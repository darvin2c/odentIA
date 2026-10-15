import { getConnInfo } from "@hono/node-server/conninfo"
import { registrationAnswersSchema } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import {
  cancelBookingLinkAppointment,
  changeBookingLinkAppointment,
  decideSaasPublicAccess,
  getBookingLinkView,
  listBookingLinkSlots,
  reserveBookingLink,
  getBookingLinkRegistrationForm,
  registerFromBookingLink,
  ServiceError,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { errorBody } from "../lib/error.js"

const WINDOW_MS = 10 * 60 * 1000
const MAX_BUCKETS = 10000
const token = z.string().regex(/^[0-9a-f]{64}$/)
const slotsQuery = z.strictObject({ token, branchId: z.uuid(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
const reserveBody = z.strictObject({
  token,
  branchId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  dentistUserId: z.string().min(1).max(200),
  chairId: z.uuid().optional(),
})
const registrationBody = z.strictObject({
  token,
  submissionId: z.uuid(),
  formVersion: z.number().int().nonnegative(),
  answers: registrationAnswersSchema,
})
export type BookingRemoteAddress = (c: Context) => string | undefined

/**
 * Página pública del enlace de reserva: quien tiene el enlace ve los horarios
 * libres y reserva su cita. Sin sesión; todo lo que puede hacer lo decide el
 * enlace. Límites locales de una instancia, sin confiar en cabeceras del cliente.
 */
export function createPublicBookingRoute(deps: { db: Db; secretsKey: Buffer; remoteAddress?: BookingRemoteAddress }) {
  const app = new Hono<{ Variables: { bookingOrganization: { id: string } } }>()
  const buckets = new Map<string, { expiresAt: number; get: number; post: number }>()
  const unavailable = (c: Context) => c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
  const address: BookingRemoteAddress =
    deps.remoteAddress ??
    ((c) => {
      try {
        return getConnInfo(c).remote.address
      } catch {
        return undefined
      }
    })
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  app.use("*", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "La solicitud excede el tamaño permitido"), 413) }))
  // Los errores inesperados no pasan al registro global: podrían llevar el enlace.
  app.onError((error, c) => {
    // Solo el tipo de error: el mensaje puede llevar la consulta y sus parámetros.
    console.error(`public-booking: ${error instanceof Error ? error.name : "error desconocido"}`)
    return c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500)
  })
  app.use("/:slug/*", limit)
  app.use("/:slug", limit)

  async function limit(c: Context, next: () => Promise<void>) {
    if (c.req.method !== "GET" && c.req.method !== "POST") return unavailable(c)
    const [org] = await deps.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, c.req.param("slug") ?? "")).limit(1)
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key)
    const key = `${org?.id ?? "unknown"}:${address(c) ?? "shared"}`
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
      bucket = { expiresAt: now + WINDOW_MS, get: 0, post: 0 }
      buckets.set(key, bucket)
    }
    const method = c.req.method === "POST" ? "post" : "get"
    if (bucket[method] >= (method === "post" ? 10 : 240)) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    bucket[method]++
    if (!org) return unavailable(c)
    c.set("bookingOrganization", org)
    await next()
  }

  const answer = async (c: Context, status: 200 | 201, run: () => Promise<unknown>) => {
    try {
      return c.json({ data: await run() }, status)
    } catch (error) {
      if (error instanceof ServiceError) {
        if (error.status === 404) return unavailable(c)
        console.error(`public-booking: rechazo ${error.code}: ${error.message.slice(0, 200)}`)
        return c.json(errorBody(c, error.code, error.message), error.status)
      }
      throw error
    }
  }

  app.get("/:slug", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    const org = c.get("bookingOrganization")
    return answer(c, 200, () => withOrgContext(deps.db, org.id, (tx) => getBookingLinkView(tx, org.id, query.data.token)))
  })

  app.get("/:slug/slots", async (c) => {
    const query = slotsQuery.safeParse(c.req.query())
    if (!query.success) return c.json(errorBody(c, "VALIDATION", "Revisa las fechas pedidas"), 400)
    const org = c.get("bookingOrganization")
    const { token: linkToken, ...range } = query.data
    return answer(c, 200, () => withOrgContext(deps.db, org.id, (tx) => listBookingLinkSlots(tx, org.id, linkToken, range)))
  })

  // Quien aún no es paciente deja aquí sus datos esenciales: la ficha la crea el registro de pacientes.
  app.get("/:slug/registration", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    const org = c.get("bookingOrganization")
    return answer(c, 200, () => withOrgContext(deps.db, org.id, (tx) => getBookingLinkRegistrationForm(tx, org.id, query.data.token)))
  })

  app.post("/:slug/registration", async (c) => {
    const body = registrationBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tus datos"), 400)
    const org = c.get("bookingOrganization")
    const { token: linkToken, ...input } = body.data
    return answer(c, 201, () => withOrgContext(deps.db, org.id, (tx) => registerFromBookingLink(tx, org.id, linkToken, input)))
  })

  app.post("/:slug/reserve", async (c) => {
    const body = reserveBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa el horario elegido"), 400)
    const org = c.get("bookingOrganization")
    const { token: linkToken, ...choice } = body.data
    return answer(c, 201, () =>
      withOrgContext(deps.db, org.id, async (tx) => {
        // Reservar nuevo se deniega en restricción/pausa (el paciente conserva
        // cambiar o cancelar lo ya reservado). Sin fila comercial: pasa.
        const access = await decideSaasPublicAccess(tx, org.id, "reservar")
        if (!access.allowed) {
          throw new ServiceError(
            "SAAS_RESTRICTED",
            403,
            "La clínica pausó las reservas en línea: escribinos por otro canal",
          )
        }
        return reserveBookingLink(
          tx,
          org.id,
          linkToken,
          { branchId: choice.branchId, startsAt: choice.startsAt, dentistUserId: choice.dentistUserId, ...(choice.chairId ? { chairId: choice.chairId } : {}) },
          { secretsKey: deps.secretsKey },
        )
      }),
    )
  })

  // Con la cita ya reservada, el mismo enlace la cambia de horario o la cancela mientras no haya empezado.
  app.post("/:slug/change", async (c) => {
    const body = reserveBody.omit({ branchId: true }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa el horario elegido"), 400)
    const org = c.get("bookingOrganization")
    const { token: linkToken, ...choice } = body.data
    return answer(c, 200, () =>
      withOrgContext(deps.db, org.id, (tx) =>
        changeBookingLinkAppointment(
          tx,
          org.id,
          linkToken,
          { startsAt: choice.startsAt, dentistUserId: choice.dentistUserId, ...(choice.chairId ? { chairId: choice.chairId } : {}) },
          { secretsKey: deps.secretsKey },
        ),
      ),
    )
  })

  app.post("/:slug/cancel", async (c) => {
    const body = z.strictObject({ token }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) return unavailable(c)
    const org = c.get("bookingOrganization")
    return answer(c, 200, () =>
      withOrgContext(deps.db, org.id, (tx) => cancelBookingLinkAppointment(tx, org.id, body.data.token, { secretsKey: deps.secretsKey })),
    )
  })

  // Terminal: nunca continuar hacia requireSession ni ampliar excepciones a otros /api/*.
  app.all("*", unavailable)
  return app
}
