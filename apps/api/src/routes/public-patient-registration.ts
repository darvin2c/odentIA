import { registrationAnswersSchema } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { chatPrivacyNotice, findOrgLocale, getPublicPatientRegistration, RegistrationHeld, registerPatient, ServiceError } from "@odentia/services"
import { getConnInfo } from "@hono/node-server/conninfo"
import { eq } from "drizzle-orm"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { errorBody } from "../lib/error.js"
import { keepRegistrationHold } from "../lib/registration-hold.js"

const submissionSchema = z.strictObject({
  submissionId: z.uuid(), formVersion: z.number().int().nonnegative(), token: z.string().max(256).optional(),
  entryPoint: z.enum(["qr", "public_link"]), answers: registrationAnswersSchema,
})
const WINDOW_MS = 10 * 60 * 1000
const MAX_BUCKETS = 10000
export type RegistrationRemoteAddress = (c: Context) => string | undefined

/** Límites locales de una instancia; no se confía en cabeceras reenviadas por el cliente. */
export function createPublicPatientRegistrationRoute(deps: { db: Db; remoteAddress?: RegistrationRemoteAddress }) {
  const app = new Hono<{ Variables: { registrationOrganization: { id: string; name: string; logo: string | null } } }>()
  const buckets = new Map<string, { expiresAt: number; get: number; post: number }>()
  const unavailable = (c: Context) => c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
  const address: RegistrationRemoteAddress = deps.remoteAddress ?? (c => {
    try { return getConnInfo(c).remote.address } catch { return undefined }
  })
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: c => c.json(errorBody(c, "BODY_TOO_LARGE", "El formulario excede el tamaño permitido"), 413) }))
  // No trasladar errores inesperados al logger global: podrían contener SQL y respuestas clínicas.
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))
  // El registro y su aviso de privacidad pasan por el mismo límite por clínica y dirección.
  const limited: MiddlewareHandler<{ Variables: { registrationOrganization: { id: string; name: string; logo: string | null } } }, "/:slug"> = async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "POST") return unavailable(c)
    const [org] = await deps.db.select({ id: organization.id, name: organization.name, logo: organization.logo }).from(organization).where(eq(organization.slug, c.req.param("slug"))).limit(1)
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key)
    const key = `${org?.id ?? "unknown"}:${address(c) ?? "shared"}`
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        const earliest = Math.min(...Array.from(buckets.values(), b => b.expiresAt))
        c.header("Retry-After", String(Math.max(1, Math.ceil((earliest - now) / 1000))))
        return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
      }
      bucket = { expiresAt: now + WINDOW_MS, get: 0, post: 0 }
      buckets.set(key, bucket)
    }
    const method = c.req.method === "POST" ? "post" : "get"
    if (bucket[method] >= (method === "post" ? 10 : 120)) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    bucket[method]++
    if (!org) return unavailable(c)
    c.set("registrationOrganization", org)
    await next()
  }
  app.use("/:slug", limited)
  app.use("/:slug/aviso", limited)
  app.get("/:slug", async c => {
    const query = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    const org = c.get("registrationOrganization")
    try {
      // El formato regional de la clínica: la página pública escribe fechas como en la clínica.
      const result = await withOrgContext(deps.db, org.id, async tx => ({
        ...(await getPublicPatientRegistration(tx, org.id, query.data.token)),
        region: await findOrgLocale(tx, org.id),
      }))
      const { region, ...rest } = result
      return c.json({ data: { organization: { name: org.name, logo: org.logo }, locale: region.locale, timeZone: region.timezone, ...rest } })
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) return unavailable(c)
      throw error
    }
  })
  app.post("/:slug", async c => {
    const body = await c.req.json().catch(() => null)
    const parsed = submissionSchema.safeParse(body)
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Revisa los datos del formulario"), 400)
    const org = c.get("registrationOrganization")
    try {
      const { token, entryPoint, ...input } = parsed.data
      await withOrgContext(deps.db, org.id, tx => registerPatient(tx, org.id, { kind: "public", token, entryPoint }, input))
      return c.json({ data: { registered: true } }, 201)
    } catch (error) {
      // Se parece a alguien que ya está (su documento o su celular): queda para que
      // recepción decida y se responde igual que un registro recibido, sin decir de quién era.
      if (error instanceof RegistrationHeld) {
        await keepRegistrationHold(deps.db, org.id, error)
        return c.json({ data: { registered: true } }, 201)
      }
      if (error instanceof ServiceError) {
        if (error.status === 404) return unavailable(c)
        return c.json(errorBody(c, error.code, error.message), error.status)
      }
      throw error
    }
  })
  // El aviso de privacidad que se enlaza desde el chat (ADR 0099): el mismo texto del
  // registro, leído aunque el registro en línea esté apagado. Sin aviso escrito, no hay página.
  app.get("/:slug/aviso", async c => {
    const org = c.get("registrationOrganization")
    const notice = await withOrgContext(deps.db, org.id, tx => chatPrivacyNotice(tx, org.id))
    if (!notice) return unavailable(c)
    return c.json({ data: { organization: { name: org.name, logo: org.logo }, notice: notice.text, version: notice.version } })
  })
  // Terminal: nunca continuar hacia requireSession ni ampliar excepciones a otros /api/*.
  app.all("*", unavailable)
  return app
}
