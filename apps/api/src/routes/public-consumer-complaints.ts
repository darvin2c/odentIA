import { getConnInfo } from "@hono/node-server/conninfo"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  consumerComplaintEmails,
  consumerComplaintInputSchema,
  markComplaintEmailSent,
  ServiceError,
  submitConsumerComplaint,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { errorBody } from "../lib/error.js"
import type { RegistrationRemoteAddress } from "./public-patient-registration.js"

const WINDOW_MS = 10 * 60 * 1000
/** Envíos por dirección y ventana: de sobra para quien reclama, poco para quien abusa. */
const MAX_POSTS = 5
const MAX_BUCKETS = 10000

/**
 * Libro de Reclamaciones virtual (Perú, Ley 29571 y D.S. 011-2011-PCM): la
 * única ruta que llama la web de marketing. Pública y terminal: nunca sigue
 * hacia `requireSession`.
 *
 * Guarda la hoja con `ownerDb` (tablas globales de la plataforma, sin acceso
 * del rol app) y después envía la copia al consumidor y el aviso a odentIA
 * (`COMPLAINTS_EMAIL`). Si el correo falla, la hoja queda guardada con
 * `email_sent` en false y la respuesta lo dice: la web pide guardarla o
 * imprimirla. Reenviar el mismo `submissionId` devuelve la misma hoja y no
 * repite correos (un envío fallido de SMTP puede haber llegado igual).
 *
 * El límite por dirección es local a la instancia y no confía en cabeceras
 * reenviadas por el cliente.
 */
export function createPublicConsumerComplaintsRoute(deps: {
  ownerDb: Db
  mailer: Mailer
  /** Correo de odentIA que recibe el aviso de cada hoja; sin él solo sale la copia. */
  complaintsEmail?: string | undefined
  /** Origen de la administración: el botón «Abrir en Reclamaciones» del aviso a odentIA. */
  adminURL?: string | undefined
  remoteAddress?: RegistrationRemoteAddress | undefined
}) {
  const app = new Hono()
  const buckets = new Map<string, { expiresAt: number; posts: number }>()
  const notFound = (c: Context) => c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
  const address: RegistrationRemoteAddress =
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
  app.use(
    "*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) =>
        c.json(errorBody(c, "BODY_TOO_LARGE", "La hoja excede el tamaño permitido"), 413),
    }),
  )
  // No llevar errores inesperados al registro global: podrían contener los datos del consumidor.
  app.onError((_error, c) =>
    c.json(
      errorBody(c, "INTERNAL", "No pudimos registrar tu reclamación. Intenta nuevamente."),
      500,
    ),
  )

  app.post("/", async (c) => {
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key)
    const key = address(c) ?? "shared"
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        const earliest = Math.min(...Array.from(buckets.values(), (b) => b.expiresAt))
        c.header("Retry-After", String(Math.max(1, Math.ceil((earliest - now) / 1000))))
        return c.json(
          errorBody(
            c,
            "RATE_LIMITED",
            "Recibimos demasiados envíos. Intenta nuevamente en unos minutos.",
          ),
          429,
        )
      }
      bucket = { expiresAt: now + WINDOW_MS, posts: 0 }
      buckets.set(key, bucket)
    }
    if (bucket.posts >= MAX_POSTS) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return c.json(
        errorBody(
          c,
          "RATE_LIMITED",
          "Recibimos demasiados envíos. Intenta nuevamente en unos minutos.",
        ),
        429,
      )
    }
    bucket.posts++

    const body = await c.req.json().catch(() => null)
    const parsed = consumerComplaintInputSchema.safeParse(body)
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Revisa los datos de la hoja de reclamación"
      return c.json(errorBody(c, "VALIDATION", message), 400)
    }

    let result: Awaited<ReturnType<typeof submitConsumerComplaint>>
    try {
      result = await deps.ownerDb.transaction((tx) => submitConsumerComplaint(tx, parsed.data))
    } catch (error) {
      if (error instanceof ServiceError)
        return c.json(errorBody(c, error.code, error.message), error.status)
      throw error
    }
    const { sheet, created } = result

    let emailSent = sheet.emailSent
    if (created) {
      const { copy, notice } = consumerComplaintEmails(sheet, {
        replyTo: deps.complaintsEmail,
        reviewUrl: deps.adminURL ? `${deps.adminURL.replace(/\/+$/, "")}/complaints` : undefined,
      })
      try {
        await deps.mailer.send({ to: sheet.email, ...copy })
        emailSent = true
      } catch {
        // Solo el número: el registro no lleva datos del consumidor.
        console.error(
          `Libro de Reclamaciones: no se pudo enviar la copia de la hoja ${sheet.number}`,
        )
      }
      if (emailSent) {
        await deps.ownerDb
          .transaction((tx) => markComplaintEmailSent(tx, sheet.id))
          .catch(() =>
            console.error(
              `Libro de Reclamaciones: no se pudo marcar el envío de la hoja ${sheet.number}`,
            ),
          )
      }
      if (deps.complaintsEmail) {
        await deps.mailer
          .send({ to: deps.complaintsEmail, ...notice })
          .catch(() =>
            console.error(
              `Libro de Reclamaciones: no se pudo avisar a odentIA de la hoja ${sheet.number}`,
            ),
          )
      }
    }

    return c.json({
      data: { number: sheet.number, createdAt: sheet.createdAt.toISOString(), emailSent },
    })
  })

  // Terminal: nunca continuar hacia requireSession ni ampliar excepciones a otros /api/*.
  app.all("*", notFound)
  return app
}
