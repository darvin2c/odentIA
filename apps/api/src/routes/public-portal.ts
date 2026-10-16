import { type Db, withOrgContext } from "@odentia/db"
import {
  confirmPortalAppointment,
  decidePortalBudget,
  exchangePortalToken,
  getPortalAccount,
  getPortalQuestionnaire,
  getPortalAppointments,
  getPortalDocumentUrl,
  getPortalRescheduleSlots,
  getPortalSessionInfo,
  listPortalBudgets,
  listPortalDocuments,
  requirePortalSession,
  reschedulePortalAppointment,
  resolvePortalOrgByLinkToken,
  resolvePortalOrgBySessionToken,
  revokePortalSession,
  savePortalQuestionnaire,
  ServiceError,
  type PortalContext,
  type Storage,
  getPortalPolicy, createPublicPortalRequest, listMyPortalGrants, selectPortalGrant,
  createPasskeyRegistrationOptions, verifyPasskeyRegistration,
  createPasskeyAuthOptions, verifyPasskeyAuth,
  recordPortalPinFailure,
} from "@odentia/services"
import { getConnInfo } from "@hono/node-server/conninfo"
import { bodyLimit } from "hono/body-limit"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"
import { portalOrigin, portalOrganization } from "../lib/portal-origin.js"
import { portalSlugInput } from "./portal-input.js"

const exchangeInput = z.strictObject({ token: z.string().min(1).max(256), pin: z.string().regex(/^\d{6}$/) })
const rescheduleInput = z.strictObject({
  expectedVersion: z.number().int().min(1),
  startsAt: z.string().min(1).max(64),
})
const decisionLineInput = z.strictObject({
  planItemId: z.uuid(),
  decision: z.enum(["aceptado", "rechazado", "pospuesto"]),
})
const decisionInput = z.strictObject({
  decisions: z.array(decisionLineInput).min(1).max(200),
  decisionNote: z.string().trim().min(1).max(2000).nullish(),
})

const WINDOW_MS = 10 * 60 * 1000
const MAX_BUCKETS = 10000

/**
 * API pública del portal del paciente (sin sesión staff). El token de enlace
 * resuelve el tenant vía ownerDb (patrón de enlaces públicos); cada llamada
 * con sesión valida revocación/expiración en DB. Sin caché, sin PII en logs.
 * El padre monta en `/api/public/portal`.
 */
export function createPublicPortalRoute(deps: {
  db: Db
  ownerDb: Db
  storage: Pick<Storage, "attachmentUrl">
  webURL: string
  cookieDomain: string
  remoteAddress?: (c: Context) => string | undefined
}) {
  const app = new Hono()
  const buckets = new Map<string, { expiresAt: number; count: number }>()
  const unavailable = (c: Context) => c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
  const address = deps.remoteAddress ?? ((c: Context) => {
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
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "La solicitud excede el tamaño permitido"), 413),
    }),
  )
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))

  function limited(c: Context, key: string, max: number): boolean {
    const now = Date.now()
    for (const [bucketKey, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(bucketKey)
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) return true
      bucket = { expiresAt: now + WINDOW_MS, count: 0 }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    if (bucket.count > max) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return true
    }
    return false
  }

  function sessionTokenOf(c: Context): string | null {
    const header = c.req.header("authorization")
    if (header?.startsWith("Bearer ")) {
      const value = header.slice("Bearer ".length).trim()
      if (value) return value
    }
    const query = c.req.query("session")
    return query && query.length <= 256 ? query : null
  }

  async function portalCall<T>(
    c: Context,
    fn: (tx: Db, ctx: PortalContext) => Promise<T>,
  ): Promise<Response> {
    const raw = sessionTokenOf(c)
    if (!raw) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión del portal requerida"), 401)
    const orgId = await resolvePortalOrgBySessionToken(deps.ownerDb, raw)
    if (!orgId) return unavailable(c)
    if (limited(c, `${orgId}:${address(c) ?? "shared"}`, 300)) {
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    try {
      const data = await withOrgContext(deps.db, orgId, async (tx) => {
        const ctx = await requirePortalSession(tx, orgId, raw)
        return fn(tx, ctx)
      })
      return c.json({ data }, 200)
    } catch (error) {
      if (error instanceof ServiceError && error.code === "PORTAL_FORBIDDEN") {
        return unavailable(c)
      }
      return serviceErrorResponse(c, error) ?? Promise.reject(error)
    }
  }

  function publicLimited(c: Context): Response | null {
    const policyRead = c.req.method === "GET"
    return limited(c, `${policyRead ? "policy" : "access"}:${address(c) ?? "shared"}`, policyRead ? 120 : 30)
      ? c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429) : null
  }

  function rpFor(org: { slug: string | null; name: string }) {
    if (!org.slug) throw new ServiceError("NOT_FOUND", 404, "Organización no disponible")
    const expectedOrigin = portalOrigin(deps, org.slug)
    return { rpID: new URL(expectedOrigin).hostname, rpName: org.name, expectedOrigin }
  }

  app.get("/policy", async c => {
    const throttled = publicLimited(c)
    if (throttled) return throttled
    const parsed = portalSlugInput.safeParse(c.req.query("orgSlug"))
    const org = parsed.success ? await portalOrganization(deps.ownerDb, parsed.data) : null
    if (!org) return c.json({ data: { enabled: false, requestsEnabled: false, passkeysEnabled: false } })
    return runService(c, 200, () => withOrgContext(deps.db, org.id, async tx => {
      const policy = await getPortalPolicy(tx, org.id)
      return { enabled: policy.enabled, requestsEnabled: policy.enabled && policy.requestsEnabled && policy.publicRequestsEnabled, passkeysEnabled: policy.enabled && policy.passkeysEnabled, orgName: org.name }
    }))
  })

  app.post("/requests", async c => {
    const throttled = publicLimited(c)
    if (throttled) return throttled
    const parsed = z.strictObject({
      orgSlug: portalSlugInput, contactName: z.string().trim().min(1).max(200),
      contactText: z.string().trim().min(1).max(300), patientHint: z.string().trim().max(300).optional(),
      idempotencyKey: z.string().trim().min(8).max(128).optional(),
    }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const org = await portalOrganization(deps.ownerDb, parsed.data.orgSlug)
    if (!org) return c.json({ data: { received: true } })
    return runService(c, 200, () => withOrgContext(deps.db, org.id, tx => createPublicPortalRequest(tx, org.id, parsed.data)))
  })

  app.post("/passkeys/register/options", async c => {
    const parsed = z.strictObject({ orgSlug: portalSlugInput }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const org = await portalOrganization(deps.ownerDb, parsed.data.orgSlug)
    if (!org) return unavailable(c)
    return portalCall(c, (tx, ctx) => {
      if (ctx.orgId !== org.id) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Acceso no disponible")
      return createPasskeyRegistrationOptions(tx, ctx, rpFor(org))
    })
  })

  const passkeyVerifyInput = z.strictObject({
    orgSlug: portalSlugInput, challengeId: z.uuid(), response: z.record(z.string(), z.unknown()),
  })
  app.post("/passkeys/register/verify", async c => {
    const parsed = passkeyVerifyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const org = await portalOrganization(deps.ownerDb, parsed.data.orgSlug)
    if (!org) return unavailable(c)
    return portalCall(c, (tx, ctx) => {
      if (ctx.orgId !== org.id) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Acceso no disponible")
      return verifyPasskeyRegistration(tx, ctx, parsed.data.challengeId, parsed.data.response, rpFor(org))
    })
  })

  app.post("/passkeys/auth/options", async c => {
    const throttled = publicLimited(c)
    if (throttled) return throttled
    const parsed = z.strictObject({ orgSlug: portalSlugInput }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const org = await portalOrganization(deps.ownerDb, parsed.data.orgSlug)
    if (!org) return unavailable(c)
    return runService(c, 200, () => withOrgContext(deps.db, org.id, tx => createPasskeyAuthOptions(tx, org.id, rpFor(org))))
  })

  app.post("/passkeys/auth/verify", async c => {
    const throttled = publicLimited(c)
    if (throttled) return throttled
    const parsed = passkeyVerifyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const org = await portalOrganization(deps.ownerDb, parsed.data.orgSlug)
    if (!org) return unavailable(c)
    return runService(c, 200, () => withOrgContext(deps.db, org.id, tx => verifyPasskeyAuth(tx, org.id, parsed.data.challengeId, parsed.data.response, rpFor(org))))
  })

  app.get("/grants", c => portalCall(c, (tx, ctx) => listMyPortalGrants(tx, ctx)))
  app.post("/grants/select", async c => {
    const parsed = z.strictObject({ grantId: z.uuid() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return portalCall(c, (tx, ctx) => selectPortalGrant(tx, ctx, parsed.data.grantId))
  })

  app.post("/exchange", async (c) => {
    if (limited(c, `exchange:${address(c) ?? "shared"}`, 10)) {
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    const parsed = exchangeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return unavailable(c)
    const orgId = await resolvePortalOrgByLinkToken(deps.ownerDb, parsed.data.token)
    if (!orgId) return unavailable(c)
    return runService(c, 200, async () => {
      try {
        return await withOrgContext(deps.db, orgId, tx => exchangePortalToken(tx, orgId, parsed.data.token, { pin: parsed.data.pin }))
      } catch (error) {
        // Registrar tras el rollback: el intento fallido no debe desaparecer ni bloquear otra transacción.
        if (error instanceof ServiceError && error.code === "PORTAL_PIN_INVALID") {
          await withOrgContext(deps.db, orgId, tx => recordPortalPinFailure(tx, orgId, parsed.data.token))
        }
        throw error
      }
    })
  })

  app.get("/session", async (c) => portalCall(c, (tx, ctx) => getPortalSessionInfo(tx, ctx)))

  app.get("/appointments", async (c) => portalCall(c, (tx, ctx) => getPortalAppointments(tx, ctx)))

  app.get("/appointments/:id/slots", async (c) => {
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const query = z
      .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
      .safeParse(c.req.query())
    if (!query.success) return validationError(c, query.error.issues)
    return portalCall(c, (tx, ctx) =>
      getPortalRescheduleSlots(tx, ctx, params.data.id, { from: query.data.from, to: query.data.to }),
    )
  })

  app.post("/appointments/:id/confirm", async (c) => {
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return portalCall(c, (tx, ctx) => confirmPortalAppointment(tx, ctx, params.data.id))
  })

  app.post("/appointments/:id/reschedule", async (c) => {
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = rescheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return portalCall(c, (tx, ctx) => reschedulePortalAppointment(tx, ctx, params.data.id, parsed.data))
  })

  app.get("/budgets", async (c) => portalCall(c, (tx, ctx) => listPortalBudgets(tx, ctx)))

  app.post("/budgets/:id/decision", async (c) => {
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = decisionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return portalCall(c, (tx, ctx) => decidePortalBudget(tx, ctx, params.data.id, parsed.data))
  })

  app.get("/documents", async (c) => portalCall(c, (tx, ctx) => listPortalDocuments(tx, ctx)))

  app.get("/documents/:id/url", async (c) => {
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return portalCall(c, (tx, ctx) => getPortalDocumentUrl(tx, ctx, params.data.id, deps.storage))
  })

  app.get("/account", async (c) => portalCall(c, (tx, ctx) => getPortalAccount(tx, ctx)))

  // Cuestionario previo a la cita: lo responde quien tiene la sesión.
  app.get("/questionnaire", async (c) => portalCall(c, (tx, ctx) => getPortalQuestionnaire(tx, ctx)))
  app.put("/questionnaire", async (c) => {
    const parsed = z
      .object({ answers: z.record(z.string(), z.unknown()), submit: z.boolean().optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return portalCall(c, (tx, ctx) => savePortalQuestionnaire(tx, ctx, parsed.data))
  })

  app.post("/session/revoke", async (c) =>
    portalCall(c, async (tx, ctx) => {
      await revokePortalSession(tx, ctx.orgId, null, ctx.session.id)
      return { revoked: true }
    }),
  )

  app.all("*", unavailable)
  return app
}
