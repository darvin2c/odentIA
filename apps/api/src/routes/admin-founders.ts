import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  type AdminActor,
  discardWaitlistRequest,
  FOUNDER_INVITATION_DAYS,
  founderInvitationEmail,
  founderOffer,
  getSignupMode,
  inviteFromWaitlist,
  listWaitlist,
  markInvitationSent,
  SAAS_WAITLIST_STATUSES,
  ServiceError,
  setSignupMode,
  setWaitlistNote,
} from "@odentia/services"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { runService, validationError } from "./helpers.js"

export interface AdminFoundersDeps {
  /** La lista de espera y la política de alta son de la plataforma: solo owner (migración 0028). */
  ownerDb: Db
  mailer: Mailer
  /** Origen del panel (`app.`): el enlace de la invitación lleva a crear la cuenta ahí. */
  panelURL: string
  /** Buzón que lee las respuestas (FOUNDERS_EMAIL). */
  replyTo?: string | undefined
}

function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support") throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de odentIA")
  return actor
}

/** Invitar, descartar y cambiar el alta es de la administración; soporte solo mira y anota. */
function adminOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo la administración de odentIA invita o descarta")
  return actor
}

const listQuery = z.object({
  status: z.enum([...SAAS_WAITLIST_STATUSES, "todas"]).optional(),
  q: z.string().trim().max(120).optional(),
})

/** «domingo 1 de noviembre», en UTC: el instante exacto lo dice el enlace. */
function dayText(date: Date): string {
  return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(date)
}

/**
 * Fundadores en la administración (`/api/admin/waitlist`, issue 165), tras el
 * guard de admin. Invitar devuelve el enlace (para copiarlo a WhatsApp) y,
 * con `send`, lo envía por correo después de confirmar la transacción: si el
 * correo falla, la invitación sigue vigente y la pantalla lo dice.
 */
export function createAdminFoundersRoute(deps: AdminFoundersDeps) {
  const app = new Hono()
  const invitationUrl = (token: string) => `${deps.panelURL.replace(/\/+$/, "")}/register?invitacion=${encodeURIComponent(token)}`

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    staffOf(c)
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => listWaitlist(tx, { status: parsed.data.status, search: parsed.data.q })),
    )
  })

  app.get("/signup-mode", (c) => {
    staffOf(c)
    return runService(c, 200, async () => ({ mode: await deps.ownerDb.transaction((tx) => getSignupMode(tx)) }))
  })

  app.put("/signup-mode", async (c) => {
    const parsed = z.strictObject({ mode: z.enum(["invitacion", "abierta"]) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => ({
      mode: await deps.ownerDb.transaction((tx) => setSignupMode(tx, adminOf(c), parsed.data.mode)),
    }))
  })

  app.put("/:id/note", async (c) => {
    const parsed = z.strictObject({ note: z.string().max(2000).nullable() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await deps.ownerDb.transaction((tx) => setWaitlistNote(tx, staffOf(c), c.req.param("id"), parsed.data.note))
      return { ok: true }
    })
  })

  app.post("/:id/discard", async (c) => {
    const parsed = z.strictObject({ reason: z.string().max(500) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await deps.ownerDb.transaction((tx) => discardWaitlistRequest(tx, adminOf(c), c.req.param("id"), parsed.data.reason))
      return { ok: true }
    })
  })

  /** Invita o reenvía (un enlace nuevo anula el anterior). `send: false` solo da el enlace para WhatsApp. */
  app.post("/:id/invite", async (c) => {
    const parsed = z
      .strictObject({ send: z.boolean().default(true), planId: z.uuid().optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const actor = adminOf(c)
    return runService(c, 200, async () => {
      const issued = await deps.ownerDb.transaction(async (tx) => {
        const result = await inviteFromWaitlist(tx, actor, c.req.param("id"), { planId: parsed.data.planId })
        const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, result.request.planId ?? "")).limit(1)
        if (!plan) throw new ServiceError("NOT_FOUND", 404, "Plan no encontrado")
        return { ...result, offer: await founderOffer(tx, plan) }
      })
      const url = invitationUrl(issued.token)
      let emailSent = false
      if (parsed.data.send) {
        try {
          await deps.mailer.send({
            to: issued.request.email,
            ...founderInvitationEmail({
              firstName: issued.request.firstName,
              clinicName: issued.request.clinicName,
              email: issued.request.email,
              url,
              expiresText: dayText(issued.expiresAt),
              offer: issued.offer,
              replyTo: deps.replyTo,
            }),
          })
          emailSent = true
          await deps.ownerDb.transaction((tx) => markInvitationSent(tx, issued.request.id)).catch(() => undefined)
        } catch {
          console.error(`Fundadores: no salió la invitación de la solicitud ${issued.request.id}`)
        }
      }
      return { url, expiresAt: issued.expiresAt, emailSent, validDays: FOUNDER_INVITATION_DAYS }
    })
  })

  return app
}
