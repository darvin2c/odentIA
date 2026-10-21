import { buildWebchatInbound, isWebchatTestSession, type NormalizedInbound, normalizeOrigin } from "@odentia/channels"
import { type Db, sendInboundMessage, withOrgContext } from "@odentia/db"
import { inboundEvent } from "@odentia/db/schema/crm"
import {
  admitWebchatSite,
  checkWebchatRateLimit,
  decideWebchatSite,
  deleteWebchatTest,
  findClinicWebchat,
  getClinicWebchat,
  openWebchatSession,
  openWebchatTest,
  peekClinicWebchat,
  pollWebchatVisitor,
  type PublicWebchat,
  readVisitorSession,
  readWebchatSiteTicket,
  rotateClinicWebchatSecret,
  saveWebchatVisitorContact,
  ServiceError,
  setClinicWebchatActive,
  updateClinicWebchat,
  webchatAppearance,
  webchatFrameAncestors,
  webchatSigningCode,
  webchatSiteTicket,
} from "@odentia/services"
import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

export interface WebchatPublicDeps {
  /** Rol owner: la clínica por su dirección (sin RLS) y el libro de duplicados y la cola. */
  ownerDb: Db
  /** Rol app: lo demás, dentro del contexto RLS de la clínica. */
  db: Db
  secretsKey: Buffer
  /**
   * La dirección real del visitante (`CLIENT_IP_HEADER` detrás del túnel). Sin
   * ella, la de la conexión: detrás del túnel todos compartirían el límite.
   */
  remoteAddress?: (c: Context) => string | undefined
}

const WINDOW_MS = 60 * 1000
/** Ráfagas cortas de widget, no scraping. Clave: clínica + ip/sesión + op. */
const LIMITS = { site: 60, session: 10, post: 30, poll: 120, contact: 10 } as const
const UNAVAILABLE = "No disponible"

function addressOf(deps: WebchatPublicDeps, c: Context): string {
  try {
    if (deps.remoteAddress) return deps.remoteAddress(c) ?? "shared"
    return getConnInfo(c).remote.address ?? "shared"
  } catch {
    return "shared"
  }
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
})

const sessionInput = z.object({ site: z.string().trim().min(1).max(300), ticket: z.string().trim().min(1).max(1000) })

const contactInput = z.object({
  whatsapp: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(320).nullish(),
})

/**
 * API pública del chat web (fase 6 del pulido de la Bandeja). Un chat por
 * clínica: se nombra por su dirección (`/api/webchat/<clínica>/…`), sin ids.
 * El visitante se autentica con el token de su sesión (30 días, solo su
 * conversación). Lo que recibe no trae nada interno (`pollWebchatVisitor`).
 *
 * Monta ANTES de los guards (como /api/webhooks).
 */
export function createWebchatPublicRoute(deps: WebchatPublicDeps) {
  const app = new Hono()

  app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "El mensaje excede el tamaño permitido"), 413) }))
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))

  async function resolve(c: Context): Promise<PublicWebchat | null> {
    const slug = c.req.param("slug")
    return slug ? findClinicWebchat(deps.ownerDb, deps.secretsKey, slug) : null
  }

  /**
   * Cualquier sitio puede preguntar (lo decide `admitWebchatSite`), sin
   * credenciales: el token viaja en la cabecera, nunca en una cookie.
   */
  function cors(c: Context): void {
    const origin = c.req.header("origin")
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Vary", "Origin")
    }
  }

  async function limited(c: Context, key: string, max: number): Promise<Response | null> {
    const rl = await checkWebchatRateLimit(deps.ownerDb, key, max, WINDOW_MS)
    if (rl.allowed) return null
    c.header("Retry-After", String(rl.retryAfter))
    return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente en un momento"), 429)
  }

  /** La sesión del token; responde 401 si no vale y «No disponible» si el chat se desactivó (salvo una prueba). */
  async function session(c: Context, found: PublicWebchat): Promise<{ sessionId: string } | Response> {
    const token = bearerToken(c)
    if (!token) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    const read = readVisitorSession(found, token)
    if (!read) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión inválida o vencida"), 401)
    if (found.connection.status !== "active" && !isWebchatTestSession(read.sessionId)) {
      return c.json(errorBody(c, "WEBCHAT_DISABLED", UNAVAILABLE), 409)
    }
    return read
  }

  /**
   * `chat.js` pregunta al cargar si el chat responde en este sitio y cómo se
   * ve. El sitio es el de la cabecera `Origin` que pone el navegador, no lo
   * que diga el cuerpo; si responde, lleva un ticket firmado de ese sitio que
   * la ventana presenta al abrir la sesión.
   */
  app.post("/:slug/site", async (c) => {
    cors(c)
    const found = await resolve(c)
    if (!found) return c.json({ data: { available: false } })
    const tooMany = await limited(c, `webchat:site:${found.orgId}:${addressOf(deps, c)}`, LIMITS.site)
    if (tooMany) return tooMany
    const origin = normalizeOrigin(c.req.header("origin") ?? "")
    const result = await withOrgContext(deps.db, found.orgId, async (tx) => {
      const site =
        origin && found.connection.status === "active" ? await admitWebchatSite(tx, found.orgId, found.connection.id, origin) : null
      const appearance = await webchatAppearance(tx, found.orgId, found)
      const available = site?.status === "permitido"
      return {
        available,
        color: appearance.color,
        clinicName: appearance.clinicName,
        ...(available && origin ? { ticket: webchatSiteTicket(found.sessionKey, origin) } : {}),
      }
    })
    return c.json({ data: result })
  })

  /** La página del chat (`/embed`) pide cómo se ve. Solo presentación: nada de sitios ni claves. */
  app.get("/:slug/config", async (c) => {
    cors(c)
    const found = await resolve(c)
    if (!found) return c.json(errorBody(c, "NOT_FOUND", UNAVAILABLE), 404)
    const appearance = await withOrgContext(deps.db, found.orgId, (tx) => webchatAppearance(tx, found.orgId, found))
    return c.json({ data: { ...appearance, active: found.connection.status === "active" } })
  })

  /** Los sitios donde el navegador deja mostrar el chat; la plataforma los pone en `frame-ancestors`. */
  app.get("/:slug/frame", async (c) => {
    const found = await resolve(c)
    if (!found) return c.json({ data: { ancestors: [] } })
    const ancestors = await withOrgContext(deps.db, found.orgId, (tx) => webchatFrameAncestors(tx, found.orgId, found.connection.id))
    return c.json({ data: { ancestors } })
  })

  app.post("/:slug/session", async (c) => {
    cors(c)
    const found = await resolve(c)
    if (!found) return c.json(errorBody(c, "NOT_FOUND", UNAVAILABLE), 404)
    const tooMany = await limited(c, `webchat:session:${found.orgId}:${addressOf(deps, c)}`, LIMITS.session)
    if (tooMany) return tooMany
    const parsed = sessionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Falta el sitio"), 400)
    if (found.connection.status !== "active") return c.json(errorBody(c, "WEBCHAT_DISABLED", UNAVAILABLE), 409)
    // El sitio tiene que ser el que vio la API al cargar `chat.js` (su ticket), no uno escrito en la dirección.
    const seen = readWebchatSiteTicket(found.sessionKey, parsed.data.ticket)
    if (!seen || seen !== normalizeOrigin(parsed.data.site)) return c.json(errorBody(c, "WEBCHAT_SITE", UNAVAILABLE), 403)
    const site = await withOrgContext(deps.db, found.orgId, (tx) => admitWebchatSite(tx, found.orgId, found.connection.id, seen))
    if (site?.status !== "permitido") return c.json(errorBody(c, "WEBCHAT_SITE", UNAVAILABLE), 403)
    return c.json({ data: openWebchatSession(found.sessionKey) }, 201)
  })

  app.post("/:slug/messages", async (c) => {
    cors(c)
    const found = await resolve(c)
    if (!found) return c.json(errorBody(c, "NOT_FOUND", UNAVAILABLE), 404)
    const read = await session(c, found)
    if (read instanceof Response) return read
    const parsed = visitorMessageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Revisa el mensaje"), 400)
    const tooMany = await limited(c, `webchat:post:${found.connection.id}:${read.sessionId}`, LIMITS.post)
    if (tooMany) return tooMany
    const event: NormalizedInbound = buildWebchatInbound(read.sessionId, parsed.data)
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
      await sendInboundMessage(tx, { orgId: found.orgId, connectionId: found.connection.id, event })
      return false
    })
    return c.json({ data: { queued: !duplicate } }, duplicate ? 200 : 202)
  })

  app.get("/:slug/messages", async (c) => {
    cors(c)
    const found = await resolve(c)
    if (!found) return c.json(errorBody(c, "NOT_FOUND", UNAVAILABLE), 404)
    const read = await session(c, found)
    if (read instanceof Response) return read
    const tooMany = await limited(c, `webchat:poll:${found.connection.id}:${read.sessionId}`, LIMITS.poll)
    if (tooMany) return tooMany
    // Recién aquí lo `sent` pasa a `delivered`: el visitante lo recibió.
    const poll = await withOrgContext(deps.db, found.orgId, (tx) => pollWebchatVisitor(tx, found.orgId, found.connection.id, read.sessionId))
    return c.json({ data: poll })
  })

  /** «¿Dónde te avisamos?» (R4): su WhatsApp o su correo, solo para responderle. */
  app.post("/:slug/contact", async (c) => {
    cors(c)
    const found = await resolve(c)
    if (!found) return c.json(errorBody(c, "NOT_FOUND", UNAVAILABLE), 404)
    const read = await session(c, found)
    if (read instanceof Response) return read
    const tooMany = await limited(c, `webchat:contact:${found.connection.id}:${read.sessionId}`, LIMITS.contact)
    if (tooMany) return tooMany
    const parsed = contactInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Escribe tu WhatsApp o tu correo."), 400)
    try {
      const contact = await withOrgContext(deps.db, found.orgId, (tx) =>
        saveWebchatVisitorContact(tx, found.orgId, found.connection.id, read.sessionId, parsed.data),
      )
      return c.json({ data: { contact } })
    } catch (e) {
      // Solo el motivo en palabras: nada interno al visitante.
      if (e instanceof ServiceError) return c.json(errorBody(c, e.code, e.message), e.status)
      throw e
    }
  })

  return app
}

const adminPatchInput = z
  .object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    greeting: z.string().trim().max(500).nullable().optional(),
    notifyUrl: z.string().trim().max(500).nullable().optional(),
  })
  .strict()

/**
 * El chat de la clínica en Configuración (`settings.read` para verlo,
 * `settings.write` para cambiarlo). Monta bajo guards en `/channels/webchat`.
 */
export function createWebchatAdminRoute(deps: CrmDeps) {
  const app = new Hono()

  function forbidden(c: Context, write: boolean): Response | null {
    const { memberRole } = orgContextOf(c)
    return canAccess(memberRole, write ? "settings.write" : "settings.read")
      ? null
      : c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
  }

  app.get("/", async (c) => {
    const denied = forbidden(c, false)
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    // `?peek=1` (lista de Integraciones): mirarlo no lo crea ni lo deja encendido.
    if (c.req.query("peek") === "1") {
      return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => peekClinicWebchat(tx, orgId, deps.secretsKey)))
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getClinicWebchat(tx, orgId, deps.secretsKey, userId)))
  })

  app.patch("/", async (c) => {
    const denied = forbidden(c, true)
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    const parsed = adminPatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updateClinicWebchat(tx, orgId, deps.secretsKey, userId, parsed.data)))
  })

  for (const [path, active] of [["/enable", true], ["/disable", false]] as const) {
    app.post(path, async (c) => {
      const denied = forbidden(c, true)
      if (denied) return denied
      const { orgId } = orgContextOf(c)
      return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => setClinicWebchatActive(tx, orgId, deps.secretsKey, active)))
    })
  }

  app.get("/code", async (c) => {
    const denied = forbidden(c, true)
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async (tx) => ({ code: await webchatSigningCode(tx, orgId) })))
  })

  // «Generar un código nuevo»: quien ya conversaba sigue 30 días con el anterior.
  app.post("/rotate", async (c) => {
    const denied = forbidden(c, true)
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => rotateClinicWebchatSecret(tx, orgId, deps.secretsKey, userId)))
  })

  for (const [action, status] of [["allow", "permitido"], ["block", "bloqueado"]] as const) {
    app.post(`/sites/:id/${action}`, async (c) => {
      const denied = forbidden(c, true)
      if (denied) return denied
      const { orgId, userId } = orgContextOf(c)
      const id = z.string().uuid().safeParse(c.req.param("id"))
      if (!id.success) return validationError(c, id.error.issues)
      return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => decideWebchatSite(tx, orgId, deps.secretsKey, userId, id.data, status)))
    })
  }

  // «Probar sin publicar»: Sofi responde de verdad, aunque el chat esté desactivado.
  app.post("/test", async (c) => {
    const denied = forbidden(c, true)
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => openWebchatTest(tx, orgId, deps.secretsKey, userId)))
  })

  app.post("/test/delete", async (c) => {
    const denied = forbidden(c, true)
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ sessionId: z.string().min(1).max(200) }).strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({ deleted: await deleteWebchatTest(tx, orgId, { sessionId: parsed.data.sessionId }) })),
    )
  })

  return app
}
