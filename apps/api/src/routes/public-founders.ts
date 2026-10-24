import { getConnInfo } from "@hono/node-server/conninfo"
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  getPublicPricing,
  markWaitlistConfirmationSent,
  readFounderInvitation,
  ServiceError,
  submitWaitlistRequest,
  waitlistInputSchemaFor,
  waitlistReceivedEmail,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { errorBody } from "../lib/error.js"
import type { RegistrationRemoteAddress } from "./public-patient-registration.js"

const WINDOW_MS = 10 * 60 * 1000
/** Solicitudes por dirección y ventana: de sobra para una clínica, poco para quien abusa. */
const MAX_POSTS = 5
const MAX_BUCKETS = 10000
/** Lo que la web vuelve a pedir: un cambio de precio en la administración se ve en menos de un minuto (decisión 14). */
const PRICING_MAX_AGE_S = 30

/**
 * Lo público de Fundadores (issue 165), terminal: nunca sigue hacia
 * `requireSession`.
 *
 * - `GET /pricing`: los planes con «Mostrar en la web»; lo lee la web de
 *   marketing al servir cada página. Nunca los lugares que quedan.
 * - `POST /waitlist`: la solicitud de la web. Guarda con `ownerDb` y después
 *   envía la copia; si el correo falla, la solicitud queda igual.
 * - `GET /invitation/:token`: lo que muestra «Crea tu cuenta» con una
 *   invitación. Sin invitación vigente responde 404 sin decir por qué.
 */
export function createPublicFoundersRoute(deps: {
  ownerDb: Db
  mailer: Mailer
  remoteAddress?: RegistrationRemoteAddress | undefined
  /** Buzón que lee las respuestas (FOUNDERS_EMAIL). */
  replyTo?: string | undefined
  /** El producto del dominio de la petición: la solicitud lo guarda (decisión 17 del issue 229). */
  productOf?: (c: Context) => ClinicalProduct
}) {
  const app = new Hono()
  const buckets = new Map<string, { expiresAt: number; posts: number }>()
  const address: RegistrationRemoteAddress =
    deps.remoteAddress ??
    ((c) => {
      try {
        return getConnInfo(c).remote.address
      } catch {
        return undefined
      }
    })

  app.onError((error, c) => {
    if (error instanceof ServiceError) return c.json(errorBody(c, error.code, error.message), error.status)
    // Sin el error: podría llevar los datos de quien pidió.
    console.error("Fundadores: error en la ruta pública")
    return c.json(errorBody(c, "INTERNAL", "No pudimos guardar tu solicitud. Intenta nuevamente."), 500)
  })

  app.get("/pricing", async (c) => {
    c.header("Cache-Control", `public, max-age=${PRICING_MAX_AGE_S}`)
    return c.json(await deps.ownerDb.transaction((tx) => getPublicPricing(tx)))
  })

  app.get("/invitation/:token", async (c) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    const found = await deps.ownerDb.transaction((tx) => readFounderInvitation(tx, c.req.param("token")))
    if (!found) return c.json(errorBody(c, "INVITATION_INVALID", "Esa invitación ya no sirve"), 404)
    return c.json(found)
  })

  app.use(
    "/waitlist",
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "La solicitud excede el tamaño permitido"), 413),
    }),
  )

  const limited = (c: Context): Response | null => {
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key)
    const key = address(c) ?? "shared"
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        c.header("Retry-After", "60")
        return c.json(errorBody(c, "RATE_LIMITED", "Recibimos demasiadas solicitudes. Intenta nuevamente en unos minutos."), 429)
      }
      bucket = { expiresAt: now + WINDOW_MS, posts: 0 }
      buckets.set(key, bucket)
    }
    if (bucket.posts >= MAX_POSTS) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return c.json(errorBody(c, "RATE_LIMITED", "Recibimos demasiadas solicitudes. Intenta nuevamente en unos minutos."), 429)
    }
    bucket.posts++
    return null
  }

  app.post("/waitlist", async (c) => {
    c.header("Cache-Control", "no-store")
    const blocked = limited(c)
    if (blocked) return blocked
    const product = deps.productOf?.(c) ?? "dental"
    const parsed = waitlistInputSchemaFor(product).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(errorBody(c, "VALIDATION", parsed.error.issues[0]?.message ?? "Revisa los datos de la solicitud"), 400)
    }
    const result = await deps.ownerDb.transaction((tx) => submitWaitlistRequest(tx, parsed.data, product))
    // La copia sale una sola vez: si ya estaba en la lista, no se repite.
    if (!result.existing) {
      try {
        await deps.mailer.send({
          to: parsed.data.email,
          ...waitlistReceivedEmail({
            firstName: parsed.data.firstName,
            clinicName: parsed.data.clinicName,
            phone: parsed.data.phone,
            answerDays: result.answerDays,
            replyTo: deps.replyTo,
          }),
        })
        await deps.ownerDb.transaction((tx) => markWaitlistConfirmationSent(tx, result.id)).catch(() => undefined)
      } catch {
        console.error(`Fundadores: no salió la copia de la solicitud ${result.id}`)
      }
    }
    return c.json({ ok: true, answerDays: result.answerDays }, 201)
  })

  return app
}
