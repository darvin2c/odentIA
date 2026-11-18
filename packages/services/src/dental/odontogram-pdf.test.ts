/**
 * El odontograma firmado es un papel emitido (ADR 0132): su PDF se dibuja en el servidor
 * una sola vez, se guarda con su huella y desde ahí se sirve; el QR lo reconoce. La copia
 * de la historia lleva cada firmado y, además, el de hoy, marcado «sin firmar» y sin
 * guardarse. Fuera de Perú no hay firmados: solo el de hoy, en la hoja neutra.
 */
import { createHash, randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter } from "@odentia/db/schema/clinical"
import { issuedPaper } from "@odentia/db/schema/clinical-forms"
import { and, eq, sql } from "drizzle-orm"
import { PDFDocument } from "pdf-lib"
import { afterEach, beforeEach, expect, it } from "vitest"
import { makeSigner, readyToClose, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { configureDocumentChecks, readDocumentCheck } from "../document-check.js"
import { finalizeEncounter } from "../encounters.js"
import { nextPatientNumber } from "../patients.js"
import { productHooks } from "../products.js"
import { configurePublicLinks } from "../public-links.js"
import { insertTestPatients } from "../test-patient.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import { addOdontogramEntries, createOdontogramAssessment } from "./odontogram.js"
import { keepSignedOdontogramPaper, signedOdontogramPaper } from "./odontogram-pdf.js"

setupTestDb()

beforeEach(() => {
  configureDocumentChecks(Buffer.alloc(32, 7))
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
    puts: () => puts,
    storage: {
      putPatientDocument: async ({ bytes }: { bytes: Uint8Array }) => {
        puts += 1
        const objectKey = `org/${randomUUID()}.pdf`
        files.set(objectKey, bytes)
        return { objectKey, mimeType: "application/pdf", filename: "x.pdf", size: bytes.byteLength }
      },
      deleteAttachment: async (key: string) => void files.delete(key),
      getAttachment: async (key: string) => files.get(key)!,
    },
  }
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Clínica de otro país, armada en la prueba: la semilla sigue siendo peruana. */
async function colombianClinic(): Promise<string> {
  const id = `org_co_${randomUUID().slice(0, 8)}`
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, 'Clínica Bogotá', ${id}, now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${id}, 'Clínica Bogotá', 'CO', 'COP', 'America/Bogota', 'es-CO')`,
  )
  return id
}

/** Quien atiende y una persona de la clínica dada. */
async function attending(orgId: string) {
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Ana Torres", email: `${actor}@example.test` })
  await makeSigner(orgId, actor)
  await seedDiagnosisCodes([{ code: "K02.1", title: "Caries de la dentina" }])
  const [person] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Rosa Quispe",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const patientId = person!.id
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const open = async () => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({ organizationId: orgId, patientId, professionalUserId: actor, reason: "Control" })
      .returning()
    return row!.id
  }
  return { orgId, actor, patientId, run, open, args: [orgId, actor, patientId] as const }
}

/** Una atención que deja una caries y se firma: en Perú firma el odontograma de inicio. */
async function closeWithCaries(f: Awaited<ReturnType<typeof attending>>, tooth: number) {
  const draft = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: tooth,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
      encounterId: draft,
    }),
  )
  await readyToClose(f.orgId, f.actor, f.patientId, draft)
  return f.run((tx) => finalizeEncounter(tx, ...f.args, draft))
}

async function storedPapers(orgId: string, documentId: string) {
  return ownerDb
    .select()
    .from(issuedPaper)
    .where(and(eq(issuedPaper.organizationId, orgId), eq(issuedPaper.documentId, documentId)))
}

it("el odontograma firmado se emite una vez, con su huella, y se reutiliza", async () => {
  const f = await attending("org_a")
  const closed = await closeWithCaries(f, 16)
  const assessmentId = (closed.odontogram as { id: string }).id
  const { storage, puts } = fakeStorage()

  // Al firmar, la ruta lo deja guardado (como la receta).
  await keepSignedOdontogramPaper({
    run: f.run,
    storage,
    orgId: f.orgId,
    patientId: f.patientId,
    assessmentId,
  })
  expect(puts()).toBe(1)
  const [row] = await storedPapers(f.orgId, assessmentId)
  expect(row).toMatchObject({
    documentType: "signed_odontogram",
    patientId: f.patientId,
    patientInitials: "R. Q.",
  })

  // Verlo después es el mismo archivo, no uno dibujado de nuevo.
  const first = await f.run((tx) =>
    signedOdontogramPaper(tx, f.orgId, f.patientId, assessmentId, storage),
  )
  const again = await f.run((tx) =>
    signedOdontogramPaper(tx, f.orgId, f.patientId, assessmentId, storage, { viewing: true }),
  )
  expect(puts()).toBe(1)
  expect(sha(first.bytes)).toBe(row!.sha256)
  expect(sha(again.bytes)).toBe(row!.sha256)
  expect(first.label).toBe("Odontograma firmado · Inicio del plan de tratamiento")
  expect(first.signer).toBe("Ana Torres · Cirujano dentista · COP 12345")

  // Una hoja, con su título; el QR lo reconoce por su huella.
  const pdf = await PDFDocument.load(first.bytes)
  expect(pdf.getPageCount()).toBe(1)
  expect(pdf.getTitle()).toBe("Odontograma firmado")
  const check = await f.run((tx) =>
    readDocumentCheck(tx, f.orgId, "signed_odontogram", assessmentId),
  )
  expect(check).toMatchObject({
    state: "vigente",
    label: "Odontograma firmado",
    patientInitials: "R. Q.",
  })
  expect(check?.fingerprints).toEqual([row!.sha256])
})

it("lo firmado antes se guarda la primera vez que se pide", async () => {
  const f = await attending("org_a")
  const signed = await f.run((tx) =>
    createOdontogramAssessment(tx, ...f.args, {
      purpose: "personal",
      observations: "Para su seguro",
    }),
  )
  expect(await storedPapers(f.orgId, signed.id)).toEqual([])
  const { storage, puts } = fakeStorage()
  const paper = await f.run((tx) =>
    signedOdontogramPaper(tx, f.orgId, f.patientId, signed.id, storage, { viewing: true }),
  )
  expect(puts()).toBe(1)
  const [row] = await storedPapers(f.orgId, signed.id)
  expect(sha(paper.bytes)).toBe(row!.sha256)
  expect(paper.label).toBe("Odontograma firmado · A pedido de la persona")
})

it("la copia lleva cada odontograma firmado con su momento y el de hoy, sin firmar", async () => {
  const f = await attending("org_a")
  const closed = await closeWithCaries(f, 16)
  const assessmentId = (closed.odontogram as { id: string }).id
  // Después de firmar, algo nuevo en una atención abierta: está en el de hoy, no en el firmado.
  const draft = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 46,
      condition: "missing_tooth",
      encounterId: draft,
    }),
  )
  const { storage, puts } = fakeStorage()
  const papers = await f.run(async (tx) =>
    (await productHooks(tx, f.orgId)).recordPapers!(
      tx,
      { orgId: f.orgId, patientId: f.patientId },
      storage,
    ),
  )
  expect(papers.map((paper) => [paper.kind, paper.label, paper.mark])).toEqual([
    ["signed_odontogram", "Odontograma firmado · Inicio del plan de tratamiento", null],
    [
      "odontogram_today",
      expect.stringMatching(/^Odontograma · Estado al \d+ de \w+ de \d{4}$/),
      "sin firmar",
    ],
  ])
  const [signedPaper, today] = papers
  expect(signedPaper).toMatchObject({
    id: assessmentId,
    fileName: `Odontograma firmado - Inicio del plan (${assessmentId.slice(0, 8)}).pdf`,
    signer: "Ana Torres · Cirujano dentista · COP 12345",
  })
  // El firmado es el papel guardado; el de hoy no se guarda: su huella es la de lo que se dibujó.
  const [row] = await storedPapers(f.orgId, assessmentId)
  expect(signedPaper!.sha256).toBe(row!.sha256)
  expect(puts()).toBe(1)
  expect(today).toMatchObject({ id: `hoy-${f.patientId}`, signer: null })
  expect(today!.fileName).toMatch(/^Odontograma de hoy - sin firmar \(\d{4}-\d{2}-\d{2}\)\.pdf$/)
  expect(today!.sha256).toBe(sha(today!.bytes))
  expect((await PDFDocument.load(today!.bytes)).getTitle()).toBe("Odontograma sin firmar")

  // Pedirla otra vez no vuelve a guardar el firmado.
  await f.run(async (tx) =>
    (await productHooks(tx, f.orgId)).recordPapers!(
      tx,
      { orgId: f.orgId, patientId: f.patientId },
      storage,
    ),
  )
  expect(puts()).toBe(1)
})

it("fuera de Perú no hay firmados: solo el de hoy en la hoja neutra, si tiene hallazgos", async () => {
  const f = await attending(await colombianClinic())
  const ask = () =>
    f.run(async (tx) =>
      (await productHooks(tx, f.orgId)).recordPapers!(
        tx,
        { orgId: f.orgId, patientId: f.patientId },
        {},
      ),
    )
  expect(await ask()).toEqual([])
  const draft = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 26,
      condition: "caries",
      surfaces: ["occlusal"],
      encounterId: draft,
    }),
  )
  const papers = await ask()
  expect(papers.map((paper) => [paper.kind, paper.mark])).toEqual([
    ["odontogram_today", "sin firmar"],
  ])
  expect((await PDFDocument.load(papers[0]!.bytes)).getTitle()).toBe("Odontograma sin firmar")
})
