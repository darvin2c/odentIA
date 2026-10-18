import type { Db } from "@odentia/db"
import { imagingStudy, imagingStudyFile, patientDocument } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import {
  getPatientDocument,
  type PatientDocumentWithContext,
  registerPatientDocument,
  retirePatientDocument,
} from "./clinical.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"

/**
 * Tomografías (ADR 0054): un documento de la ficha con muchos archivos DICOM
 * que el navegador sube directo al almacenamiento. El servicio reserva los
 * archivos, marca como recibidos los que la ruta ya comprobó en el bucket y da
 * por terminada la subida cuando llegaron todos. Quien sube puede no leer la
 * ficha (recepción con `clinical.receive`): lo que se le devuelve es el avance,
 * nunca el contenido.
 */

/** Tope por tomografía (decisión 4 del lienzo). */
export const IMAGING_STUDY_MAX_BYTES = 1024 ** 3
export const IMAGING_STUDY_MAX_FILES = 5000
/** Motivo con que se retira una subida que nadie va a terminar. */
export const IMAGING_UPLOAD_CANCEL_REASON = "Subida cancelada"

/** UID de DICOM (PS3.5 §9.1): números separados por puntos, hasta 64 caracteres. */
const DICOM_UID = /^[0-9]+(\.[0-9]+)*$/

function dicomUid(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > 64 || !DICOM_UID.test(value))
    throw validation(`${what} no es un UID de DICOM`)
  return value
}

export interface ImagingFileInput {
  sopInstanceUid: string
  seriesInstanceUid: string
  sizeBytes: number
}

export interface StartImagingStudyInput {
  label: string
  studyInstanceUid: string
  dicomPatientName?: string | null
  modality?: string | null
  capturedAt?: Date | string | null
  source?: string | null
  toothNumbers?: readonly number[] | null
  sliceCount: number
  voxelMm?: number | null
  files: readonly ImagingFileInput[]
}

export interface ImagingProgress {
  documentId: string
  fileCount: number
  uploadedCount: number
  totalBytes: number
  completedAt: Date | null
}

export interface PendingImagingFile {
  index: number
  storageKey: string
  sizeBytes: number
  sopInstanceUid: string
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "patient_document",
    entityId,
    metadata,
  })
}

async function requireStudy(tx: Db, orgId: string, patientId: string, documentId: string) {
  const [row] = await tx
    .select({ study: imagingStudy, retiredAt: patientDocument.retiredAt })
    .from(imagingStudy)
    .innerJoin(
      patientDocument,
      and(
        eq(patientDocument.organizationId, imagingStudy.organizationId),
        eq(patientDocument.id, imagingStudy.documentId),
      ),
    )
    .where(
      and(
        eq(imagingStudy.documentId, documentId),
        eq(imagingStudy.organizationId, orgId),
        eq(imagingStudy.patientId, patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Tomografía")
  return row
}

export async function imagingProgress(
  tx: Db,
  orgId: string,
  documentId: string,
): Promise<ImagingProgress> {
  const [study] = await tx
    .select()
    .from(imagingStudy)
    .where(and(eq(imagingStudy.documentId, documentId), eq(imagingStudy.organizationId, orgId)))
    .limit(1)
  if (!study) throw notFound("Tomografía")
  const [uploaded] = await tx
    .select({ n: count() })
    .from(imagingStudyFile)
    .where(
      and(
        eq(imagingStudyFile.documentId, documentId),
        eq(imagingStudyFile.organizationId, orgId),
        isNotNull(imagingStudyFile.uploadedAt),
      ),
    )
  return {
    documentId,
    fileCount: study.fileCount,
    uploadedCount: Number(uploaded?.n ?? 0),
    totalBytes: study.totalBytes,
    completedAt: study.completedAt,
  }
}

/** Archivos que aún no se recibieron (para firmar su subida o comprobarlos). */
export async function pendingImagingFiles(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
  indexes?: readonly number[],
): Promise<PendingImagingFile[]> {
  const { study, retiredAt } = await requireStudy(tx, orgId, patientId, documentId)
  if (retiredAt) throw new ServiceError("DOCUMENT_RETIRED", 409, "La tomografía está retirada")
  if (study.completedAt) return []
  const conditions = [
    eq(imagingStudyFile.documentId, documentId),
    eq(imagingStudyFile.organizationId, orgId),
    isNull(imagingStudyFile.uploadedAt),
  ]
  if (indexes) {
    if (!indexes.length) return []
    conditions.push(inArray(imagingStudyFile.fileIndex, [...new Set(indexes)]))
  }
  return tx
    .select({
      index: imagingStudyFile.fileIndex,
      storageKey: imagingStudyFile.storageKey,
      sizeBytes: imagingStudyFile.sizeBytes,
      sopInstanceUid: imagingStudyFile.sopInstanceUid,
    })
    .from(imagingStudyFile)
    .where(and(...conditions))
    .orderBy(asc(imagingStudyFile.fileIndex))
}

/**
 * Empieza (o retoma) la subida de una tomografía. El mismo estudio no se
 * guarda dos veces: si ya está completo en la ficha devuelve ese documento
 * (`exists`); si quedó a medias, ese mismo para seguir subiendo (`resumed`).
 */
export async function startImagingStudyUpload(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: StartImagingStudyInput,
): Promise<{
  document: PatientDocumentWithContext
  state: "new" | "resumed" | "exists"
  files: { index: number; sopInstanceUid: string }[]
}> {
  await requirePatient(tx, orgId, patientId)
  const studyUid = dicomUid(input.studyInstanceUid, "El estudio")
  const files = input.files ?? []
  if (!files.length) throw validation("La tomografía no trae archivos DICOM")
  if (files.length > IMAGING_STUDY_MAX_FILES)
    throw validation(`Una tomografía admite hasta ${IMAGING_STUDY_MAX_FILES} archivos`)
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    const sop = dicomUid(file.sopInstanceUid, "Un archivo")
    dicomUid(file.seriesInstanceUid, "Una serie")
    if (seen.has(sop)) throw validation("Hay archivos repetidos en la tomografía")
    seen.add(sop)
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes < 1)
      throw validation("Un archivo de la tomografía está vacío")
    total += file.sizeBytes
  }
  if (total > IMAGING_STUDY_MAX_BYTES)
    throw validation("La tomografía supera 1 GB: descárgala del centro de imágenes sin el visor")
  if (!Number.isInteger(input.sliceCount) || input.sliceCount < 1 || input.sliceCount > 20000)
    throw validation("La cantidad de cortes no es válida")
  const voxel =
    input.voxelMm != null && Number.isFinite(input.voxelMm) && input.voxelMm > 0 && input.voxelMm < 10
      ? input.voxelMm
      : null
  const patientName = input.dicomPatientName?.trim().slice(0, 200) || null
  const modality = input.modality?.trim().slice(0, 16) || null

  // Dos subidas del mismo estudio a la vez no crean dos documentos.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`imaging:${orgId}:${patientId}:${studyUid}`}))`)
  const [existing] = await tx
    .select({ study: imagingStudy })
    .from(imagingStudy)
    .innerJoin(
      patientDocument,
      and(
        eq(patientDocument.organizationId, imagingStudy.organizationId),
        eq(patientDocument.id, imagingStudy.documentId),
      ),
    )
    .where(
      and(
        eq(imagingStudy.organizationId, orgId),
        eq(imagingStudy.patientId, patientId),
        eq(imagingStudy.studyInstanceUid, studyUid),
        isNull(patientDocument.retiredAt),
      ),
    )
    .limit(1)
  if (existing) {
    if (existing.study.completedAt)
      return {
        document: await getPatientDocument(tx, orgId, patientId, existing.study.documentId),
        state: "exists",
        files: [],
      }
    const stored = await tx
      .select({ index: imagingStudyFile.fileIndex, sopInstanceUid: imagingStudyFile.sopInstanceUid })
      .from(imagingStudyFile)
      .where(
        and(
          eq(imagingStudyFile.documentId, existing.study.documentId),
          eq(imagingStudyFile.organizationId, orgId),
        ),
      )
      .orderBy(asc(imagingStudyFile.fileIndex))
    return {
      document: await getPatientDocument(tx, orgId, patientId, existing.study.documentId),
      state: "resumed",
      files: stored,
    }
  }

  const folder = `patients/${orgId}/${patientId}/cbct-${crypto.randomUUID()}/`
  const document = await registerPatientDocument(tx, orgId, actorUserId, patientId, {
    category: "radiografia",
    label: input.label,
    storageKey: folder,
    contentType: "application/dicom",
    sizeBytes: total,
    imageType: "tomografia",
    capturedAt: input.capturedAt ?? undefined,
    source: input.source ?? undefined,
    toothNumbers: input.toothNumbers ?? undefined,
  })
  await tx.insert(imagingStudy).values({
    documentId: document.id,
    organizationId: orgId,
    patientId,
    studyInstanceUid: studyUid,
    dicomPatientName: patientName,
    modality,
    fileCount: files.length,
    totalBytes: total,
    sliceCount: input.sliceCount,
    voxelMm: voxel,
  })
  const rows = files.map((file, index) => ({
    organizationId: orgId,
    documentId: document.id,
    fileIndex: index,
    storageKey: `${folder}${String(index + 1).padStart(5, "0")}.dcm`,
    sizeBytes: file.sizeBytes,
    sopInstanceUid: file.sopInstanceUid,
    seriesInstanceUid: file.seriesInstanceUid,
  }))
  for (let at = 0; at < rows.length; at += 1000) {
    await tx.insert(imagingStudyFile).values(rows.slice(at, at + 1000))
  }
  await audit(tx, orgId, actorUserId, "imaging_study.started", document.id, {
    patientId,
    fileCount: files.length,
    totalBytes: total,
  })
  return {
    document: await getPatientDocument(tx, orgId, patientId, document.id),
    state: "new",
    files: rows.map((row, index) => ({ index, sopInstanceUid: row.sopInstanceUid })),
  }
}

/**
 * Marca como recibidos los archivos que la ruta ya comprobó en el bucket
 * (existen, pesan lo anunciado y son DICOM). Con el último, la tomografía
 * queda completa.
 */
export async function markImagingFilesUploaded(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  documentId: string,
  indexes: readonly number[],
): Promise<ImagingProgress> {
  const { study, retiredAt } = await requireStudy(tx, orgId, patientId, documentId)
  if (retiredAt) throw new ServiceError("DOCUMENT_RETIRED", 409, "La tomografía está retirada")
  if (indexes.length && !study.completedAt) {
    await tx
      .update(imagingStudyFile)
      .set({ uploadedAt: new Date() })
      .where(
        and(
          eq(imagingStudyFile.documentId, documentId),
          eq(imagingStudyFile.organizationId, orgId),
          inArray(imagingStudyFile.fileIndex, [...new Set(indexes)]),
          isNull(imagingStudyFile.uploadedAt),
        ),
      )
  }
  const progress = await imagingProgress(tx, orgId, documentId)
  if (!progress.completedAt && progress.uploadedCount === progress.fileCount) {
    // Bloquea la fila: solo una confirmación cierra la subida.
    const [locked] = await tx
      .select({ completedAt: imagingStudy.completedAt })
      .from(imagingStudy)
      .where(and(eq(imagingStudy.documentId, documentId), eq(imagingStudy.organizationId, orgId)))
      .for("update")
    if (!locked?.completedAt) {
      const completedAt = new Date()
      await tx
        .update(imagingStudy)
        .set({ completedAt })
        .where(and(eq(imagingStudy.documentId, documentId), eq(imagingStudy.organizationId, orgId)))
      await audit(tx, orgId, actorUserId, "imaging_study.completed", documentId, {
        patientId,
        fileCount: progress.fileCount,
      })
      return { ...progress, completedAt }
    }
  }
  return progress
}

/** Guarda la miniatura que armó el navegador con el corte del medio. */
export async function setImagingThumbnail(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
  thumbnailKey: string,
): Promise<void> {
  const { retiredAt } = await requireStudy(tx, orgId, patientId, documentId)
  if (retiredAt) throw new ServiceError("DOCUMENT_RETIRED", 409, "La tomografía está retirada")
  await tx
    .update(imagingStudy)
    .set({ thumbnailKey })
    .where(and(eq(imagingStudy.documentId, documentId), eq(imagingStudy.organizationId, orgId)))
}

/**
 * Cancela una subida a medias: el documento se retira con su motivo (no se
 * borra nada). Una tomografía completa se retira como cualquier archivo.
 */
export async function cancelImagingUpload(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  documentId: string,
): Promise<void> {
  const { study, retiredAt } = await requireStudy(tx, orgId, patientId, documentId)
  if (retiredAt) return
  if (study.completedAt)
    throw new ServiceError(
      "IMAGING_STUDY_COMPLETE",
      409,
      "La tomografía ya terminó de subirse: retírala con su motivo",
    )
  await retirePatientDocument(tx, orgId, actorUserId, patientId, documentId, {
    reason: IMAGING_UPLOAD_CANCEL_REASON,
  })
}

export interface ImagingUploadRow {
  documentId: string
  label: string
  capturedAt: Date | null
  createdAt: Date
  fileCount: number
  uploadedCount: number
  totalBytes: number
  completedAt: Date | null
}

/**
 * Tomografías de la ficha con su avance, sin su contenido: es lo que ve quien
 * las recibe sin leer la historia clínica.
 */
export async function listImagingUploads(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<ImagingUploadRow[]> {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx
    .select({
      documentId: imagingStudy.documentId,
      label: patientDocument.label,
      capturedAt: patientDocument.capturedAt,
      createdAt: patientDocument.createdAt,
      fileCount: imagingStudy.fileCount,
      totalBytes: imagingStudy.totalBytes,
      completedAt: imagingStudy.completedAt,
      uploadedCount: sql<number>`(
        select count(*)::int from ${imagingStudyFile}
        where ${imagingStudyFile.documentId} = ${imagingStudy.documentId}
          and ${imagingStudyFile.organizationId} = ${imagingStudy.organizationId}
          and ${imagingStudyFile.uploadedAt} is not null
      )`,
    })
    .from(imagingStudy)
    .innerJoin(
      patientDocument,
      and(
        eq(patientDocument.organizationId, imagingStudy.organizationId),
        eq(patientDocument.id, imagingStudy.documentId),
      ),
    )
    .where(
      and(
        eq(imagingStudy.organizationId, orgId),
        eq(imagingStudy.patientId, patientId),
        isNull(patientDocument.retiredAt),
      ),
    )
    .orderBy(sql`${patientDocument.createdAt} desc`)
  return rows.map((row) => ({ ...row, uploadedCount: Number(row.uploadedCount) }))
}

export interface ImagingStudyFileRow {
  index: number
  storageKey: string
  sizeBytes: number
  sopInstanceUid: string
  seriesInstanceUid: string
}

/** Archivos de una tomografía completa, en orden, para verla o descargarla. */
export async function getImagingStudyFiles(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
): Promise<{ study: typeof imagingStudy.$inferSelect; files: ImagingStudyFileRow[] }> {
  const { study } = await requireStudy(tx, orgId, patientId, documentId)
  if (!study.completedAt)
    throw new ServiceError("IMAGING_UPLOAD_PENDING", 409, "La tomografía aún no termina de subirse")
  const files = await tx
    .select({
      index: imagingStudyFile.fileIndex,
      storageKey: imagingStudyFile.storageKey,
      sizeBytes: imagingStudyFile.sizeBytes,
      sopInstanceUid: imagingStudyFile.sopInstanceUid,
      seriesInstanceUid: imagingStudyFile.seriesInstanceUid,
    })
    .from(imagingStudyFile)
    .where(and(eq(imagingStudyFile.documentId, documentId), eq(imagingStudyFile.organizationId, orgId)))
    .orderBy(asc(imagingStudyFile.fileIndex))
  return { study, files }
}

/**
 * ¿Es un archivo DICOM lo que llegó? PS3.10 §7.1: 128 bytes de preámbulo y la
 * marca «DICM». Lo usa la ruta al comprobar cada archivo subido.
 */
export function looksLikeDicom(head: Uint8Array): boolean {
  return head.length >= 132 && head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d
}
