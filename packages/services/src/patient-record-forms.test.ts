/**
 * La historia completa (QA de formularios del 13 nov): la copia salía sin ningún
 * formulario y sin la entrevista de salud, la atención firmada decía «Sin
 * registrar» teniendo uno y la Historia lo listaba solo con su título.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import {
  patient,
  patientAllergy,
  patientAnamnesis,
  patientDocument,
  patientHealthDeclaration,
  patientRegistration,
} from "@odentia/db/schema/clinical"
import { clinicalFormAddendum, clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
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
import { finalizeEncounter, getEncounterDetail, voidEncounter } from "./encounters.js"
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

  // Lo que la persona envió desde su enlace y nadie revisó todavía no es registro clínico, pero es
  // suyo: sale marcado «sin revisar», como lo que declaró de su salud (QA de la entrega 2, 14 nov).
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
  const [unreviewed] = await ownerDb
    .insert(clinicalFormResponse)
    .values({ ...declaredRow, answers: { motivo: "Respuesta que nadie revisó" } })
    .returning()
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
  expect(record.forms.map((form) => form.title)).toEqual([
    "Evaluación de endodoncia",
    "Cuestionario previo",
    "Cuestionario previo",
  ])
  // Los dos cuestionarios se enviaron en el mismo instante: se buscan por su id, no por su lugar.
  const form = record.forms[0]
  const sentOnly = record.forms.find((row) => row.id === unreviewed!.id)
  const fromPerson = record.forms.find((row) => row.id === reviewed!.id)
  expect(sentOnly).toMatchObject({ id: unreviewed!.id, source: "portal", finalizedAt: null, finalizedBy: null })
  // Quién lo respondió, con las palabras de la ficha: sin su sexo registrado, «el paciente».
  expect(sentOnly!.byWords).toMatch(/^Lo respondió el paciente desde su enlace el .+ · sin revisar$/)
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
    /^Lo respondió el paciente desde su enlace el .+ · lo revisó Clínico el /,
  )

  // La entrevista, como la cuenta odentIA, con lo que ella declaró dicho como suyo. El embarazo se
  // guarda con el día en que lo dijo: la copia dice la semana a su fecha y la que dijo ese día.
  // Dicho hoy, el día que ya dice el encabezado («Lo registró Clínico el …»): la semana va una vez y
  // el día no se repite (verificador, QA de la entrega 2).
  const pregnancy = "Sí · 30 semanas"
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
    // Lo del equipo y lo de la persona, cada uno en su apartado, con los nombres de la Historia.
    "Fichas de consulta (1)",
    "Lo que respondió el paciente (2)",
    "Evaluación de endodoncia · versión 1",
    // Quien lo llenó y lo finalizó se nombra una vez.
    "Lo llenó y lo finalizó Clínico el",
    "Respuesta que nadie revisó",
    "Pruebas de vitalidad",
    "Frío +, Percusión +",
    "Pieza 46",
    "Sin respuesta",
    "La prueba al frío se repitió a los 10 minutos.",
    "Lo respondió el paciente desde su enlace el",
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
  expect(text).not.toContain("Lo llenó Clínico · lo finalizó Clínico")
  expect(text).not.toContain("¿Desde cuándo no le duele?")
  // El equipo ya guardó sus antecedentes después de lo que ella dijo: de su salud nada queda «sin
  // revisar», y dice quién los revisó. Lo único sin revisar es el cuestionario que nadie miró.
  // La revisión no tocó enfermedades ni medicación («no se le preguntó»): no se dice que las revisó.
  expect(text).not.toContain("revisadas por")
  expect(text).not.toContain("revisada por")
  expect(text.match(/sin revisar/g)).toHaveLength(1)

  // El archivo para otro sistema: cada formulario como QuestionnaireResponse de FHIR R4.
  const resources = resourcesOf(record)
  const answered = resources.find((resource) => resource.id === response.id)
  expect(answered).toMatchObject({
    resourceType: "QuestionnaireResponse",
    // Tiene una adenda posterior: en R4 eso es `amended`.
    status: "amended",
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
  // Quién agregó la adenda y cuándo, en el recurso de R4 para eso.
  expect(resources.find((resource) => resource.resourceType === "Provenance" && resource.id === form!.addenda[0]!.id)).toMatchObject({
    target: [{ reference: `QuestionnaireResponse/${response.id}` }],
    activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "APPEND" }] },
    agent: [{ type: { coding: [{ code: "author" }] }, who: { display: "Clínico" } }],
  })
  // El que respondió ella: la fuente es la paciente, y sus respuestas son de cuando las envió, no de
  // cuando el equipo las revisó (R4: `authored` es cuándo se dieron).
  const [sent] = await ownerDb
    .select({ submittedAt: clinicalFormResponse.submittedAt })
    .from(clinicalFormResponse)
    .where(eq(clinicalFormResponse.id, reviewed!.id))
  expect(resources.find((resource) => resource.id === reviewed!.id)).toMatchObject({
    resourceType: "QuestionnaireResponse",
    source: { reference: `Patient/${f.patient.id}` },
    authored: sent!.submittedAt!.toISOString(),
  })
  // Lo que envió y nadie revisó viaja también, dicho así en su texto.
  const notReviewed = resources.find((resource) => resource.id === unreviewed!.id)
  expect(notReviewed).toMatchObject({ resourceType: "QuestionnaireResponse", status: "completed" })
  expect((notReviewed!.text as { div: string }).div).toContain("sin revisar")

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
  expect(record.declarations).toEqual([])
  const text = await printedText(record)
  expect(text).toContain("Sin fichas de consulta finalizadas.")
  expect(text).toContain("No respondió ningún cuestionario.")
  expect(text).toContain("Sin entrevista de salud registrada.")
  // Sin nada declarado no se anuncia una sección vacía.
  expect(text).not.toContain("Lo que declaró de su salud")
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
    expect(record.interview!.entries.map((entry) => [entry.key, entry.label, entry.value])).toEqual([
      ["antecedentesPersonales.hospitalizaciones", "Hospitalizaciones", "Neumonía en 2019"],
      // Una sola vez, y con las palabras comunes: latidIA no lo vuelve a decir en su grupo.
      // Dicho hoy, el día del encabezado: la semana va una vez y sin repetir el día.
      ["embarazoLactancia.embarazo", "Embarazo", "Sí · 12 semanas"],
      ["habitos", "Hábitos", "tabaco: nunca fumó"],
    ])
    // Una sola vez: ya no va además en una sección aparte del producto.
    expect(record.productSections).toEqual([])
    const interview = resourcesOf(record).find((resource) => resource.id === `${f.patient.id}-entrevista`)
    expect(JSON.stringify(interview)).toContain(`Lo registró Clínico el`)
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
  // Con lo que dice la atención de cada formulario (su estado, entrega 4) y lo respondido en una línea.
  expect(card?.born?.forms).toEqual([
    {
      id: inside.id,
      title: "Evaluación de endodoncia",
      summary,
      state: "finalizado",
      finalizedAt: expect.any(Date),
      afterSigning: false,
      retired: false,
      discardReason: null,
      discardedWithAttention: false,
      fromPerson: false,
    },
  ])
  // El que se llenó fuera de una atención es un hecho suelto, también con su resumen.
  expect(timeline.data.find((item) => item.type === "form")).toMatchObject({
    refId: loose.id,
    title: "Se completó la ficha de consulta: Evaluación periodontal",
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
  // Con las palabras de la ficha y de Documentos: «su madre, Marta».
  expect(record.forms[0]!.byWords).toMatch(/^Lo respondió su madre, Marta, el /)

  // La misma frase en la Historia: una sola regla para decir quién lo llenó.
  const timeline = await run((tx) => getTimeline(tx, "org_a", child.id, {}))
  expect(timeline.data.find((item) => item.type === "form")?.byText).toBe(
    "Lo respondió su madre, Marta · lo revisó Clínico",
  )

  const resources = resourcesOf(record)
  // FHIR R4: un id tiene hasta 64 caracteres, de letras, números, guion y punto.
  expect(resources.filter((resource) => !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id)).map((resource) => resource.id)).toEqual([])
  const related = resources.find((resource) => resource.resourceType === "RelatedPerson")
  // El vínculo, no la persona: su id es de este paciente, no el del contacto (que choca en la copia de un hermano).
  expect(related).toMatchObject({ patient: { reference: `Patient/${child.id}` }, name: [{ text: "Marta Tutora" }] })
  expect(related!.id).not.toBe(mother.id)
  expect(related!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const answered = resources.find((resource) => resource.id === sent!.id)
  expect(answered).toMatchObject({
    resourceType: "QuestionnaireResponse",
    source: { reference: `RelatedPerson/${related!.id}`, display: "Marta Tutora" },
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
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.interview!.entries.map((entry) => [entry.key, entry.label, entry.value])).toEqual([
    // El día en que se anotó es el del encabezado («Versión 1 · Lo registró Clínico el …»): no se repite.
    ["embarazoLactancia.embarazo", "Embarazo", "Sí · 32 semanas a la fecha de esta copia (30 semanas ese día)"],
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

  // La declaración original va también, tal como llegó: lo que envió, con su fecha y quién.
  expect(own.record.declarations).toMatchObject([
    {
      via: "registro",
      by: { kind: "patient" },
      entries: [
        { label: "Alergias", value: "Penicilina · Ronchas" },
        { label: "Enfermedades", value: "Hipertensión" },
        { label: "Medicación", value: "Losartán · 50 mg" },
        { label: "Embarazo", value: "Sí, 30 semanas" },
        { label: "Cirugías", value: "Cesárea en 2020" },
      ],
    },
  ])
  expect(own.text).toContain("Lo que declaró de su salud (1)")
  expect(own.text).toContain("En su registro")
  expect(own.text).toContain("Penicilina · Ronchas")
  expect(own.text).toContain("Sí, 30 semanas")
  const original = own.record.declarations[0]!
  const sent = resourcesOf(own.record).find((resource) => resource.id === `${own.f.patient.id}-declaracion-1`)
  expect(sent).toMatchObject({
    resourceType: "QuestionnaireResponse",
    status: "completed",
    authored: original.at.toISOString(),
    source: patientRef,
    contained: [{ resourceType: "Questionnaire", title: "Declaración de salud" }],
  })
  expect(sent).not.toHaveProperty("author")
  expect(JSON.stringify(sent)).toContain('"valueString":"Penicilina · Ronchas"')

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
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  const text = await printedText(record)
  const day = dayWords(new Date(), ZONE)
  for (const topic of ["Alergias", "Enfermedades", "Medicación"])
    expect(text).toContain(`${topic}: Dijo que no el ${day}, sin revisar`)
  expect(text).not.toContain("Sin registros.")
  // Y en su declaración, tal como lo respondió.
  expect(record.declarations[0]!.entries).toEqual([
    { key: "allergies", label: "Alergias", value: "No" },
    { key: "conditions", label: "Enfermedades", value: "No" },
    { key: "medications", label: "Medicación", value: "No" },
  ])
})

/** Lo que la persona envió desde su enlace, tal como llegó (la respuesta del portal). */
async function sentForm(f: Fixture, title: string, schema: FormSchemaDef, answers: Record<string, unknown>, sentAt = new Date()) {
  const template = await publishTemplate(f, title, schema, "portal")
  const [row] = await ownerDb
    .insert(clinicalFormResponse)
    .values({
      organizationId: "org_a",
      templateId: template.id,
      templateVersion: template.version,
      templateTitle: template.title,
      templateSnapshot: template.schema,
      patientId: f.patient.id,
      status: "borrador",
      source: "portal",
      respondentContactId: f.patient.personId,
      submittedAt: sentAt,
      submittedVia: "enlace",
      answers,
    })
    .returning()
  return row!
}

it("QA de la entrega 2: la ficha de una atención anulada sale marcada, y en FHIR ya no vale", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const response = await finalizedForm(f, f.encounter.id)
  // «Abierta por error: era de otra paciente»: se anula con su ficha ya finalizada.
  await run((tx) => voidEncounter(tx, "org_a", f.actor, f.patient.id, f.encounter.id, { reason: "Era de otra paciente" }))
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.forms[0]).toMatchObject({ id: response.id, voidedAttention: { reason: "Era de otra paciente" } })
  const text = await printedText(record)
  expect(text).toContain("Se conserva, pero ya no vale: es de una atención anulada el")
  expect(text).toContain("motivo: Era de otra paciente")
  // En el archivo para otro sistema, como lo observado de esa atención: ya no vale.
  const resources = resourcesOf(record)
  expect(resources.find((resource) => resource.id === response.id)).toMatchObject({
    resourceType: "QuestionnaireResponse",
    status: "entered-in-error",
  })
  expect(resources.find((resource) => resource.id === f.encounter.id)).toMatchObject({ status: "entered-in-error" })
})

it("QA de la entrega 2: la medicina que ya no toma no se lee como vigente, en el PDF ni en FHIR", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const health = await run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  await run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "recorded" },
      conditions: [],
      medications: [
        {
          name: "Sulfato ferroso",
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          notes: "Suspendida por indicación médica",
        },
        { name: "Aspirina 100 mg", frequency: "Cada 24 horas" },
        { name: "Amoxicilina 500 mg", startDate: "2026-01-01", endDate: "2099-12-31" },
      ],
    }),
  )
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  const text = await printedText(record)
  expect(text).toContain("Ya no lo toma: Sulfato ferroso · hasta el 31/01/2026 · Suspendida por indicación médica")
  expect(text).toContain("Medicamento: Aspirina 100 mg · Cada 24 horas")
  // Con un fin por venir todavía la toma: dice hasta cuándo.
  expect(text).toContain("Medicamento: Amoxicilina 500 mg · hasta el 31/12/2099")
  expect(text).not.toContain("Medicamento: Sulfato ferroso")
  const statements = resourcesOf(record).filter((resource) => resource.resourceType === "MedicationStatement")
  const byName = (name: string) =>
    statements.find((resource) => (resource.medicationCodeableConcept as { text: string }).text === name)
  expect(byName("Sulfato ferroso")).toMatchObject({
    status: "completed",
    effectivePeriod: { start: "2026-01-01", end: "2026-01-31" },
    note: [{ text: "Suspendida por indicación médica" }],
  })
  expect(byName("Aspirina 100 mg")).toMatchObject({ status: "active" })
  expect(byName("Amoxicilina 500 mg")).toMatchObject({ status: "active", effectivePeriod: { end: "2099-12-31" } })
})

it("QA de la entrega 2: la copia dice quién revisó los antecedentes, y el «no» que ella dijo no se pierde", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  await ownerDb
    .insert(patientRegistration)
    .values({ organizationId: "org_a", patientId: f.patient.id, entryPoint: "public_link", respondent: "patient", answers: {} })
  const declared = {
    allergies: { state: "none" as const, items: [] },
    conditions: { state: "none" as const, items: [] },
    medications: { state: "none" as const, items: [] },
  }
  await run(async (tx) => {
    await initializeDeclaredPatientHealth(tx, "org_a", f.patient.id, declared, null)
    await recordHealthDeclaration(tx, "org_a", f.patient.id, {
      via: "registro",
      by: { kind: "patient", name: null, relation: null },
      health: declared,
    })
  })
  // «Revisar antecedentes»: la doctora niega alergias, anota una medicina y deja enfermedades sin tocar.
  const health = await run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  await run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "none", conditions: "unknown", medications: "recorded" },
      conditions: [],
      medications: [{ name: "Ácido fólico", dose: "0,4 mg" }],
    }),
  )
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.reviews.history).toMatchObject({ by: "Clínico" })
  const text = await printedText(record)
  const day = dayWords(new Date(), ZONE)
  // Dice lo que revisó: la medicación; enfermedades quedó «no se le preguntó» y las alergias tienen su revisión.
  expect(text).toContain(`Medicación revisada por Clínico el ${day}`)
  expect(text).not.toContain("Antecedentes revisados")
  // Las alergias tienen su propia revisión: su «no» sigue sin revisar, como suyo.
  expect(text).toContain(`Alergias: Dijo que no el ${day}, sin revisar`)
  // En la clínica nadie le preguntó por sus enfermedades, pero ella dijo que no: se dicen las dos cosas.
  expect(text).toContain(`Enfermedades: no se le preguntó en la clínica; dijo que no el ${day}`)
  expect(text).toContain("Medicamento: Ácido fólico · 0,4 mg")
  // En FHIR, quién verificó lo revisado y cuándo (`Provenance`, `verifier`).
  const provenance = resourcesOf(record).find((resource) => resource.id === `${f.patient.id}-antecedentes-revisados`)
  expect(provenance).toMatchObject({
    resourceType: "Provenance",
    agent: [
      {
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "verifier" }] },
        who: { display: "Clínico" },
      },
    ],
  })
  expect((provenance!.target as Array<{ reference: string }>)[0]!.reference).toMatch(/^MedicationStatement\//)
})

it("QA de la entrega 2: la corrección lleva su motivo, si se dijo, en la ficha, el PDF y FHIR", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const sent = await sentForm(
    f,
    "Cuestionario previo",
    { sections: [{ id: "motivo", title: "Motivo", fields: [{ id: "motivo", label: "¿Por qué vienes?", type: "texto" }] }] },
    { motivo: "Me duele la muela de la derecha" },
  )
  const withReason = await run((tx) =>
    addFormAddendum(tx, "org_a", f.actor, sent.id, "Es la izquierda, la 36.", "  Lo confirmó en consulta  "),
  )
  expect(withReason.reason).toBe("Lo confirmó en consulta")
  // Vacío no traba: la corrección se guarda sin motivo.
  const without = await run((tx) => addFormAddendum(tx, "org_a", f.actor, sent.id, "Toma aspirina.", "   "))
  expect(without.reason).toBeNull()
  // Con tope, como todo texto.
  await expect(run((tx) => addFormAddendum(tx, "org_a", f.actor, sent.id, "Otra", "x".repeat(2001)))).rejects.toThrow(
    /motivo/i,
  )
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.forms[0]!.addenda.map((addendum) => [addendum.text, addendum.reason])).toEqual([
    ["Es la izquierda, la 36.", "Lo confirmó en consulta"],
    ["Toma aspirina.", null],
  ])
  const text = await printedText(record)
  expect(text).toContain("Es la izquierda, la 36. · Motivo: Lo confirmó en consulta (Clínico,")
  expect(text).toContain("Toma aspirina. (Clínico,")
  const resources = resourcesOf(record)
  expect(resources.find((resource) => resource.id === withReason.id)).toMatchObject({
    resourceType: "Provenance",
    target: [{ reference: `QuestionnaireResponse/${sent.id}` }],
    reason: [{ text: "Lo confirmó en consulta" }],
  })
  expect(resources.find((resource) => resource.id === without.id)).not.toHaveProperty("reason")
  // Sin revisar todavía: lo que envió es de cuando lo envió, y con correcciones queda enmendado.
  expect(resources.find((resource) => resource.id === sent.id)).toMatchObject({
    status: "amended",
    authored: sent.submittedAt!.toISOString(),
  })
})

it("QA de la entrega 2: en la Historia, lo que respondió va el día en que lo envió, sin signos sueltos y con su corrección", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const sentAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const sent = await sentForm(
    f,
    "Antes de tu cita",
    {
      sections: [
        {
          id: "dolor",
          title: "Dolor",
          fields: [{ id: "dolor", label: "¿Cuánto te duele? (0 sin dolor, 10 el peor dolor)", type: "escala", min: 0, max: 10 }],
        },
      ],
    },
    { dolor: 7 },
    sentAt,
  )
  await run((tx) => addFormAddendum(tx, "org_a", f.actor, sent.id, "En consulta dice 5."))
  await run((tx) => finalizeFormResponse(tx, "org_a", f.actor, sent.id))
  const history = await run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["form"] }))
  expect(history.data).toHaveLength(1)
  const [item] = history.data
  // El día en que lo envió, no el de su revisión (auditor: «hace 11 min» cuando era de hace 15).
  expect(new Date(item!.createdAt).getTime()).toBe(sentAt.getTime())
  expect(item!.detail).toBe("Cuánto te duele (0 sin dolor, 10 el peor dolor): 7 de 10 · con 1 corrección")
  expect(item!.byText).toBe("Lo respondió el paciente · lo revisó Clínico")
})

it("QA de la entrega 2 (revisor): la revisión de alergias apunta solo a lo que existía al revisar y está confirmado", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const reviewedAt = new Date(Date.now() - 7 * 86_400_000)
  const allergy = async (substance: string, verification: string, createdAt: Date) =>
    (
      await ownerDb
        .insert(patientAllergy)
        .values({ organizationId: "org_a", patientId: f.patient.id, substance, severity: "desconocida", verification, createdAt })
        .returning()
    )[0]!
  const before = await allergy("Penicilina", "confirmada", new Date(reviewedAt.getTime() - 86_400_000))
  await allergy("Ibuprofeno", "no_confirmada", new Date(reviewedAt.getTime() - 86_400_000))
  // Anotada una semana después de la revisión: esa revisión no la vio.
  await allergy("Látex", "confirmada", new Date(reviewedAt.getTime() + 86_400_000))
  await ownerDb
    .update(patient)
    .set({ allergiesReviewedAt: reviewedAt, allergiesReviewedBy: f.actor })
    .where(eq(patient.id, f.patient.id))
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  const provenance = resourcesOf(record).find((resource) => resource.id === `${f.patient.id}-alergias-revisadas`)
  expect(provenance).toMatchObject({ resourceType: "Provenance", recorded: reviewedAt.toISOString() })
  expect(provenance!.target).toEqual([{ reference: `AllergyIntolerance/${before.id}` }])
  // Dice qué se revisó, no «antecedentes».
  const text = await printedText(record)
  expect(text).toContain(`Alergias revisadas por Clínico el ${dayWords(reviewedAt, ZONE)}`)
  expect(text).not.toContain("Antecedentes revisados")
})

it("QA de la entrega 2 (revisor): la madre de dos hermanos es un vínculo distinto en cada copia, y cada fullUrl es un urn:uuid", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const mother = await run((tx) => createContact(tx, "org_a", { displayName: "Carla Ríos" }))
  const child = (displayName: string) =>
    run((tx) =>
      createPatient(tx, "org_a", f.actor, {
        displayName,
        birthDate: "2018-02-03",
        contacts: [{ contactId: mother.id, relationship: "guardian", relationshipDetail: "Madre", isPreferred: true }],
      }),
    )
  const [ana, luis] = [await child("Ana Ríos"), await child("Luis Ríos")]
  const relatedOf = async (patientId: string) =>
    resourcesOf(await run((tx) => loadPatientRecord(tx, "org_a", patientId))).find(
      (resource) => resource.resourceType === "RelatedPerson",
    )!.id
  const [first, again, sibling] = [await relatedOf(ana.id), await relatedOf(ana.id), await relatedOf(luis.id)]
  expect(first).toBe(again)
  expect(first).not.toBe(sibling)
  // Un urn:uuid lleva un UUID, también para lo que no tiene uno de id (la entrevista, una revisión).
  await run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, ana.id, {
      expectedRevision: 0,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "recorded" },
      conditions: [],
      medications: [{ name: "Ácido fólico" }],
      anamnesis: { expectedVersion: 0, answers: { antecedentesPersonales: { cirugias: "Ninguna" } } },
    }),
  )
  const bundle = patientRecordFhirBundle(await run((tx) => loadPatientRecord(tx, "org_a", ana.id))) as {
    entry: Array<{ fullUrl: string; resource: Resource }>
  }
  const uuid = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  expect(bundle.entry.filter((entry) => !uuid.test(entry.fullUrl)).map((entry) => entry.fullUrl)).toEqual([])
  expect(new Set(bundle.entry.map((entry) => entry.fullUrl)).size).toBe(bundle.entry.length)
  expect(bundle.entry.map((entry) => entry.resource.id)).toContain(`${ana.id}-entrevista`)
})

it("QA de la entrega 2 (revisor): lo que respondió va en la copia por el día en que lo envió, no por el de su revisión", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  // Lo envió hace tres días; el equipo finalizó una ficha y, después, revisó lo enviado.
  const sent = await sentForm(
    f,
    "Antes de tu cita",
    { sections: [{ id: "motivo", title: "Motivo", fields: [{ id: "motivo", label: "¿Por qué vienes?", type: "texto" }] }] },
    { motivo: "Control" },
    new Date(Date.now() - 3 * 86_400_000),
  )
  const staff = await finalizedForm(f, null)
  await run((tx) => finalizeFormResponse(tx, "org_a", f.actor, sent.id))
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.forms.map((form) => form.id)).toEqual([sent.id, staff.id])
})

it("QA de la entrega 2 (revisor): la copia trae todas sus declaraciones, también las de hace más de 50", async () => {
  const f = await clinicalFixture()
  const run = runOf(f)
  const base = Date.now() - 60 * 86_400_000
  await ownerDb.insert(patientHealthDeclaration).values(
    Array.from({ length: 55 }, (_, index) => ({
      organizationId: "org_a",
      patientId: f.patient.id,
      via: "enlace" as const,
      respondent: "patient" as const,
      health: { allergies: { state: "none" as const, items: [] } },
      saidAt: new Date(base + index * 86_400_000),
      createdAt: new Date(base + index * 86_400_000),
    })),
  )
  const record = await run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(record.declarations).toHaveLength(55)
  // La ficha sigue leyendo las últimas 50.
  expect((await run((tx) => getPatientHealth(tx, "org_a", f.patient.id))).declarations).toHaveLength(50)
})

it("QA de la entrega 2 (revisor): el motivo de una corrección, si se guarda, no va vacío ni pasa de 2000 caracteres en la base", async () => {
  const f = await clinicalFixture()
  const sent = await sentForm(
    f,
    "Cuestionario previo",
    { sections: [{ id: "motivo", title: "Motivo", fields: [{ id: "motivo", label: "¿Por qué vienes?", type: "texto" }] }] },
    { motivo: "Control" },
  )
  const row = (reason: string | null) => ({ organizationId: "org_a", responseId: sent.id, text: "Corrección", reason })
  await expect(ownerDb.insert(clinicalFormAddendum).values(row(""))).rejects.toThrow()
  await expect(ownerDb.insert(clinicalFormAddendum).values(row("x".repeat(2001)))).rejects.toThrow()
  await ownerDb.insert(clinicalFormAddendum).values(row(null))
  await ownerDb.insert(clinicalFormAddendum).values(row("Lo confirmó en consulta"))
})
