import type { Db } from "@odentia/db"
import { type SaasChatChannel, saasChat } from "@odentia/db/schema/admin-arm"
import {
  type AdminActor,
  type AdminChannels,
  assignChat,
  type ChatReply,
  getChat,
  invalidField,
  issueFields,
  markChatNotClinic,
  openChatForContact,
  pauseChatKairos,
  prepareChatReply,
  resumeChatKairos,
  ServiceError,
  undoChatNotClinic,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import {
  CHAT_CHANNEL_WORDS,
  chatChannelOff,
  chatSenderOf,
  INSTAGRAM_TEXT_BYTES,
  sendChatOutreach,
} from "../lib/admin-chat-send.js"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse } from "./helpers.js"

/**
 * Las conversaciones de la administración por WhatsApp, Instagram y Messenger
 * (`/api/admin/chats`, tras el guard de admin; ADR 0189). Leer y responder es
 * del equipo (Soporte solo lo de una clínica con su app: lo demás es 404);
 * decir de quién es y «No es una clínica», de Administración.
 *
 * Responder: se reserva el envío (`pendiente`) en una transacción y sale
 * después del commit por el canal de la conversación, con el id del envío como
 * `biz_opaque_callback_data` en WhatsApp. Meta lo acepta: `enviado`. Lo rechaza
 * con su error: `no_salio` con el motivo. Cualquier otra cosa (un corte, un
 * 5xx): `incierto` y 502 `SEND_UNKNOWN`; nunca se reintenta solo, lo resuelve
 * el estado que mande Meta o una persona con «¿Salió?».
 */
export interface AdminChatsDeps {
  ownerDb: Db
  /** Lo configurado de la app de Meta de la administración; sin él no se envía nada. */
  channels?: AdminChannels | undefined
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
  body: z.string("Escribe el mensaje").max(5000, "Usa como máximo 5000 caracteres"),
  adminOnly: z.boolean().optional(),
  /** «Enviar la propuesta» por WhatsApp: el texto habla de ella (el PDF no va). */
  proposalId: z.uuid("Esa propuesta no es de este cliente").nullish(),
})

const openBody = z.strictObject({
  clientId: z.uuid(UUID_MESSAGE),
  contactId: z.uuid("Esa persona no es de este cliente"),
  channel: z.literal("whatsapp", "Solo se le escribe primero por WhatsApp"),
})

function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support")
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de la administración")
  return actor
}

function adminOf(c: Context): AdminActor {
  const actor = staffOf(c)
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

const bodyOf = (c: Context) => c.req.json().catch(() => null)

export function createAdminChatsRoute(deps: AdminChatsDeps) {
  const app = new Hono()
  const clock = deps.now ?? (() => new Date())
  const fetchImpl = deps.fetch ?? fetch
  const owner = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    deps.ownerDb.transaction((tx) => fn(tx as Db))
  const staffRun = <T>(c: Context, status: 200 | 201, fn: (actor: AdminActor) => Promise<T>) =>
    runService(c, status, () => fn(staffOf(c)))
  const adminRun = <T>(c: Context, status: 200 | 201, fn: (actor: AdminActor) => Promise<T>) =>
    runService(c, status, () => fn(adminOf(c)))

  /** Qué canales están: sin WhatsApp configurado, «Escribir» sigue con wa.me. */
  app.get("/config", (c) =>
    staffRun(c, 200, async () => ({
      whatsapp: Boolean(deps.channels?.whatsapp),
      instagram: Boolean(deps.channels?.instagram),
      messenger: Boolean(deps.channels?.messenger),
    })),
  )

  /** «Escribir por WhatsApp» desde la ficha: la conversación de ese celular, creada si no existe. */
  app.post("/open", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      const body = parse(openBody, raw)
      if (!deps.channels?.whatsapp) throw chatChannelOff("whatsapp")
      const now = clock()
      return owner(async (tx) => {
        const opened = await openChatForContact(tx, actor, body, now)
        return { ...(await getChat(tx, actor, opened.chatId, now)), created: opened.created }
      })
    })
  })

  app.get("/:id", (c) =>
    staffRun(c, 200, (actor) => owner((tx) => getChat(tx, actor, c.req.param("id"), clock()))),
  )

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

  /** «Lo atiendo yo» y «Devolver a Kairós»: cualquiera del equipo que ve la conversación. */
  app.post("/:id/kairos-pause", (c) =>
    staffRun(c, 200, (actor) =>
      owner((tx) => pauseChatKairos(tx, actor, c.req.param("id"), clock())),
    ),
  )
  app.delete("/:id/kairos-pause", (c) =>
    staffRun(c, 200, (actor) =>
      owner((tx) => resumeChatKairos(tx, actor, c.req.param("id"), clock())),
    ),
  )

  /**
   * Reserva y envía. La reserva y las comprobaciones van en la misma
   * transacción: si el canal no está configurado o el texto no cabe, no queda
   * nada pendiente.
   */
  const reserveAndSend = async (
    c: Context,
    actor: AdminActor,
    input: {
      body?: string | null
      adminOnly?: boolean
      template?: string
      proposalId?: string | null
    },
  ) => {
    const now = clock()
    const { reply, channel } = await owner(async (tx) => {
      const prepared = await prepareChatReply(tx, actor, c.req.param("id") ?? "", input, now)
      const [chat] = await tx
        .select({ channel: saasChat.channel })
        .from(saasChat)
        .where(eq(saasChat.id, prepared.chatId))
        .limit(1)
      const chatChannel = (chat?.channel ?? "whatsapp") as SaasChatChannel
      if (!chatSenderOf(deps.channels, chatChannel)) throw chatChannelOff(chatChannel)
      if (
        chatChannel === "instagram" &&
        Buffer.byteLength(prepared.body, "utf8") > INSTAGRAM_TEXT_BYTES
      )
        throw invalidField("body", "Instagram deja como mucho 1000 caracteres: acórtalo")
      return { reply: prepared, channel: chatChannel }
    })
    return send(c, reply, channel)
  }

  /** Después del commit: una sola vez, y el resultado anotado (`sendChatOutreach`). */
  const send = async (c: Context, reply: ChatReply, channel: SaasChatChannel) => {
    const outcome = await sendChatOutreach(
      { ownerDb: deps.ownerDb, channels: deps.channels, fetch: fetchImpl, now: clock },
      reply,
      channel,
    )
    if (outcome.kind === "unrecorded")
      // Salió (o quizá) pero no se pudo anotar: queda pendiente para que una persona diga si salió.
      return c.json(
        {
          error: {
            ...errorBody(
              c,
              "SEND_UNKNOWN",
              "No se pudo anotar si el mensaje salió: revisa y marca si salió o no",
            ).error,
            outreachId: reply.outreachId,
          },
        },
        502,
      )
    if (outcome.kind === "rejected")
      return c.json(
        {
          error: {
            ...errorBody(c, "SEND_REJECTED", `No salió: ${outcome.why}`).error,
            outreachId: reply.outreachId,
          },
        },
        502,
      )
    if (outcome.kind === "unknown")
      return c.json(
        {
          error: {
            ...errorBody(
              c,
              "SEND_UNKNOWN",
              `No se sabe si el mensaje salió por ${CHAT_CHANNEL_WORDS[channel]}: revisa y marca si salió o no antes de volver a enviarlo`,
            ).error,
            outreachId: reply.outreachId,
          },
        },
        502,
      )
    return c.json({ data: { outreachId: reply.outreachId, status: outcome.status } }, 201)
  }

  app.post("/:id/reply", async (c) => {
    const raw = await bodyOf(c)
    try {
      const actor = staffOf(c)
      const body = parse(replyBody, raw)
      return await reserveAndSend(c, actor, {
        body: body.body,
        ...(body.adminOnly !== undefined ? { adminOnly: body.adminOnly } : {}),
        ...(body.proposalId ? { proposalId: body.proposalId } : {}),
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /** Fuera de las 24 h, solo WhatsApp: la plantilla `retomar_conversacion` con el nombre de quien escribe. */
  app.post("/:id/retomar", async (c) => {
    try {
      const actor = staffOf(c)
      return await reserveAndSend(c, actor, { template: "retomar_conversacion" })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
