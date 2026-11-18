import type { Db } from "@odentia/db"
import { type SaasChatChannel, saasChat } from "@odentia/db/schema/admin-arm"
import {
  type AdminActor,
  type AdminChannels,
  assignChat,
  CHAT_REPLY_FILES_MAX,
  type ChatOutboundPart,
  type ChatReply,
  type ChatReplyInput,
  chatReplyOutbound,
  getChat,
  issueFields,
  listAdsToTie,
  markChatNotClinic,
  openChatForContact,
  pauseChatKairos,
  prepareChatReply,
  resumeChatKairos,
  ServiceError,
  type Storage,
  setAdProduct,
  setChatProduct,
  skipChatOutreach,
  undoChatNotClinic,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import {
  CHAT_CHANNEL_WORDS,
  type ChatSendOutcome,
  chatChannelOff,
  chatSenderOf,
  sendChatOutreach,
} from "../lib/admin-chat-send.js"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse } from "./helpers.js"

/**
 * Las conversaciones de la administración por WhatsApp, Instagram y Messenger
 * (`/api/admin/chats`, tras el guard de admin; ADR 0189). Son de Administración
 * (ADR 0196): Soporte recibe 403 en todas, también en la configuración (su
 * «Escribir por WhatsApp» sigue por wa.me).
 *
 * Responder: se reservan los envíos (`pendiente`: el texto y uno por archivo)
 * en una transacción y salen después del commit, en orden, por el canal de la
 * conversación, con el id de cada envío como `biz_opaque_callback_data` en
 * WhatsApp. Meta lo acepta: `enviado`. Lo rechaza con su error: `no_salio` con
 * el motivo. Cualquier otra cosa (un corte, un 5xx): `incierto` y 502
 * `SEND_UNKNOWN`; nunca se reintenta solo, lo resuelve el estado que mande Meta
 * o una persona con «¿Salió?». Si una parte no sale (o no se sabe), lo que
 * seguía no se envía y queda `no_salio`: nunca se llamó a Meta con eso.
 */
export interface AdminChatsDeps {
  ownerDb: Db
  /** Lo configurado de la app de Meta de la administración; sin él no se envía nada. */
  channels?: AdminChannels | undefined
  /** El bucket privado: firma la dirección de los archivos que salen. Sin él no salen archivos. */
  storage?: Pick<Storage, "attachmentUrl"> | undefined
  /** Solo las pruebas lo cambian. */
  fetch?: typeof fetch
  now?: () => Date
}

const UUID_MESSAGE = "Cliente no encontrado"

const assignBody = z.strictObject({
  clientId: z.uuid(UUID_MESSAGE),
  contactId: z.uuid("Esa persona no es de este cliente").nullish(),
})

const replyBody = z.strictObject({
  /** Con archivos puede no llevar texto; el servicio dice si falta y cuánto cabe en el canal. */
  body: z.string("Escribe el mensaje").max(5000, "Usa como máximo 5000 caracteres").optional(),
  adminOnly: z.boolean().optional(),
  /** «Enviar la propuesta» por WhatsApp: el texto habla de ella (el PDF no va). */
  proposalId: z.uuid("Esa propuesta no es de este cliente").nullish(),
  /** Documentos del cliente que salen después del texto, cada uno como su propio mensaje. */
  fileIds: z
    .array(z.uuid("Ese archivo no existe"))
    .max(CHAT_REPLY_FILES_MAX, `Manda como máximo ${CHAT_REPLY_FILES_MAX} archivos`)
    .optional(),
})

const openBody = z.strictObject({
  clientId: z.uuid(UUID_MESSAGE),
  contactId: z.uuid("Esa persona no es de este cliente"),
  channel: z.literal("whatsapp", "Solo se le escribe primero por WhatsApp"),
})

function adminOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración puede hacer esto")
  return actor
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw new ServiceError(
      "VALIDATION",
      400,
      parsed.error.issues[0]?.message ?? "Revisa los datos marcados.",
      issueFields(parsed.error.issues),
    )
  return parsed.data
}

/** La app que se elige: el servicio dice si es una de las de hoy. */
const appBody = z.strictObject({
  product: z.string().trim().min(1, "Elige una de las apps").max(40),
})

const bodyOf = (c: Context) => c.req.json().catch(() => null)

/** Una parte de lo que salió, para la respuesta: el texto o un archivo, con su estado. */
interface SentPart {
  outreachId: string
  kind: "texto" | "archivo"
  filename: string | null
  status: string
}

export function createAdminChatsRoute(deps: AdminChatsDeps) {
  const app = new Hono()
  const clock = deps.now ?? (() => new Date())
  const fetchImpl = deps.fetch ?? fetch
  const owner = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    deps.ownerDb.transaction((tx) => fn(tx as Db))
  const adminRun = <T>(c: Context, status: 200 | 201, fn: (actor: AdminActor) => Promise<T>) =>
    runService(c, status, () => fn(adminOf(c)))

  /** Qué canales están: sin WhatsApp configurado, «Escribir» sigue con wa.me. */
  app.get("/config", (c) =>
    adminRun(c, 200, async () => ({
      whatsapp: Boolean(deps.channels?.whatsapp),
      instagram: Boolean(deps.channels?.instagram),
      messenger: Boolean(deps.channels?.messenger),
    })),
  )

  /** «Escribir por WhatsApp» desde la ficha: la conversación de ese celular, creada si no existe. */
  app.post("/open", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(openBody, raw)
      if (!deps.channels?.whatsapp) throw chatChannelOff("whatsapp")
      const now = clock()
      return owner(async (tx) => {
        const opened = await openChatForContact(tx, actor, body, now)
        return { ...(await getChat(tx, actor, opened.chatId, now)), created: opened.created }
      })
    })
  })

  /** Los anuncios de Meta que nadie ató todavía a su app (Hoy, «Anuncios por atar»). */
  app.get("/ads/to-tie", (c) => adminRun(c, 200, (actor) => owner((tx) => listAdsToTie(tx, actor))))

  /** Ata un anuncio a su app: sus conversaciones sin app la toman. */
  app.post("/ads/:adId/app", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(appBody, raw)
      return owner((tx) => setAdProduct(tx, actor, c.req.param("adId"), body.product, clock()))
    })
  })

  app.get("/:id", (c) =>
    adminRun(c, 200, (actor) => owner((tx) => getChat(tx, actor, c.req.param("id"), clock()))),
  )

  /** «Cambiar la app» de una conversación sin cliente: devuelve la conversación como queda. */
  app.post("/:id/app", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(appBody, raw)
      const now = clock()
      return owner(async (tx) => {
        await setChatProduct(tx, actor, c.req.param("id"), body.product, now)
        return getChat(tx, actor, c.req.param("id"), now)
      })
    })
  })

  app.post("/:id/assign", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(assignBody, raw)
      return owner((tx) => assignChat(tx, actor, c.req.param("id"), body, clock()))
    })
  })

  app.post("/:id/not-clinic", (c) =>
    adminRun(c, 200, (actor) =>
      owner((tx) => markChatNotClinic(tx, actor, c.req.param("id"), clock())),
    ),
  )
  app.delete("/:id/not-clinic", (c) =>
    adminRun(c, 200, (actor) =>
      owner((tx) => undoChatNotClinic(tx, actor, c.req.param("id"), clock())),
    ),
  )

  /** «Lo atiendo yo» y «Devolver a Kairós». */
  app.post("/:id/kairos-pause", (c) =>
    adminRun(c, 200, (actor) =>
      owner((tx) => pauseChatKairos(tx, actor, c.req.param("id"), clock())),
    ),
  )
  app.delete("/:id/kairos-pause", (c) =>
    adminRun(c, 200, (actor) =>
      owner((tx) => resumeChatKairos(tx, actor, c.req.param("id"), clock())),
    ),
  )

  /**
   * Reserva y envía. La reserva, las comprobaciones (lo que acepta el canal) y la firma de la
   * dirección de cada archivo van en la misma transacción: si el canal no está configurado, el
   * texto no cabe o un archivo no sale, no queda nada pendiente.
   */
  const reserveAndSend = async (c: Context, actor: AdminActor, input: ChatReplyInput) => {
    const now = clock()
    const { reply, channel, outbound } = await owner(async (tx) => {
      const prepared = await prepareChatReply(tx, actor, c.req.param("id") ?? "", input, now)
      const [chat] = await tx
        .select({ channel: saasChat.channel })
        .from(saasChat)
        .where(eq(saasChat.id, prepared.chatId))
        .limit(1)
      const chatChannel = (chat?.channel ?? "whatsapp") as SaasChatChannel
      if (!chatSenderOf(deps.channels, chatChannel)) throw chatChannelOff(chatChannel)
      const parts = await chatReplyOutbound(tx, deps.storage, prepared)
      return { reply: prepared, channel: chatChannel, outbound: parts }
    })
    return send(c, reply, channel, outbound)
  }

  /** Lo que se dice de una parte que no salió (o no se sabe), con el nombre del archivo. */
  const failureWords = (
    outcome: Exclude<ChatSendOutcome, { kind: "sent" }>,
    part: ChatOutboundPart["part"],
    channel: SaasChatChannel,
    rest: number,
  ) => {
    const what = part.kind === "archivo" && part.filename ? `«${part.filename}»` : "el mensaje"
    const after = rest > 0 ? ". Lo que seguía no se envió" : ""
    if (outcome.kind === "unrecorded")
      return `No se pudo anotar si ${what} salió: revisa y marca si salió o no${after}`
    if (outcome.kind === "rejected")
      return `No salió${part.kind === "archivo" ? ` ${what}` : ""}: ${outcome.why}${after}`
    return `No se sabe si ${what} salió por ${CHAT_CHANNEL_WORDS[channel]}: revisa y marca si salió o no antes de volver a enviarlo${after}`
  }

  /**
   * Después del commit, en orden y una sola vez cada parte (`sendChatOutreach`). Si una no sale
   * o no se sabe, lo que seguía queda `no_salio` sin llamar a Meta.
   */
  const send = async (
    c: Context,
    reply: ChatReply,
    channel: SaasChatChannel,
    outbound: ChatOutboundPart[],
  ) => {
    const parts: SentPart[] = outbound.map(({ part }) => ({
      outreachId: part.outreachId,
      kind: part.kind,
      filename: part.filename,
      status: "pendiente",
    }))
    for (const [index, item] of outbound.entries()) {
      const outcome = await sendChatOutreach(
        { ownerDb: deps.ownerDb, channels: deps.channels, fetch: fetchImpl, now: clock },
        item,
        channel,
      )
      const sent = parts[index]
      if (sent) sent.status = outcome.status
      if (outcome.kind === "sent") continue
      const rest = outbound.slice(index + 1)
      if (rest.length > 0) {
        const skipped = await skipChatOutreach(
          deps.ownerDb,
          rest.map(({ part }) => part.outreachId),
          "No se envió: lo anterior de la misma respuesta no salió o no se sabe si salió",
          clock(),
        )
        for (const part of parts.slice(index + 1))
          part.status = skipped.get(part.outreachId) ?? part.status
      }
      const code = outcome.kind === "rejected" ? "SEND_REJECTED" : "SEND_UNKNOWN"
      return c.json(
        {
          error: {
            ...errorBody(c, code, failureWords(outcome, item.part, channel, rest.length)).error,
            outreachId: item.outreachId,
            parts,
          },
        },
        502,
      )
    }
    const first = parts[0]
    return c.json(
      {
        data: {
          outreachId: first?.outreachId ?? reply.outreachId,
          status: first?.status ?? "pendiente",
          parts,
        },
      },
      201,
    )
  }

  app.post("/:id/reply", async (c) => {
    const raw = await bodyOf(c)
    try {
      const actor = adminOf(c)
      const body = parse(replyBody, raw)
      return await reserveAndSend(c, actor, {
        body: body.body ?? null,
        ...(body.adminOnly !== undefined ? { adminOnly: body.adminOnly } : {}),
        ...(body.proposalId ? { proposalId: body.proposalId } : {}),
        ...(body.fileIds?.length ? { fileIds: body.fileIds } : {}),
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /** Fuera de las 24 h, solo WhatsApp: la plantilla `retomar_conversacion` con el nombre de quien escribe. */
  app.post("/:id/retomar", async (c) => {
    try {
      const actor = adminOf(c)
      return await reserveAndSend(c, actor, { template: "retomar_conversacion" })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
