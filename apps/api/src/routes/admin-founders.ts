import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  type AdminActor,
  discardWaitlistRequest,
  FOUNDER_INVITATION_DAYS,
  founderInvitationEmail,
  founderOffer,
  getSignupModes,
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
  /** Origen del panel (`app.`) de cada producto: la invitación lleva a crear la cuenta en el de su solicitud. */
  panelUrlOf: (product: ClinicalProduct) => string
  /** Buzón que lee las respuestas (FOUNDERS_EMAIL). */
  replyTo?: string | undefined
}

function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support") throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de la administración")
  return actor
}

/** Invitar, descartar y cambiar el alta es de la administración; soporte solo mira y anota. */
function adminOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración invita o descarta")
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
  const invitationUrl = (token: string, product: ClinicalProduct) =>
    `${deps.panelUrlOf(product).replace(/\/+$/, "")}/register?invitacion=${encodeURIComponent(token)}`

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    staffOf(c)
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => listWaitlist(tx, { status: parsed.data.status, search: parsed.data.q })),
    )
  })

  // Cómo se abren las clínicas de cada producto (ADR 0093).
  app.get("/signup-mode", (c) => {
    staffOf(c)
    return runService(c, 200, async () => ({ modes: await deps.ownerDb.transaction((tx) => getSignupModes(tx)) }))
  })

  app.put("/signup-mode", async (c) => {
    const parsed = z
      .strictObject({
        mode: z.enum(["invitacion", "abierta"], { error: "Elige cómo se abren las clínicas" }),
        product: z.enum(CLINICAL_PRODUCTS, { error: "Elige el producto" }).default("dental"),
      })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => ({
      mode: await deps.ownerDb.transaction((tx) => setSignupMode(tx, adminOf(c), parsed.data.mode, parsed.data.product)),
    }))
  })

  app.put("/:id/note", async (c) => {
    const parsed = z
      .strictObject({ note: z.string().max(2000, "La nota puede tener como máximo 2000 caracteres").nullable() })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await deps.ownerDb.transaction((tx) => setWaitlistNote(tx, staffOf(c), c.req.param("id"), parsed.data.note))
      return { ok: true }
    })
  })

  app.post("/:id/discard", async (c) => {
    const parsed = z
      .strictObject({ reason: z.string().trim().min(1, "Escribe por qué se descarta").max(500, "Usa como máximo 500 caracteres") })
      .safeParse(await c.req.json().catch(() => null))
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
      const url = invitationUrl(issued.token, issued.request.product)
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
              brand: productWords(issued.request.product).brand,
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
