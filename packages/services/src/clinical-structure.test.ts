import { type Db, withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { beforeAll, expect, it } from "vitest"
import { addClinicalNote, getPatientHealth, savePatientHealth } from "./clinical.js"
import { listClinicalAccess, recordClinicalAccess } from "./clinical-access.js"
import {
  cancelConsentDocument,
  createConsentDocument,
  createConsentTemplate,
  createFormResponse,
  createFormTemplate,
  createSuggestedConsentTemplates,
  discardFormResponse,
  finalizeFormResponse,
  listFormTemplates,
  publishFormTemplate,
  updateFormResponseDraft,
  listConsentTemplates,
  publishConsentTemplate,
  revokeConsentDocument,
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
import { createPrescription } from "./prescriptions.js"
import { grantResponsibility } from "./responsibilities.js"
import { appDb, container, ownerDb, setupTestDb } from "./test-setup.js"

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
    sql`with "release" as (
      insert into "diagnosis_code_release" ("system_key", "edition", "official", "license", "code_count")
      values ('ICD-10-PE', 'prueba', false, 'Solo pruebas', 0) on conflict do nothing
    )
    insert into "diagnosis_code" ("system_key", "code", "edition", "title", "search_text")
    select 'ICD-10-PE', v.code, 'prueba', v.title, lower(v.code || ' ' || replace(v.code, '.', '') || ' ' || v.title)
    from (values
        ('I10', 'Hipertensión esencial'), ('K04.0', 'Pulpitis')) as v(code, title)
    on conflict do nothing`,
  )
})

it("antecedentes: categoría de alergia, CIE-10 de la condición y principio activo", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Ana Salud" }))
  const base = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
    allergies: [{ substance: "Lidocaína", category: "anestesico", severity: "severa" }],
    conditions: [{ name: "Hipertensión arterial", diagnosisCode: "i10", status: "activa" }],
    medications: [{ name: "Cozaar 50 mg", genericName: "Losartán" }],
  }
  await run((tx) => savePatientHealth(tx, "org_a", ACTOR, patient.id, base))
  const health = await run((tx) => getPatientHealth(tx, "org_a", patient.id))
  expect(health.allergies).toEqual([
    expect.objectContaining({ substance: "Lidocaína", category: "anestesico", severity: "severa" }),
  ])
  expect(health.conditions).toEqual([expect.objectContaining({ diagnosisCode: "I10" })])
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
        conditions: [{ name: "Otra", diagnosisCode: "ZZ99", status: "activa" }],
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
      diagnosisCode: "K04.0",
      diagnosisType: "provisional",
      toothNumber: 46,
      surfaces: ["occlusal"],
    }),
  )
  expect(dx).toMatchObject({
    diagnosisCode: "K04.0",
    diagnosisType: "provisional",
    toothNumber: 46,
    surfaces: ["occlusal"],
    status: "activo",
  })
  for (const bad of [
    { diagnosisCode: "K04.0", diagnosisType: "probable" },
    { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 99 },
    { diagnosisCode: "Z99.9", diagnosisType: "confirmed" },
    { diagnosisCode: "K04.0", diagnosisType: "confirmed", surfaces: ["occlusal"] },
    { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 11, surfaces: ["occlusal"] },
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
      diagnosisCode: "K04.0",
      diagnosisType: "confirmed",
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
  // Quien informa firma con su colegiatura: miembro con perfil profesional.
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
    values ('m-estructura', 'org_a', ${ACTOR}, 'member', now()) on conflict do nothing`)
  await ownerDb.execute(sql`insert into "professional_profile" ("organization_id", "user_id", "professional_title", "registration_body", "registration_number")
    values ('org_a', ${ACTOR}, 'Cirujano dentista', 'COP', '12345') on conflict do nothing`)
  const template = await run(async (tx) => {
    const draft = await createConsentTemplate(tx, "org_a", ACTOR, {
      title: "Consentimiento de restauración",
      sections: {
        procedure: "Restauración de la pieza con resina compuesta.",
        benefits: ["Recuperar forma y función"],
        risks: ["Sensibilidad temporal"],
        alternatives: ["Control sin tratamiento"],
        consequences: "Avance de la caries y dolor.",
      },
    })
    return publishConsentTemplate(tx, "org_a", ACTOR, draft.id)
  })
  expect(template).toMatchObject({ status: "publicado", version: 1 })
  expect(template.body).toContain("Riesgos y molestias")
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
  const consent = (patientId = child.id) =>
    run((tx) =>
      createConsentDocument(tx, "org_a", ACTOR, {
        templateId: template.id,
        patientId,
        procedureRef: "Restauración pieza 75",
      }),
    )
  const sign = (
    documentId: string,
    signerContactId: string,
    signerKind: "paciente" | "representante",
    extra: Partial<Parameters<typeof signConsentDocument>[4]> = {},
  ) =>
    run((tx) =>
      signConsentDocument(tx, "org_a", ACTOR, documentId, {
        signerKind,
        signerContactId,
        representativeRelation: "Madre",
        signerDoc: "DNI 44556677",
        signatureData: signature,
        professionalSignature: signature,
        comprehensionConfirmed: true,
        ...extra,
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
      // Hoy en la clínica (Lima): lo vigente se cuenta con su día, no con UTC.
      startsAt: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date()),
      endsAt: null,
      evidenceDocumentId: null,
    }),
  )
  await expect(sign(first.id, aunt.id, "representante")).rejects.toMatchObject({ status: 409 })
  // Sin comprensión confirmada, o sin el trazo de quien firma en la clínica, no hay firma.
  // El del profesional es opcional: firma con su perfil (fase 3, decisión 3).
  await expect(
    sign(first.id, mother.id, "representante", { comprehensionConfirmed: false }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    sign(first.id, mother.id, "representante", { signatureData: null }),
  ).rejects.toMatchObject({ status: 400 })
  // Con facultad vigente firma; el nombre sale de su registro, y queda quien informó.
  const signed = await sign(first.id, mother.id, "representante", {
    witness: { name: "Luis Testigo", doc: "DNI 11223344" },
  })
  expect(signed).toMatchObject({
    status: "firmado",
    signerKind: "representante",
    signerContactId: mother.id,
    signerName: "Marta Tutora",
    informerName: "Dra. Estructura",
    informerRegistration: "COP 12345",
    comprehensionConfirmed: true,
    witnessName: "Luis Testigo",
  })
  // La persona que firmó no se reemplaza después (trigger).
  await expect(
    run((tx) =>
      tx.execute(sql`update consent_document set signer_contact_id = ${aunt.id} where id = ${first.id}`),
    ),
  ).rejects.toThrow()

  // El menor no firma por sí mismo, ni como «otra persona».
  const second = await consent()
  const own = (await run((tx) => getPatient(tx, "org_a", child.id))).contacts.find(
    (link) => link.relationship === "self",
  )
  if (!own) throw new Error("El paciente no tiene persona propia")
  await expect(sign(second.id, own.contactId, "paciente")).rejects.toMatchObject({ status: 400 })
  await expect(sign(second.id, own.contactId, "representante")).rejects.toMatchObject({
    code: "SIGNER_NOT_AUTHORIZED",
  })
  await expect(sign(second.id, "", "representante")).rejects.toMatchObject({ status: 400 })
  // Un pendiente se anula con motivo; firmado no se anula, se revoca.
  await expect(
    run((tx) => cancelConsentDocument(tx, "org_a", ACTOR, second.id, " ")),
  ).rejects.toMatchObject({ status: 400 })
  expect(
    await run((tx) => cancelConsentDocument(tx, "org_a", ACTOR, second.id, "Plantilla equivocada")),
  ).toMatchObject({ status: "anulado", cancelReason: "Plantilla equivocada" })
  await expect(
    run((tx) => cancelConsentDocument(tx, "org_a", ACTOR, first.id, "x")),
  ).rejects.toMatchObject({ status: 409 })

  // Adulto: firma la propia persona; revoca con su firma.
  const adult = await run((tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Adulta Paciente", birthDate: "1980-05-05" }),
  )
  const adultSelf = (await run((tx) => getPatient(tx, "org_a", adult.id))).contacts.find(
    (link) => link.relationship === "self",
  )!
  const third = await consent(adult.id)
  await expect(sign(third.id, mother.id, "paciente")).rejects.toMatchObject({ status: 404 })
  const adultSigned = await sign(third.id, adultSelf.contactId, "paciente")
  expect(adultSigned).toMatchObject({ signerName: "Adulta Paciente", status: "firmado" })
  await expect(
    run((tx) =>
      revokeConsentDocument(tx, "org_a", ACTOR, third.id, {
        reason: "Cambio de opinión",
        revokerContactId: adultSelf.contactId,
        signatureData: null,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect(
    await run((tx) =>
      revokeConsentDocument(tx, "org_a", ACTOR, third.id, {
        reason: "Cambio de opinión",
        revokerContactId: adultSelf.contactId,
        signatureData: signature,
      }),
    ),
  ).toMatchObject({ status: "revocado", revokerName: "Adulta Paciente" })

  // Publicar una versión nueva archiva la anterior y devuelve el número real.
  const v2 = await run(async (tx) => {
    const draft = await createConsentTemplate(tx, "org_a", ACTOR, {
      key: template.key,
      title: "Consentimiento de restauración",
      sections: {
        procedure: "Restauración de la pieza con resina compuesta o ionómero.",
        benefits: ["Recuperar forma y función"],
        risks: ["Sensibilidad temporal", "Fractura de la restauración"],
        alternatives: ["Control sin tratamiento"],
        consequences: "Avance de la caries y dolor.",
      },
    })
    return publishConsentTemplate(tx, "org_a", ACTOR, draft.id)
  })
  expect(v2).toMatchObject({ version: 2, status: "publicado" })
  const published = await run((tx) =>
    listConsentTemplates(tx, "org_a", { status: "publicado" }),
  )
  expect(published.filter((t) => t.key === template.key).map((t) => t.version)).toEqual([2])
  // Sugeridas: se crean como borrador, sin duplicar claves existentes.
  const suggested = await run((tx) => createSuggestedConsentTemplates(tx, "org_a", ACTOR))
  expect(suggested.length).toBeGreaterThan(5)
  expect(suggested.every((t) => t.status === "borrador" && t.sections)).toBe(true)
  expect(await run((tx) => createSuggestedConsentTemplates(tx, "org_a", ACTOR))).toEqual([])
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
  // Los permisos siguen como en 0035: consulta, inserta y solo cuenta.
  const [grants] = await ownerDb.execute<Record<string, boolean>>(sql`select
    has_table_privilege('dentalagent_app', 'clinical_access_log', 'SELECT') as "select",
    has_table_privilege('dentalagent_app', 'clinical_access_log', 'INSERT') as "insert",
    has_table_privilege('dentalagent_app', 'clinical_access_log', 'UPDATE') as "update",
    has_table_privilege('dentalagent_app', 'clinical_access_log', 'DELETE') as "delete",
    has_table_privilege('dentalagent_app', 'clinical_access_log', 'TRUNCATE') as "truncate",
    has_column_privilege('dentalagent_app', 'clinical_access_log', 'last_at', 'UPDATE') as "lastAt",
    has_column_privilege('dentalagent_app', 'clinical_access_log', 'hits', 'UPDATE') as "hits",
    has_column_privilege('dentalagent_app', 'clinical_access_log', 'user_id', 'UPDATE') as "userId",
    has_column_privilege('dentalagent_app', 'clinical_access_log', 'bucket', 'UPDATE') as "bucket"`)
  expect(grants).toEqual({
    select: true,
    insert: true,
    update: false,
    delete: false,
    truncate: false,
    lastAt: true,
    hits: true,
    userId: false,
    bucket: false,
  })
  // Lo de una hora anterior va después, aunque se haya contado más tarde.
  await ownerDb.execute(sql`insert into clinical_access_log
    (organization_id, patient_id, user_id, resource, bucket, first_at, last_at)
    values ('org_a', ${patient.id}, ${ACTOR}, 'recetas', date_trunc('hour', now()) - interval '2 hours',
      now() - interval '2 hours', now() + interval '1 minute')`)
  const ordered = await run((tx) => listClinicalAccess(tx, "org_a", patient.id))
  expect(ordered.map((entry) => entry.resource).at(-1)).toBe("recetas")
})

it("bitácora: contar una consulta más se escribe en su sitio (HOT), sin tocar el índice", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Recargada" }))
  // Una sola conexión del rol de la aplicación: al cerrarla, Postgres vuelca
  // sus estadísticas y `pg_stat_user_tables` las refleja sin esperar.
  const client = postgres(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
    { max: 1 },
  )
  const single = drizzle(client) as unknown as Db
  // Cada recarga es su propia transacción, como en la API: `now()` cambia y
  // `last_at` se reescribe de verdad.
  for (let i = 0; i < 11; i++)
    await withOrgContext(single, "org_a", (tx) =>
      recordClinicalAccess(tx, "org_a", ACTOR, patient.id, "odontograma"),
    )
  await client.end()
  const stats = async () => {
    const rows = await ownerDb.execute<{ upd: string; hot: string }>(
      sql`select n_tup_upd::text as upd, n_tup_hot_upd::text as hot
          from pg_stat_user_tables where relname = 'clinical_access_log'`,
    )
    return { upd: Number(rows[0]!.upd), hot: Number(rows[0]!.hot) }
  }
  let current = await stats()
  for (let waited = 0; current.hot < 10 && waited < 10_000; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    current = await stats()
  }
  // Las diez repeticiones fueron HOT, y ninguna actualización de la tabla
  // dejó de serlo: `last_at` y `hits` no están en ningún índice.
  expect(current.hot).toBeGreaterThanOrEqual(10)
  expect(current.upd).toBe(current.hot)
  const log = await run((tx) => listClinicalAccess(tx, "org_a", patient.id))
  expect(log).toEqual([expect.objectContaining({ resource: "odontograma", hits: 11 })])
})

it("formularios: versión real al publicar, título congelado, tipos clínicos, condición y descarte", async () => {
  const schema = {
    sections: [
      {
        id: "sintomas",
        title: "Síntomas",
        fields: [
          { id: "dolor", label: "¿Hay dolor?", type: "booleano", required: true },
          {
            id: "intensidad",
            label: "Intensidad",
            type: "escala",
            min: 0,
            max: 10,
            required: true,
            showIf: { field: "dolor", equals: true },
          },
          { id: "pieza", label: "Pieza", type: "pieza" },
          { id: "hallazgos", label: "Hallazgos", type: "texto_largo", required: true },
          { id: "foto", label: "Foto", type: "adjunto" },
          { id: "firma", label: "Firma del profesional", type: "firma" },
        ],
      },
    ],
  }
  const v1 = await run(async (tx) => {
    const draft = await createFormTemplate(tx, "org_a", ACTOR, { title: "Evaluación", schema })
    return publishFormTemplate(tx, "org_a", ACTOR, draft.id)
  })
  expect(v1).toMatchObject({ version: 1, status: "publicado" })
  // Una condición sobre un campo posterior o inexistente se rechaza.
  await expect(
    run((tx) =>
      createFormTemplate(tx, "org_a", ACTOR, {
        title: "Mal condicionado",
        schema: {
          sections: [
            {
              id: "s",
              title: "S",
              fields: [{ id: "a", label: "A", type: "texto", showIf: { field: "b", equals: true } }],
            },
          ],
        },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const v2 = await run(async (tx) => {
    const draft = await createFormTemplate(tx, "org_a", ACTOR, {
      key: v1.key,
      title: "Evaluación inicial",
      schema,
    })
    // Un segundo borrador de la misma clave no se permite.
    await expect(
      createFormTemplate(tx, "org_a", ACTOR, { key: v1.key, title: "Otro", schema }),
    ).rejects.toMatchObject({ code: "DRAFT_EXISTS" })
    return publishFormTemplate(tx, "org_a", ACTOR, draft.id)
  })
  expect(v2).toMatchObject({ version: 2, status: "publicado" })
  const published = await run((tx) => listFormTemplates(tx, "org_a", { status: "publicado" }))
  expect(published.filter((t) => t.key === v1.key).map((t) => t.version)).toEqual([2])

  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Forma Paciente" }))
  const response = await run((tx) =>
    createFormResponse(tx, "org_a", ACTOR, { templateId: v2.id, patientId: patient.id }),
  )
  expect(response.templateTitle).toBe("Evaluación inicial")
  const save = (answers: Record<string, unknown>) =>
    run((tx) => updateFormResponseDraft(tx, "org_a", ACTOR, response.id, { answers }))
  await expect(save({ pieza: 19 })).rejects.toMatchObject({ status: 400 })
  await expect(save({ dolor: true, intensidad: 11 })).rejects.toMatchObject({ status: 400 })
  await expect(save({ foto: crypto.randomUUID() })).rejects.toMatchObject({ status: 400 })
  await expect(save({ firma: { strokes: [[[1, 1], [2, 2]]] } })).rejects.toMatchObject({
    status: 400,
  })
  // Sin dolor, la intensidad queda oculta: no se exige ni se guarda.
  const saved = await save({ dolor: false, intensidad: 7, pieza: 36 })
  expect(saved.answers).toMatchObject({ dolor: false, intensidad: null, pieza: 36 })
  // Finalizar sin un obligatorio nombra el campo.
  await expect(
    run((tx) => finalizeFormResponse(tx, "org_a", ACTOR, response.id)),
  ).rejects.toThrow(/Hallazgos/)
  await save({
    dolor: true,
    intensidad: 6,
    pieza: 36,
    hallazgos: "Percusión positiva",
    firma: { strokes: [[[1, 1], [2, 2]]], signerName: "Dra. Estructura" },
  })
  expect(await run((tx) => finalizeFormResponse(tx, "org_a", ACTOR, response.id))).toMatchObject({
    status: "finalizado",
  })
  // Un borrador se descarta con motivo y ya no se edita.
  const other = await run((tx) =>
    createFormResponse(tx, "org_a", ACTOR, { templateId: v2.id, patientId: patient.id }),
  )
  await expect(
    run((tx) => discardFormResponse(tx, "org_a", ACTOR, other.id, "")),
  ).rejects.toMatchObject({ status: 400 })
  expect(
    await run((tx) => discardFormResponse(tx, "org_a", ACTOR, other.id, "Paciente equivocado")),
  ).toMatchObject({ status: "descartado" })
  await expect(
    run((tx) => updateFormResponseDraft(tx, "org_a", ACTOR, other.id, { answers: {} })),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    run((tx) => discardFormResponse(tx, "org_a", ACTOR, response.id, "x")),
  ).rejects.toMatchObject({ status: 409 })
})

it("la alergia declarada en el cuestionario pasa a antecedentes a nombre del paciente y la receta avisa", async () => {
  const patient = await run((tx) => createPatient(tx, "org_a", ACTOR, { displayName: "Lucía Declara" }))
  // Látex ya lo confirmó un profesional: lo declarado no lo repite ni lo cambia.
  await run((tx) =>
    savePatientHealth(tx, "org_a", ACTOR, patient.id, {
      expectedRevision: 0,
      reviewStatus: { allergies: "recorded", conditions: "unknown", medications: "unknown" },
      allergies: [{ substance: "Látex", severity: "moderada", verification: "confirmada" }],
      conditions: [],
      medications: [],
    }),
  )
  const fields = [
    { id: "alergia", label: "¿Eres alérgica o alérgico a algo?", type: "booleano", required: true },
    {
      id: "alergia_cual",
      label: "¿A qué y qué te pasó?",
      type: "texto",
      showIf: { field: "alergia", equals: true },
      definition: "AllergyIntolerance.code",
    },
  ]
  // Solo una respuesta de texto pasa a los antecedentes.
  await expect(
    run((tx) =>
      createFormTemplate(tx, "org_a", ACTOR, {
        title: "Mal marcado",
        schema: { sections: [{ id: "s", title: "S", fields: [{ ...fields[0], definition: "AllergyIntolerance.code" }] }] },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const template = await run(async (tx) => {
    const draft = await createFormTemplate(tx, "org_a", ACTOR, {
      title: "Antes de tu cita",
      respondent: "portal",
      schema: { sections: [{ id: "salud", title: "Salud", fields }] },
    })
    return publishFormTemplate(tx, "org_a", ACTOR, draft.id)
  })
  const response = await run((tx) =>
    createFormResponse(tx, "org_a", ACTOR, {
      templateId: template.id,
      patientId: patient.id,
      answers: { alergia: true, alergia_cual: "Penicilina: ronchas en la piel; látex: picazón" },
    }),
  )
  // Mientras no se finaliza, nada pasa a los antecedentes.
  expect((await run((tx) => getPatientHealth(tx, "org_a", patient.id))).allergies).toHaveLength(1)
  await run((tx) => finalizeFormResponse(tx, "org_a", ACTOR, response.id))
  const health = await run((tx) => getPatientHealth(tx, "org_a", patient.id))
  expect(health.allergies).toHaveLength(2)
  expect(health.allergies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        substance: "Penicilina",
        // La dijo el paciente y es exactamente una sustancia de la lista: queda con su grupo ATC.
        source: "paciente",
        substanceSystem: "atc",
        substanceCode: "J01C",
        reaction: "ronchas en la piel",
        verification: "no_confirmada",
        severity: "desconocida",
        isActive: true,
      }),
      expect.objectContaining({ substance: "Látex", verification: "confirmada", severity: "moderada" }),
    ]),
  )
  // La revisión avanza: una edición abierta de Antecedentes recarga en vez de pisarlo.
  expect(health.revision).toBe(2)
  expect(health.reviewStatus.allergies).toBe("recorded")
  // «Ninguna» no es una alergia, y repetir la penicilina no la duplica.
  const again = await run((tx) =>
    createFormResponse(tx, "org_a", ACTOR, {
      templateId: template.id,
      patientId: patient.id,
      answers: { alergia: true, alergia_cual: "Ninguna.\npenicilina: ronchas" },
    }),
  )
  await run((tx) => finalizeFormResponse(tx, "org_a", ACTOR, again.id))
  expect((await run((tx) => getPatientHealth(tx, "org_a", patient.id))).allergies).toHaveLength(2)
  // Al escribir amoxicilina, la receta avisa la penicilina por su grupo, como cualquier
  // otra alergia: no hay «por confirmar» (tablero 7, versión 4).
  await expect(
    run((tx) =>
      createPrescription(tx, "org_a", ACTOR, patient.id, {
        items: [
          {
            genericName: "amoxicilina",
            strength: "500 mg",
            dosageForm: "cápsula",
            dose: "1 cápsula",
            route: "oral",
            frequency: "Cada 8 horas",
            duration: "7 días",
          },
        ],
      }),
    ),
  ).rejects.toMatchObject({
    code: "ALLERGY_CONFLICT",
    message: expect.stringMatching(/Amoxicilina: alergia a penicilinas\. Es del mismo grupo/),
  })
})
