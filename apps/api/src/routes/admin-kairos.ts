import { fakeKairosWriter } from "@odentia/agent"
import type { Db } from "@odentia/db"
import type { KairosItemStatus } from "@odentia/db/schema/admin-arm"
import type { MailBrand, Mailer } from "@odentia/mail"
import {
  type AdminActor,
  assignInboundEmail,
  createSaasProposal,
  decideKairosItem,
  draftPendingKairosItems,
  KAIROS_DRAFTS_PER_PASS,
  type KairosDraftWriter,
  type KairosExecutors,
  type KairosWeeklyWriter,
  kairosDonePage,
  kairosRulesPass,
  linkContactToUser,
  listKairosItems,
  markOutreachSent,
  type OutreachEmail,
  type OutreachRow,
  outreachEmail,
  prepareEmailReply,
  prepareOutreach,
  recordPresentation,
  ServiceError,
  settleKairosOutreach,
  todayForStaff,
  updateClient,
  writeKairosWeekly,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Kairós en la administración (`/api/admin/kairos`, el ARM; ADR 0185): lo
 * que espera un sí, aprobar o descartar, «Lo que hizo», Hoy y el número del
 * menú. Kairós nunca envía ni decide solo: aprobar ejecuta la misma operación
 * de la pantalla (`KairosExecutors` con las funciones reales de venta,
 * clientes y correos) y, si es un correo, la ruta lo envía después
 * del commit como cualquier envío: queda `enviado` o `incierto`, nunca se
 * reintenta. Un WhatsApp aprobado devuelve su enlace y queda pendiente hasta
 * que la persona dice «Salió» o «No salió».
 */
export interface AdminKairosDeps {
  /** Las tablas del ARM viven en `admin`, sin GRANT a la app: solo la conexión propietaria. */
  ownerDb: Db
  mailer: Mailer
  /**
   * El escritor de Kairós con modelo (`createKairosWriter` de `@odentia/agent`);
   * sin él, el doble determinista (`fakeKairosWriter`), sin gasto.
   */
  kairos?: KairosDraftWriter & KairosWeeklyWriter
  /** El buzón que lee las respuestas de cada marca; sin él, contacto@ del dominio del producto. */
  replyToOf?: (brand: MailBrand) => string | undefined
}

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
function executorsAt(now: Date): KairosExecutors<OutreachRow> {
  return {
    prepareOutreach: (tx, actor, clientId, input) =>
      prepareOutreach(tx, actor, clientId, input, now),
    updateClient: (tx, actor, clientId, patch) => updateClient(tx, actor, clientId, patch),
    linkContactToUser: (tx, actor, contactId, userId) =>
      linkContactToUser(tx, actor, contactId, userId),
    assignInboundEmail: (tx, actor, emailId, clientId) =>
      assignInboundEmail(tx, actor, emailId, clientId, now),
    prepareEmailReply: (tx, actor, emailId, input) =>
      prepareEmailReply(tx, actor, emailId, input, now),
    recordPresentation: (tx, actor, taskId, input) =>
      recordPresentation(tx, actor, taskId, input, now),
    createProposal: (tx, actor, clientId, input) =>
      createSaasProposal(tx, actor, clientId, input, now),
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
  deps: Pick<AdminKairosDeps, "ownerDb" | "mailer" | "replyToOf">,
  actor: AdminActor,
  outreachId: string,
  email: OutreachEmail,
): Promise<KairosEmailOutcome> {
  let sent = false
  try {
    await deps.mailer.send({
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: deps.replyToOf?.(email.brand) ?? email.replyTo,
      brand: email.brand,
      attachments: email.attachments,
    })
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
    let decided: Awaited<ReturnType<typeof decideKairosItem<OutreachRow>>>
    let email: OutreachEmail | null = null
    try {
      const done = await deps.ownerDb.transaction(async (tx) => {
        const decision = await decideKairosItem(tx, actor, id, parsed.data, executorsAt(now), now)
        // El correo se arma dentro: si no se puede (la propuesta no sale en PDF), no queda nada a medias.
        const mail =
          decision.outreach?.channel === "correo"
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
    const { outreach, ...decision } = decided
    if (!outreach) return c.json({ data: { ...decision, outreach: null, emailSent: null } })
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

  // Una pasada a pedido (útil en local; en producción la corre el worker cada 5 min).
  app.post("/run", async (c) => {
    adminOf(c)
    const parsed = runBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      const { now, pass } = await deps.ownerDb.transaction(async (tx) => {
        const at = await dbNow(tx)
        return { now: at, pass: await kairosRulesPass(tx, at) }
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

  return app
}
