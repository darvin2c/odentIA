import { withOrgContext } from "@odentia/db"
import { auditEvent } from "@odentia/db/schema/org"
import {
  buildPatientRecordCopy,
  createDataRequest,
  DATA_REQUEST_CHANNELS,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_VERIFICATIONS,
  denyDataRequest,
  eraseForDataRequest,
  erasurePreview,
  getDataRequestsView,
  type PatientRecordCopy,
  patientRecordSummary,
  recordSendOptions,
  respondDataRequest,
  sendPatientRecordCopy,
  verifyDataRequest,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { recordCopyZip } from "../lib/record-copy-zip.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Pedidos sobre sus datos y la copia de la historia (issues 45 y 50, ADR
 * 0080). Los permisos los decide el guarda de `patients.ts`:
 * `/data-requests` es de pacientes (`patients.read`/`.write`: Recepción
 * registra, comprueba, envía y responde) y `/record` es clínico
 * (`clinical.read`), con traza en «Consultas a la historia». Borrar sus
 * datos y ver qué se borraría es solo de Administración (`patients.erase`).
 */
const createInput = z
  .object({
    kind: z.enum(DATA_REQUEST_KINDS, "Elige qué pide"),
    requesterContactId: z.uuid("Elige quién lo pide"),
    channel: z.enum(DATA_REQUEST_CHANNELS, "Elige por dónde llegó"),
    requestedOn: z.iso.date("Cuándo lo pidió: fecha inválida").nullish(),
    said: z.string().max(1000, "Lo que dijo admite hasta 1000 caracteres").nullish(),
  })
  .strict()
const verifyInput = z
  .object({ how: z.enum(DATA_REQUEST_VERIFICATIONS, "Elige cómo comprobaste que es ella") })
  .strict()
const respondInput = z
  .object({
    resolution: z
      .string()
      .trim()
      .min(1, "Escribe qué se entregó o qué se hizo")
      .max(1000, "La respuesta admite hasta 1000 caracteres"),
  })
  .strict()
const denyInput = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, "Escribe por qué se deniega")
      .max(1000, "El motivo admite hasta 1000 caracteres"),
  })
  .strict()
const sendInput = z.object({ connectionId: z.uuid() }).strict()

export function createPatientDataRequestsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/:id/data-requests", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getDataRequestsView(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/:id/data-requests", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createDataRequest(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.get("/:id/data-requests/:requestId/erase-preview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.erase"))
      return c.json(
        errorBody(c, "FORBIDDEN", "Solo Administración borra los datos de una persona"),
        403,
      )
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => erasurePreview(tx, orgId, c.req.param("id"))),
    )
  })

  // Los adjuntos de sus mensajes se borran del almacenamiento después de
  // confirmar: si falla, el archivo queda huérfano, nunca a la vista.
  app.post("/:id/data-requests/:requestId/erase", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.erase"))
      return c.json(
        errorBody(c, "FORBIDDEN", "Solo Administración borra los datos de una persona"),
        403,
      )
    return runService(c, 200, async () => {
      const { request, attachmentKeys } = await withOrgContext(deps.db, orgId, (tx) =>
        eraseForDataRequest(tx, orgId, userId, c.req.param("id"), c.req.param("requestId")),
      )
      await Promise.all(
        attachmentKeys.map((key) => deps.storage.deleteAttachment(key).catch(() => {})),
      )
      return request
    })
  })

  app.post("/:id/data-requests/:requestId/verify", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = verifyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        verifyDataRequest(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("requestId"),
          parsed.data,
        ),
      ),
    )
  })

  app.post("/:id/data-requests/:requestId/respond", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = respondInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        respondDataRequest(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("requestId"),
          parsed.data,
        ),
      ),
    )
  })

  app.post("/:id/data-requests/:requestId/deny", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = denyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        denyDataRequest(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("requestId"),
          parsed.data,
        ),
      ),
    )
  })

  app.get("/:id/data-requests/:requestId/send-options", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        recordSendOptions(tx, orgId, c.req.param("id"), c.req.param("requestId")),
      ),
    )
  })

  // Envía la copia a quien la pidió: el servidor arma el PDF y no lo muestra.
  app.post("/:id/data-requests/:requestId/send", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = sendInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendPatientRecordCopy(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("requestId"),
          parsed.data,
          // Con la clave, el PDF lleva en su primera página «Su enlace» para bajar la copia completa.
          { storage: deps.storage, secretsKey: deps.secretsKey },
        ),
      ),
    )
  })

  // La copia completa de su historia en un ZIP: el PDF para leer, el paquete HL7 FHIR R4, cada
  // papel emitido en su PDF, los archivos y el LÉEME (`buildPatientRecordCopy`, la misma lista del
  // enlace de la persona). Solo para quien lee la ficha clínica.
  app.get("/:id/record", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const stream = deps.storage.streamAttachment
    if (!stream) return c.json(errorBody(c, "UNAVAILABLE", "La descarga no está disponible"), 503)
    const patientId = c.req.param("id")
    let copy: PatientRecordCopy
    try {
      copy = await withOrgContext(deps.db, orgId, async (tx) => {
        const built = await buildPatientRecordCopy(tx, orgId, patientId, { storage: deps.storage })
        // Cada descarga queda registrada, no solo la hora (la bitácora agrupa por hora), con lo que trae.
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: userId,
          action: "patient_record.downloaded",
          entity: "patient",
          entityId: patientId,
          metadata: { patientId, files: built.entries.length, summary: built.summary },
        })
        return built
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    // La transacción ya se cerró: el ZIP se arma mientras se envía.
    return c.body(recordCopyZip(copy, (key) => stream(key)), 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(copy.fileName)}`,
      "cache-control": "private, no-store",
    })
  })

  // Lo que trae la copia, contado de la misma lista que arma el ZIP: lo muestra la pantalla antes
  // de bajarla. El mismo permiso que la copia (`clinical.read`, el guarda de `patients.ts`).
  app.get("/:id/record/summary", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => patientRecordSummary(tx, orgId, c.req.param("id"), { storage: deps.storage })),
    )
  })

  return app
}
