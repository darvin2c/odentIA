/**
 * La historia completa (QA de formularios del 13 nov): la copia salía sin ningún
 * formulario y sin la entrevista de salud, la atención firmada decía «Sin
 * registrar» teniendo uno y la Historia lo listaba solo con su título.
 */
import type { Db } from "@odentia/db"
import { patientRegistration } from "@odentia/db/schema/clinical"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { afterEach, expect, it, vi } from "vitest"
import { getPatientHealth, initializeDeclaredPatientHealth, savePatientHealth } from "./clinical.js"
import {
  addFormAddendum,
  createFormResponse,
  createFormTemplate,
  type FormSchemaDef,
  finalizeFormResponse,
  publishFormTemplate,
  updateFormResponseDraft,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { DocumentKit } from "./document-kit.js"
import { finalizeEncounter, getEncounterDetail } from "./encounters.js"
import { clinicToday } from "./inventory-stock.js"
import { getTimeline } from "./patient-history.js"
import { loadPatientRecord, patientRecordFhirBundle, renderPatientRecordPdf } from "./patient-record.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()
afterEach(() => vi.restoreAllMocks())

const ENDODONTICS: FormSchemaDef = {
  sections: [
    {
      id: "sintomas",
      title: "Síntomas",
      fields: [
        { id: "dolor", label: "¿Presenta dolor?", type: "booleano", required: true },
        { id: "intensidad", label: "Intensidad del dolor", type: "escala", min: 0, max: 10, showIf: { field: "dolor", equals: true } },
        // Solo se pregunta a quien no tiene dolor: aquí no se hizo y no debe salir.
        { id: "sin_dolor", label: "¿Desde cuándo no le duele?", type: "texto", showIf: { field: "dolor", equals: false } },
        { id: "pieza", label: "Pieza", type: "pieza" },
      ],
    },
    {
      id: "examen",
      title: "Examen",
      fields: [
        { id: "pruebas", label: "Pruebas de vitalidad", type: "opcion_multiple", options: ["Frío +", "Percusión +", "Palpación −"] },
        { id: "hallazgos", label: "Hallazgos", type: "texto_largo", required: true },
        { id: "fecha", label: "Fecha de evaluación", type: "fecha" },
        { id: "sangrado", label: "Sangrado al sondaje", type: "numero", unit: "%" },
      ],
    },
  ],
}

const ANSWERS = {
  dolor: true,
  intensidad: 8,
  pieza: 46,
  pruebas: ["Frío +", "Percusión +"],
  hallazgos: "Pulpitis irreversible sintomática, periodonto apical normal.",
  fecha: "2026-11-13",
}

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>
const runOf = (f: Fixture) => f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

async function publishTemplate(f: Fixture, title: string, schema: FormSchemaDef, respondent: "staff" | "portal" = "staff") {
  const run = runOf(f)
  const draft = await run((tx) => createFormTemplate(tx, "org_a", f.actor, { title, schema, respondent }))
  return run((tx) => publishFormTemplate(tx, "org_a", f.actor, draft.id))
}

/** La «Evaluación de endodoncia» llenada y finalizada por el equipo, en la atención o fuera de ella. */
async function finalizedForm(f: Fixture, encounterId: string | null, title = "Evaluación de endodoncia") {
  const run = runOf(f)
  const template = await publishTemplate(f, title, ENDODONTICS)
  const response = await run((tx) =>
    createFormResponse(tx, "org_a", f.actor, {
      templateId: template.id,
      patientId: f.patient.id,
      ...(encounterId ? { encounterId } : {}),
      answers: {},
    }),
  )
  await run((tx) => updateFormResponseDraft(tx, "org_a", f.actor, response.id, { answers: ANSWERS }))
  await run((tx) => finalizeFormResponse(tx, "org_a", f.actor, response.id))
  return response
}

/** Lo que el PDF escribe, línea por línea (los tipos de letra van recortados: el archivo no se lee como texto). */
async function printedText(record: Awaited<ReturnType<typeof loadPatientRecord>>): Promise<string> {
  const lay = vi.spyOn(DocumentKit.prototype, "lay")
  const pdf = await renderPatientRecordPdf(record, record.clinic)
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
  return JSON.stringify(lay.mock.calls.map((call) => call[0]))
}

type Resource = Record<string, unknown> & { resourceType: string; id: string }
const resourcesOf = (record: Awaited<ReturnType<typeof loadPatientRecord>>): Resource[] =>
  (patientRecordFhirBundle(record) as { entry: Array<{ resource: Resource }> }).entry.map((entry) => entry.resource)

it("la copia trae el formulario finalizado y la entrevista de salud, en el PDF y en FHIR", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const response = await finalizedForm(f, f.encounter.id)
  await run((tx) => addFormAddendum(tx, "org_a", f.actor, response.id, "La prueba al frío se repitió a los 10 minutos."))

  // Lo que la persona envió desde su enlace y nadie revisó todavía no es registro: no sale.
  const previo = await publishTemplate(
    f,
    "Cuestionario previo",
    { sections: [{ id: "motivo", title: "Motivo", fields: [{ id: "motivo", label: "¿Por qué vienes?", type: "texto", required: true }] }] },
    "portal",
  )
  const declaredRow = {
    organizationId: "org_a",
    templateId: previo.id,
    templateVersion: previo.version,
    templateTitle: previo.title,
    templateSnapshot: previo.schema,
    patientId: f.patient.id,
    status: "borrador",
    source: "portal",
    respondentContactId: f.patient.personId,
    submittedAt: new Date(),
  }
  await ownerDb.insert(clinicalFormResponse).values({ ...declaredRow, answers: { motivo: "Respuesta que nadie revisó" } })
  // El que sí se revisó y se finalizó entra, dicho como respondido por ella.
  const [reviewed] = await ownerDb
    .insert(clinicalFormResponse)
    .values({ ...declaredRow, answers: { motivo: "Me duele la muela de abajo" } })
    .returning()
  await run((tx) => finalizeFormResponse(tx, "org_a", f.actor, reviewed!.id))

  // Ella declaró su embarazo en el registro; después el equipo anotó una cirugía y a su madre.
  await ownerDb
    .insert(patientRegistration)
    .values({ organizationId: "org_a", patientId: f.patient.id, entryPoint: "public_link", respondent: "patient", answers: {} })
  await run((tx) =>
    initializeDeclaredPatientHealth(
      tx,
      "org_a",
      f.patient.id,
      { personal: { embarazo: true, semanasEmbarazo: 30 }, dental: { bruxismo: true } },
      null,
    ),
  )
  const health = await run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  await run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
      conditions: [],
      medications: [],
      anamnesis: {
        expectedVersion: health.latestAnamnesis?.version ?? 0,
        answers: {
          ...(health.latestAnamnesis?.answers as Record<string, unknown>),
          antecedentesPersonales: { embarazo: true, semanasEmbarazo: 30, cirugias: "Apendicectomía en 2010" },
        },
      },
      familyHistory: [{ relationship: "MTH", condition: "Diabetes tipo 2" }],
    }),
  )

  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))

  // El formulario, con cada pregunta que se hizo y su respuesta en palabras.
  expect(record.forms.map((form) => form.title)).toEqual(["Evaluación de endodoncia", "Cuestionario previo"])
  const [form, fromPerson] = record.forms
  expect(form).toMatchObject({ version: 1, encounterId: f.encounter.id, source: "staff", filledBy: "Clínico" })
  expect(form!.sections.flatMap((section) => section.items).map((item) => [item.label, item.words])).toEqual([
    ["¿Presenta dolor?", "Sí"],
    ["Intensidad del dolor", "8 de 10"],
    ["Pieza", "Pieza 46"],
    ["Pruebas de vitalidad", "Frío +, Percusión +"],
    ["Hallazgos", "Pulpitis irreversible sintomática, periodonto apical normal."],
    ["Fecha de evaluación", "13/11/2026"],
    ["Sangrado al sondaje", null],
  ])
  expect(form!.addenda).toMatchObject([{ text: "La prueba al frío se repitió a los 10 minutos.", authorName: "Clínico" }])
  expect(fromPerson).toMatchObject({ source: "portal", filledBy: "Paciente de prueba", filledByPatient: true })

  // La entrevista, como la cuenta odentIA, con lo que ella declaró dicho como suyo.
  expect(record.interview).toMatchObject({ version: 2, declared: false, recordedBy: "Clínico" })
  expect(record.interview!.entries.map((entry) => [entry.label, entry.value, entry.since?.declared ?? null])).toEqual([
    ["Cirugías", "Apendicectomía en 2010", null],
    ["Embarazo", "Sí, 30 semanas al registrarlo", true],
    ["Bruxismo", "Sí", true],
  ])
  expect(record.familyHistory.map((row) => [row.relationship, row.condition])).toEqual([["MTH", "Diabetes tipo 2"]])

  const text = await printedText(record)
  for (const said of [
    "Formularios (2)",
    "Evaluación de endodoncia · versión 1",
    "Lo llenó Clínico",
    "Pruebas de vitalidad",
    "Frío +, Percusión +",
    "Pieza 46",
    "Sin respuesta",
    "La prueba al frío se repitió a los 10 minutos.",
    "Lo respondió Paciente de prueba (paciente)",
    "Me duele la muela de abajo",
    "Entrevista de salud",
    "Sí, 30 semanas al registrarlo",
    "Lo declaró el paciente o su responsable el",
    "Apendicectomía en 2010",
    "Madre: Diabetes tipo 2",
  ])
    expect(text).toContain(said)
  expect(text).not.toContain("Respuesta que nadie revisó")
  expect(text).not.toContain("¿Desde cuándo no le duele?")

  // El archivo para otro sistema: cada formulario como QuestionnaireResponse de FHIR R4.
  const resources = resourcesOf(record)
  const answered = resources.find((resource) => resource.id === response.id)
  expect(answered).toMatchObject({
    resourceType: "QuestionnaireResponse",
    status: "completed",
    questionnaire: "#cuestionario",
    subject: { reference: `Patient/${f.patient.id}` },
    encounter: { reference: `Encounter/${f.encounter.id}` },
    author: { display: "Clínico" },
    contained: [{ resourceType: "Questionnaire", id: "cuestionario", title: "Evaluación de endodoncia", version: "1" }],
  })
  const items = (answered!.item as Array<{ linkId: string; item: Array<Record<string, unknown>> }>).flatMap((group) => group.item)
  expect(items).toEqual([
    { linkId: "dolor", text: "¿Presenta dolor?", answer: [{ valueBoolean: true }] },
    { linkId: "intensidad", text: "Intensidad del dolor", answer: [{ valueInteger: 8 }] },
    { linkId: "pieza", text: "Pieza", answer: [{ valueInteger: 46 }] },
    {
      linkId: "pruebas",
      text: "Pruebas de vitalidad",
      answer: [{ valueCoding: { display: "Frío +" } }, { valueCoding: { display: "Percusión +" } }],
    },
    {
      linkId: "hallazgos",
      text: "Hallazgos",
      answer: [{ valueString: "Pulpitis irreversible sintomática, periodonto apical normal." }],
    },
    { linkId: "fecha", text: "Fecha de evaluación", answer: [{ valueDate: "2026-11-13" }] },
    // Sin responder: la pregunta consta, sin respuesta.
    { linkId: "sangrado", text: "Sangrado al sondaje (%)" },
  ])
  // La adenda no cambia las respuestas: viaja en el texto del recurso, con quién y cuándo.
  expect((answered!.text as { status: string; div: string }).status).toBe("additional")
  expect((answered!.text as { div: string }).div).toContain("La prueba al frío se repitió a los 10 minutos.")
  // El que respondió ella: la fuente es la paciente.
  expect(resources.find((resource) => resource.id === reviewed!.id)).toMatchObject({
    resourceType: "QuestionnaireResponse",
    source: { reference: `Patient/${f.patient.id}` },
  })
  expect(JSON.stringify(resources)).not.toContain("Respuesta que nadie revisó")

  // La entrevista y los antecedentes familiares.
  const interview = resources.find((resource) => resource.id === `${f.patient.id}-entrevista`)
  expect(interview).toMatchObject({
    resourceType: "QuestionnaireResponse",
    status: "completed",
    contained: [{ resourceType: "Questionnaire", title: "Entrevista de salud", version: "2" }],
  })
  expect(JSON.stringify(interview)).toContain("Sí, 30 semanas al registrarlo")
  expect((interview!.text as { div: string }).div).toContain("Lo declaró el paciente o su responsable el")
  expect(resources.find((resource) => resource.resourceType === "FamilyMemberHistory")).toMatchObject({
    patient: { reference: `Patient/${f.patient.id}` },
    relationship: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-RoleCode", code: "MTH" }], text: "Madre" },
    condition: [{ code: { text: "Diabetes tipo 2" } }],
  })
})

it("sin formularios ni entrevista, la copia lo dice y no trae recursos vacíos", async () => {
  const f = await clinicalFixture()
  const record = await runOf(f)((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.forms).toEqual([])
  expect(record.interview).toBeNull()
  const text = await printedText(record)
  expect(text).toContain("Sin formularios finalizados.")
  expect(text).toContain("Sin entrevista de salud registrada.")
  const types = resourcesOf(record).map((resource) => resource.resourceType)
  expect(types).not.toContain("QuestionnaireResponse")
  expect(types).not.toContain("FamilyMemberHistory")
})

it("latidIA: su entrevista va en la copia con el embarazo y su fecha, por el gancho del producto", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, "org_a"))
  try {
    const today = await run((tx) => clinicToday(tx, "org_a"))
    await run((tx) =>
      savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
        expectedRevision: 0,
        reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
        conditions: [],
        medications: [],
        anamnesis: {
          expectedVersion: 0,
          answers: {
            antecedentesPersonales: { hospitalizaciones: "Neumonía en 2019" },
            embarazoLactancia: { embarazo: { estado: "si", fecha: today, semanas: 12 } },
            habitos: { tabaco: "nunca" },
          },
        },
      }),
    )
    const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
    const [day, month, year] = [today.slice(8, 10), today.slice(5, 7), today.slice(0, 4)]
    expect(record.interview!.entries.map((entry) => [entry.key, entry.label, entry.value])).toEqual([
      ["antecedentesPersonales.hospitalizaciones", "Hospitalizaciones", "Neumonía en 2019"],
      ["embarazoLactancia.embarazo", "Embarazo", `Embarazada, 12 semanas (registrado el ${day}/${month}/${year})`],
      ["habitos", "Hábitos", "tabaco: nunca fumó"],
    ])
    // Una sola vez: ya no va además en una sección aparte del producto.
    expect(record.productSections).toEqual([])
    const interview = resourcesOf(record).find((resource) => resource.id === `${f.patient.id}-entrevista`)
    expect(JSON.stringify(interview)).toContain("Embarazada, 12 semanas")
  } finally {
    await ownerDb.update(orgProfile).set({ product: "dental" }).where(eq(orgProfile.organizationId, "org_a"))
  }
})

it("la atención firmada muestra sus formularios, y la Historia los lleva con su resumen", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const inside = await finalizedForm(f, f.encounter.id)
  const loose = await finalizedForm(f, null, "Evaluación periodontal")
  await f.ready(f.encounter.id)
  await run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))

  const detail = await run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id))
  expect(detail.forms).toHaveLength(1)
  expect(detail.forms[0]).toMatchObject({ id: inside.id, title: "Evaluación de endodoncia", filledBy: "Clínico" })
  expect(detail.forms[0]!.sections[1]!.items[0]).toMatchObject({ label: "Pruebas de vitalidad", words: "Frío +, Percusión +" })

  // Lo que no cabe en una línea (la fecha) queda para «Ver»: ninguna respuesta se corta por la mitad.
  const summary =
    "Presenta dolor: Sí · Intensidad del dolor: 8 de 10 · Pieza 46 · Pruebas de vitalidad: Frío +, Percusión + · Pulpitis irreversible sintomática, periodonto apical normal. · …"
  const timeline = await run((tx) => getTimeline(tx, "org_a", f.patient.id, {}))
  const card = timeline.data.find((item) => item.type === "encounter" && item.refId === f.encounter.id)
  expect(card?.born?.forms).toEqual([{ id: inside.id, title: "Evaluación de endodoncia", summary }])
  // El que se llenó fuera de una atención es un hecho suelto, también con su resumen.
  expect(timeline.data.find((item) => item.type === "form")).toMatchObject({
    refId: loose.id,
    title: "Evaluación periodontal",
    detail: summary,
    byText: "Lo llenó Clínico",
  })
})
