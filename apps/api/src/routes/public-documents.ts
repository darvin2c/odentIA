import { getConnInfo } from "@hono/node-server/conninfo"
import { withOrgContext } from "@odentia/db"
import { readDocumentCheck, readDocumentCheckToken } from "@odentia/services"
import { type Context, Hono } from "hono"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService } from "./helpers.js"

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 60
const MAX_BUCKETS = 10_000

/**
 * Comprobar un documento con su QR, sin cuenta (ADR 0112). Ruta terminal: solo responde
 * si sigue vigente y los datos del papel que no dicen nada de salud (`DocumentCheck`).
 * Un token inválido o de un documento que no está es el mismo 404: no se distingue por
 * qué. El padre monta en `/api/public/documents`.
 */
export function createPublicDocumentsRoute(deps: {
  db: CrmDeps["db"]
  secretsKey: Buffer
  remoteAddress?: ((c: Context) => string | undefined) | undefined
}) {
  const app = new Hono()
  const address =
    deps.remoteAddress ??
    ((c: Context) => {
      try {
        return getConnInfo(c).remote.address
      } catch {
        return undefined
      }
    })
  const buckets = new Map<string, { count: number; resetAt: number }>()

  function limited(c: Context): Response | null {
    const now = Date.now()
    if (buckets.size >= MAX_BUCKETS) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
      if (buckets.size >= MAX_BUCKETS)
        return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    const key = address(c) ?? "shared"
    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
      return null
    }
    bucket.count += 1
    return bucket.count > MAX_PER_WINDOW
      ? c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
      : null
  }

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Robots-Tag", "noindex")
    await next()
  })
  app.onError((_error, c) =>
    c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500),
  )

  app.get("/:token", async (c) => {
    const throttled = limited(c)
    if (throttled) return throttled
    const missing = () => c.json(errorBody(c, "NOT_FOUND", "Documento no disponible"), 404)
    const read = readDocumentCheckToken(deps.secretsKey, c.req.param("token"))
    if (!read) return missing()
    const check = await withOrgContext(deps.db, read.orgId, (tx) =>
      readDocumentCheck(tx, read.orgId, read.type, read.id),
    )
    if (!check) return missing()
    return runService(c, 200, async () => check)
  })

  return app
}
