import { randomUUID } from "node:crypto"
import { patientDocument, paymentTicket, prescription } from "@odentia/db/schema/clinical"
import { consentDocument, consentTemplate, issuedPaper, medicalLeave } from "@odentia/db/schema/clinical-forms"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { collectPortalPapers } from "./portal-papers.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function file(
  patientId: string,
  values: Partial<typeof patientDocument.$inferInsert> & { category: string; label: string },
): Promise<string> {
  const [row] = await ownerDb
    .insert(patientDocument)
    .values({
      organizationId: "org_a",
      patientId,
      storageKey: `org_a/${randomUUID()}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1024,
      ...values,
    })
    .returning({ id: patientDocument.id })
  return row!.id
}

it("el portal muestra cada papel una vez: el PDF del consentimiento y su hoja escaneada van dentro de él", async () => {
  const f = await clinicalFixture()
  const pdf = await file(f.patient.id, { category: "consentimiento", label: "Consentimiento firmado" })
  const paper = await file(f.patient.id, { category: "consentimiento", label: "Hoja escaneada", contentType: "image/jpeg" })
  const [template] = await ownerDb
    .insert(consentTemplate)
    .values({ organizationId: "org_a", key: `exo-${randomUUID().slice(0, 8)}`, title: "Exodoncia", body: "Texto", status: "publicado" })
    .returning()
  await ownerDb.insert(consentDocument).values({
    organizationId: "org_a",
    templateId: template!.id,
    templateVersion: 1,
    bodySnapshot: "Texto",
    titleSnapshot: "Exodoncia",
    patientId: f.patient.id,
    signerName: "Paciente de prueba",
    status: "firmado",
    signedAt: new Date(),
    pdfDocumentId: pdf,
    pdfSha256: "0".repeat(64),
    signatureMethod: "papel",
    paperDocumentId: paper,
  })
  const papers = await f.run((tx) => collectPortalPapers(tx, "org_a", f.patient.id, { account: true }))
  expect(papers.filter((item) => item.type === "Consentimiento")).toEqual([
    expect.objectContaining({ kind: "consentimiento", title: "Exodoncia", stateWord: null }),
  ])
  expect(papers.some((item) => item.id === pdf || item.id === paper)).toBe(false)
})

it("solo lo terminado: lo anulado marcado, la imagen con su informe y nada oculto ni la tomografía", async () => {
  const f = await clinicalFixture()
  const at = (days: number) => new Date(Date.now() - days * 86_400_000)
  const [{ next }] = (await ownerDb.execute<{ next: number }>(
    sql`select coalesce(max(prescription_number), 0) + 1 as next from prescription where organization_id = 'org_a'`,
  )) as unknown as Array<{ next: number }>
  await ownerDb.insert(prescription).values([
    { organizationId: "org_a", patientId: f.patient.id, prescriptionNumber: Number(next), issuedAt: at(5) },
    {
      organizationId: "org_a",
      patientId: f.patient.id,
      prescriptionNumber: Number(next) + 1,
      status: "anulada",
      issuedAt: at(4),
      cancelledAt: at(3),
      cancelledBy: f.actor,
      cancelReason: "Dosis equivocada",
    },
    {
      organizationId: "org_a",
      patientId: f.patient.id,
      prescriptionNumber: Number(next) + 2,
      issuedAt: at(40),
      validUntil: at(10).toISOString().slice(0, 10),
    },
  ])
  const [{ leave }] = (await ownerDb.execute<{ leave: number }>(
    sql`select coalesce(max(leave_number), 0) + 1 as leave from medical_leave where organization_id = 'org_a'`,
  )) as unknown as Array<{ leave: number }>
  await ownerDb.insert(medicalLeave).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    leaveNumber: Number(leave),
    startsOn: "2026-11-01",
    days: 2,
    endsOn: "2026-11-02",
    issuedAt: at(2),
  })
  await ownerDb.insert(issuedPaper).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    documentType: "attention_sheet",
    documentId: f.encounter.id,
    storageKey: `org_a/${randomUUID()}.pdf`,
    sha256: "a".repeat(64),
    sizeBytes: 10,
    patientInitials: "PP",
  })
  const shown = await file(f.patient.id, { category: "radiografia", label: "Panorámica", reportStatus: "informado", contentType: "image/jpeg" })
  const unread = await file(f.patient.id, { category: "radiografia", label: "Periapical", reportStatus: "pendiente", contentType: "image/jpeg" })
  const cbct = await file(f.patient.id, { category: "radiografia", label: "Tomografía", imageType: "tomografia", reportStatus: "informado", contentType: "application/zip" })
  const hidden = await file(f.patient.id, {
    category: "otro",
    label: "DNI escaneado",
    portalHiddenAt: new Date(),
    portalHiddenBy: f.actor,
  })
  const retired = await file(f.patient.id, {
    category: "foto_clinica",
    label: "Foto equivocada",
    reportStatus: "no_requiere",
    retiredAt: new Date(),
    retiredBy: f.actor,
    retireReason: "Paciente equivocado",
  })
  const [{ ticketNo }] = (await ownerDb.execute<{ ticketNo: number }>(
    sql`select coalesce(max(ticket_number), 0) + 1 as "ticketNo" from payment_ticket where organization_id = 'org_a'`,
  )) as unknown as Array<{ ticketNo: number }>
  const [branchRow] = (await ownerDb.execute<{ id: string }>(
    sql`select id from branch where organization_id = 'org_a' limit 1`,
  )) as unknown as Array<{ id: string }>
  if (branchRow) {
    await ownerDb.insert(paymentTicket).values({
      organizationId: "org_a",
      patientId: f.patient.id,
      branchId: branchRow.id,
      ticketNumber: Number(ticketNo),
      currency: "PEN",
      totalCents: 1000,
      snapshot: {},
      voidedAt: at(1),
      voidedBy: f.actor,
      voidReason: "Cobro duplicado",
    })
  }

  const papers = await f.run((tx) => collectPortalPapers(tx, "org_a", f.patient.id, { account: true }))
  const recipes = papers.filter((item) => item.kind === "receta")
  expect(recipes).toHaveLength(3)
  expect(recipes.find((item) => item.title === `Receta N.º ${Number(next) + 1}`)?.stateWord).toBe("Anulada")
  expect(recipes.find((item) => item.title === `Receta N.º ${Number(next) + 2}`)?.stateWord).toBe("Vencida")
  expect(recipes.find((item) => item.title === `Receta N.º ${Number(next)}`)?.stateWord).toBeNull()
  expect(papers.find((item) => item.kind === "descanso")).toMatchObject({ type: "Descanso médico", stateWord: null })
  expect(papers.find((item) => item.kind === "hoja")).toMatchObject({ id: f.encounter.id })
  const ids = papers.map((item) => item.id)
  expect(ids).toContain(shown)
  expect(papers.find((item) => item.id === shown)).toMatchObject({ type: "Radiografía", image: true })
  for (const id of [unread, cbct, hidden, retired]) expect(ids).not.toContain(id)
  if (branchRow) {
    expect(papers.find((item) => item.kind === "comprobante")).toMatchObject({ stateWord: "Anulado" })
    // Sin la cuenta, el comprobante no sale: es de la cuenta.
    const noAccount = await f.run((tx) => collectPortalPapers(tx, "org_a", f.patient.id, { account: false }))
    expect(noAccount.some((item) => item.kind === "comprobante")).toBe(false)
  }
  // Lo más reciente primero, y nada dice su código interno.
  const times = papers.map((item) => item.at)
  expect([...times].sort().reverse()).toEqual(times)
  expect(papers.some((item) => /_/.test(item.type))).toBe(false)
})
