import { withOrgContext } from "@odentia/db"
import { imagingStudy, imagingStudyFile } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { getPatientDocument, listPatientDocuments } from "./clinical.js"
import {
  cancelImagingUpload,
  getImagingStudyFiles,
  listImagingUploads,
  looksLikeDicom,
  markImagingFilesUploaded,
  pendingImagingFiles,
  startImagingStudyUpload,
} from "./imaging-studies.js"
import { createPatient } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-imaging"
const STUDY = "2.25.34001"

async function seed() {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Tests', 'imaging@example.com')
        on conflict ("id") do nothing`,
  )
  return withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Carmen Díaz" }),
  )
}

const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    sopInstanceUid: `${STUDY}.4.${i + 1}`,
    seriesInstanceUid: `${STUDY}.2`,
    sizeBytes: 1000 + i,
  }))

function input(n = 3) {
  return {
    label: "Tomografía (CBCT)",
    studyInstanceUid: STUDY,
    dicomPatientName: "DIAZ ROJAS^CARMEN",
    modality: "CT",
    sliceCount: n,
    voxelMm: 0.2,
    toothNumbers: [36],
    files: files(n),
  }
}

it("una tomografía es un documento con sus archivos, completo cuando llegaron todos", async () => {
  const patient = await seed()
  const started = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input()),
  )
  expect(started.state).toBe("new")
  expect(started.document).toMatchObject({
    category: "radiografia",
    imageType: "tomografia",
    contentType: "application/dicom",
    sizeBytes: 3003,
    reportStatus: "pendiente",
    toothNumbers: [36],
  })
  expect(started.document.imaging).toMatchObject({ fileCount: 3, uploadedCount: 0, completedAt: null })
  const id = started.document.id

  const pending = await withOrgContext(appDb, "org_a", (tx) =>
    pendingImagingFiles(tx, "org_a", patient.id, id),
  )
  expect(pending.map((f) => f.index)).toEqual([0, 1, 2])
  // Cada archivo en su clave dentro de la carpeta del estudio.
  expect(pending[0]!.storageKey.startsWith(started.document.storageKey)).toBe(true)

  const partial = await withOrgContext(appDb, "org_a", (tx) =>
    markImagingFilesUploaded(tx, "org_a", ACTOR, patient.id, id, [0, 1]),
  )
  expect(partial).toMatchObject({ uploadedCount: 2, completedAt: null })
  await expect(
    withOrgContext(appDb, "org_a", (tx) => getImagingStudyFiles(tx, "org_a", patient.id, id)),
  ).rejects.toMatchObject({ code: "IMAGING_UPLOAD_PENDING" })

  // Retomar el mismo estudio devuelve el mismo documento con lo que falta.
  const resumed = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input()),
  )
  expect(resumed).toMatchObject({ state: "resumed", document: { id } })
  const left = await withOrgContext(appDb, "org_a", (tx) =>
    pendingImagingFiles(tx, "org_a", patient.id, id),
  )
  expect(left.map((f) => f.index)).toEqual([2])

  const done = await withOrgContext(appDb, "org_a", (tx) =>
    markImagingFilesUploaded(tx, "org_a", ACTOR, patient.id, id, [2]),
  )
  expect(done.uploadedCount).toBe(3)
  expect(done.completedAt).toBeInstanceOf(Date)
  const study = await withOrgContext(appDb, "org_a", (tx) =>
    getImagingStudyFiles(tx, "org_a", patient.id, id),
  )
  expect(study.files.map((f) => f.index)).toEqual([0, 1, 2])

  // El mismo estudio no se guarda dos veces.
  const again = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input()),
  )
  expect(again).toMatchObject({ state: "exists", document: { id } })
  const listed = await withOrgContext(appDb, "org_a", (tx) =>
    listPatientDocuments(tx, "org_a", patient.id),
  )
  expect(listed.filter((doc) => doc.imageType === "tomografia")).toHaveLength(1)
  expect(listed[0]!.imaging).toMatchObject({ studyInstanceUid: STUDY, fileCount: 3, uploadedCount: 3 })
})

it("cancelar retira la subida a medias con su motivo y deja subirla de nuevo", async () => {
  const patient = await seed()
  const { document } = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input(2)),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    cancelImagingUpload(tx, "org_a", ACTOR, patient.id, document.id),
  )
  const retired = await withOrgContext(appDb, "org_a", (tx) =>
    getPatientDocument(tx, "org_a", patient.id, document.id),
  )
  expect(retired.retireReason).toBe("Subida cancelada")
  expect(
    await withOrgContext(appDb, "org_a", (tx) => listImagingUploads(tx, "org_a", patient.id)),
  ).toEqual([])
  const fresh = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input(2)),
  )
  expect(fresh.state).toBe("new")
  expect(fresh.document.id).not.toBe(document.id)
})

it("valida tope, archivos repetidos y UID de DICOM", async () => {
  const patient = await seed()
  const tooBig = { ...input(1), files: [{ ...files(1)[0]!, sizeBytes: 1024 ** 3 + 1 }] }
  await expect(
    withOrgContext(appDb, "org_a", (tx) => startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, tooBig)),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const repeated = { ...input(2), files: [files(1)[0]!, files(1)[0]!] }
  await expect(
    withOrgContext(appDb, "org_a", (tx) => startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, repeated)),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, { ...input(1), studyInstanceUid: "1.2.x" }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
})

it("otra clínica no ve ni completa la tomografía", async () => {
  const patient = await seed()
  const { document } = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input(1)),
  )
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      markImagingFilesUploaded(tx, "org_b", ACTOR, patient.id, document.id, [0]),
    ),
  ).rejects.toThrow()
  const rows = await withOrgContext(appDb, "org_b", (tx) =>
    tx.select().from(imagingStudyFile).where(eq(imagingStudyFile.documentId, document.id)),
  )
  expect(rows).toEqual([])
})

it("la base no deshace lo recibido ni deja borrar", async () => {
  const patient = await seed()
  const { document } = await withOrgContext(appDb, "org_a", (tx) =>
    startImagingStudyUpload(tx, "org_a", ACTOR, patient.id, input(1)),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    markImagingFilesUploaded(tx, "org_a", ACTOR, patient.id, document.id, [0]),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.update(imagingStudyFile).set({ uploadedAt: null }).where(eq(imagingStudyFile.documentId, document.id)),
    ),
  ).rejects.toThrow()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.update(imagingStudy).set({ completedAt: null }).where(eq(imagingStudy.documentId, document.id)),
    ),
  ).rejects.toThrow()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.delete(imagingStudyFile).where(eq(imagingStudyFile.documentId, document.id)),
    ),
  ).rejects.toThrow()
})

it("reconoce la marca DICM de PS3.10", () => {
  const head = new Uint8Array(132)
  expect(looksLikeDicom(head)).toBe(false)
  head.set([0x44, 0x49, 0x43, 0x4d], 128)
  expect(looksLikeDicom(head)).toBe(true)
})
