import { withOrgContext } from "@odentia/db"
import {
  acknowledgeCalendarClient,
  CALENDAR_CLIENTS,
  createMyCalendarFeed,
  findCalendarFeedOrg,
  getMyCalendarFeed,
  listTeamCalendarFeeds,
  revokeMyCalendarFeed,
  revokeTeamCalendarFeed,
  rotateMyCalendarFeed,
  serveCalendarFeed,
} from "@odentia/services"
import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const knownInput = z.strictObject({ client: z.enum(CALENDAR_CLIENTS) })

/**
 * «Mi calendario» (issue 46, ADR 0082). `/mine` es de quien atiende: su
 * enlace, quién lo usa, cambiarlo y apagarlo. `/team` es de quien configura
 * el equipo: ve quién comparte y lo puede apagar, nunca el enlace. El padre
 * monta en `/api/agenda/calendar`.
 */
export function createCalendarFeedRoute(deps: CrmDeps) {
  const app = new Hono()
  const feedDeps = { secretsKey: deps.secretsKey, feedBaseUrl: deps.webhookBaseUrl ?? null }

  app.get("/mine", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "appointments.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la agenda"), 403)
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getMyCalendarFeed(tx, orgId, userId, feedDeps)))
  })

  app.post("/mine", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createMyCalendarFeed(tx, orgId, userId, feedDeps)))
  })

  app.post("/mine/rotate", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => rotateMyCalendarFeed(tx, orgId, userId, feedDeps)))
  })

  app.delete("/mine", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => revokeMyCalendarFeed(tx, orgId, userId))
      return { revoked: true }
    })
  })

  // «Fui yo»: ese programa queda como conocido.
  app.post("/mine/known", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = knownInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => acknowledgeCalendarClient(tx, orgId, userId, parsed.data.client))
      return { known: true }
    })
  })

  app.get("/team", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver el equipo"), 403)
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listTeamCalendarFeeds(tx, orgId)))
  })

  app.delete("/team/:userId", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar el equipo"), 403)
    }
    const target = c.req.param("userId")
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => revokeTeamCalendarFeed(tx, orgId, userId, target))
      return { revoked: true }
    })
  })

  return app
}

const WINDOW_MS = 10 * 60_000
/** Pedidos de un mismo enlace válido en la ventana. */
const MAX_PER_FEED = 60
/** Pedidos de una misma dirección en la ventana: frena a quien prueba tokens al azar. */
const MAX_PER_ADDRESS = 120
const MAX_BUCKETS = 10_000

type Buckets = Map<string, { expiresAt: number; count: number }>

/**
 * Suma un pedido y dice si se pasó del límite. Con la tabla llena no se
 * cuenta (deja pasar): llenarla con tokens o direcciones inventadas no puede
 * dejar sin calendario a los enlaces de verdad.
 */
function over(buckets: Buckets, key: string, max: number, now: number): number | null {
  for (const [bucketKey, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(bucketKey)
  let bucket = buckets.get(key)
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) return null
    bucket = { expiresAt: now + WINDOW_MS, count: 0 }
    buckets.set(key, bucket)
  }
  return ++bucket.count > max ? Math.ceil((bucket.expiresAt - now) / 1000) : null
}

/**
 * La dirección que pide el calendario (`/api/public/calendar/<token>.ics`),
 * sin sesión: el token resuelve la clínica. Un enlace apagado responde como
 * si no existiera, sin decir de qué clínica era. Dos límites: por dirección
 * (quien prueba tokens) y, solo para enlaces que existen, por enlace (Google
 * pide desde muchos servidores, así que su límite no puede ser por dirección).
 */
export function createPublicCalendarRoute(deps: {
  db: CrmDeps["db"]
  ownerDb: CrmDeps["db"]
  remoteAddress?: (c: Context) => string | undefined
}) {
  const app = new Hono()
  const byFeed: Buckets = new Map()
  const byAddress: Buckets = new Map()
  const addressOf =
    deps.remoteAddress ??
    ((c: Context) => {
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
  // Solo el tipo de error: el mensaje podría llevar el token.
  app.onError((error, c) => {
    console.error(`public-calendar: ${error instanceof Error ? error.name : "error desconocido"}`)
    return c.text("No disponible", 500)
  })

  app.get("/:file", async (c) => {
    const match = /^([0-9a-f]{64})\.ics$/.exec(c.req.param("file"))
    if (!match) return c.text("No disponible", 404)
    const token = match[1]!
    const now = Date.now()
    const address = addressOf(c)
    const waitAddress = address ? over(byAddress, address, MAX_PER_ADDRESS, now) : null
    if (waitAddress !== null) {
      c.header("Retry-After", String(waitAddress))
      return c.text("Intenta más tarde", 429)
    }
    const orgId = await findCalendarFeedOrg(deps.ownerDb, token)
    if (!orgId) return c.text("No disponible", 404)
    const waitFeed = over(byFeed, token, MAX_PER_FEED, now)
    if (waitFeed !== null) {
      c.header("Retry-After", String(waitFeed))
      return c.text("Intenta más tarde", 429)
    }
    const file = await withOrgContext(deps.db, orgId, (tx) => serveCalendarFeed(tx, orgId, token, c.req.header("user-agent")))
    if (!file) return c.text("No disponible", 404)
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="mis-citas.ics"',
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    })
  })

  return app
}
