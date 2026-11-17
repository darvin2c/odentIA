import { fakeKairosWriter } from "@odentia/agent"
import type { Db } from "@odentia/db"
import type { KairosItemStatus } from "@odentia/db/schema/admin-arm"
import type { Mailer } from "@odentia/mail"
import {
  type AdminActor,
  type AdminChannels,
  assignChat,
  assignInboundEmail,
  type ChatReply,
  createSaasProposal,
  decideKairosItem,
  draftPendingKairosItems,
  getKairosSells,
  KAIROS_DRAFTS_PER_PASS,
  type KairosDraftWriter,
  type KairosExecutors,
  type KairosImproveWriter,
  type KairosWeeklyWriter,
  kairosDonePage,
  kairosRulesPass,
  linkContactToUser,
  listKairosItems,
  markClientFileCarga,
  markOutreachSent,
  type OutreachEmail,
  type OutreachRow,
  outreachEmail,
  outreachMailMessage,
  prepareChatMessage,
  prepareEmailReply,
  prepareOutreach,
  reassignPresentation,
  recordPresentation,
  ServiceError,
  setKairosSells,
  settleKairosOutreach,
  todayForStaff,
  updateClient,
  writeKairosWeekly,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { sendChatOutreach } from "../lib/admin-chat-send.js"
import { adminContextOf } from "../lib/admin-context.js"
import { createKairosImproveRoute } from "./admin-kairos-improve.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Kairós en la administración (`/api/admin/kairos`, el ARM; ADR 0185): lo
 * que espera un sí, aprobar o descartar, «Lo que hizo», Hoy y el número del
 * menú. Kairós nunca envía ni decide solo: aprobar ejecuta la misma operación
 * de la pantalla (`KairosExecutors` con las funciones reales de venta,
 * clientes y correos) y, si es un correo, la ruta lo envía después
 * del commit como cualquier envío: queda `enviado` o `incierto`, nunca se
 * reintenta. Un WhatsApp aprobado sale igual por el número de Sallca, desde
 * la conversación de esa persona (queda en su historial; fuera de las 24 h,
 * con la plantilla para retomar); sin el número configurado, devuelve su
 * enlace wa.me y queda pendiente hasta que la persona dice «Salió» o «No salió».
 */
export interface AdminKairosDeps {
  /** Las tablas del ARM viven en `admin`, sin GRANT a la app: solo la conexión propietaria. */
  ownerDb: Db
  mailer: Mailer
  /**
   * El escritor de Kairós con modelo (`createKairosWriter` de `@odentia/agent`);
   * sin él, el doble determinista (`fakeKairosWriter`), sin gasto. También
   * «Mejorar con Kairós» (`/improve`).
   */
  kairos?: KairosDraftWriter & KairosWeeklyWriter & KairosImproveWriter
  /**
   * Por dónde salen los correos que se aprueban (conversaciones): el canal de
   * ZeptoMail para conversaciones (`CONVERSATION_SMTP_*`); sin él, `mailer`. Las
   * respuestas van a quien firma (la persona que aprueba, soporte@ u hola@).
   */
  conversationMailer?: Mailer
  /** «Conectar con Facebook» está configurado: sin él, el paso de WhatsApp del alta espera a Meta. */
  metaSignupAvailable?: boolean
  /** Los canales de la administración (ADR 0189): con WhatsApp, el mensaje sale por el número de Sallca. */
  channels?: AdminChannels | undefined
  /** Solo las pruebas lo cambian (el envío a Meta). */
  fetch?: typeof fetch
}

/**
 * Lo que prepara un sí de un mensaje: el envío de los envíos (`prepareOutreach`:
 * correo, o WhatsApp por wa.me) o, con el número de Sallca, la respuesta
 * reservada en la conversación (`prepareChatMessage`), que la ruta envía.
 */
export type KairosOutreach =
  | { via: "envio"; id: string; row: OutreachRow }
  | { via: "chat"; id: string; reply: ChatReply }

function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support")
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de la administración")
  return actor
}

function adminOf(c: Context): AdminActor {
  const actor = staffOf(c)
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración corre a Kairós a pedido")
  return actor
}

const itemsQuery = z.object({
  status: z.enum(["espera", "hecho"], "Elige «espera» o «hecho»").default("espera"),
  clientId: z.uuid("El cliente no es válido").optional(),
  limit: z.coerce
    .number("El tope es un número")
    .int("El tope es entero")
    .min(1, "El tope va de 1 a 100")
    .max(100, "El tope va de 1 a 100")
    .optional(),
})

const decideBody = z.strictObject({
  action: z.enum(["aprobar", "descartar"], "Elige aprobar o descartar"),
  /** Lo que la persona cambió («Cambiar»); el servicio dice qué deja cambiar cada tipo. */
  edited: z.record(z.string(), z.unknown(), "Lo cambiado no es válido").optional(),
})

const doneQuery = z.object({
  limit: z.coerce
    .number("El tope es un número")
    .int("El tope es entero")
    .min(1, "El tope va de 1 a 200")
    .max(200, "El tope va de 1 a 200")
    .optional(),
  before: z.iso.datetime({ offset: true, error: "La fecha no es válida" }).optional(),
})

const todayQuery = z.object({
  who: z.enum(["mias", "todas"], "Elige «mías» o «todas»").default("mias"),
})

const runBody = z.strictObject({
  /** También el resumen de la semana para Reportes, si todavía no está. */
  weekly: z.boolean("Di sí o no").optional(),
})

/** La hora la decide la base (con réplicas, la del servidor puede no ser la misma). */
async function dbNow(tx: Db): Promise<Date> {
  const [row] = [...(await tx.execute<{ now: string | Date }>(sql`select now() as now`))]
  return row ? new Date(row.now) : new Date()
}

/** Las operaciones de la pantalla que ejecuta un sí: las mismas, con sus reglas y su auditoría. */
function executorsAt(
  now: Date,
  channels: AdminChannels | undefined,
): KairosExecutors<KairosOutreach> {
  const envio = (row: OutreachRow): KairosOutreach => ({ via: "envio", id: row.id, row })
  return {
    prepareOutreach: async (tx, actor, clientId, input) => {
      // Con el número de Sallca, el WhatsApp a una persona del cliente sale desde su
      // conversación (la misma de «Escribir»); wa.me solo sin él.
      if (input.channel === "whatsapp" && channels?.whatsapp) {
        if (!input.contactId)
          throw new ServiceError(
            "KAIROS_ITEM_INCOMPLETE",
            409,
            "Falta a qué persona del cliente se le escribe",
          )
        const reply = await prepareChatMessage(
          tx,
          actor,
          clientId,
          {
            contactId: input.contactId,
            body: input.body,
            proposalId: input.proposalId ?? null,
            kairosItemId: input.kairosItemId ?? null,
          },
          now,
        )
        return { via: "chat", id: reply.outreachId, reply }
      }
      return envio(await prepareOutreach(tx, actor, clientId, input, now))
    },
    updateClient: (tx, actor, clientId, patch) => updateClient(tx, actor, clientId, patch),
    linkContactToUser: (tx, actor, contactId, userId) =>
      linkContactToUser(tx, actor, contactId, userId),
    assignInboundEmail: (tx, actor, emailId, clientId) =>
      assignInboundEmail(tx, actor, emailId, clientId, now),
    assignChat: (tx, actor, chatId, input) => assignChat(tx, actor, chatId, input, now),
    prepareEmailReply: async (tx, actor, emailId, input) =>
      envio(await prepareEmailReply(tx, actor, emailId, input, now)),
    recordPresentation: (tx, actor, taskId, input) =>
      recordPresentation(tx, actor, taskId, input, now),
    createProposal: (tx, actor, clientId, input) =>
      createSaasProposal(tx, actor, clientId, input, now),
    // Lo que ya pasó los 30 días queda para borrarse ahora: lo borra el worker en su vuelta
    // siguiente (esta ruta no tiene el almacenamiento).
    markClientFileCarga: (tx, actor, fileId) => markClientFileCarga(tx, actor, fileId, now),
    reassignPresentation: (tx, actor, taskId, toUserId) =>
      reassignPresentation(tx, actor, taskId, toUserId, now),
  }
}

export interface KairosEmailOutcome {
  emailSent: boolean
  outreachStatus: OutreachRow["status"]
  itemStatus: KairosItemStatus | null
}

/**
 * Envía el correo de un envío ya confirmado en la base y anota el resultado:
 * `enviado` si el servidor de correo lo aceptó, `incierto` si falló o se
 * cortó (no se sabe si salió: nunca se reintenta, lo resuelve una persona).
 * Después, el ítem de Kairós sigue a su envío (`settleKairosOutreach`). Si
 * anotar falla, el envío queda pendiente y también lo resuelve una persona.
 */
export async function sendKairosOutreachEmail(
  deps: Pick<AdminKairosDeps, "ownerDb" | "mailer" | "conversationMailer">,
  actor: AdminActor,
  outreachId: string,
  email: OutreachEmail,
): Promise<KairosEmailOutcome> {
  let sent = false
  try {
    await (deps.conversationMailer ?? deps.mailer).send(outreachMailMessage(email))
    sent = true
  } catch (error) {
    console.error("[kairos] el correo del envío no se sabe si salió", outreachId, error)
  }
  try {
    return await deps.ownerDb.transaction(async (tx) => {
      const row = await markOutreachSent(tx, actor, outreachId, sent ? "enviado" : "incierto")
      const itemStatus = await settleKairosOutreach(tx, outreachId)
      return { emailSent: sent, outreachStatus: row.status, itemStatus }
    })
  } catch (error) {
    console.error("[kairos] no se anotó el resultado del envío", outreachId, error)
    return { emailSent: sent, outreachStatus: "pendiente", itemStatus: "incierta" }
  }
}

const sellsBody = z.strictObject({ enabled: z.boolean() })

export function createAdminKairosRoute(deps: AdminKairosDeps) {
  const app = new Hono()
  const writer = deps.kairos ?? fakeKairosWriter

  // Lo que preparó Kairós: lo que espera un sí o lo ya decidido. Soporte no ve lo de Administración.
  app.get("/items", async (c) => {
    const actor = staffOf(c)
    const parsed = itemsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => listKairosItems(tx, actor, parsed.data)),
    )
  })

  // El número del menú: cuánto espera un sí, de lo que esta persona puede ver.
  app.get("/count", async (c) => {
    const actor = staffOf(c)
    return runService(c, 200, () =>
      deps.ownerDb.transaction(async (tx) => {
        const { total } = await listKairosItems(tx, actor, { status: "espera", limit: 1 })
        return { waiting: total }
      }),
    )
  })

  // Aprobar o descartar. Un correo aprobado sale después del commit, una sola vez.
  app.post("/items/:id/decide", async (c) => {
    const actor = staffOf(c)
    const parsed = decideBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const id = c.req.param("id")
    const now = new Date()
    let decided: Awaited<ReturnType<typeof decideKairosItem<KairosOutreach>>>
    let email: OutreachEmail | null = null
    try {
      const done = await deps.ownerDb.transaction(async (tx) => {
        const decision = await decideKairosItem(
          tx,
          actor,
          id,
          parsed.data,
          executorsAt(now, deps.channels),
          now,
        )
        // El correo se arma dentro: si no se puede (la propuesta no sale en PDF), no queda nada a medias.
        const mail =
          decision.outreach?.via === "envio" && decision.outreach.row.channel === "correo"
            ? await outreachEmail(tx, decision.outreach.id)
            : null
        return { decision, mail }
      })
      decided = done.decision
      email = done.mail
    } catch (error) {
      const response = serviceErrorResponse(c, error)
      if (response) return response
      throw error
    }
    const { outreach: prepared, ...decision } = decided
    if (!prepared) return c.json({ data: { ...decision, outreach: null, emailSent: null } })
    if (prepared.via === "chat") {
      // Después del commit, una sola vez: enviado, no salió (con el motivo de Meta) o incierto.
      const { reply } = prepared
      const sent = await sendChatOutreach(
        {
          ownerDb: deps.ownerDb,
          channels: deps.channels,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        },
        reply,
        "whatsapp",
      )
      return c.json({
        data: {
          ...decision,
          status: sent.itemStatus ?? decision.status,
          outreach: {
            id: reply.outreachId,
            channel: "whatsapp",
            to: reply.to,
            status: sent.status,
            whatsappUrl: null,
            chatId: reply.chatId,
            template: reply.template,
            why: sent.kind === "rejected" ? sent.why : null,
          },
          emailSent: null,
        },
      })
    }
    const outreach = prepared.row
    if (!email) {
      return c.json({
        data: {
          ...decision,
          outreach: {
            id: outreach.id,
            channel: outreach.channel,
            to: outreach.to,
            status: outreach.status,
            whatsappUrl: outreach.whatsappUrl,
            chatId: null,
            template: null,
            why: null,
          },
          emailSent: null,
        },
      })
    }
    const sent = await sendKairosOutreachEmail(deps, actor, outreach.id, email)
    return c.json({
      data: {
        ...decision,
        status: sent.itemStatus ?? decision.status,
        outreach: {
          id: outreach.id,
          channel: outreach.channel,
          to: outreach.to,
          status: sent.outreachStatus,
          whatsappUrl: null,
          chatId: null,
          template: null,
          why: null,
        },
        emailSent: sent.emailSent,
      },
    })
  })

  // «Lo que hizo» Kairós, en frases y con Deshacer cuando se puede.
  app.get("/done", async (c) => {
    const actor = staffOf(c)
    const parsed = doneQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { limit, before } = parsed.data
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) =>
        kairosDonePage(tx, actor, {
          ...(limit ? { limit } : {}),
          ...(before ? { before: new Date(before) } : {}),
        }),
      ),
    )
  })

  // Hoy: lo que Kairós dejó listo, las tareas (mías o todas), quién se enfría y quién está en riesgo.
  app.get("/today", async (c) => {
    const actor = staffOf(c)
    const parsed = todayQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => todayForStaff(tx, actor, parsed.data)),
    )
  })

  // «Kairós responde solo en los chats» (ADR 0189): el interruptor general, solo Administración.
  app.get("/sells", (c) =>
    runService(c, 200, () => {
      adminOf(c)
      return deps.ownerDb.transaction((tx) => getKairosSells(tx))
    }),
  )
  app.put("/sells", async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = sellsBody.safeParse(raw)
    return runService(c, 200, () => {
      const actor = adminOf(c)
      if (!parsed.success)
        throw new ServiceError("VALIDATION", 400, "Di si lo prendes o lo apagas", {
          enabled: "Di si lo prendes o lo apagas",
        })
      return deps.ownerDb.transaction((tx) => setKairosSells(tx, actor, parsed.data.enabled))
    })
  })

  // Una pasada a pedido (útil en local; en producción la corre el worker cada 5 min).
  app.post("/run", async (c) => {
    adminOf(c)
    const parsed = runBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      const { now, pass } = await deps.ownerDb.transaction(async (tx) => {
        const at = await dbNow(tx)
        return {
          now: at,
          pass: await kairosRulesPass(tx, at, {
            metaSignupAvailable: deps.metaSignupAvailable === true,
          }),
        }
      })
      // El modelo redacta fuera de la transacción de la pasada; nada se envía.
      const drafts = await draftPendingKairosItems(
        deps.ownerDb,
        writer,
        { limit: KAIROS_DRAFTS_PER_PASS },
        now,
      )
      const weekly = parsed.data.weekly ? await writeKairosWeekly(deps.ownerDb, writer, now) : null
      return {
        ...pass,
        drafted: drafts.drafted.length,
        draftsFailed: drafts.failed.length,
        // «plantilla» si el modelo no está configurado: lo redactado lo dice en su ítem.
        drafter: drafts.drafter,
        weekly: weekly ? { weekStart: weekly.row.weekStart, written: weekly.written } : null,
      }
    })
  })

  // «Mejorar con Kairós» en el editor de respuesta (ADR 0196): solo Administración, nunca envía.
  app.route(
    "/improve",
    createKairosImproveRoute({
      ownerDb: deps.ownerDb,
      ...(deps.kairos ? { kairos: deps.kairos } : {}),
    }),
  )

  return app
}
