import { sniffDocumentMime } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  addImagingMeasurement,
  cancelImagingUpload,
  getImagingStudyFiles,
  getPatientDocument,
  IMAGING_STUDY_MAX_FILES,
  listImagingMeasurements,
  listImagingUploads,
  looksLikeDicom,
  markImagingFilesUploaded,
  MEASUREMENT_VIEWS,
  pendingImagingFiles,
  retireImagingMeasurement,
  setImagingThumbnail,
  startImagingStudyUpload,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { zipStream } from "../lib/zip-stream.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Tomografías (ADR 0055). `/imaging/uploads` es la subida: la usa quien
 * recibe el CD (`clinical.receive`) o quien escribe en la ficha, y solo
 * devuelve el avance. `/imaging/studies` es abrirla y descargarla, con
 * `clinical.read`. Los permisos los decide el guarda de `patients.ts`.
 */

const DICOM = "application/dicom"
const THUMBNAIL_MAX_BYTES = 512 * 1024
/** Firmas y comprobaciones por llamada: la cola del navegador va por tandas. */
const BATCH = 500
const PROBE_CONCURRENCY = 8

const uid = z.string().regex(/^[0-9]+(\.[0-9]+)*$/).max(64)
const startInput = z
  .object({
    label: z.string().trim().min(1).max(200),
    studyInstanceUid: uid,
    dicomPatientName: z.string().max(200).nullish(),
    modality: z.string().max(16).nullish(),
    capturedAt: z.iso.datetime({ offset: true }).nullish(),
    source: z.string().trim().min(1).max(120).nullish(),
    toothNumbers: z.array(z.number().int()).max(52).optional(),
    sliceCount: z.number().int().min(1).max(20000),
    voxelMm: z.number().positive().max(10).nullish(),
    files: z
      .array(
        z.object({
          sopInstanceUid: uid,
          seriesInstanceUid: uid,
          sizeBytes: z.number().int().min(1),
        }),
      )
      .min(1)
      .max(IMAGING_STUDY_MAX_FILES),
  })
  .strict()
const measurementInput = z
  .object({
    kind: z.enum(["distancia", "angulo"]),
    view: z.enum(MEASUREMENT_VIEWS),
    points: z.array(z.tuple([z.number(), z.number(), z.number()])).min(2).max(3),
    value: z.number().min(0),
    // La pieza FDI la valida el servicio (también los dientes de leche).
    toothNumber: z.number().int().min(11).max(85).nullish(),
  })
  .strict()
const indexesInput = z.object({ indexes: z.array(z.number().int().min(0)).min(1).max(BATCH) }).strict()

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        out[at] = await fn(items[at]!)
      }
    }),
  )
  return out
}


export function createImagingStudiesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/:id/imaging/uploads", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listImagingUploads(tx, orgId, c.req.param("id"))),
    )
  })

  // Empieza o retoma: firma la subida de lo que falta.
  app.post("/:id/imaging/uploads", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!deps.storage.uploadUrl)
      return c.json(errorBody(c, "UNAVAILABLE", "La subida de tomografías no está disponible"), 503)
    const parsed = startInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const patientId = c.req.param("id")
    return runService(c, 201, async () => {
      const started = await withOrgContext(deps.db, orgId, (tx) =>
        startImagingStudyUpload(tx, orgId, userId, patientId, parsed.data),
      )
      const pending =
        started.state === "exists"
          ? []
          : await withOrgContext(deps.db, orgId, (tx) =>
              pendingImagingFiles(tx, orgId, patientId, started.document.id),
            )
      const targets = await Promise.all(
        pending.slice(0, BATCH).map(async (file) => ({
          index: file.index,
          url: await deps.storage.uploadUrl!(file.storageKey, DICOM),
        })),
      )
      return {
        state: started.state,
        document: started.document,
        files: started.files,
        pending: pending.map((file) => file.index),
        targets,
      }
    })
  })

  // Más firmas (las anteriores vencen a los 15 minutos o no entraron en la tanda).
  app.post("/:id/imaging/uploads/:documentId/sign", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!deps.storage.uploadUrl)
      return c.json(errorBody(c, "UNAVAILABLE", "La subida de tomografías no está disponible"), 503)
    const parsed = indexesInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      const pending = await withOrgContext(deps.db, orgId, (tx) =>
        pendingImagingFiles(tx, orgId, c.req.param("id"), c.req.param("documentId"), parsed.data.indexes),
      )
      return Promise.all(
        pending.map(async (file) => ({
          index: file.index,
          url: await deps.storage.uploadUrl!(file.storageKey, DICOM),
        })),
      )
    })
  })

  // Comprueba en el bucket lo que el navegador dice haber subido.
  app.post("/:id/imaging/uploads/:documentId/confirm", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const probe = deps.storage.probeAttachment
    if (!probe)
      return c.json(errorBody(c, "UNAVAILABLE", "La subida de tomografías no está disponible"), 503)
    const parsed = indexesInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const patientId = c.req.param("id")
    const documentId = c.req.param("documentId")
    return runService(c, 200, async () => {
      const pending = await withOrgContext(deps.db, orgId, (tx) =>
        pendingImagingFiles(tx, orgId, patientId, documentId, parsed.data.indexes),
      )
      const checks = await mapLimit(pending, PROBE_CONCURRENCY, async (file) => {
        const found = await probe(file.storageKey, 132)
        if (!found) return { index: file.index, problem: "missing" as const }
        if (found.size !== file.sizeBytes) return { index: file.index, problem: "size" as const }
        if (!looksLikeDicom(found.head)) return { index: file.index, problem: "not_dicom" as const }
        return { index: file.index, problem: null }
      })
      const good = checks.filter((check) => !check.problem).map((check) => check.index)
      const progress = await withOrgContext(deps.db, orgId, (tx) =>
        markImagingFilesUploaded(tx, orgId, userId, patientId, documentId, good),
      )
      return {
        ...progress,
        rejected: checks.filter((check) => check.problem).map(({ index, problem }) => ({ index, problem })),
      }
    })
  })

  // Miniatura del corte del medio, que arma el navegador (imagen pequeña).
  app.put("/:id/imaging/uploads/:documentId/thumbnail", async (c) => {
    const { orgId } = orgContextOf(c)
    const patientId = c.req.param("id")
    const documentId = c.req.param("documentId")
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File) || !file.size || file.size > THUMBNAIL_MAX_BYTES)
      return c.json(errorBody(c, "VALIDATION", "La miniatura debe pesar hasta 512 KB"), 400)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const mime = sniffDocumentMime(bytes)
    if (mime !== "image/webp" && mime !== "image/png" && mime !== "image/jpeg")
      return c.json(errorBody(c, "VALIDATION", "La miniatura debe ser una imagen"), 400)
    return runService(c, 200, async () => {
      // Comprueba antes de guardar nada que la tomografía es de esta ficha.
      await withOrgContext(deps.db, orgId, (tx) => getPatientDocument(tx, orgId, patientId, documentId))
      const ref = await deps.storage.putPatientDocument({
        orgId,
        patientId,
        bytes,
        contentType: mime,
        ext: mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : "jpg",
      })
      await withOrgContext(deps.db, orgId, (tx) =>
        setImagingThumbnail(tx, orgId, patientId, documentId, ref.objectKey),
      )
      return { ok: true }
    })
  })

  app.post("/:id/imaging/uploads/:documentId/cancel", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) =>
        cancelImagingUpload(tx, orgId, userId, c.req.param("id"), c.req.param("documentId")),
      )
      return { ok: true }
    })
  })

  // Abrir: los archivos en orden con su URL firmada de lectura (visor).
  app.get("/:id/imaging/studies/:documentId/files", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, async () => {
      const { study, files } = await withOrgContext(deps.db, orgId, (tx) =>
        getImagingStudyFiles(tx, orgId, c.req.param("id"), c.req.param("documentId")),
      )
      return {
        sliceCount: study.sliceCount,
        voxelMm: study.voxelMm,
        files: await Promise.all(
          files.map(async (file) => ({
            index: file.index,
            sizeBytes: file.sizeBytes,
            seriesInstanceUid: file.seriesInstanceUid,
            url: await deps.storage.attachmentUrl(file.storageKey, 3600),
          })),
        ),
      }
    })
  })

  // Medidas guardadas (decisión 3): leerlas es clínico; guardarlas y quitarlas, escribir en la ficha.
  app.get("/:id/imaging/studies/:documentId/measurements", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listImagingMeasurements(tx, orgId, c.req.param("id"), c.req.param("documentId")),
      ),
    )
  })
  app.post("/:id/imaging/studies/:documentId/measurements", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = measurementInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addImagingMeasurement(tx, orgId, userId, c.req.param("id"), c.req.param("documentId"), parsed.data),
      ),
    )
  })
  app.post("/:id/imaging/studies/:documentId/measurements/:measurementId/retire", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) =>
        retireImagingMeasurement(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("documentId"),
          c.req.param("measurementId"),
        ),
      )
      return { ok: true }
    })
  })

  // Descargar para el programa del equipo: la tomografía tal como llegó, en un ZIP.
  app.get("/:id/imaging/studies/:documentId/download", async (c) => {
    const { orgId } = orgContextOf(c)
    const stream = deps.storage.streamAttachment
    if (!stream) return c.json(errorBody(c, "UNAVAILABLE", "La descarga no está disponible"), 503)
    const patientId = c.req.param("id")
    const documentId = c.req.param("documentId")
    let found: Awaited<ReturnType<typeof getImagingStudyFiles>>
    let label: string
    let takenAt: Date
    try {
      ;[found, { label, takenAt }] = await withOrgContext(deps.db, orgId, async (tx) => {
        const doc = await getPatientDocument(tx, orgId, patientId, documentId)
        return [
          await getImagingStudyFiles(tx, orgId, patientId, documentId),
          { label: doc.label, takenAt: doc.capturedAt ?? doc.createdAt },
        ] as const
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
    const name = `${label.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "tomografia"}.zip`
    const body = ReadableStream.from(
      zipStream(
        found.files.map((file) => ({
          name: `DICOM/${String(file.index + 1).padStart(5, "0")}.dcm`,
          open: () => stream(file.storageKey),
        })),
        takenAt,
      ),
    )
    return c.body(body, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
    })
  })

  return app
}
