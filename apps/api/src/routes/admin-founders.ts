import { type ClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  type AdminActor,
  addWaitlistFollowUp,
  discardWaitlistRequest,
  FOUNDER_INVITATION_DAYS,
  founderInvitationEmail,
  founderOffer,
  getWaitlistRequest,
  hideWaitlistFollowUp,
  inviteFromWaitlist,
  markInvitationSent,
  ServiceError,
} from "@odentia/services"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { runService, validationError } from "./helpers.js"

export interface AdminFoundersDeps {
  /** Las solicitudes son de la plataforma: solo owner (migración 0028). */
  ownerDb: Db
  mailer: Mailer
  /** Origen del panel (`app.`) de cada producto: la invitación lleva a crear la cuenta en el de su solicitud. */
  panelUrlOf: (product: ClinicalProduct) => string
  /** A dónde responde la clínica la invitación: hola@ de la marca de su solicitud. */
  replyToOf?: (product: ClinicalProduct) => string | undefined
}

function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support") throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de la administración")
  return actor
}

/** Invitar y descartar es de la administración; soporte solo mira y anota. */
function adminOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración invita o descarta")
  return actor
}

/** Lo que se anota en el seguimiento: la regla de cada dato la dice el servicio (`addWaitlistFollowUp`). */
const followUpBody = z.strictObject({
  body: z.string({ error: "Escribe qué pasó" }).max(2000, "Usa como máximo 2000 caracteres"),
  followUpOn: z.string().nullable().optional(),
  adminOnly: z.boolean().optional(),
})

/** «domingo 1 de noviembre», en UTC: el instante exacto lo dice el enlace. */
function dayText(date: Date): string {
  return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(date)
}

/**
 * Las solicitudes del ARM en la administración (`/api/admin/waitlist`), tras el
 * guard de admin. Ya no llegan de la web (ADR 0221): quedan las que ya estaban y
 * las que crea el equipo al invitar a un cliente desde su venta. Invitar devuelve el enlace (para copiarlo a WhatsApp) y,
 * con `send`, lo envía por correo después de confirmar la transacción: si el
 * correo falla, la invitación sigue vigente y la pantalla lo dice.
 */
export function createAdminFoundersRoute(deps: AdminFoundersDeps) {
  const app = new Hono()
  const invitationUrl = (token: string, product: ClinicalProduct) =>
    `${deps.panelUrlOf(product).replace(/\/+$/, "")}/register?invitacion=${encodeURIComponent(token)}`

  // Una solicitud con su seguimiento, para su cajón: no depende del filtro de la lista.
  app.get("/:id", (c) => {
    const actor = staffOf(c)
    return runService(c, 200, () => deps.ownerDb.transaction((tx) => getWaitlistRequest(tx, actor, c.req.param("id"))))
  })

  /** Anota un contacto (soporte también) y, si hay que volver, el día. */
  app.post("/:id/follow-ups", async (c) => {
    const parsed = followUpBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const actor = staffOf(c)
    return runService(c, 201, () => deps.ownerDb.transaction((tx) => addWaitlistFollowUp(tx, actor, c.req.param("id"), parsed.data)))
  })

  /**
   * Ocultar una entrada a soporte es de la administración, y no se deshace. El
   * rol lo revisa el servicio, con su propio motivo («Solo el rol
   * Administración oculta una entrada a soporte»), no el de invitar o descartar.
   */
  app.post("/follow-ups/:entryId/hide", (c) => {
    const actor = staffOf(c)
    return runService(c, 200, async () => {
      await deps.ownerDb.transaction((tx) => hideWaitlistFollowUp(tx, actor, c.req.param("entryId")))
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
              replyTo: deps.replyToOf?.(issued.request.product),
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
