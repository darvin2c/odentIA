import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  type AdminActor,
  CONSUMER_COMPLAINT_STATUS_FILTERS,
  type ConsumerComplaintDetail,
  consumerComplaintResponseEmails,
  consumerComplaintResponseSchema,
  consumerComplaintSummary,
  getConsumerComplaint,
  listConsumerComplaints,
  markComplaintResponseEmailSent,
  prepareComplaintResponseResend,
  respondConsumerComplaint,
  ServiceError,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { runService, validationError } from "./helpers.js"

export interface AdminConsumerComplaintsDeps {
  /** Conexión propietaria: el libro no da acceso al rol app (migración 0004). */
  ownerDb: Db
  mailer: Mailer
  /** Buzón de reclamos de odentIA: recibe una copia de cada respuesta. */
  complaintsEmail?: string | undefined
}

const listQuery = z.object({
  status: z.enum(CONSUMER_COMPLAINT_STATUS_FILTERS).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

/** Administración y Soporte responden el libro (decisión 2 del lienzo). */
function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support") {
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de odentIA")
  }
  return actor
}

/**
 * Libro de Reclamaciones en la administración (`/api/admin/consumer-complaints`,
 * tras el guard de admin: sesión, personal activo, segundo factor y origen
 * administrativo). Cada lectura con datos de la persona y cada respuesta
 * quedan en `admin_audit`.
 */
export function createAdminConsumerComplaintsRoute(deps: AdminConsumerComplaintsDeps) {
  const app = new Hono()

  /**
   * Envía la respuesta después de confirmar la transacción. Un fallo no se
   * reintenta solo (SMTP pudo entregarla igual): la hoja queda con el correo
   * sin enviar y la administración ofrece reenviarla a mano. La copia al buzón
   * sale solo con la primera respuesta.
   */
  async function deliver(sheet: ConsumerComplaintDetail, withCopy: boolean): Promise<boolean> {
    const { response, copy } = consumerComplaintResponseEmails(sheet)
    let sent = false
    try {
      await deps.mailer.send({ to: sheet.email, ...response })
      sent = true
    } catch {
      // Solo el número: el registro no lleva datos de la persona.
      console.error(`Libro de Reclamaciones: no salió la respuesta de la hoja ${sheet.number}`)
    }
    if (sent) {
      await deps.ownerDb
        .transaction((tx) => markComplaintResponseEmailSent(tx, sheet.id))
        .catch(() =>
          console.error(
            `Libro de Reclamaciones: no se pudo marcar el envío de la respuesta ${sheet.number}`,
          ),
        )
    }
    if (withCopy && deps.complaintsEmail) {
      await deps.mailer
        .send({ to: deps.complaintsEmail, ...copy })
        .catch(() =>
          console.error(
            `Libro de Reclamaciones: no llegó al buzón la copia de la respuesta ${sheet.number}`,
          ),
        )
    }
    return sent
  }

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      deps.ownerDb.transaction((tx) =>
        listConsumerComplaints(tx, staffOf(c), {
          status: query.status,
          search: query.q,
          limit: query.limit,
          offset: query.offset,
        }),
      ),
    )
  })

  app.get("/summary", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => consumerComplaintSummary(tx, staffOf(c))),
    ),
  )

  app.get("/:id", (c) =>
    runService(c, 200, () =>
      deps.ownerDb.transaction((tx) => getConsumerComplaint(tx, staffOf(c), c.req.param("id"))),
    ),
  )

  app.post("/:id/response", async (c) => {
    const parsed = consumerComplaintResponseSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      const sheet = await deps.ownerDb.transaction((tx) =>
        respondConsumerComplaint(tx, staffOf(c), c.req.param("id"), parsed.data),
      )
      const responseEmailSent = await deliver(sheet, true)
      return { ...sheet, responseEmailSent }
    })
  })

  /** Reenvío a mano de una respuesta cuyo correo no salió. */
  app.post("/:id/response-email", (c) =>
    runService(c, 200, async () => {
      const sheet = await deps.ownerDb.transaction((tx) =>
        prepareComplaintResponseResend(tx, staffOf(c), c.req.param("id")),
      )
      const responseEmailSent = await deliver(sheet, false)
      return { ...sheet, responseEmailSent }
    }),
  )

  return app
}
