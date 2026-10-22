import { odontogramAssessment } from "@odentia/db/schema/dental"
import { consentDocument, consentTemplate } from "@odentia/db/schema/clinical-forms"
import { expect, it } from "vitest"
import { createClinicalOrder } from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { voidEncounter } from "./encounters.js"
import { getTimeline } from "./patient-history.js"
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
  expect(consent).toMatchObject({ title: "Firmó el consentimiento: Exodoncia de la pieza 38" })
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
