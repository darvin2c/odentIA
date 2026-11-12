import { odontogramAssessment } from "@odentia/db/schema/dental"
import { encounter, patientDocument, patientDocumentContext } from "@odentia/db/schema/clinical"
import { consentDocument, consentTemplate } from "@odentia/db/schema/clinical-forms"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createClinicalOrder } from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { voidEncounter } from "./encounters.js"
import { getTimeline } from "./patient-history.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("Historia: la atención anulada con su motivo y los papeles como hechos (ADR 0035)", async () => {
  const f = await clinicalFixture()
  // Una atención abierta por error se anula: queda en la historia con su motivo.
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Abierta por error" }))
  // Se pidió una radiografía y la persona firmó un consentimiento.
  await f.run((tx) =>
    createClinicalOrder(tx, "org_a", f.actor, {
      kind: "imagen",
      patientId: f.patient.id,
      title: "Radiografía panorámica",
      recipient: "Centro de imágenes",
    }),
  )
  const [template] = await ownerDb
    .insert(consentTemplate)
    .values({ organizationId: "org_a", key: "exodoncia", title: "Exodoncia", body: "Texto", status: "publicado" })
    .returning()
  const signedAt = new Date("2026-10-08T15:00:00Z")
  await ownerDb.insert(consentDocument).values({
    organizationId: "org_a",
    templateId: template!.id,
    templateVersion: 1,
    bodySnapshot: "Texto",
    titleSnapshot: "Exodoncia de la pieza 38",
    patientId: f.patient.id,
    signerName: "Paciente de prueba",
    status: "firmado",
    signedAt,
  })

  const all = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id))
  const voided = all.data.find((item) => item.type === "encounter")
  expect(voided).toMatchObject({ status: "anulada", voidReason: "Abierta por error" })
  expect(all.data.find((item) => item.type === "order")).toMatchObject({
    title: "Se pidió: Radiografía panorámica",
    detail: "Orden de imagen · sin resultado",
  })
  // El consentimiento sale a la hora en que se firmó, no cuando se preparó.
  const consent = all.data.find((item) => item.type === "consent")
  expect(consent).toMatchObject({ title: "Firmó: Exodoncia de la pieza 38", detail: "Lo firmó Paciente de prueba" })
  expect(consent?.createdAt.toISOString()).toBe(signedAt.toISOString())

  // «Atenciones» trae solo atenciones (también la anulada); los papeles no tienen filtro propio.
  const encounters = await f.run((tx) =>
    getTimeline(tx, "org_a", f.patient.id, { types: ["encounter"] }),
  )
  expect(encounters.data.map((item) => item.type)).toEqual(["encounter"])
})

it("el odontograma firmado es un hecho de la historia: el del botón aparte, el del cierre dentro de su atención", async () => {
  const f = await clinicalFixture()
  const signed = (encounterId: string | null, purpose: string) => ({
    organizationId: "org_a",
    patientId: f.patient.id,
    authorUserId: f.actor,
    purpose,
    specifications: "",
    observations: "",
    examinerName: "Dra. Ana Torres",
    examinerTitle: "Cirujano dentista",
    registrationNumber: "COP 12345",
    patientName: "Paciente de prueba",
    patientNumber: 1,
    entries: [],
    standard: "PE-NTS-188",
    encounterId,
  })
  const [manual] = await ownerDb.insert(odontogramAssessment).values(signed(null, "legal")).returning({ id: odontogramAssessment.id })
  const [closing] = await ownerDb.insert(odontogramAssessment).values(signed(f.encounter.id, "initial")).returning({ id: odontogramAssessment.id })
  // En la historia completa, el del cierre va dentro de su atención; el del botón, como su propio hecho.
  const all = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id))
  const facts = all.data.filter((item) => item.type === "odontogram_signed")
  expect(facts.map((item) => item.refId)).toEqual([manual!.id])
  expect(facts[0]).toMatchObject({ title: expect.stringMatching(/^Odontograma firmado · /), detail: "Dra. Ana Torres · COP 12345" })
  // Filtrando solo los firmados, salen los dos, con su atención.
  const only = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["odontogram_signed"] }))
  expect(only.data.map((item) => [item.refId, item.encounterId ?? null]).sort()).toEqual(
    [
      [manual!.id, null],
      [closing!.id, f.encounter.id],
    ].sort(),
  )
})

it("la Historia dice que la receta se anuló y por qué, como con la orden y el consentimiento", async () => {
  const f = await clinicalFixture()
  const item = { genericName: "Amoxicilina", strength: "500 mg", dosageForm: "tableta", dose: "1 tableta", route: "oral", frequency: "cada 8 horas", duration: "5 días", quantity: 15 }
  const rx = await f.run((tx) => createPrescription(tx, ...f.args, { items: [item] } as never))
  await f.run((tx) => cancelPrescription(tx, ...f.args, rx.id, { reason: "Se equivocó de dosis" }))
  const { data } = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id))
  const fact = data.find((entry) => entry.refId === rx.id)
  expect(fact?.title).toMatch(/^Se anuló la receta N\.º \d+$/)
  expect(fact?.detail).toContain("Se equivocó de dosis")
})

it("Historia: cada atención va el día en que empezó, aunque se haya cargado después, y la anulada también el día en que empezó (con su motivo y cuándo se anuló)", async () => {
  const f = await clinicalFixture()
  await f.run((tx) => voidEncounter(tx, ...f.args, f.encounter.id, { reason: "Abierta por error" }))
  // Firmadas como las cierra la app: primero en borrador (una por persona) y después finalizadas.
  const signed = async (startedAt: Date, createdAt: Date) => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({
        organizationId: "org_a",
        patientId: f.patient.id,
        professionalUserId: f.actor,
        reason: "Control",
        startedAt,
        createdAt,
        signerName: "Ana Torres",
        signerTitle: "Médica cirujana",
        signerRegistration: "12345",
      })
      .returning({ id: encounter.id })
    if (!row) throw new Error("no se creó la atención")
    const endedAt = new Date(startedAt.getTime() + 20 * 60_000)
    await ownerDb
      .update(encounter)
      .set({ status: "finalizada", endedAt, finalizedAt: endedAt, finalizedBy: f.actor })
      .where(eq(encounter.id, row.id))
    return row.id
  }
  // La del 10 de septiembre se cargó el 1 de noviembre; la del 5 de octubre, en su día.
  const late = await signed(new Date("2026-09-10T15:00:00Z"), new Date("2026-11-01T12:00:00Z"))
  const onTime = await signed(new Date("2026-10-05T15:00:00Z"), new Date("2026-10-05T15:00:00Z"))
  const { data } = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["encounter"] }))
  expect(data.map((item) => item.id)).toEqual([f.encounter.id, onTime, late])
  expect(data.find((item) => item.id === late)?.createdAt.toISOString()).toBe("2026-09-10T15:00:00.000Z")
  const asc = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["encounter"], order: "asc" }))
  expect(asc.data.map((item) => item.id)).toEqual([late, onTime, f.encounter.id])
})

it("Historia: cada documento va el día de su fecha, aunque se haya subido después, y guarda cuándo se subió", async () => {
  const f = await clinicalFixture()
  const upload = async (label: string, createdAt: Date, capturedAt: Date | null) => {
    const [row] = await ownerDb
      .insert(patientDocument)
      .values({
        organizationId: "org_a",
        patientId: f.patient.id,
        category: "informe",
        label,
        storageKey: `pruebas/${label}.pdf`,
        contentType: "application/pdf",
        sizeBytes: 100,
        createdAt,
        capturedAt,
      })
      .returning({ id: patientDocument.id })
    if (!row) throw new Error("no se creó el documento")
    return row.id
  }
  // La historia anterior, de 2019, se subió hoy; el informe de octubre se subió en su día; el de hoy no tiene fecha propia.
  const today = new Date("2026-11-12T15:00:00Z")
  const old = await upload("Historia anterior", today, new Date("2019-03-03T17:00:00Z"))
  const october = await upload("Informe de octubre", new Date("2026-10-01T15:00:00Z"), null)
  const fresh = await upload("Informe de hoy", new Date("2026-11-12T14:00:00Z"), null)
  const { data } = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["document"] }))
  expect(data.map((item) => item.refId)).toEqual([fresh, october, old])
  const past = data.find((item) => item.refId === old)
  expect(past?.createdAt.toISOString()).toBe("2019-03-03T17:00:00.000Z")
  expect(past?.uploadedAt?.toISOString()).toBe(today.toISOString())
  expect(data.find((item) => item.refId === october)?.uploadedAt?.toISOString()).toBe("2026-10-01T15:00:00.000Z")
  // De lo más antiguo a lo más nuevo, igual.
  const asc = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["document"], order: "asc" }))
  expect(asc.data.map((item) => item.refId)).toEqual([old, october, fresh])
})

it("Historia: un archivo retirado queda en su día como retirado, con su motivo, no como vigente", async () => {
  const f = await clinicalFixture()
  const [row] = await ownerDb
    .insert(patientDocument)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      category: "informe",
      label: "INR de otro paciente",
      storageKey: "pruebas/inr.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      retiredAt: new Date("2026-11-12T16:00:00Z"),
      retiredBy: f.actor,
      retireReason: "Subido al paciente equivocado",
    })
    .returning({ id: patientDocument.id })
  const { data } = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["document"] }))
  expect(data.find((item) => item.refId === row!.id)).toMatchObject({ status: "retirado", voidReason: "Subido al paciente equivocado" })
  // Aunque estuviera en una atención: ya no está en su tarjeta, así que sale suelto y plegado.
  await ownerDb.insert(patientDocumentContext).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    documentId: row!.id,
    version: 1,
    encounterId: f.encounter.id,
  })
  const all = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id))
  expect(all.data.find((item) => item.refId === row!.id)).toMatchObject({ status: "retirado" })
})
