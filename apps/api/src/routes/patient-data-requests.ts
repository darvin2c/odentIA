import { withOrgContext } from "@odentia/db"
import {
  createDataRequest,
  DATA_REQUEST_CHANNELS,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_VERIFICATIONS,
  denyDataRequest,
  getDataRequestsView,
  loadPatientRecord,
  patientRecordFhirBundle,
  patientRecordFileName,
  patientRecordFiles,
  recordSendOptions,
  renderPatientRecordPdf,
  respondDataRequest,
  sendPatientRecordCopy,
  verifyDataRequest,
} from "@odentia/services"
import { auditEvent } from "@odentia/db/schema/org"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { zipStream } from "../lib/zip-stream.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Pedidos sobre sus datos y la copia de la historia (issues 45 y 50, ADR
 * 0080). Los permisos los decide el guarda de `patients.ts`:
 * `/data-requests` es de pacientes (`patients.read`/`.write`: Recepción
 * registra, comprueba, envía y responde) y `/record` es clínico
 * (`clinical.read`), con traza en «Consultas a la historia».
 */
const createInput = z
  .object({
    kind: z.enum(DATA_REQUEST_KINDS),
    requesterContactId: z.uuid(),
    channel: z.enum(DATA_REQUEST_CHANNELS),
    requestedOn: z.iso.date().nullish(),
    said: z.string().max(1000).nullish(),
  })
  .strict()
const verifyInput = z.object({ how: z.enum(DATA_REQUEST_VERIFICATIONS) }).strict()
const respondInput = z.object({ resolution: z.string().min(1).max(1000) }).strict()
const denyInput = z.object({ reason: z.string().min(1).max(1000) }).strict()
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
      withOrgContext(deps.db, orgId, (tx) => createDataRequest(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })

  app.post("/:id/data-requests/:requestId/verify", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = verifyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        verifyDataRequest(tx, orgId, userId, c.req.param("id"), c.req.param("requestId"), parsed.data),
      ),
    )
  })

  app.post("/:id/data-requests/:requestId/respond", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = respondInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        respondDataRequest(tx, orgId, userId, c.req.param("id"), c.req.param("requestId"), parsed.data),
      ),
    )
  })

  app.post("/:id/data-requests/:requestId/deny", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = denyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        denyDataRequest(tx, orgId, userId, c.req.param("id"), c.req.param("requestId"), parsed.data),
      ),
    )
  })

  app.get("/:id/data-requests/:requestId/send-options", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => recordSendOptions(tx, orgId, c.req.param("id"), c.req.param("requestId"))),
    )
  })

  // Envía la copia a quien la pidió: el servidor arma el PDF y no lo muestra.
  app.post("/:id/data-requests/:requestId/send", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = sendInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendPatientRecordCopy(tx, orgId, userId, c.req.param("id"), c.req.param("requestId"), parsed.data, {
          storage: deps.storage,
        }),
      ),
    )
  })

  // La historia completa en un ZIP: el PDF para leer, el paquete FHIR y los
  // archivos (imágenes y documentos). Solo para quien lee la ficha clínica.
  app.get("/:id/record", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const stream = deps.storage.streamAttachment
    if (!stream) return c.json(errorBody(c, "UNAVAILABLE", "La descarga no está disponible"), 503)
    const patientId = c.req.param("id")
    let pdf: Uint8Array
    let fhir: string
    let fileName: string
    let files: Array<{ name: string; storageKey: string }>
    let generatedAt: Date
    try {
      ;({ pdf, fhir, fileName, files, generatedAt } = await withOrgContext(deps.db, orgId, async (tx) => {
        const record = await loadPatientRecord(tx, orgId, patientId)
        // Cada descarga queda registrada, no solo la hora (la bitácora agrupa por hora).
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: userId,
          action: "patient_record.downloaded",
          entity: "patient",
          entityId: patientId,
          metadata: { patientId, documents: record.documents.length },
        })
        return {
          pdf: await renderPatientRecordPdf(record),
          fhir: JSON.stringify(patientRecordFhirBundle(record), null, 2),
          fileName: patientRecordFileName(record, "zip"),
          files: await patientRecordFiles(tx, orgId, record),
          generatedAt: record.generatedAt,
        }
      }))
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    const bytes = (data: Uint8Array) => async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      })
    const base = fileName.replace(/\.zip$/, "")
    const body = ReadableStream.from(
      zipStream(
        [
          { name: `${base}.pdf`, open: bytes(pdf) },
          { name: `${base}.fhir.json`, open: bytes(new TextEncoder().encode(fhir)) },
          ...files.map((f) => ({ name: f.name, open: () => stream(f.storageKey) })),
        ],
        generatedAt,
      ),
    )
    return c.body(body, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "cache-control": "private, no-store",
    })
  })

  return app
}
