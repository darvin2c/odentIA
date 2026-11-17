import {
  type ChannelAdapter,
  messengerAdapter,
  type OutboundMessage,
  ProviderRejectedError,
  whatsappCloudApiAdapter,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import {
  type KairosItemStatus,
  type SaasChatChannel,
  saasClientFile,
} from "@odentia/db/schema/admin-arm"
import { inArray } from "drizzle-orm"
import { CHANNEL_RULES } from "./admin-channel-rules.js"
import type { AdminChannels } from "./admin-channels.js"
import {
  type ChatReply,
  type ChatReplyPart,
  markChatOutreachFailed,
  markChatOutreachSent,
  markChatOutreachUncertain,
} from "./admin-inbound-chat.js"
import { settleKairosOutreach } from "./admin-kairos.js"
import { ServiceError } from "./errors.js"
import type { Storage } from "./storage.js"

/**
 * Enviar por los canales de la administración (ADR 0189) lo que ya quedó
 * reservado (`prepareChatReply` o, lo que escribe Kairós solo, `prepareKairosChatReply`): lo
 * usan la conversación y el sí de un mensaje de Kairós (rutas `admin-chats` y `admin-kairos`) y
 * el worker cuando Kairós responde en los chats. Sale una sola vez, después del
 * commit, con el id del envío como `biz_opaque_callback_data` en WhatsApp.
 * Meta lo acepta: `enviado`. Lo rechaza con su error: `no_salio` con el
 * motivo. Cualquier otra cosa (un corte, un 5xx): `incierto`; nunca se
 * reintenta, lo resuelve el estado que mande Meta o una persona con «¿Salió?».
 *
 * Un archivo sale como su propio mensaje (ADR 0196), con la dirección firmada por una hora del
 * documento del cliente: Meta lo descarga al enviarlo (`chatReplyOutbound`).
 */

export const CHAT_CHANNEL_WORDS: Record<SaasChatChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Instagram corta el texto a 1000 bytes (UTF-8): el tope de sus reglas (`CHANNEL_RULES`). */
export const INSTAGRAM_TEXT_BYTES = CHANNEL_RULES.instagram.maxBytes ?? 1000

/** Cuánto vale la dirección firmada de un archivo que sale: Meta lo descarga al enviarlo. */
export const CHAT_FILE_URL_SECONDS = 3600

/** Cómo sale por un canal: su adaptador y su configuración; nulo si no está configurado. */
export function chatSenderOf(
  channels: AdminChannels | undefined,
  channel: SaasChatChannel,
): { adapter: ChannelAdapter; config: Record<string, unknown> } | null {
  if (!channels) return null
  if (channel === "whatsapp" && channels.whatsapp)
    return {
      adapter: whatsappCloudApiAdapter,
      // `wabaId` solo lo usan las plantillas de la cuenta: enviar no.
      config: {
        phoneNumberId: channels.whatsapp.phoneNumberId,
        wabaId: channels.whatsapp.phoneNumberId,
        accessToken: channels.whatsapp.accessToken,
      },
    }
  if (channel === "messenger" && channels.messenger)
    return {
      adapter: messengerAdapter,
      config: {
        pageId: channels.messenger.pageId,
        pageAccessToken: channels.messenger.accessToken,
        appSecret: channels.appSecret,
      },
    }
  // Instagram por la página (Messenger Platform para Instagram): `/{page-id}/messages`
  // con el token de la página y el IGSID como destinatario.
  if (channel === "instagram" && channels.instagram)
    return {
      adapter: messengerAdapter,
      config: {
        pageId: channels.instagram.pageId,
        pageAccessToken: channels.instagram.accessToken,
        appSecret: channels.appSecret,
      },
    }
  return null
}

export function chatChannelOff(channel: SaasChatChannel): ServiceError {
  return new ServiceError(
    "CHAT_CHANNEL_OFF",
    409,
    `El ${CHAT_CHANNEL_WORDS[channel]} de la administración no está configurado: no se puede enviar`,
  )
}

export interface ChatSendDeps {
  ownerDb: Db
  channels?: AdminChannels | undefined
  fetch?: typeof fetch
  now?: () => Date
}

/** Lo que sale en un envío: el texto o la plantilla de lo reservado, o un archivo. */
export interface ChatOutbound {
  outreachId: string
  to: string
  body: string
  template: string | null
  templateParams: string[]
  /** Un archivo: la dirección firmada que Meta descarga al enviar, su tipo y su nombre. */
  media?: { url: string; mimeType: string; filename: string } | null
}

/**
 * Cómo terminó: `sent` (enviado), `rejected` (no salió, con el motivo de
 * Meta), `unknown` (incierto) o `unrecorded` (salió o quizá, pero no se pudo
 * anotar: queda pendiente). `itemStatus`: el ítem de Kairós que sigue a este
 * envío (`settleKairosOutreach`), o null si no salió de Kairós.
 */
export type ChatSendOutcome =
  | { kind: "sent"; status: string; itemStatus: KairosItemStatus | null }
  | { kind: "rejected"; why: string; status: string; itemStatus: KairosItemStatus | null }
  | { kind: "unknown"; status: string; itemStatus: KairosItemStatus | null }
  | { kind: "unrecorded"; status: "pendiente"; itemStatus: null }

/** Después del commit: una sola vez, y el resultado anotado en la misma transacción que su ítem. */
export async function sendChatOutreach(
  deps: ChatSendDeps,
  reply: ChatOutbound,
  channel: SaasChatChannel,
): Promise<ChatSendOutcome> {
  const sender = chatSenderOf(deps.channels, channel)
  if (!sender) throw chatChannelOff(channel)
  const message: OutboundMessage = {
    // WhatsApp: el número sin «+» (con «+» el adaptador lo tomaría por un BSUID).
    to: channel === "whatsapp" ? reply.to.replace(/^\+/, "") : reply.to,
    callbackData: reply.outreachId,
    kind: reply.media
      ? { type: "media", media: reply.media }
      : reply.template
        ? { type: "template", name: reply.template, language: "es", params: reply.templateParams }
        : { type: "text", text: reply.body },
  }
  let result:
    | { kind: "sent"; externalId: string }
    | { kind: "rejected"; why: string }
    | { kind: "unknown" }
  try {
    const sent = await sender.adapter.sendMessage(sender.config, message, {
      fetch: deps.fetch ?? fetch,
    })
    result = { kind: "sent", externalId: sent.externalId }
  } catch (error) {
    result =
      error instanceof ProviderRejectedError
        ? { kind: "rejected", why: error.message }
        : { kind: "unknown" }
    if (result.kind === "unknown")
      console.warn(
        `[chats de la administración] no se sabe si salió el envío ${reply.outreachId}`,
        error,
      )
  }
  const now = (deps.now ?? (() => new Date()))()
  try {
    return await deps.ownerDb.transaction(async (raw) => {
      const tx = raw as Db
      const marked =
        result.kind === "sent"
          ? await markChatOutreachSent(tx, reply.outreachId, result.externalId, now)
          : result.kind === "rejected"
            ? await markChatOutreachFailed(tx, reply.outreachId, result.why, now)
            : await markChatOutreachUncertain(tx, reply.outreachId, now)
      const itemStatus = await settleKairosOutreach(tx, reply.outreachId)
      const outcome: ChatSendOutcome =
        result.kind === "rejected"
          ? { kind: "rejected", why: result.why, status: marked.status, itemStatus }
          : result.kind === "sent"
            ? { kind: "sent", status: marked.status, itemStatus }
            : { kind: "unknown", status: marked.status, itemStatus }
      return outcome
    })
  } catch (error) {
    console.error(
      `[chats de la administración] no se anotó el resultado del envío ${reply.outreachId}`,
      error,
    )
    return { kind: "unrecorded", status: "pendiente", itemStatus: null }
  }
}

/** Un envío de una respuesta, listo para `sendChatOutreach`, con la parte de la que sale. */
export interface ChatOutboundPart extends ChatOutbound {
  part: ChatReplyPart
}

/**
 * Lo que sale de una respuesta, en orden, listo para `sendChatOutreach`: el texto tal cual y cada
 * archivo con la dirección firmada por una hora de su documento (Meta la descarga al enviarlo).
 * Va en la misma transacción que la reserva: si no se puede firmar, no queda nada pendiente. La
 * constancia de cada archivo (`client_file.sent`, a nombre de quien lo manda) la deja la parte
 * cuando de verdad sale (`settleChatOutreach`), no la reserva: lo que no salió no se dio a Meta.
 */
export async function chatReplyOutbound(
  tx: Db,
  storage: Pick<Storage, "attachmentUrl"> | undefined,
  reply: ChatReply,
): Promise<ChatOutboundPart[]> {
  const fileIds = reply.parts.flatMap((part) => (part.fileId ? [part.fileId] : []))
  const files = fileIds.length
    ? await tx
        .select({
          id: saasClientFile.id,
          objectKey: saasClientFile.objectKey,
          contentType: saasClientFile.contentType,
          filename: saasClientFile.filename,
        })
        .from(saasClientFile)
        .where(inArray(saasClientFile.id, fileIds))
    : []
  if (fileIds.length > 0 && !storage)
    throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudieron leer los archivos")
  const out: ChatOutboundPart[] = []
  for (const part of reply.parts) {
    const base = {
      outreachId: part.outreachId,
      to: reply.to,
      body: part.body,
      template: part.kind === "texto" ? reply.template : null,
      templateParams: part.kind === "texto" ? reply.templateParams : [],
      part,
    }
    if (!part.fileId) {
      out.push({ ...base, media: null })
      continue
    }
    const file = files.find((row) => row.id === part.fileId)
    if (!file || !storage)
      throw new ServiceError("FILE_GONE", 409, "Un archivo ya no está: vuelve a elegirlos")
    const url = await storage.attachmentUrl(file.objectKey, CHAT_FILE_URL_SECONDS)
    out.push({
      ...base,
      media: { url, mimeType: file.contentType, filename: file.filename },
    })
  }
  return out
}

/**
 * Lo que seguía de una respuesta y no se envió porque una parte anterior no salió (o no se sabe
 * si salió): no salió, y es seguro (nunca se llamó a Meta). Si no se puede anotar, queda
 * pendiente y lo resuelve una persona con «¿Salió?». Devuelve el estado de cada uno.
 */
export async function skipChatOutreach(
  ownerDb: Db,
  outreachIds: readonly string[],
  why: string,
  now = new Date(),
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  for (const outreachId of outreachIds) {
    try {
      const marked = await ownerDb.transaction((raw) =>
        markChatOutreachFailed(raw as Db, outreachId, why, now),
      )
      statuses.set(outreachId, marked.status)
    } catch (error) {
      console.error(`[chats de la administración] no se anotó que no salió ${outreachId}`, error)
      statuses.set(outreachId, "pendiente")
    }
  }
  return statuses
}
