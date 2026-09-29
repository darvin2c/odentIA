import {
  buildWebchatInbound,
  isOriginAllowed,
  type NormalizedInbound,
} from "@odentia/channels"
import { type Db, sendInboundMessage, withOrgContext } from "@odentia/db"
import { inboundEvent } from "@odentia/db/schema/crm"
import {
  checkWebchatRateLimit,
  createWebchatConnection,
  findPublicWebchatConnection,
  getWebchatConnection,
  issueWebchatSession,
  listWebchatConnections,
  listWebchatNew,
  pollWebchat,
  type PublicWebchatConnection,
  readWebchatSession,
  rotateWebchatSecret,
  setWebchatConnectionStatus,
  toWidgetConfig,
  updateWebchatConnection,
  ServiceError,
} from "@odentia/services"
import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

export interface WebchatPublicDeps {
  /** Rol owner: lookup de org/conexión por slug+id (sin RLS) y ledger/cola. */
  ownerDb: Db
  /** Rol app: polls dentro del contexto RLS de la org. */
  db: Db
  /** Cifrado de configs (el padre la inyecta igual que en CrmDeps). */
  secretsKey: Buffer
  /** Dominio base (`odentia.localhost`): orígenes `*.base` siempre aceptados. */
  cookieDomain: string
  remoteAddress?: (c: Context) => string | undefined
}

const WINDOW_MS = 60 * 1000
/** Ráfagas cortas de widget, no scraping. Clave: conexión + ip/sesión + op. */
const LIMITS = { session: 10, post: 30, poll: 120 } as const

function addressOf(deps: WebchatPublicDeps, c: Context): string {
  try {
    if (deps.remoteAddress) return deps.remoteAddress(c) ?? "shared"
    return getConnInfo(c).remote.address ?? "shared"
  } catch {
    return "shared"
  }
}

/** Origen aceptado: mismo tenant/plataforma o sitio en la allowlist. */
function originAccepted(cookieDomain: string, config: { allowedOrigins: string[] }, origin: string | null): boolean {
  if (!origin) return true
  let hostname = ""
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  const base = cookieDomain.toLowerCase()
  if (hostname === base || hostname.endsWith(`.${base}`)) return true
  return isOriginAllowed(config, origin)
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization")
  if (!header || !header.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length).trim()
  return token || null
}

const visitorMessageInput = z.object({
  clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  text: z.string().trim().min(1).max(2000),
  displayName: z.string().trim().max(80).optional(),
})

const pollQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/**
 * API pública del widget. Sin sesión: el visitante se autentica con el token
 * de sesión (alcance = su sesión, expiración 24 h). Aislamiento por
 * org (slug) + conexión (id) + origen permitido.
 *
 * Monta ANTES de los guards (como /api/webhooks): `padre: app.route("/api/webchat", ...)`.
 */
export function createWebchatPublicRoute(deps: WebchatPublicDeps) {
  const app = new Hono()

  app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "El mensaje excede el tamaño permitido"), 413) }))
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))

  // Preflight para sitios externos en la allowlist.
  app.options("/*", async (c) => {
    const origin = c.req.header("origin") ?? null
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Vary", "Origin")
    }
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    c.header("Access-Control-Allow-Headers", "authorization, content-type")
    c.header("Access-Control-Max-Age", "600")
    return c.body(null, 204)
  })

  async function resolve(
    c: Context,
  ): Promise<{ ok: true; found: PublicWebchatConnection } | { ok: false; response: Response }> {
    const slug = c.req.param("slug")
    const connectionId = c.req.param("connectionId")
    if (!slug || !connectionId) {
      return { ok: false, response: c.json(errorBody(c, "NOT_FOUND", "Chat no disponible"), 404) }
    }
    let found: PublicWebchatConnection
    try {
      found = await findPublicWebchatConnection(deps.ownerDb, deps.secretsKey, slug, connectionId)
    } catch (e) {
      if (e instanceof ServiceError) {
        return { ok: false, response: c.json(errorBody(c, e.code, "Chat no disponible"), e.status) }
      }
      throw e
    }
    const origin = c.req.header("origin") ?? null
    if (!originAccepted(deps.cookieDomain, found.config, origin)) {
      return { ok: false, response: c.json(errorBody(c, "FORBIDDEN", "Origen no permitido"), 403) }
    }
    return { ok: true, found }
  }

  // CORS restringido al origen verificado (no `*`: el token viaja en header).
  function cors(c: Context): void {
    const origin = c.req.header("origin")
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Vary", "Origin")
    }
  }

  app.get("/:slug/:connectionId/config", async (c) => {
    const resolved = await resolve(c)
    if (!resolved.ok) return resolved.response
    cors(c)
    const { found } = resolved
    return c.json({
      data: toWidgetConfig({ orgName: found.orgName, displayName: found.connection.displayName, config: found.config }),
    })
  })

  app.post("/:slug/:connectionId/session", async (c) => {
    const resolved = await resolve(c)
    if (!resolved.ok) return resolved.response
    cors(c)
    const rl = await checkWebchatRateLimit(
      deps.ownerDb,
      `webchat:session:${c.req.param("connectionId")}:${addressOf(deps, c)}`,
      LIMITS.session,
      WINDOW_MS,
    )
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfter))
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    return c.json({ data: issueWebchatSession(resolved.found.connection) }, 201)
  })

  app.post("/:slug/:connectionId/messages", async (c) => {
    const resolved = await resolve(c)
    if (!resolved.ok) return resolved.response
    cors(c)
    const token = bearerToken(c)
    if (!token) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    const parsed = visitorMessageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Revisa el mensaje"), 400)
    const { found } = resolved
    const verified = readWebchatSession(found.connection, token)
    if (!verified) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión inválida o vencida"), 401)
    const sessionId = verified.sessionId
    const rl = await checkWebchatRateLimit(
      deps.ownerDb,
      `webchat:post:${found.connection.id}:${sessionId}`,
      LIMITS.post,
      WINDOW_MS,
    )
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfter))
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    // Nunca vincular paciente por nombre/teléfono escrito: el displayName solo
    // nombra el contacto del canal al crearse (ver ingestInbound).
    const event: NormalizedInbound = buildWebchatInbound(sessionId, {
      clientMessageId: parsed.data.clientMessageId,
      text: parsed.data.text,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
    })
    // Ledger de dedupe + encolado en la MISMA transacción: si cae entre medias,
    // nada confirma y el visitante puede reintentar sin perder el mensaje.
    const duplicate = await deps.ownerDb.transaction(async (tx) => {
      const inserted = await tx
        .insert(inboundEvent)
        .values({ provider: "web_chat", externalEventId: event.externalEventId })
        .onConflictDoNothing()
        .returning({ id: inboundEvent.id })
      if (inserted.length === 0) return true
      // Misma tubería que el resto de canales: ingesta + agent_runs en el worker.
      await sendInboundMessage(tx, {
        orgId: found.orgId,
        connectionId: found.connection.id,
        event,
      })
      return false
    })
    if (duplicate) return c.json({ data: { duplicate: true } }, 200)
    return c.json({ data: { queued: true } }, 202)
  })

  app.get("/:slug/:connectionId/messages", async (c) => {
    const resolved = await resolve(c)
    if (!resolved.ok) return resolved.response
    cors(c)
    const token = bearerToken(c)
    if (!token) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    const query = pollQuery.safeParse(c.req.query())
    if (!query.success) return c.json(errorBody(c, "VALIDATION", "Parámetros inválidos"), 400)
    const { found } = resolved
    const verified = readWebchatSession(found.connection, token)
    if (!verified) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión inválida o vencida"), 401)
    const sessionId = verified.sessionId
    const rl = await checkWebchatRateLimit(
      deps.ownerDb,
      `webchat:poll:${found.connection.id}:${sessionId}`,
      LIMITS.poll,
      WINDOW_MS,
    )
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfter))
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    // Recién aquí lo `sent` pasa a `delivered`: el visitante lo recibió.
    const poll = await withOrgContext(deps.db, found.orgId, (tx) =>
      pollWebchat(tx, found.orgId, found.connection.id, sessionId, {
        ...(query.data.before ? { before: query.data.before } : {}),
        ...(query.data.limit ? { limit: query.data.limit } : {}),
      }),
    )
    return c.json({ data: poll })
  })

  // SSE autorizado por token en query (EventSource no envía headers).
  app.get("/:slug/:connectionId/stream", async (c) => {
    const resolved = await resolve(c)
    if (!resolved.ok) return resolved.response
    cors(c)
    const token = c.req.query("token") ?? ""
    const { found } = resolved
    const verified = readWebchatSession(found.connection, token)
    if (!verified) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión inválida o vencida"), 401)
    const sessionId = verified.sessionId
    return streamSSE(c, async (stream) => {
      let cursor: { ts: string; id: string } | null = null
      for (let tick = 0; tick < 27; tick += 1) {
        if (stream.aborted) break
        const page = await withOrgContext(deps.db, found.orgId, (tx) =>
          listWebchatNew(tx, found.orgId, found.connection.id, sessionId, cursor, 20),
        ).catch(() => null)
        if (page === null) break
        for (const item of page.items) {
          cursor = { ts: item.createdAt, id: item.id }
          await stream.writeSSE({
            event: "webchat.message",
            data: JSON.stringify({
              id: item.id,
              direction: item.direction,
              senderKind: item.senderKind,
              contentType: item.contentType,
              body: item.body,
              status: item.status,
              createdAt: item.createdAt,
            }),
          })
        }
        if (page.status === "closed") {
          await stream.writeSSE({ event: "webchat.closed", data: JSON.stringify({ closed: true }) })
          break
        }
        await stream.sleep(2000)
      }
    })
  })

  return app
}

const adminCreateInput = z.object({
  displayName: z.string().trim().min(1).max(120),
  allowedOrigins: z.array(z.string().trim().min(1)).min(1).max(50),
  widgetTitle: z.string().trim().max(80).optional(),
  widgetColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  greeting: z.string().trim().max(500).optional(),
  notifyUrl: z.string().url().optional(),
})

const adminPatchInput = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  allowedOrigins: z.array(z.string().trim().min(1)).min(1).max(50).optional(),
  widgetTitle: z.string().trim().max(80).optional(),
  widgetColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  greeting: z.string().trim().max(500).optional(),
  notifyUrl: z.string().url().optional(),
})

function configOf(data: z.infer<typeof adminPatchInput>): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (data.allowedOrigins !== undefined) config["allowedOrigins"] = data.allowedOrigins
  for (const key of ["widgetTitle", "widgetColor", "greeting", "notifyUrl"] as const) {
    if (data[key] !== undefined) config[key] = data[key]
  }
  return config
}

/**
 * Admin del chat web (sesión + membresía + `settings.read/write`).
 * Monta bajo guards: `padre: guarded.route("/channels/webchat", ...)`.
 */
export function createWebchatAdminRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listWebchatConnections(tx, orgId, deps.secretsKey)),
    )
  })

  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    const parsed = adminCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { displayName, ...rest } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createWebchatConnection(tx, orgId, deps.secretsKey, userId, { displayName, config: rest }, { fetch }),
      ),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getWebchatConnection(tx, orgId, deps.secretsKey, c.req.param("id"))),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    const parsed = adminPatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { displayName, ...rest } = parsed.data
    const patch: { displayName?: string; config?: unknown } = {}
    if (displayName !== undefined) patch.displayName = displayName
    if (Object.keys(rest).length > 0) {
      const current = await withOrgContext(deps.db, orgId, (tx) => getWebchatConnection(tx, orgId, deps.secretsKey, c.req.param("id")))
      patch.config = { ...current.config, ...configOf(rest) }
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateWebchatConnection(tx, orgId, deps.secretsKey, userId, c.req.param("id"), patch),
      ),
    )
  })

  app.post("/:id/enable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setWebchatConnectionStatus(tx, orgId, deps.secretsKey, c.req.param("id"), "active"),
      ),
    )
  })

  app.post("/:id/disable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setWebchatConnectionStatus(tx, orgId, deps.secretsKey, c.req.param("id"), "disabled"),
      ),
    )
  })

  // Revoca todas las sesiones de visitante (rotación del secreto HMAC).
  app.post("/:id/rotate", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        rotateWebchatSecret(tx, orgId, deps.secretsKey, userId, c.req.param("id")),
      ),
    )
  })

  return app
}
