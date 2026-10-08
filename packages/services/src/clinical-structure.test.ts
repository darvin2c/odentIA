import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { addClinicalNote, getPatientHealth, savePatientHealth } from "./clinical.js"
import { listClinicalAccess, recordClinicalAccess } from "./clinical-access.js"
import {
  createConsentDocument,
  createConsentTemplate,
  publishConsentTemplate,
  signConsentDocument,
} from "./clinical-forms.js"
import { createContact } from "./contacts.js"
import {
  addEncounterDiagnosis,
  listPatientDiagnoses,
  setDiagnosisStatus,
  voidEncounterDiagnosis,
} from "./encounter-diagnoses.js"
import { createEncounter } from "./encounters.js"
import { createPatient, getPatient } from "./patients.js"
import { grantResponsibility } from "./responsibilities.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-estructura"
const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
const signature = { strokes: [[[1, 1], [2, 2], [3, 3]]] }

beforeAll(async () => {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Dra. Estructura', 'estructura@example.com')
        on conflict ("id") do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "cie10_code" ("code", "description") values
        ('I10', 'Hipertensión esencial'), ('K04.0', 'Pulpitis') on conflict ("code") do nothing`,
  )
})

it("antecedentes: categoría de alergia, CIE-10 de la condición y principio activo", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Ana Salud" }))
  const base = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
    allergies: [{ substance: "Lidocaína", category: "anestesico", severity: "severa" }],
    conditions: [{ name: "Hipertensión arterial", cie10Code: "i10", status: "activa" }],
    medications: [{ name: "Cozaar 50 mg", genericName: "Losartán" }],
  }
  await run((tx) => savePatientHealth(tx, "org_a", ACTOR, patient.id, base))
  const health = await run((tx) => getPatientHealth(tx, "org_a", patient.id))
  expect(health.allergies).toEqual([
    expect.objectContaining({ substance: "Lidocaína", category: "anestesico", severity: "severa" }),
  ])
  expect(health.conditions).toEqual([expect.objectContaining({ cie10Code: "I10" })])
  expect(health.medications).toEqual([expect.objectContaining({ genericName: "Losartán" })])

  // Fuera de catálogo o código inexistente: se rechaza sin escribir nada.
  await expect(
    run((tx) =>
      savePatientHealth(tx, "org_a", ACTOR, patient.id, {
        ...base,
        expectedRevision: health.revision,
        allergies: [{ substance: "Látex", category: "goma", severity: "leve" }],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    run((tx) =>
      savePatientHealth(tx, "org_a", ACTOR, patient.id, {
        ...base,
        expectedRevision: health.revision,
        conditions: [{ name: "Otra", cie10Code: "ZZ99", status: "activa" }],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect((await run((tx) => getPatientHealth(tx, "org_a", patient.id))).revision).toBe(
    health.revision,
  )
})

it("diagnóstico: entidad de la atención con tipo, pieza y catálogo; la nota no diagnostica", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Dx Tipo" }))
  const draft = await run((tx) =>
    createEncounter(tx, "org_a", ACTOR, patient.id, { reason: "Dolor nocturno" }),
  )
  const dx = await run((tx) =>
    addEncounterDiagnosis(tx, "org_a", ACTOR, patient.id, draft.id, {
      cie10Code: "K04.0",
      diagnosisType: "presuntivo",
      toothNumber: 46,
      surfaces: ["occlusal"],
    }),
  )
  expect(dx).toMatchObject({
    cie10Code: "K04.0",
    diagnosisType: "presuntivo",
    toothNumber: 46,
    surfaces: ["occlusal"],
    status: "activo",
  })
  for (const bad of [
    { cie10Code: "K04.0", diagnosisType: "probable" },
    { cie10Code: "K04.0", diagnosisType: "definitivo", toothNumber: 99 },
    { cie10Code: "Z99.9", diagnosisType: "definitivo" },
    { cie10Code: "K04.0", diagnosisType: "definitivo", surfaces: ["occlusal"] },
    { cie10Code: "K04.0", diagnosisType: "definitivo", toothNumber: 11, surfaces: ["occlusal"] },
  ]) {
    await expect(
      run((tx) => addEncounterDiagnosis(tx, "org_a", ACTOR, patient.id, draft.id, bad)),
    ).rejects.toMatchObject({ status: 400 })
  }
  // Una sola vía para diagnosticar: la nota de evolución no lleva código.
  await expect(
    run((tx) =>
      addClinicalNote(tx, "org_a", ACTOR, patient.id, {
        note: "Dolor",
        diagnosisCode: "K04.0",
        encounterId: draft.id,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  // Anular en borrador exige motivo y la lista de problemas lo excluye.
  await expect(
    run((tx) => voidEncounterDiagnosis(tx, "org_a", ACTOR, patient.id, draft.id, dx.id, { reason: " " })),
  ).rejects.toMatchObject({ status: 400 })
  await run((tx) =>
    voidEncounterDiagnosis(tx, "org_a", ACTOR, patient.id, draft.id, dx.id, {
      reason: "Pieza equivocada",
    }),
  )
  const kept = await run((tx) =>
    addEncounterDiagnosis(tx, "org_a", ACTOR, patient.id, draft.id, {
      cie10Code: "K04.0",
      diagnosisType: "definitivo",
      toothNumber: 47,
    }),
  )
  const problems = await run((tx) => listPatientDiagnoses(tx, "org_a", patient.id))
  expect(problems.map((p) => [p.toothNumber, p.description])).toEqual([[47, "Pulpitis"]])
  expect(
    await run((tx) => setDiagnosisStatus(tx, "org_a", ACTOR, patient.id, kept.id, "resuelto")),
  ).toMatchObject({ status: "resuelto" })
})

it("consentimiento: firma verificada del paciente o de su representante legal vigente", async () => {
  const template = await run(async (tx) => {
    const draft = await createConsentTemplate(tx, "org_a", ACTOR, {
      title: "Consentimiento de restauración",
      body: "Autorizo el procedimiento indicado tras recibir la explicación de sus riesgos y alternativas.",
    })
    return publishConsentTemplate(tx, "org_a", ACTOR, draft.id)
  })
  const mother = await run((tx) =>
    createContact(tx, "org_a", { displayName: "Marta Tutora", phone: "+51944000111" }),
  )
  const aunt = await run((tx) => createContact(tx, "org_a", { displayName: "Tía Acompañante" }))
  const child = await run((tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Niño Paciente",
      birthDate: "2018-02-03",
      contacts: [
        { contactId: mother.id, relationship: "guardian", relationshipDetail: "Madre", isPreferred: true },
        { contactId: aunt.id, relationship: "family", relationshipDetail: "Tía", isPreferred: false },
      ],
    }),
  )
  const consent = () =>
    run((tx) =>
      createConsentDocument(tx, "org_a", ACTOR, {
        templateId: template.id,
        patientId: child.id,
        procedureRef: "Restauración pieza 75",
      }),
    )
  const sign = (documentId: string, signerContactId: string, signerKind: "paciente" | "representante") =>
    run((tx) =>
      signConsentDocument(tx, "org_a", ACTOR, documentId, {
        signerKind,
        signerContactId,
        signerName: "Nombre escrito a mano",
        signerDoc: "DNI 00000000",
        representativeRelation: "Madre",
        signatureData: signature,
      }),
    )

  // Vinculada pero sin facultad legal: no firma por el menor.
  const first = await consent()
  await expect(sign(first.id, mother.id, "representante")).rejects.toMatchObject({
    code: "DECISION_CONTACT_NOT_AUTHORIZED",
    status: 409,
  })
  await run((tx) =>
    grantResponsibility(tx, "org_a", ACTOR, child.id, {
      contactId: mother.id,
      kind: "representante_legal",
      startsAt: new Date().toISOString().slice(0, 10),
      endsAt: null,
      evidenceDocumentId: null,
    }),
  )
  await expect(sign(first.id, aunt.id, "representante")).rejects.toMatchObject({ status: 409 })
  // Con facultad vigente firma, y el nombre sale de su registro, no de lo tecleado.
  const signed = await sign(first.id, mother.id, "representante")
  expect(signed).toMatchObject({
    status: "firmado",
    signerKind: "representante",
    signerContactId: mother.id,
    signerName: "Marta Tutora",
  })

  // Como paciente solo firma la propia persona.
  const second = await consent()
  await expect(sign(second.id, mother.id, "paciente")).rejects.toMatchObject({
    code: "SIGNER_NOT_AUTHORIZED",
  })
  const own = (await run((tx) => getPatient(tx, "org_a", child.id))).contacts.find(
    (link) => link.relationship === "self",
  )
  if (!own) throw new Error("El paciente no tiene persona propia")
  await expect(sign(second.id, own.contactId, "representante")).rejects.toMatchObject({
    code: "SIGNER_NOT_AUTHORIZED",
  })
  expect(await sign(second.id, own.contactId, "paciente")).toMatchObject({
    signerContactId: own.contactId,
    signerName: "Niño Paciente",
  })
})

it("bitácora: registra quién consultó qué parte de la ficha, una fila por hora", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Consultada" }))
  await run((tx) => recordClinicalAccess(tx, "org_a", ACTOR, patient.id, "odontograma"))
  await run((tx) => recordClinicalAccess(tx, "org_a", ACTOR, patient.id, "odontograma"))
  await run((tx) => recordClinicalAccess(tx, "org_a", ACTOR, patient.id, "antecedentes"))
  const log = await run((tx) => listClinicalAccess(tx, "org_a", patient.id))
  expect(log).toHaveLength(2)
  expect(log).toContainEqual(
    expect.objectContaining({ resource: "odontograma", hits: 2, userName: "Dra. Estructura" }),
  )
  // Solo anexado: el rol de la aplicación no borra ni reescribe quién consultó.
  await expect(
    run((tx) => tx.execute(sql`delete from clinical_access_log where patient_id = ${patient.id}`)),
  ).rejects.toThrow()
  await expect(
    run((tx) =>
      tx.execute(sql`update clinical_access_log set user_id = 'otro' where patient_id = ${patient.id}`),
    ),
  ).rejects.toThrow()
  // Otra organización no ve la bitácora.
  await expect(
    withOrgContext(appDb, "org_b", (tx) => listClinicalAccess(tx, "org_b", patient.id)),
  ).rejects.toMatchObject({ status: 404 })
})
