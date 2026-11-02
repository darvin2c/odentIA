/**
 * Lo emitido no cambia (ADR 0132): receta, orden y descanso se guardan una sola vez y
 * desde ahí se sirve ese archivo; la base no deja reescribir lo que dicen, y la huella
 * pública sirve para reconocer un PDF sin decir nada de su contenido.
 */
import { createHash, randomUUID } from "node:crypto"
import { patient, prescription } from "@odentia/db/schema/clinical"
import {
  clinicalOrder,
  issuedPaper,
  medicalLeave,
  professionalProfile,
} from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { PDFDocument } from "pdf-lib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { getAttentionSheetPrint } from "./attention-sheet.js"
import {
  advanceClinicalOrder,
  cancelClinicalOrder,
  createClinicalOrder,
  getOrderPrint,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { configureDocumentChecks, readDocumentCheck } from "./document-check.js"
import { DocumentKit, stampVoidedPdf } from "./document-kit.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { keepIssuedPaper, renderHealthDocumentPdf } from "./health-documents.js"
import { createMedicalLeave } from "./medical-leaves.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { configurePublicLinks } from "./public-links.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  configureDocumentChecks(KEY)
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
})

afterEach(() => {
  configureDocumentChecks(null)
  configurePublicLinks(null)
})

function fakeStorage() {
  const files = new Map<string, Uint8Array>()
  let puts = 0
  return {
    files,
    puts: () => puts,
    storage: {
      putPatientDocument: async ({ bytes }: { bytes: Uint8Array }) => {
        puts += 1
        const objectKey = `org_a/${randomUUID()}.pdf`
        files.set(objectKey, bytes)
        return { objectKey, mimeType: "application/pdf", filename: "x.pdf", size: bytes.byteLength }
      },
      deleteAttachment: async (key: string) => void files.delete(key),
      getAttachment: async (key: string) => files.get(key)!,
    },
  }
}

const ITEM = {
  genericName: "Amoxicilina",
  strength: "500 mg",
  dosageForm: "tableta",
  dose: "1 tableta",
  route: "oral",
  frequency: "cada 8 horas",
  duration: "5 días",
  quantity: 15,
}

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

function issue(f: Fixture) {
  return f.run((tx) => createPrescription(tx, ...f.args, { items: [ITEM] } as never))
}

function open(
  f: Fixture,
  type: "prescription" | "order" | "medical_leave" | "attention_sheet",
  id: string,
  storage: ReturnType<typeof fakeStorage>["storage"],
) {
  return f.run((tx) => renderHealthDocumentPdf(tx, "org_a", f.patient.id, type, id, storage))
}

async function renamePatient(f: Fixture, givenNames: string) {
  const [row] = await ownerDb
    .select({ personId: patient.personId })
    .from(patient)
    .where(eq(patient.id, f.patient.id))
  await ownerDb
    .update(contact)
    .set({ givenNames, familyName: "Cambiada" })
    .where(eq(contact.id, row!.personId))
}

const rowOf = async (documentId: string) =>
  ownerDb
    .select()
    .from(issuedPaper)
    .where(and(eq(issuedPaper.organizationId, "org_a"), eq(issuedPaper.documentId, documentId)))

it("la receta se guarda una vez y sigue igual aunque cambie la persona", async () => {
  const f = await clinicalFixture()
  const { storage, puts, files } = fakeStorage()
  const rx = await issue(f)

  await keepIssuedPaper({
    run: f.run,
    storage,
    orgId: "org_a",
    patientId: f.patient.id,
    type: "prescription",
    documentId: rx.id,
  })
  const [row] = await rowOf(rx.id)
  expect(puts()).toBe(1)
  const original = files.get(row!.storageKey)!
  expect(createHash("sha256").update(original).digest("hex")).toBe(row!.sha256)

  await renamePatient(f, "Otro Nombre")
  await ownerDb
    .update(professionalProfile)
    .set({ registrationNumber: "99999" })
    .where(eq(professionalProfile.userId, f.actor))

  const again = await open(f, "prescription", rx.id, storage)
  expect(Buffer.from(again.bytes).equals(Buffer.from(original))).toBe(true)
  expect(puts()).toBe(1)
  expect(await rowOf(rx.id)).toHaveLength(1)
  // El QR deja cotejarlo con lo que dice el papel, no con el nombre de hoy.
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id))
  expect(check?.patientInitials).toBe("P. D. P.")

  // Otro archivo en su lugar no se hace pasar por el emitido.
  files.set(row!.storageKey, new Uint8Array([...original, 32]))
  await expect(open(f, "prescription", rx.id, storage)).rejects.toMatchObject({
    code: "PAPER_ALTERED",
  })
})

it("emitido antes de esto: se guarda la primera vez que se abre", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const rx = await issue(f)
  expect(await rowOf(rx.id)).toHaveLength(0)
  const first = await open(f, "prescription", rx.id, storage)
  expect(await rowOf(rx.id)).toHaveLength(1)
  expect((await open(f, "prescription", rx.id, storage)).bytes).toEqual(first.bytes)
})

it("anular pone el sello encima y no toca el original", async () => {
  const f = await clinicalFixture()
  const { storage, files } = fakeStorage()
  const rx = await issue(f)
  const issued = await open(f, "prescription", rx.id, storage)
  await f.run((tx) => cancelPrescription(tx, ...f.args, rx.id, { reason: "Se equivocó de dosis" }))

  const voided = await open(f, "prescription", rx.id, storage)
  expect(Buffer.from(voided.bytes).equals(Buffer.from(issued.bytes))).toBe(false)
  expect((await PDFDocument.load(voided.bytes)).getPageCount()).toBe(
    (await PDFDocument.load(issued.bytes)).getPageCount(),
  )
  const [row] = await rowOf(rx.id)
  expect(Buffer.from(files.get(row!.storageKey)!).equals(Buffer.from(issued.bytes))).toBe(true)

  // La huella sigue siendo la del original: un PDF que ya tenía se reconoce.
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id))
  expect(check?.state).toBe("anulado")
  expect(check?.fingerprints).toEqual([row!.sha256])
})

it("un anulado que nunca se guardó sale con su aviso y no se guarda", async () => {
  const f = await clinicalFixture()
  const { storage, puts } = fakeStorage()
  const rx = await issue(f)
  await f.run((tx) => cancelPrescription(tx, ...f.args, rx.id, { reason: "Duplicada" }))
  expect((await open(f, "prescription", rx.id, storage)).bytes.byteLength).toBeGreaterThan(0)
  expect(puts()).toBe(0)
  expect(await rowOf(rx.id)).toHaveLength(0)
})

it("sin QR no se guarda: quedaría sin él para siempre", async () => {
  const f = await clinicalFixture()
  const { storage, puts } = fakeStorage()
  const rx = await issue(f)
  configureDocumentChecks(null)
  await open(f, "prescription", rx.id, storage)
  expect(puts()).toBe(0)
  configureDocumentChecks(KEY)
  await open(f, "prescription", rx.id, storage)
  expect(puts()).toBe(1)
})

it("dos a la vez: vale el primero y el archivo que sobra se borra", async () => {
  const f = await clinicalFixture()
  const { storage, files, puts } = fakeStorage()
  const rx = await issue(f)
  const [a, b] = await Promise.all([
    open(f, "prescription", rx.id, storage),
    open(f, "prescription", rx.id, storage),
  ])
  expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
  expect(await rowOf(rx.id)).toHaveLength(1)
  expect(files.size).toBe(1)
  expect(puts()).toBeGreaterThanOrEqual(1)
})

it("si falla el guardado: verlo no se traba, enviarlo sí, y emitir nunca se deshace", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const failing = {
    ...storage,
    putPatientDocument: async () => {
      throw new Error("Almacenamiento caído")
    },
  }
  const rx = await issue(f)
  const signedBlock = vi.spyOn(DocumentKit.prototype, "signedBlock")
  const seen = await f.run((tx) =>
    renderHealthDocumentPdf(tx, "org_a", f.patient.id, "prescription", rx.id, failing, {
      viewing: true,
    }),
  )
  expect(seen.bytes.byteLength).toBeGreaterThan(0)
  // Sin QR: lo que se guarde después no coincidiría con este archivo.
  expect(signedBlock.mock.calls.at(-1)?.[0]).toMatchObject({ checkUrl: null })
  signedBlock.mockRestore()
  await expect(
    f.run((tx) =>
      renderHealthDocumentPdf(tx, "org_a", f.patient.id, "prescription", rx.id, failing),
    ),
  ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" })
  await expect(
    keepIssuedPaper({
      run: f.run,
      storage: failing,
      orgId: "org_a",
      patientId: f.patient.id,
      type: "prescription",
      documentId: rx.id,
    }),
  ).resolves.toBeUndefined()
  expect(await rowOf(rx.id)).toHaveLength(0)
})

it("la base no deja reescribir una receta ni un descanso; anular sí, y una sola vez", async () => {
  const f = await clinicalFixture()
  const rx = await issue(f)
  const leave = await f.run((tx) => createMedicalLeave(tx, ...f.args, { days: 2 }))

  for (const change of [
    { notes: "Cambiada" },
    { prescriberName: "Otra persona" },
    { validUntil: "2099-01-01" },
    { issuedAt: new Date("2020-01-01") },
  ])
    await expect(
      f.run((tx) => tx.update(prescription).set(change).where(eq(prescription.id, rx.id))),
    ).rejects.toThrow()
  await expect(
    f.run((tx) =>
      tx.update(medicalLeave).set({ notes: "Cambiada" }).where(eq(medicalLeave.id, leave.id)),
    ),
  ).rejects.toThrow()
  await expect(
    f.run((tx) =>
      tx.update(medicalLeave).set({ signerName: "Otra" }).where(eq(medicalLeave.id, leave.id)),
    ),
  ).rejects.toThrow()
  // Ni siquiera quien tiene la conexión dueña de la base, sin apartar la guarda.
  await expect(
    ownerDb.update(prescription).set({ notes: "Cambiada" }).where(eq(prescription.id, rx.id)),
  ).rejects.toThrow()

  await f.run((tx) => cancelPrescription(tx, ...f.args, rx.id, { reason: "Duplicada" }))
  // Anulada, no vuelve a valer ni cambia su motivo.
  await expect(
    f.run((tx) =>
      tx
        .update(prescription)
        .set({ status: "emitida", cancelledAt: null, cancelledBy: null, cancelReason: null })
        .where(eq(prescription.id, rx.id)),
    ),
  ).rejects.toThrow()
  await expect(
    f.run((tx) =>
      tx
        .update(prescription)
        .set({ cancelReason: "Otro motivo" })
        .where(eq(prescription.id, rx.id)),
    ),
  ).rejects.toThrow()
})

it("la orden: lo pedido no cambia, su avance sí; y guarda quién firmó aunque cambie su perfil", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const order = await f.run((tx) =>
    createClinicalOrder(tx, "org_a", f.actor, {
      patientId: f.patient.id,
      kind: "laboratorio",
      recipient: "Laboratorio Central",
      title: "Hemograma",
    }),
  )
  expect(order.signerRegistration).toBe("COP 12345")

  await expect(
    f.run((tx) =>
      tx.update(clinicalOrder).set({ title: "Otra cosa" }).where(eq(clinicalOrder.id, order.id)),
    ),
  ).rejects.toThrow()
  await expect(
    f.run((tx) =>
      tx.update(clinicalOrder).set({ signerName: "Otra" }).where(eq(clinicalOrder.id, order.id)),
    ),
  ).rejects.toThrow()

  const issued = await open(f, "order", order.id, storage)
  await ownerDb
    .update(professionalProfile)
    .set({ registrationNumber: "99999" })
    .where(eq(professionalProfile.userId, f.actor))
  const print = await f.run((tx) => getOrderPrint(tx, "org_a", order.id))
  expect(print.requestedBy?.registration).toBe("COP 12345")
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "order", order.id))
  expect(check?.signer?.registration).toBe("COP 12345")

  // Avanzar y completar no cambia el papel.
  await f.run((tx) => advanceClinicalOrder(tx, "org_a", f.actor, order.id, "en_proceso"))
  await f.run((tx) =>
    advanceClinicalOrder(tx, "org_a", f.actor, order.id, "completado", "Hemoglobina normal"),
  )
  const done = await open(f, "order", order.id, storage)
  expect(Buffer.from(done.bytes).equals(Buffer.from(issued.bytes))).toBe(true)
})

it("la orden de quien no tiene colegiatura lleva su QR y puede cancelarse", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  await ownerDb
    .update(professionalProfile)
    .set({ registrationNumber: null })
    .where(eq(professionalProfile.userId, f.actor))
  const order = await f.run((tx) =>
    createClinicalOrder(tx, "org_a", f.actor, {
      patientId: f.patient.id,
      kind: "imagen",
      recipient: "Centro de imágenes",
      title: "Radiografía",
    }),
  )
  expect(order.signerName).toBeNull()
  const paper = await open(f, "order", order.id, storage)
  expect(paper.bytes.byteLength).toBeGreaterThan(0)
  const [row] = await rowOf(order.id)
  expect(row).toBeTruthy()
  await f.run((tx) => cancelClinicalOrder(tx, "org_a", f.actor, order.id, "Ya no hace falta"))
  expect((await f.run((tx) => readDocumentCheck(tx, "org_a", "order", order.id)))?.state).toBe(
    "anulado",
  )
})

it("el descanso se guarda igual, y la huella pública no dice lo que contiene", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const leave = await f.run((tx) => createMedicalLeave(tx, ...f.args, { days: 3, notes: "Reposo" }))
  const before = await f.run((tx) => readDocumentCheck(tx, "org_a", "medical_leave", leave.id))
  expect(before?.fingerprints).toEqual([])
  const paper = await open(f, "medical_leave", leave.id, storage)
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "medical_leave", leave.id))
  expect(check?.fingerprints).toEqual([createHash("sha256").update(paper.bytes).digest("hex")])
  expect(JSON.stringify(check)).not.toContain("Reposo")
})

it("el sello cabe con un motivo largo y con letras que la fuente no tiene", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const rx = await issue(f)
  const { bytes } = await open(f, "prescription", rx.id, storage)
  const stamped = await stampVoidedPdf(bytes, {
    word: "ANULADA",
    reason: `${"motivo ".repeat(200)}🙂`,
  })
  expect((await PDFDocument.load(stamped)).getPageCount()).toBe(1)
  expect(Buffer.from(stamped).equals(Buffer.from(bytes))).toBe(false)
})

it("la hoja de atención sale de la atención firmada, con lo que piden los seguros y sin la evolución", async () => {
  const f = await clinicalFixture()
  const { storage, puts } = fakeStorage()
  const encounterId = f.encounter.id
  await f.ready(encounterId)
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, encounterId, { serviceId: f.service.id }),
  )
  const order = (kind: "laboratorio" | "interconsulta", title: string) =>
    f.run((tx) =>
      createClinicalOrder(tx, "org_a", f.actor, {
        patientId: f.patient.id,
        encounterId,
        kind,
        recipient: "Centro",
        title,
      }),
    )
  await order("laboratorio", "Hemograma")
  await order("interconsulta", "Interconsulta con endodoncia")
  const cancelled = await order("laboratorio", "Examen que no va")
  await f.run((tx) => cancelClinicalOrder(tx, "org_a", f.actor, cancelled.id, "Ya no hace falta"))

  // Sin firmar no hay hoja: nadie la confunde con un papel que vale.
  await expect(
    f.run((tx) => renderHealthDocumentPdf(tx, "org_a", f.patient.id, "attention_sheet", encounterId, storage)),
  ).rejects.toMatchObject({ code: "ATTENTION_NOT_SIGNED" })
  expect(await f.run((tx) => readDocumentCheck(tx, "org_a", "attention_sheet", encounterId))).toBeNull()

  await f.run((tx) => finalizeEncounter(tx, ...f.args, encounterId, {}))

  const print = await f.run((tx) => getAttentionSheetPrint(tx, "org_a", f.patient.id, encounterId))
  expect(print.diagnoses.join()).toContain("K02.1")
  expect(print.procedures.join()).toContain("Tratamiento propio")
  // Solo lo que se manda a hacer: ni una derivación ni lo cancelado.
  expect(print.exams).toEqual(["Orden de laboratorio: Hemograma"])
  // Lo ya hecho va en procedimientos: el seguro no debe leerlo como pendiente.
  expect(print.treatments.join()).not.toContain("Tratamiento propio")
  expect(print.encounter.signerRegistration).toBe("COP 12345")

  const text = vi.spyOn(DocumentKit.prototype, "text")
  const bullets = vi.spyOn(DocumentKit.prototype, "bullets")
  const signedBlock = vi.spyOn(DocumentKit.prototype, "signedBlock")
  const paper = await open(f, "attention_sheet", encounterId, storage)
  const written = JSON.stringify([...text.mock.calls, ...bullets.mock.calls])
  expect(written).toContain("Hemograma")
  // La evolución no sale de la clínica: nadie la pide.
  expect(written).not.toContain("Evolución favorable")
  expect(signedBlock.mock.calls[0]?.[0]).toMatchObject({
    name: print.encounter.signerName,
    credential: "Cirujano dentista · COP 12345",
  })
  vi.restoreAllMocks()

  // Queda fija, y el QR la reconoce con sus iniciales aunque se corrija el nombre.
  await renamePatient(f, "Otro Nombre")
  const again = await open(f, "attention_sheet", encounterId, storage)
  expect(Buffer.from(again.bytes).equals(Buffer.from(paper.bytes))).toBe(true)
  expect(puts()).toBe(1)
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "attention_sheet", encounterId))
  expect(check).toMatchObject({ state: "vigente", label: "Hoja de atención", patientInitials: "P. D. P." })
  expect(check?.fingerprints).toEqual([createHash("sha256").update(paper.bytes).digest("hex")])
  expect(JSON.stringify(check)).not.toContain("K02.1")
})

it("si el almacenamiento tarda, emitir responde igual y el archivo se guarda después", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const rx = await issue(f)
  let release: () => void = () => {}
  const slow = {
    ...storage,
    putPatientDocument: async (input: { bytes: Uint8Array }) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return storage.putPatientDocument(input)
    },
  }
  await keepIssuedPaper({
    run: f.run,
    storage: slow,
    orgId: "org_a",
    patientId: f.patient.id,
    type: "prescription",
    documentId: rx.id,
    waitMs: 300,
  })
  // Ya respondió, y el archivo todavía no está.
  expect(await rowOf(rx.id)).toHaveLength(0)
  release()
  await vi.waitFor(async () => expect(await rowOf(rx.id)).toHaveLength(1), { timeout: 10_000 })
})

it("si no se puede leer lo guardado, lo dice y no muestra otra cosa", async () => {
  const f = await clinicalFixture()
  const { storage } = fakeStorage()
  const rx = await issue(f)
  await open(f, "prescription", rx.id, storage)
  const broken = {
    ...storage,
    getAttachment: async () => {
      throw new Error("Almacenamiento caído")
    },
  }
  await expect(
    f.run((tx) =>
      renderHealthDocumentPdf(tx, "org_a", f.patient.id, "prescription", rx.id, broken, {
        viewing: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503 })
})

it("la orden pedida sin colegiatura no gana firmante cuando después la registran", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .update(professionalProfile)
    .set({ registrationNumber: null })
    .where(eq(professionalProfile.userId, f.actor))
  const order = await f.run((tx) =>
    createClinicalOrder(tx, "org_a", f.actor, {
      patientId: f.patient.id,
      kind: "imagen",
      recipient: "Centro de imágenes",
      title: "Radiografía",
    }),
  )
  await ownerDb
    .update(professionalProfile)
    .set({ registrationNumber: "12345" })
    .where(eq(professionalProfile.userId, f.actor))
  const print = await f.run((tx) => getOrderPrint(tx, "org_a", order.id))
  expect(print.requestedBy).toBeNull()
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "order", order.id))
  expect(check?.signer).toBeNull()
})
