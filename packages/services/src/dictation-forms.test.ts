import { withOrgContext } from "@odentia/db"
import { encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { listFormResponses } from "./clinical-forms.js"
import { type DictationFormQuestion, dictationFormQuestions, prepareFormAnswer, saidNumbers } from "./dictation-forms.js"
import { confirmDictationSuggestion, listDictationSuggestions, saveDictationSegment } from "./encounter-dictation.js"
import type { ProductSite } from "./product-hooks.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Clío propone las respuestas de la ficha empezada (entrega 11, ADR 0187): solo
 * lo que se dijo, comprobado contra la frase, y nada entra hasta que una
 * persona lo acepta, sin pisar lo que ella escribió.
 */

const FDI: ProductSite = {
  code: (value: unknown) => (typeof value === "number" && /^[1-4][1-8]$|^[5-8][1-5]$/.test(String(value)) ? String(value) : null),
  invalid: (value: unknown) => `${String(value)} no es una pieza`,
} as unknown as ProductSite

const question = (number: number, overrides: Partial<DictationFormQuestion>): DictationFormQuestion => ({
  number,
  responseId: "r1",
  formTitle: "Ficha de ortodoncia",
  fieldId: `p${number}`,
  label: `Pregunta ${number}`,
  type: "numero",
  options: null,
  unit: null,
  min: null,
  max: null,
  order: number,
  dependsOn: null,
  ...overrides,
})

const ANGLE = ["Clase I", "Clase II división 1", "Clase II división 2", "Clase III"]
const QUESTIONS: DictationFormQuestion[] = [
  question(1, { fieldId: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE }),
  question(2, { fieldId: "overjet", label: "Overjet", unit: "mm", min: -10, max: 20 }),
  question(3, { fieldId: "dolor", label: "¿Presenta dolor?", type: "booleano" }),
  question(4, { fieldId: "intensidad", label: "Intensidad", type: "escala", min: 0, max: 10 }),
  question(5, { fieldId: "pieza", label: "Pieza", type: "pieza" }),
  question(6, { fieldId: "habitos", label: "Hábitos", type: "opcion_multiple", options: ["Onicofagia", "Succión digital", "Respiración bucal"] }),
]
const propose = (payload: Record<string, unknown>, sourceText?: string) => prepareFormAnswer({ payload, sourceText }, QUESTIONS, FDI)

describe("los números que se dijeron", () => {
  it("lee cifras, palabras, decimales y negativos, con sus repeticiones", () => {
    expect(saidNumbers("overjet de seis milímetros, overbite de tres")).toEqual([6, 3])
    expect(saidNumbers("dolor en la cuarenta y seis, ocho de diez")).toEqual([46, 8, 10])
    expect(saidNumbers("la veintiséis y la 6,5")).toEqual([26, 6.5])
    expect(saidNumbers("seis y medio, menos dos")).toEqual([6.5, -2])
    expect(saidNumbers("clase dos división dos")).toEqual([2, 2])
    // El punto que cierra la frase no es parte del número.
    expect(saidNumbers("overbite de tres. Clase 2.")).toEqual([3, 2])
    expect(saidNumbers("talla de ciento quince")).toEqual([115])
  })
  it("en una opción lee los romanos; en lo dictado, solo los de dos letras", () => {
    expect(saidNumbers("Clase II división 1", { roman: "todos" })).toEqual([2, 1])
    expect(saidNumbers("Clase I", { roman: "todos" })).toEqual([1])
    expect(saidNumbers("I lado derecho", { roman: "largos" })).toEqual([])
  })
})

describe("lo que propone Clío se comprueba contra lo que se dijo", () => {
  it("sin frase no se propone nada, ni a una pregunta que no se le dio", () => {
    expect(propose({ question: 2, answer: "6" })).toBeNull()
    expect(propose({ question: 9, answer: "6" }, "overjet de seis")).toBeNull()
  })
  it("el número tiene que estar en la frase, sin convertir unidades", () => {
    expect(propose({ question: 2, answer: "6" }, "overjet de seis milímetros")).toMatchObject({ status: "lista", payload: { fieldId: "overjet", value: 6, unit: "mm" } })
    expect(propose({ question: 2, answer: "5" }, "medio centímetro de overjet")).toBeNull()
    expect(propose({ question: 2, answer: "16" }, "overjet de seis")).toBeNull()
  })
  it("fuera de rango queda por revisar, sin valor", () => {
    expect(propose({ question: 4, answer: "15" }, "dolor quince de diez")).toMatchObject({ status: "por_revisar", payload: { value: null } })
  })
  it("el silencio no es «No»: un «No» exige una negación dicha", () => {
    expect(propose({ question: 3, answer: "No" }, "dolor a la percusión en la cuarenta y seis")).toBeNull()
    expect(propose({ question: 3, answer: "No" }, "sin dolor espontáneo")).toMatchObject({ status: "lista", payload: { value: false } })
    expect(propose({ question: 3, answer: "Sí" }, "presenta dolor")).toMatchObject({ status: "lista", payload: { value: true } })
  })
  it("la opción cuya división no se dijo queda por revisar y nombra entre cuáles elegir", () => {
    const vague = propose({ question: 1, answer: "Clase II división 1" }, "clase dos molar derecha")
    expect(vague).toMatchObject({ status: "por_revisar", payload: { value: null } })
    expect(vague?.note).toContain("«Clase II división 1» y «Clase II división 2»")
    expect(propose({ question: 1, answer: "clase i" }, "clase uno molar derecha")).toMatchObject({ status: "lista", payload: { value: "Clase I" } })
    expect(propose({ question: 1, answer: "Clase IV" }, "clase cuatro")).toBeNull()
  })
  it("el número de una opción es solo un rótulo si se dijeron sus palabras y ninguna otra calza mejor", () => {
    const frankl = [question(1, { fieldId: "conducta", label: "Conducta (Frankl)", type: "opcion_unica", options: ["1 · Definitivamente negativa", "2 · Negativa", "3 · Positiva", "4 · Definitivamente positiva"] })]
    const check = (answer: string, said: string) => prepareFormAnswer({ payload: { question: 1, answer }, sourceText: said }, frankl, FDI)
    expect(check("1 · Definitivamente negativa", "conducta definitivamente negativa")).toMatchObject({ status: "lista" })
    expect(check("2 · Negativa", "conducta definitivamente negativa")).toMatchObject({ status: "por_revisar" })
    expect(check("3 · Positiva", "Frankl tres")).toMatchObject({ status: "lista" })
    // Con un número dicho que es de la lista, las palabras no bastan: «clase dos» no es «Clase I».
    expect(propose({ question: 1, answer: "Clase I" }, "clase dos molar derecha")).toMatchObject({ status: "por_revisar" })
  })
  it("la pieza tiene que existir y haberse dicho", () => {
    expect(propose({ question: 5, answer: "46" }, "en la cuarenta y seis")).toMatchObject({ status: "lista", payload: { value: 46 } })
    expect(propose({ question: 5, answer: "19" }, "la diecinueve")).toMatchObject({ status: "por_revisar" })
  })
  it("varias opciones: solo las que están en la lista", () => {
    expect(propose({ question: 6, answers: ["Onicofagia", "Bruxismo"] }, "se come las uñas")).toMatchObject({ status: "lista", payload: { value: ["Onicofagia"] } })
  })
})

setupTestDb()
const ORG = "org_a"

const ORTHO_SCHEMA = {
  sections: [
    {
      id: "oclusion",
      title: "Oclusión",
      fields: [
        { id: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE },
        { id: "overjet", label: "Overjet", type: "numero", unit: "mm", min: -10, max: 20 },
        { id: "overbite", label: "Overbite", type: "numero", unit: "mm", min: -10, max: 15 },
        { id: "dolor", label: "¿Presenta dolor?", type: "booleano" },
        { id: "intensidad", label: "Intensidad", type: "escala", min: 0, max: 10, showIf: { field: "dolor", equals: true } },
        { id: "observaciones", label: "Observaciones", type: "texto_largo" },
      ],
    },
  ],
}

/** Una atención con Clío encendida y la ficha de ortodoncia ya empezada. */
async function startedForm(answers: Record<string, unknown> = {}) {
  const fx = await clinicalFixture()
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: true }))
  const [template] = await ownerDb
    .insert(clinicalFormTemplate)
    .values({ organizationId: ORG, key: `orto-${fx.actor}`, title: "Ficha de ortodoncia", status: "publicado", schema: ORTHO_SCHEMA })
    .returning()
  const [form] = await ownerDb
    .insert(clinicalFormResponse)
    .values({
      organizationId: ORG,
      templateId: template!.id,
      templateVersion: 1,
      templateTitle: "Ficha de ortodoncia",
      templateSnapshot: ORTHO_SCHEMA,
      patientId: fx.patient.id,
      encounterId: fx.encounter.id,
      professionalUserId: fx.actor,
      authorUserId: fx.actor,
      status: "borrador",
      source: "staff",
      answers,
    })
    .returning()
  const questions = () => fx.run((tx) => dictationFormQuestions(tx, ORG, fx.encounter.id))
  /** Como la ruta: con las preguntas que vio Clío (leídas antes de ordenar, salvo que se den). */
  const save = async (drafts: Array<{ payload: Record<string, unknown>; sourceText: string }>, seen?: DictationFormQuestion[]) => {
    const formQuestions = seen ?? (await questions())
    return fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: drafts.map((draft) => ({ kind: "ficha" as const, ...draft })), formQuestions }),
    )
  }
  const answersNow = async () =>
    ((await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, form!.id)))[0]?.answers ?? {}) as Record<string, unknown>
  return { fx, form: form!, save, questions, answersNow }
}

describe("la ficha empezada recibe lo que propone Clío (base)", () => {
  it("Clío ve solo las preguntas vacías que puede comprobar; sin ficha empezada, ninguna", async () => {
    const { questions, fx } = await startedForm({ overbite: 4 })
    const list = await questions()
    expect(list.map((item) => item.fieldId)).toEqual(["clase_molar_derecha", "overjet", "dolor", "intensidad"])
    expect(list.find((item) => item.fieldId === "intensidad")?.dependsOn).toMatchObject({ fieldId: "dolor", equals: true })
    await ownerDb.update(clinicalFormResponse).set({ status: "finalizado", finalizedAt: new Date() }).where(eq(clinicalFormResponse.encounterId, fx.encounter.id))
    expect(await questions()).toEqual([])
  })

  it("aceptar escribe en la ficha con quién y cuándo; la ficha lo dice mientras siga siendo eso", async () => {
    const { save, fx, form, answersNow } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis milímetros" }])
    expect(saved.suggestions).toHaveLength(1)
    expect(await answersNow()).not.toHaveProperty("overjet", 6)
    const confirmed = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id))
    expect(confirmed.status).toBe("confirmada")
    expect(await answersNow()).toMatchObject({ overjet: 6 })
    const listed = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(listed.find((row) => row.id === form.id)?.clioAccepted["overjet"]?.by).toBe(fx.actor)
    // Cambiada a mano, ya es de la persona: la marca se va.
    await ownerDb.update(clinicalFormResponse).set({ answers: { ...(await answersNow()), overjet: 7 } }).where(eq(clinicalFormResponse.id, form.id))
    const after = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(after.find((row) => row.id === form.id)?.clioAccepted).toEqual({})
  })

  it("lo que escribió la persona gana: la propuesta se descarta y se dice por qué", async () => {
    const { save, fx, form, answersNow } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await ownerDb.update(clinicalFormResponse).set({ answers: { overjet: 5 } }).where(eq(clinicalFormResponse.id, form.id))
    const result = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id))
    expect(result.status).toBe("descartada")
    expect(result.note).toContain("ya tenía respuesta")
    expect(await answersNow()).toMatchObject({ overjet: 5 })
  })

  it("respondida a mano mientras Clío ordenaba, no se propone, y el número no se corre a otra pregunta", async () => {
    const { save, form, questions } = await startedForm()
    const seen = await questions()
    await ownerDb.update(clinicalFormResponse).set({ answers: { overjet: 5 } }).where(eq(clinicalFormResponse.id, form.id))
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }], seen)
    expect(saved.suggestions).toEqual([])
  })

  it("sin las preguntas que vio Clío no se propone nada", async () => {
    const { fx } = await startedForm()
    const saved = await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: [{ kind: "ficha", payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }] }),
    )
    expect(saved.suggestions).toEqual([])
  })

  it("la que depende de otra acepta primero la propuesta de esa otra", async () => {
    const { save, fx, answersNow } = await startedForm()
    const saved = await save([
      { payload: { question: 4, answer: "Sí" }, sourceText: "presenta dolor" },
      { payload: { question: 5, answer: "8" }, sourceText: "ocho de diez" },
    ])
    const intensity = saved.suggestions.find((item) => item.payload["fieldId"] === "intensidad")!
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, intensity.id))
    expect(await answersNow()).toMatchObject({ dolor: true, intensidad: 8 })
    const pending = await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(pending.filter((item) => item.kind === "ficha")).toEqual([])
  })

  it("lo último que dijo para la misma pregunta cambia la propuesta, no la repite", async () => {
    const { save, fx } = await startedForm()
    await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    const again = await save([{ payload: { question: 2, answer: "7" }, sourceText: "no, overjet de siete" }])
    expect(again.corrected).toHaveLength(1)
    const pending = await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    const forms = pending.filter((item) => item.kind === "ficha")
    expect(forms).toHaveLength(1)
    expect(forms[0]?.payload["value"]).toBe(7)
    const rows = await ownerDb
      .select({ id: encounterDictationSuggestion.id })
      .from(encounterDictationSuggestion)
      .where(and(eq(encounterDictationSuggestion.encounterId, fx.encounter.id), eq(encounterDictationSuggestion.kind, "ficha")))
    expect(rows).toHaveLength(1)
  })
})
