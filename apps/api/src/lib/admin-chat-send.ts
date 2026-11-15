import {
  type ChannelAdapter,
  messengerAdapter,
  type OutboundMessage,
  ProviderRejectedError,
  whatsappCloudApiAdapter,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import type { KairosItemStatus, SaasChatChannel } from "@odentia/db/schema/admin-arm"
import {
  type AdminChannels,
  type ChatReply,
  markChatOutreachFailed,
  markChatOutreachSent,
  markChatOutreachUncertain,
  ServiceError,
  settleKairosOutreach,
} from "@odentia/services"

/**
 * Enviar por los canales de la administración (ADR 0189) lo que ya quedó
 * reservado (`prepareChatReply`): lo usan la conversación (`admin-chats`) y el
 * sí de un mensaje de Kairós (`admin-kairos`). Sale una sola vez, después del
 * commit, con el id del envío como `biz_opaque_callback_data` en WhatsApp.
 * Meta lo acepta: `enviado`. Lo rechaza con su error: `no_salio` con el
 * motivo. Cualquier otra cosa (un corte, un 5xx): `incierto`; nunca se
 * reintenta, lo resuelve el estado que mande Meta o una persona con «¿Salió?».
 */

export const CHAT_CHANNEL_WORDS: Record<SaasChatChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Instagram corta el texto a 1000 bytes (UTF-8). */
export const INSTAGRAM_TEXT_BYTES = 1000

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
  reply: ChatReply,
  channel: SaasChatChannel,
): Promise<ChatSendOutcome> {
  const sender = chatSenderOf(deps.channels, channel)
  if (!sender) throw chatChannelOff(channel)
  const message: OutboundMessage = {
    // WhatsApp: el número sin «+» (con «+» el adaptador lo tomaría por un BSUID).
    to: channel === "whatsapp" ? reply.to.replace(/^\+/, "") : reply.to,
    callbackData: reply.outreachId,
    kind: reply.template
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
      console.warn(`[admin-chats] no se sabe si salió el envío ${reply.outreachId}`, error)
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
    console.error(`[admin-chats] no se anotó el resultado del envío ${reply.outreachId}`, error)
    return { kind: "unrecorded", status: "pendiente", itemStatus: null }
  }
}
