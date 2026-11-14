import { withOrgContext } from "@odentia/db"
import { encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { listFormResponses } from "./clinical-forms.js"
import { type DictationFormQuestion, dictationFormQuestions, formQuestionsOf, prepareFormAnswer, saidNumbers } from "./dictation-forms.js"
import { confirmDictationSuggestion, listDictationSuggestions, saveDictationSegment } from "./encounter-dictation.js"
import { voidEncounter } from "./encounters.js"
import { loadFormRecords } from "./form-record.js"
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
    expect(propose({ question: 6, answers: ["Onicofagia", "Bruxismo"] }, "hábitos: onicofagia")).toMatchObject({ status: "lista", payload: { value: ["Onicofagia"] } })
    // La opción exige su palabra: «se come las uñas» no dice «Onicofagia» (decidido el 14 nov).
    expect(propose({ question: 6, answers: ["Onicofagia"] }, "se come las uñas")).toBeNull()
  })
})

describe("lo que el servidor dejaba pasar (QA del 14 nov)", () => {
  const ORTHO = {
    sections: [
      {
        id: "o",
        title: "Oclusión",
        fields: [
          { id: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE },
          { id: "clase_canina_derecha", label: "Clase canina derecha", type: "opcion_unica", options: ["Clase I", "Clase II", "Clase III"] },
          { id: "clase_canina_izquierda", label: "Clase canina izquierda", type: "opcion_unica", options: ["Clase I", "Clase II", "Clase III"] },
          { id: "mordida_cruzada", label: "Mordida cruzada", type: "opcion_multiple", options: ["No tiene", "Anterior", "Posterior derecha", "Posterior izquierda"] },
          { id: "apinamiento", label: "Apiñamiento", type: "opcion_unica", options: ["No", "Leve", "Moderado", "Severo"] },
          { id: "linea_media_superior", label: "Línea media superior", type: "opcion_unica", options: ["Centrada", "Desviada a la derecha", "Desviada a la izquierda"] },
          { id: "linea_media_inferior", label: "Línea media inferior", type: "opcion_unica", options: ["Centrada", "Desviada a la derecha", "Desviada a la izquierda"] },
        ],
      },
    ],
  }
  const ENDO = {
    sections: [
      {
        id: "e",
        title: "Pieza y pruebas",
        fields: [
          { id: "pieza", label: "Pieza", type: "pieza" },
          { id: "tumefaccion", label: "Tumefacción", type: "opcion_unica", options: ["No tiene", "Intraoral", "Extraoral"] },
          { id: "fistula", label: "Fístula (tracto sinusal)", type: "booleano" },
          { id: "movilidad", label: "Movilidad", type: "opcion_unica", options: ["Grado 0 (fisiológica)", "Grado 1", "Grado 2", "Grado 3"] },
          { id: "percusion", label: "Percusión", type: "opcion_unica", options: ["Negativa", "Positiva"] },
          { id: "palpacion", label: "Palpación", type: "opcion_unica", options: ["Negativa", "Positiva"] },
        ],
      },
    ],
  }
  const forms = formQuestionsOf([
    { id: "orto", title: "Ficha de ortodoncia", snapshot: ORTHO, answers: {} },
    { id: "endo", title: "Evaluación de endodoncia", snapshot: ENDO, answers: {} },
  ])
  const ask = (fieldId: string, answer: string | string[], said: string) => {
    const number = forms.find((item) => item.fieldId === fieldId)?.number
    const payload = Array.isArray(answer) ? { question: number, answers: answer } : { question: number, answer }
    return prepareFormAnswer({ payload, sourceText: said }, forms, FDI)
  }

  it("una opción sin número exige su palabra; «No», «No tiene» o «Negativa», una negación y la pregunta nombrada", () => {
    expect(ask("mordida_cruzada", ["Anterior"], "mordida abierta anterior")).toBeNull()
    expect(ask("palpacion", "Negativa", "percusión positiva")).toBeNull()
    expect(ask("apinamiento", "No", "buena higiene, sin caries")).toBeNull()
    expect(ask("tumefaccion", "No tiene", "dolor provocado al masticar")).toBeNull()
    expect(ask("apinamiento", "No", "no hay apiñamiento")).toMatchObject({ status: "lista", payload: { value: "No" } })
    expect(ask("tumefaccion", "No tiene", "sin tumefacción")).toMatchObject({ status: "lista", payload: { value: "No tiene" } })
    expect(ask("mordida_cruzada", ["Anterior"], "mordida cruzada anterior")).toMatchObject({ status: "lista", payload: { value: ["Anterior"] } })
  })
  it("la frase tiene que hablar de esa pregunta: el lado y superior o inferior", () => {
    expect(ask("clase_canina_izquierda", "Clase I", "clase canina derecha clase uno")).toBeNull()
    expect(ask("clase_canina_derecha", "Clase I", "clase canina derecha clase uno")).toMatchObject({ status: "lista" })
    expect(ask("linea_media_inferior", "Centrada", "línea media superior centrada")).toBeNull()
  })
  it("«un» y «una» no cuentan como 1 al elegir una opción", () => {
    expect(ask("clase_molar_derecha", "Clase II división 1", "una clase dos molar derecha")).not.toMatchObject({ status: "lista" })
    expect(ask("movilidad", "Grado 1", "un diente con movilidad grado dos")).not.toMatchObject({ status: "lista" })
  })
  it("un «Sí» con una negación queda por revisar; «sin embargo» no niega", () => {
    expect(ask("fistula", "Sí", "no hay fístula")).toMatchObject({ status: "por_revisar" })
    expect(ask("fistula", "Sí", "sin embargo hay fístula")).toMatchObject({ status: "lista", payload: { value: true } })
  })
  it("«al menos dos» no es menos dos, y la pieza se dice dígito a dígito", () => {
    expect(saidNumbers("al menos dos")).toEqual([2])
    expect(saidNumbers("por lo menos dos")).toEqual([2])
    expect(saidNumbers("menos dos")).toEqual([-2])
    expect(ask("pieza", "46", "en la cuatro seis")).toMatchObject({ status: "lista", payload: { value: 46 } })
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
  it("Clío ve las preguntas que puede comprobar, las respondidas con lo que dicen; sin ficha empezada, ninguna", async () => {
    const { questions, fx } = await startedForm({ overbite: 4 })
    const list = await questions()
    expect(list.map((item) => item.fieldId)).toEqual(["clase_molar_derecha", "overjet", "overbite", "dolor", "intensidad"])
    expect(list.find((item) => item.fieldId === "overbite")?.answered).toBe(4)
    expect(list.find((item) => item.fieldId === "overjet")).not.toHaveProperty("answered")
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
    expect(result.note).toBe("Clío proponía «6 mm»; quedó «5 mm», que ya estaba escrito.")
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

  it("la que depende de otra no acepta esa otra por su cuenta: se confirman en el orden de la ficha", async () => {
    const { save, fx, answersNow } = await startedForm()
    const saved = await save([
      { payload: { question: 4, answer: "Sí" }, sourceText: "presenta dolor" },
      { payload: { question: 5, answer: "8" }, sourceText: "intensidad ocho de diez" },
    ])
    const pain = saved.suggestions.find((item) => item.payload["fieldId"] === "dolor")!
    const intensity = saved.suggestions.find((item) => item.payload["fieldId"] === "intensidad")!
    // Desmarcada «¿Presenta dolor?» al firmar, la intensidad sola no la acepta.
    await expect(fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, intensity.id))).rejects.toMatchObject({
      code: "FORM_ANSWER_DEPENDS",
    })
    expect(await answersNow()).toEqual({})
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, pain.id))
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, intensity.id))
    expect(await answersNow()).toMatchObject({ dolor: true, intensidad: 8 })
  })

  it("respondida la otra de forma que la oculta, la propuesta se descarta con el motivo, sin error", async () => {
    const { save, fx, form, answersNow } = await startedForm()
    const saved = await save([{ payload: { question: 5, answer: "8" }, sourceText: "intensidad ocho de diez" }])
    await ownerDb.update(clinicalFormResponse).set({ answers: { dolor: false } }).where(eq(clinicalFormResponse.id, form.id))
    const result = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id))
    expect(result.status).toBe("descartada")
    expect(result.note).toBe("«¿Presenta dolor?» quedó en «No»: esta pregunta ya no va.")
    expect(await answersNow()).toEqual({ dolor: false })
  })

  it("confirma lo que se veía: si una pausa la cambió, avisa y no escribe", async () => {
    const { save, fx, answersNow } = await startedForm()
    const first = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await save([{ payload: { question: 2, answer: "9" }, sourceText: "no, overjet de nueve" }])
    await expect(
      fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, first.suggestions[0]!.id, { expectedValue: 6 })),
    ).rejects.toMatchObject({ code: "SUGGESTION_CHANGED" })
    expect(await answersNow()).toEqual({})
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, first.suggestions[0]!.id, { expectedValue: 9 }))
    expect(await answersNow()).toMatchObject({ overjet: 9 })
  })

  it("dos respuestas a la misma pregunta en una pausa: vale la última", async () => {
    const { save } = await startedForm()
    const saved = await save([
      { payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" },
      { payload: { question: 2, answer: "9" }, sourceText: "perdón, overjet de nueve" },
    ])
    expect(saved.suggestions).toHaveLength(1)
    expect(saved.suggestions[0]).toMatchObject({ payload: { value: 9 }, sourceText: "perdón, overjet de nueve" })
  })

  it("corregida por voz, la propuesta muestra la frase nueva", async () => {
    const { save, fx, questions } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    const id = saved.suggestions[0]!.id
    const formQuestions = await questions()
    await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        drafts: [],
        corrections: [{ suggestionId: id, changes: { answer: "7" }, said: "no, el overjet es de siete" }],
        formQuestions,
      }),
    )
    const pending = await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(pending.find((item) => item.id === id)).toMatchObject({ payload: { value: 7 }, sourceText: "no, el overjet es de siete" })
  })

  it("sobre una ya respondida, lo que la cambia queda por revisar con lo que dice; lo mismo no se propone", async () => {
    const { save, answersNow } = await startedForm({ clase_molar_derecha: "Clase II división 2" })
    const same = await save([{ payload: { question: 1, answer: "Clase II división 2" }, sourceText: "clase molar derecha clase dos división dos" }])
    expect(same.suggestions).toEqual([])
    const changed = await save([{ payload: { question: 1, answer: "Clase II división 1" }, sourceText: "corrijo, clase molar derecha clase dos división uno" }])
    expect(changed.suggestions).toHaveLength(1)
    expect(changed.suggestions[0]).toMatchObject({
      status: "por_revisar",
      payload: { value: "Clase II división 1" },
      note: "Ya dice «Clase II división 2». Si cambió, cámbiala tú en la ficha.",
    })
    expect(await answersNow()).toEqual({ clase_molar_derecha: "Clase II división 2" })
  })

  it("lo que entra al firmar queda dicho en la ficha: «confirmó al firmar»", async () => {
    const { save, fx, form } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id, { expectedValue: 6, atSign: true }))
    const listed = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(listed.find((row) => row.id === form.id)?.clioAccepted["overjet"]).toMatchObject({ by: fx.actor, atSign: true })
    // La Historia y la copia lo dicen en su pregunta, mientras siga siendo eso (finalizada, es registro).
    await ownerDb.update(clinicalFormResponse).set({ status: "finalizado", finalizedAt: new Date() }).where(eq(clinicalFormResponse.id, form.id))
    const [record] = await fx.run((tx) => loadFormRecords(tx, ORG, fx.patient.id, { ids: [form.id] }))
    const overjet = record?.sections.flatMap((section) => section.items).find((item) => item.id === "overjet")
    expect(overjet?.clio).toMatch(/^Clío · confirmó al firmar .+ el /)
    expect(record?.sections.flatMap((section) => section.items).find((item) => item.id === "overbite")?.clio).toBeNull()
  })

  it("lo dicho para la ficha que no queda como propuesta vuelve con su motivo", async () => {
    const { save } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis centímetros" }])
    expect(saved.suggestions).toEqual([])
    expect(saved.droppedForms).toEqual([{ said: "overjet de seis centímetros", why: "«Overjet» va en mm: dilo en mm o escríbelo en la ficha." }])
  })

  it("la ficha abierta en pantalla se lee siempre, además de las dos últimas tocadas", async () => {
    const { fx, form, questions } = await startedForm()
    const more = async (title: string, updatedAt: Date) =>
      (
        await ownerDb
          .insert(clinicalFormResponse)
          .values({ ...form, id: undefined, templateTitle: title, answers: {}, createdAt: updatedAt, updatedAt })
          .returning()
      )[0]!
    await ownerDb.update(clinicalFormResponse).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(clinicalFormResponse.id, form.id))
    await more("Segunda", new Date())
    await more("Tercera", new Date())
    const titles = (list: DictationFormQuestion[]) => [...new Set(list.map((item) => item.formTitle))]
    expect(titles(await questions())).toEqual(["Segunda", "Tercera"])
    const open = await fx.run((tx) => dictationFormQuestions(tx, ORG, fx.encounter.id, { open: [form.id] }))
    expect(titles(open)).toEqual(["Ficha de ortodoncia", "Segunda", "Tercera"])
  })

  it("un dato que preguntan dos fichas empezadas se propone en las dos", async () => {
    const { form, save } = await startedForm()
    await ownerDb.insert(clinicalFormResponse).values({ ...form, id: undefined, templateTitle: "Control de ortodoncia", answers: {}, createdAt: new Date() })
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis milímetros" }])
    expect(saved.suggestions.map((item) => [item.payload["formTitle"], item.payload["value"]])).toEqual([
      ["Ficha de ortodoncia", 6],
      ["Control de ortodoncia", 6],
    ])
  })

  it("anular la atención descarta lo que Clío proponía", async () => {
    const { save, fx } = await startedForm()
    await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await fx.run((tx) => voidEncounter(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { reason: "Paciente equivocado" }))
    const rows = await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.encounterId, fx.encounter.id))
    expect(rows.map((row) => [row.status, row.note])).toEqual([["descartada", "Atención anulada: Paciente equivocado"]])
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
