/**
 * La historia completa (QA de formularios del 13 nov): la copia salía sin ningún
 * formulario y sin la entrevista de salud, la atención firmada decía «Sin
 * registrar» teniendo uno y la Historia lo listaba solo con su título.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientAnamnesis, patientDocument, patientRegistration } from "@odentia/db/schema/clinical"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { afterEach, expect, it, vi } from "vitest"
import {
  getPatientHealth,
  initializeDeclaredPatientHealth,
  recordHealthDeclaration,
  savePatientHealth,
} from "./clinical.js"
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
import { createContact } from "./contacts.js"
import { demoSignatureStrokes } from "./demo-signature.js"
import { DocumentKit, dayWords } from "./document-kit.js"
import { finalizeEncounter, getEncounterDetail } from "./encounters.js"
import { clinicToday } from "./inventory-stock.js"
import { getTimeline } from "./patient-history.js"
import { loadPatientRecord, patientRecordFhirBundle, renderPatientRecordPdf } from "./patient-record.js"
import { createPatient } from "./patients.js"
import { setTestPatientIdentity } from "./test-patient.js"
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

/** La zona de las clínicas de prueba: el papel dice las fechas así. */
const ZONE = { locale: "es-PE", timezone: "America/Lima" }

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
    submittedVia: "enlace",
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
  const declaredHealth = { personal: { embarazo: true, semanasEmbarazo: 30 }, dental: { bruxismo: true } }
  await run(async (tx) => {
    await initializeDeclaredPatientHealth(tx, "org_a", f.patient.id, declaredHealth, null)
    await recordHealthDeclaration(tx, "org_a", f.patient.id, {
      via: "registro",
      by: { kind: "patient", name: null, relation: null },
      health: declaredHealth,
    })
  })
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
          antecedentesPersonales: { cirugias: "Apendicectomía en 2010" },
        },
      },
      familyHistory: [{ relationship: "MTH", condition: "Diabetes tipo 2" }],
    }),
  )

  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))

  // El formulario, con cada pregunta que se hizo y su respuesta en palabras.
  expect(record.forms.map((form) => form.title)).toEqual(["Evaluación de endodoncia", "Cuestionario previo"])
  const [form, fromPerson] = record.forms
  expect(form).toMatchObject({
    version: 1,
    encounterId: f.encounter.id,
    source: "staff",
    filledBy: "Clínico",
    finalizedBy: "Clínico",
    addendaTitle: "Adendas",
  })
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
  expect(fromPerson).toMatchObject({
    source: "portal",
    via: "enlace",
    filledBy: "Paciente de prueba",
    filledByPatient: true,
    finalizedBy: "Clínico",
  })
  // Quién lo envió, por dónde y cuándo; y quién lo revisó, que es quien lo finalizó.
  expect(fromPerson!.byWords).toMatch(
    /^Lo respondió Paciente de prueba \(paciente\) desde su enlace el .+ · lo revisó Clínico el /,
  )

  // La entrevista, como la cuenta odentIA, con lo que ella declaró dicho como suyo. El embarazo se
  // guarda con el día en que lo dijo: la copia dice la semana a su fecha y la que dijo ese día.
  const said = (await run((tx) => clinicToday(tx, "org_a"))).split("-").reverse().join("/")
  const pregnancy = `Sí · 30 semanas a la fecha de esta copia (30 el ${said})`
  expect(record.interview).toMatchObject({ version: 2, said: { kind: "recorded", by: "Clínico" } })
  expect(record.interview!.entries.map((entry) => [entry.label, entry.value, entry.since?.kind ?? null])).toEqual([
    ["Cirugías", "Apendicectomía en 2010", null],
    ["Embarazo", pregnancy, null],
    // Viene igual desde la versión que ella declaró: se sigue diciendo como suyo.
    ["Bruxismo", "Sí", "declared"],
  ])
  expect(record.familyHistory.map((row) => [row.relationship, row.condition])).toEqual([["MTH", "Diabetes tipo 2"]])

  const text = await printedText(record)
  for (const said of [
    "Formularios (2)",
    "Evaluación de endodoncia · versión 1",
    "Lo llenó Clínico · lo finalizó Clínico el",
    "Pruebas de vitalidad",
    "Frío +, Percusión +",
    "Pieza 46",
    "Sin respuesta",
    "La prueba al frío se repitió a los 10 minutos.",
    "Lo respondió Paciente de prueba (paciente) desde su enlace el",
    "Me duele la muela de abajo",
    "Entrevista de salud",
    pregnancy,
    // Sin sexo registrado no se supone «ella» ni «él»: la frase va sin sujeto, como en la ficha.
    `Lo dijo el ${dayWords(new Date(), ZONE)}`,
    `Lo registró Clínico el ${dayWords(new Date(), ZONE)}`,
    "Apendicectomía en 2010",
    "Madre: Diabetes tipo 2",
  ])
    expect(text).toContain(said)
  expect(text).not.toContain("Respuesta que nadie revisó")
  expect(text).not.toContain("¿Desde cuándo no le duele?")
  // El equipo ya guardó sus antecedentes después de lo que ella dijo: nada queda «sin revisar».
  expect(text).not.toContain("sin revisar")

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
    // La pieza, como la dice el producto para FHIR (odentIA: con su sistema, FDI), no un número suelto.
    { linkId: "pieza", text: "Pieza", answer: [{ valueString: "Pieza 46 (FDI)" }] },
    // Las opciones de la clínica no tienen código: van como texto, no como un `Coding` solo con `display`.
    { linkId: "pruebas", text: "Pruebas de vitalidad", answer: [{ valueString: "Frío +" }, { valueString: "Percusión +" }] },
    {
      linkId: "hallazgos",
      text: "Hallazgos",
      answer: [{ valueString: "Pulpitis irreversible sintomática, periodonto apical normal." }],
    },
    { linkId: "fecha", text: "Fecha de evaluación", answer: [{ valueDate: "2026-11-13" }] },
    // Sin responder: la pregunta consta, sin respuesta.
    { linkId: "sangrado", text: "Sangrado al sondaje (%)" },
  ])
  const asked = (answered!.contained as Array<{ item: Array<{ item: Array<Record<string, unknown>> }> }>)[0]!.item.flatMap(
    (group) => group.item,
  )
  expect(asked.find((item) => item.linkId === "pruebas")).toEqual({
    linkId: "pruebas",
    text: "Pruebas de vitalidad",
    type: "string",
    repeats: true,
    answerOption: [{ valueString: "Frío +" }, { valueString: "Percusión +" }, { valueString: "Palpación −" }],
  })
  expect(JSON.stringify(answered)).not.toContain("valueCoding")
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
  expect(JSON.stringify(interview)).toContain(pregnancy)
  expect((interview!.text as { div: string }).div).toContain(`Bruxismo: Lo dijo el ${dayWords(new Date(), ZONE)}`)
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
      // Una sola vez, y con las palabras comunes: latidIA no lo vuelve a decir en su grupo.
      ["embarazoLactancia.embarazo", "Embarazo", `Sí · 12 semanas a la fecha de esta copia (12 el ${day}/${month}/${year})`],
      ["habitos", "Hábitos", "tabaco: nunca fumó"],
    ])
    // Una sola vez: ya no va además en una sección aparte del producto.
    expect(record.productSections).toEqual([])
    const interview = resourcesOf(record).find((resource) => resource.id === `${f.patient.id}-entrevista`)
    expect(JSON.stringify(interview)).toContain("Sí · 12 semanas a la fecha de esta copia")
    expect(JSON.stringify(interview)).not.toContain("Embarazada")
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

it("una entrevista guardada sin nada que contar no deja un encabezado solo en la copia", async () => {
  const f = await clinicalFixture()
  // Una versión que quedó vacía (lo que tenía pasó a las listas de enfermedades y medicación).
  await ownerDb
    .insert(patientAnamnesis)
    .values({ organizationId: "org_a", patientId: f.patient.id, version: 1, answers: {}, createdBy: f.actor })
  const record = await runOf(f)((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  const text = await printedText(record)
  expect(text).toContain("Sin entrevista de salud registrada.")
  expect(text).not.toContain("Versión 1")
  expect(text).not.toContain("Registrada por")
  expect(resourcesOf(record).map((resource) => resource.id)).not.toContain(`${f.patient.id}-entrevista`)
})

it("cada tipo de respuesta sale con su valor; lo guardado bajo una pregunta oculta no sale y las adendas van en orden", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const [xray] = await ownerDb
    .insert(patientDocument)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      category: "radiografia",
      label: "Periapical de la 46",
      storageKey: `pruebas/${randomUUID()}.png`,
      contentType: "image/png",
      sizeBytes: 100,
    })
    .returning()
  const template = await publishTemplate(f, "Control de endodoncia", {
    sections: [
      {
        id: "control",
        title: "Control",
        fields: [
          { id: "dolor", label: "¿Presenta dolor?", type: "booleano", required: true },
          { id: "intensidad", label: "Intensidad del dolor", type: "escala", min: 0, max: 10, showIf: { field: "dolor", equals: true } },
          { id: "pieza", label: "Pieza", type: "pieza" },
          { id: "estado", label: "Estado de la restauración", type: "opcion_unica", options: ["Íntegra", "Filtrada", "Ausente"] },
          { id: "radiografia", label: "Radiografía de control", type: "adjunto" },
          { id: "conforme", label: "Conformidad", type: "firma" },
        ],
      },
    ],
  })
  const response = await run((tx) =>
    createFormResponse(tx, "org_a", f.actor, { templateId: template.id, patientId: f.patient.id, encounterId: f.encounter.id, answers: {} }),
  )
  const saved = await run((tx) =>
    updateFormResponseDraft(tx, "org_a", f.actor, response.id, {
      answers: {
        dolor: false,
        pieza: 46,
        estado: "Íntegra",
        radiografia: xray!.id,
        conforme: { signerName: "Paciente de prueba", strokes: demoSignatureStrokes("Paciente de prueba") },
      },
    }),
  )
  // Una respuesta que quedó guardada bajo una pregunta que su condición oculta (primero dijo que sí le dolía).
  await ownerDb
    .update(clinicalFormResponse)
    .set({ answers: { ...(saved.answers as Record<string, unknown>), intensidad: 9 } })
    .where(eq(clinicalFormResponse.id, response.id))
  await run((tx) => finalizeFormResponse(tx, "org_a", f.actor, response.id))
  for (const text of ["Primera corrección.", "Segunda corrección.", "Tercera corrección."])
    await run((tx) => addFormAddendum(tx, "org_a", f.actor, response.id, text))

  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  const [form] = record.forms
  expect(form!.sections.flatMap((section) => section.items).map((item) => [item.label, item.words])).toEqual([
    ["¿Presenta dolor?", "No"],
    ["Pieza", "Pieza 46"],
    ["Estado de la restauración", "Íntegra"],
    ["Radiografía de control", "Periapical de la 46"],
    ["Conformidad", "Firmó Paciente de prueba"],
  ])
  expect(form!.addenda.map((addendum) => addendum.text)).toEqual(["Primera corrección.", "Segunda corrección.", "Tercera corrección."])
  // El «No» es una respuesta y resume como tal.
  expect(form!.summary).toBe("Presenta dolor: No · Pieza 46 · Estado de la restauración: Íntegra")

  const text = await printedText(record)
  expect(text).not.toContain("Intensidad del dolor")
  expect(text.indexOf("Primera corrección.")).toBeLessThan(text.indexOf("Segunda corrección."))
  expect(text.indexOf("Segunda corrección.")).toBeLessThan(text.indexOf("Tercera corrección."))

  const resources = resourcesOf(record)
  const answered = resources.find((resource) => resource.id === response.id)!
  expect((answered.item as Array<{ item: unknown[] }>)[0]!.item).toEqual([
    { linkId: "dolor", text: "¿Presenta dolor?", answer: [{ valueBoolean: false }] },
    { linkId: "pieza", text: "Pieza", answer: [{ valueString: "Pieza 46 (FDI)" }] },
    { linkId: "estado", text: "Estado de la restauración", answer: [{ valueString: "Íntegra" }] },
    {
      linkId: "radiografia",
      text: "Radiografía de control",
      // El archivo va en el ZIP: la respuesta apunta a su DocumentReference.
      answer: [{ valueReference: { reference: `DocumentReference/${xray!.id}`, display: "Periapical de la 46" } }],
    },
    // La firma: quién firmó. El trazo se queda en el formulario.
    { linkId: "conforme", text: "Conformidad", answer: [{ valueString: "Firmó Paciente de prueba" }] },
  ])
  expect(resources.some((resource) => resource.resourceType === "DocumentReference" && resource.id === xray!.id)).toBe(true)
  expect(JSON.stringify(answered)).not.toContain("intensidad")
  expect(JSON.stringify(answered)).not.toContain("strokes")
  const narrative = (answered.text as { div: string }).div
  expect(narrative.indexOf("Primera corrección.")).toBeLessThan(narrative.indexOf("Segunda corrección."))
  expect(narrative.indexOf("Segunda corrección.")).toBeLessThan(narrative.indexOf("Tercera corrección."))
})

it("lo que respondió quien habla por el paciente lo dice así, y en FHIR apunta a una persona vinculada con un id válido", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const mother = await run((tx) => createContact(tx, "org_a", { displayName: "Marta Tutora" }))
  const child = await run((tx) =>
    createPatient(tx, "org_a", f.actor, {
      displayName: "Niño Paciente",
      birthDate: "2018-02-03",
      contacts: [{ contactId: mother.id, relationship: "guardian", relationshipDetail: "Madre", isPreferred: true }],
    }),
  )
  const previo = await publishTemplate(
    f,
    "Antes de la cita",
    { sections: [{ id: "motivo", title: "Motivo", fields: [{ id: "motivo", label: "¿Por qué vienen?", type: "texto", required: true }] }] },
    "portal",
  )
  const [sent] = await ownerDb
    .insert(clinicalFormResponse)
    .values({
      organizationId: "org_a",
      templateId: previo.id,
      templateVersion: previo.version,
      templateTitle: previo.title,
      templateSnapshot: previo.schema,
      patientId: child.id,
      status: "borrador",
      source: "portal",
      respondentContactId: mother.id,
      submittedAt: new Date(),
      answers: { motivo: "Se le mueve un diente de leche" },
    })
    .returning()
  // Lo que envió no se cambia: lo que el equipo precisa queda aparte, también antes de revisarlo.
  await run((tx) => addFormAddendum(tx, "org_a", f.actor, sent!.id, "Dice que es el diente de arriba, no el de abajo."))
  await run((tx) => finalizeFormResponse(tx, "org_a", f.actor, sent!.id))

  const record = await run((tx) => loadPatientRecord(tx, "org_a", child.id))
  expect(record.forms[0]).toMatchObject({
    source: "portal",
    filledBy: "Marta Tutora",
    filledByPatient: false,
    // Sin el canal guardado (lo de antes), no se dice por dónde llegó.
    via: null,
    addendaTitle: "Correcciones",
  })
  const [correction] = record.forms[0]!.addenda
  expect(correction).toMatchObject({ text: "Dice que es el diente de arriba, no el de abajo.", authorName: "Clínico" })
  expect(record.forms[0]!.byWords).not.toContain("desde")
  const text = await printedText(record)
  expect(text).toContain("Correcciones")
  expect(text).not.toContain("Adendas")
  expect(record.forms[0]!.byWords).toMatch(/^Lo respondió Marta Tutora \(en nombre del paciente\) el /)

  // La misma frase en la Historia: una sola regla para decir quién lo llenó.
  const timeline = await run((tx) => getTimeline(tx, "org_a", child.id, {}))
  expect(timeline.data.find((item) => item.type === "form")?.byText).toBe(
    "Lo respondió Marta Tutora (en nombre del paciente) · lo revisó Clínico",
  )

  const resources = resourcesOf(record)
  // FHIR R4: un id tiene hasta 64 caracteres, de letras, números, guion y punto.
  expect(resources.filter((resource) => !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id)).map((resource) => resource.id)).toEqual([])
  const related = resources.find((resource) => resource.resourceType === "RelatedPerson")
  expect(related).toMatchObject({ id: mother.id, patient: { reference: `Patient/${child.id}` }, name: [{ text: "Marta Tutora" }] })
  const answered = resources.find((resource) => resource.id === sent!.id)
  expect(answered).toMatchObject({
    resourceType: "QuestionnaireResponse",
    source: { reference: `RelatedPerson/${mother.id}`, display: "Marta Tutora" },
  })
  expect((answered!.text as { div: string }).div).toContain("Corrección: Dice que es el diente de arriba, no el de abajo.")
})

it("un embarazo guardado antes, sin fecha, sale con el día en que se anotó y la semana a la fecha de la copia", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  // La forma de antes de odentIA: un sí con sus semanas en «Personales», anotado hace dos semanas.
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
  await ownerDb.insert(patientAnamnesis).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    version: 1,
    answers: { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 30 } },
    createdBy: f.actor,
    createdAt: twoWeeksAgo,
  })
  const day = (await run((tx) => clinicToday(tx, "org_a", twoWeeksAgo))).split("-").reverse().join("/")
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.interview!.entries.map((entry) => [entry.key, entry.label, entry.value])).toEqual([
    ["embarazoLactancia.embarazo", "Embarazo", `Sí · 32 semanas a la fecha de esta copia (30 el ${day})`],
  ])
})

it("lo que la persona dijo se dice como suyo, con su día, y lo que nadie revisó va marcado en el PDF y en FHIR", async () => {
  const day = dayWords(new Date(), ZONE)
  /** Una ficha con lo que alguien declaró en su registro, que recepción escribe por ella. */
  const declaredBy = async (by: Parameters<typeof recordHealthDeclaration>[3]["by"]) => {
    const f = await clinicalFixture()
    const run = runOf(f)
    await setTestPatientIdentity(ownerDb, f.patient.id, { sex: "F" })
    await ownerDb
      .insert(patientRegistration)
      .values({ organizationId: "org_a", patientId: f.patient.id, entryPoint: "platform", respondent: "patient", answers: {} })
    const health = {
      allergies: { state: "recorded" as const, items: [{ substance: "Penicilina", reaction: "Ronchas", severity: "desconocida" as const }] },
      conditions: { state: "recorded" as const, items: [{ name: "Hipertensión" }] },
      medications: { state: "recorded" as const, items: [{ name: "Losartán", dose: "50 mg" }] },
      personal: { embarazo: true, semanasEmbarazo: 30, cirugias: "Cesárea en 2020" },
    }
    await run(async (tx) => {
      // Quien escribe es alguien del equipo (`f.actor`), pero lo dijo otra persona: eso es lo que cuenta.
      await initializeDeclaredPatientHealth(tx, "org_a", f.patient.id, health, f.actor)
      await recordHealthDeclaration(tx, "org_a", f.patient.id, { via: "registro", by, health })
    })
    const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
    const resources = resourcesOf(record)
    const stated = (type: string, category?: string) =>
      resources.find(
        (resource) =>
          resource.resourceType === type &&
          (!category || JSON.stringify(resource.category) === JSON.stringify([{ text: category }])),
      )
    return { f, record, text: await printedText(record), stated }
  }

  // Lo dijo ella, en recepción: no «registrada por» quien lo escribió.
  const own = await declaredBy({ kind: "patient", name: null, relation: null })
  const mark = `Lo dijo ella el ${day}, sin revisar`
  expect(own.record.interview).toMatchObject({ version: 1, said: { kind: "declared", by: { kind: "patient" } } })
  expect(own.text).toContain(`Versión 1 · Lo dijo ella el ${day}`)
  expect(own.text).toContain(mark)
  expect(own.text).not.toContain("Registrada por")
  expect(own.text).not.toContain("Lo registró")
  // El campo de R4 para quién lo afirma, y la nota de que nadie lo revisó.
  const patientRef = { reference: `Patient/${own.f.patient.id}` }
  expect(own.stated("AllergyIntolerance")).toMatchObject({ asserter: patientRef, note: [{ text: mark }] })
  expect(own.stated("Condition", "Antecedente")).toMatchObject({ asserter: patientRef, note: [{ text: mark }] })
  expect(own.stated("MedicationStatement")).toMatchObject({ informationSource: patientRef, note: [{ text: mark }] })
  // El embarazo de la entrevista también lo dijo ella y sigue sin revisar.
  expect(own.record.interview!.entries.find((entry) => entry.label === "Embarazo")).toMatchObject({ unreviewed: { by: { kind: "patient" } } })

  // Lo dijo su madre: con su vínculo y su nombre, como quedaron guardados ese día.
  const mother = await declaredBy({ kind: "representative", name: "Carla Ríos", relation: "madre" })
  const motherMark = `Lo dijo su madre, Carla, el ${day}, sin revisar`
  expect(mother.text).toContain(`Versión 1 · Lo dijo su madre, Carla, el ${day}`)
  expect(mother.text).toContain(motherMark)
  expect(mother.stated("AllergyIntolerance")).toMatchObject({ asserter: { display: "Carla Ríos (madre)" }, note: [{ text: motherMark }] })
  expect(mother.stated("MedicationStatement")).toMatchObject({ informationSource: { display: "Carla Ríos (madre)" } })

  // Se lo dijeron al equipo, que lo anotó: no se afirma quién lo dijo.
  const team = await declaredBy({ kind: "staff", name: null, relation: null })
  const teamMark = `Lo anotó el equipo el ${day}, sin revisar`
  expect(team.text).toContain(`Versión 1 · Lo anotó el equipo el ${day}`)
  expect(team.text).toContain(teamMark)
  expect(team.stated("Condition", "Antecedente")).toMatchObject({ note: [{ text: teamMark }] })
  expect(team.stated("Condition", "Antecedente")).not.toHaveProperty("asserter")
  expect(team.stated("MedicationStatement")).not.toHaveProperty("informationSource")
})

it("un «no» que dijo la persona y nadie revisó se dice como suyo, no como algo que no se registró", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  await ownerDb
    .insert(patientRegistration)
    .values({ organizationId: "org_a", patientId: f.patient.id, entryPoint: "public_link", respondent: "patient", answers: {} })
  const health = {
    allergies: { state: "none" as const, items: [] },
    conditions: { state: "none" as const, items: [] },
    medications: { state: "none" as const, items: [] },
  }
  await run(async (tx) => {
    await initializeDeclaredPatientHealth(tx, "org_a", f.patient.id, health, null)
    await recordHealthDeclaration(tx, "org_a", f.patient.id, {
      via: "registro",
      by: { kind: "patient", name: null, relation: null },
      health,
    })
  })
  const text = await printedText(await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id)))
  const day = dayWords(new Date(), ZONE)
  for (const topic of ["Alergias", "Enfermedades", "Medicación"])
    expect(text).toContain(`${topic}: Dijo que no el ${day}, sin revisar`)
  expect(text).not.toContain("Sin registros.")
})
