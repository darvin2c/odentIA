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

it("diagnóstico: tipo y pieza exigen código y catálogo", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Dx Tipo" }))
  const note = await run((tx) =>
    addClinicalNote(tx, "org_a", ACTOR, patient.id, {
      note: "Dolor espontáneo nocturno",
      diagnosisCode: "K04.0",
      diagnosisType: "presuntivo",
      toothNumber: 46,
    }),
  )
  expect(note).toMatchObject({ diagnosisCode: "K04.0", diagnosisType: "presuntivo", toothNumber: 46 })
  for (const bad of [
    { note: "Sin código", diagnosisType: "definitivo" },
    { note: "Tipo raro", diagnosisCode: "K04.0", diagnosisType: "probable" },
    { note: "Pieza inexistente", diagnosisCode: "K04.0", toothNumber: 99 },
  ]) {
    await expect(
      run((tx) => addClinicalNote(tx, "org_a", ACTOR, patient.id, bad)),
    ).rejects.toMatchObject({ status: 400 })
  }
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
