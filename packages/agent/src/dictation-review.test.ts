import { formQuestionsOf, productHooksFor } from "@odentia/services"
import { dictationFindingsText } from "@odentia/services/dental"
import { describe, expect, it } from "vitest"
import { DENTAL_DICTATION_PROFILE, systemPrompt } from "./dental/dictation.js"
import {
  askDictationReview,
  DICTATION_REVIEW_RULES,
  type DictationReviewAsk,
  type DictationReviewSegment,
  dictationReviewExtraction,
  dictationReviewMessages,
  readDictation,
  readDictationReview,
} from "./dictation.js"
import { createConfiguredChatModel, resolveLlmSpec } from "./llm.js"
import { MEDICAL_DICTATION_PROFILE } from "./medical/dictation.js"
import { cacheMarked, fakeProvider, messageContent, systemBlock, toolCallReply } from "./test-provider.js"

/**
 * El repaso al terminar (mesa del 20 nov 2026, «Clío en una consulta conversada», P4): lo que lee
 * Clío y cómo se lee lo que devuelve. Los turnos valen solo si son el tramo tal cual: «Lo que se
 * dijo» nunca muestra un texto que nadie dijo.
 */
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 15, minute))
const SEGMENTS: DictationReviewSegment[] = [
  { number: 1, saidAt: at(0), transcript: "¿Tiene alguna enfermedad? Tiene asma, usa salbutamol.", needsTurns: true },
  { number: 2, saidAt: at(3), transcript: "Mi papá es diabético. Debe pesar veinticuatro.", needsTurns: true },
  { number: 3, saidAt: at(6), transcript: "Listo, te veo la próxima semana para la otra resina.", needsTurns: false },
]
const PARTS = DENTAL_DICTATION_PROFILE.parts
const read = (args: unknown) => readDictationReview(args, SEGMENTS, PARTS)

describe("los turnos del repaso", () => {
  // Las frases, numeradas seguidas: [1] ¿Tiene alguna enfermedad? [2] Tiene asma, usa salbutamol.
  // [3] Mi papá es diabético. [4] Debe pesar veinticuatro. [5] Listo, te veo… (tramo 3, ya con turnos).
  it("Clío dice solo dónde empieza cada turno y quién; el texto lo ponen las frases del tramo", () => {
    const result = read({
      turnos: [
        { desde: 1, quien: "dra" },
        { desde: 2, quien: "acompanante", vinculo: " madre " },
      ],
    })
    expect(result?.turns).toEqual([
      { number: 1, turns: [{ quien: "dra", texto: "¿Tiene alguna enfermedad?" }, { quien: "acompanante", vinculo: "madre", texto: "Tiene asma, usa salbutamol." }] },
      // El turno sigue en el tramo que viene hasta que empiece otro.
      { number: 2, turns: [{ quien: "acompanante", vinculo: "madre", texto: "Mi papá es diabético. Debe pesar veinticuatro." }] },
    ])
    expect(result?.turnsRejected).toEqual([])
  })

  it("lo de antes del primer turno no se sabe de quién es; quien no es de la lista o una frase que no existe no cuentan", () => {
    const result = read({
      turnos: [
        { desde: 2, quien: "paciente", vinculo: "madre" },
        { desde: 3, quien: "asistente" },
        { desde: 4, quien: "dra" },
        { desde: 5, quien: "dra" },
        { desde: 99, quien: "paciente" },
        { desde: "tres", quien: "dra" },
      ],
    })
    expect(result?.turns).toEqual([
      { number: 1, turns: [{ quien: "no_se_sabe", texto: "¿Tiene alguna enfermedad?" }, { quien: "paciente", texto: "Tiene asma, usa salbutamol." }] },
      { number: 2, turns: [{ quien: "paciente", texto: "Mi papá es diabético." }, { quien: "dra", texto: "Debe pesar veinticuatro." }] },
    ])
    // Sin ningún turno, ningún tramo queda partido: otro repaso lo vuelve a pedir.
    expect(read({ turnos: [] })?.turns).toEqual([])
  })
})

describe("lo que propone el repaso", () => {
  it("se lee con toda la conversación, sin correcciones ni «quita»: las órdenes ya se aplicaron en su pausa", () => {
    const result = read({
      controles: [{ title: "Control: la otra resina", dueAt: "2026-11-27T15:00:00Z", dicho: "te veo la próxima semana para la otra resina" }],
      correcciones: [{ sugerencia: 1, cambios: { toothNumber: 26 }, dicho: "Listo" }],
      quitar: [{ sugerencia: 1, dicho: "Listo" }],
    })
    expect(result?.drafts).toEqual([
      { kind: "control", payload: { title: "Control: la otra resina", dueAt: "2026-11-27T15:00:00Z" }, sourceText: "te veo la próxima semana para la otra resina" },
    ])
    // Lo ignorado no se avisa como «No lo usé».
    expect(result?.omitted).toBe(0)
    expect(result?.unused).toEqual([])
  })

  it("lo de un familiar y el peso dicho quedan fuera con su motivo, solo si se dijeron", () => {
    const result = read({
      sin_lugar: [
        { dicho: "Mi papá es diabético", motivo: "familiar" },
        { dicho: "Debe pesar veinticuatro", motivo: "peso_dicho" },
        { dicho: "Su abuela tiene presión alta", motivo: "familiar" },
        { dicho: "Tiene asma", motivo: "inventado" },
      ],
    })
    expect(result?.outOfPlace).toEqual([
      { said: "Mi papá es diabético", why: "familiar" },
      { said: "Debe pesar veinticuatro", why: "peso_dicho" },
      { said: "Tiene asma", why: "otro" },
    ])
  })
})

const ASK: DictationReviewAsk = {
  provider: "openai",
  services: ["Resina compuesta", "Endodoncia"],
  diagnosisList: "CIE-10",
  catalog: dictationFindingsText(),
  zone: { locale: "es-PE", timezone: "America/Lima" },
  now: new Date("2026-11-20T15:10:00Z"),
  segments: SEGMENTS,
  earlierLeftOut: false,
  pending: ["Consulta · motivo: «Control» · relato: «Viene con su mamá.»"],
  confirmed: ["Diagnóstico: K02.1 Caries de la dentina, pieza 36"],
  discarded: ["Controles: Control en 6 meses"],
}

describe("lo que lee Clío en el repaso", () => {
  it("las instrucciones de la pausa con las del repaso, con su corte; después lo que ya quedó y la conversación", async () => {
    const [system, human] = dictationReviewMessages(ASK, DENTAL_DICTATION_PROFILE, false)
    const blocks = system?.content as Array<{ text: string; prompt_cache_breakpoint?: unknown }>
    expect(blocks[0]?.prompt_cache_breakpoint).toEqual({ mode: "explicit" })
    expect(blocks[0]?.text.startsWith(systemPrompt({ services: ASK.services, diagnosisList: ASK.diagnosisList, catalog: ASK.catalog }))).toBe(true)
    expect(blocks[0]?.text.endsWith(DICTATION_REVIEW_RULES)).toBe(true)
    const text = String(human?.content)
    expect(text).toContain("descartada: no la vuelvas a proponer")
    expect(text).toContain(["Tramo 1 (10:00 a. m.) · partir en turnos:", "[1] ¿Tiene alguna enfermedad?", "[2] Tiene asma, usa salbutamol."].join("\n"))
    expect(text).toContain(["Tramo 3 (10:06 a. m.):", "[5] Listo, te veo la próxima semana para la otra resina."].join("\n"))
    expect(text).not.toContain("Lo dicho antes del tramo 1")
    expect(String(dictationReviewMessages({ ...ASK, earlierLeftOut: true }, DENTAL_DICTATION_PROFILE, false)[1]?.content)).toContain("Lo dicho antes del tramo 1 no se incluye")
    // Cada mensaje tal como llega al proveedor, con las instrucciones de siempre abreviadas.
    const shown = [blocks.map((block) => `${block.text}${block.prompt_cache_breakpoint ? "\n⟦corte de caché⟧" : ""}`).join(""), text]
      .join("\n⟦otro mensaje⟧\n")
      .replace(systemPrompt({ services: ASK.services, diagnosisList: ASK.diagnosisList, catalog: ASK.catalog }), "⟦instrucciones de siempre⟧")
    await expect(shown).toMatchFileSnapshot("./__golden__/clio-repaso.txt")
  })

  it("con una ficha abierta, sus reglas van antes de las del repaso, y sus preguntas con lo que ya quedó", () => {
    const forms = formQuestionsOf([{ id: "endo", title: "Evaluación de endodoncia", snapshot: productHooksFor("dental").forms.suggestions.find((item) => item.key === "evaluacion-de-endodoncia")?.schema, answers: {} }])
    const [system, human] = dictationReviewMessages({ ...ASK, forms }, DENTAL_DICTATION_PROFILE, false)
    const text = ((system?.content ?? []) as Array<{ text: string }>)[0]?.text ?? ""
    expect(text.indexOf("Fichas abiertas en esta atención")).toBeLessThan(text.indexOf("Repaso al terminar"))
    expect(String(human?.content)).toContain("Evaluación de endodoncia:")
  })

  it("la herramienta es la de la pausa del producto, con los turnos; lo que no tiene dónde ir ya va en la pausa (odentIA y latidIA)", () => {
    for (const profile of [DENTAL_DICTATION_PROFILE, MEDICAL_DICTATION_PROFILE]) {
      const shape = dictationReviewExtraction(profile).shape
      expect(Object.keys(profile.extraction.shape)).toContain("sin_lugar")
      expect(Object.keys(shape)).toEqual([...Object.keys(profile.extraction.shape), "turnos"])
    }
  })

  it("una llamada, por Chat Completions en odentIA, con la parte fija marcada", async () => {
    const provider = await fakeProvider((_, response, url) => toolCallReply(response, url, "registrar_dictado"))
    try {
      const spec = resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
      const model = await createConfiguredChatModel(spec, { explicitCache: true })
      const { read: result } = await askDictationReview(model, spec, ASK, DENTAL_DICTATION_PROFILE)
      expect(provider.requests.map((request) => request.url)).toEqual(["/v1/chat/completions"])
      expect(systemBlock(provider.requests[0])).toEqual(cacheMarked("text"))
      expect(JSON.stringify(messageContent(provider.requests[0], 1))).toContain("La conversación, tramo por tramo")
      expect(result).toMatchObject({ drafts: [], turns: [], turnsRejected: [] })
    } finally {
      await provider.close()
    }
  })
})

// QA del 21 nov (C10): sin puntuación, la pregunta y su respuesta son una sola frase y salían de un
// solo turno; y «Acompañante (no_se_sabe)» mostraba una clave interna.
describe("un turno que empieza a media frase", () => {
  const spoken = [{ number: 1, saidAt: at(0), transcript: "toma alguna medicina si tomo losartan para la presion", needsTurns: true }]
  it("con `empieza`, la frase se parte donde están esas palabras; un vínculo que es una clave no va", () => {
    const result = readDictationReview(
      {
        turnos: [
          { desde: 1, quien: "dra" },
          { desde: 1, quien: "acompanante", vinculo: "no_se_sabe", empieza: "si tomo losartan" },
        ],
      },
      spoken,
      PARTS,
    )
    expect(result?.turns).toEqual([
      { number: 1, turns: [{ quien: "dra", texto: "toma alguna medicina" }, { quien: "acompanante", texto: "si tomo losartan para la presion" }] },
    ])
  })

  it("«señora» es cómo se le habla, no su parentesco: no va (QA del 21 nov)", () => {
    const result = readDictationReview({ turnos: [{ desde: 1, quien: "acompanante", vinculo: "señora" }] }, spoken, PARTS)
    expect(result?.turns).toEqual([{ number: 1, turns: [{ quien: "acompanante", texto: "toma alguna medicina si tomo losartan para la presion" }] }])
  })

  it("si esas palabras no están, el turno empieza en la frase", () => {
    const result = readDictationReview({ turnos: [{ desde: 1, quien: "paciente", empieza: "sí, tomo warfarina" }] }, spoken, PARTS)
    expect(result?.turns).toEqual([{ number: 1, turns: [{ quien: "paciente", texto: "toma alguna medicina si tomo losartan para la presion" }] }])
  })
})

describe("lo que no tiene dónde ir, ya en la pausa (QA del 21 nov)", () => {
  it("el peso dicho y lo de un familiar llegan con su frase y su motivo", () => {
    const pause = readDictation(
      { sin_lugar: [{ dicho: "Debe pesar 24.", motivo: "peso_dicho" }, { dicho: "mi papa es diabetico", motivo: "familiar" }] },
      "debe pesar 24 kilos y mi papa es diabetico",
      0,
      PARTS,
    )
    expect(pause?.outOfPlace).toEqual([
      { said: "Debe pesar 24", why: "peso_dicho" },
      { said: "mi papa es diabetico", why: "familiar" },
    ])
  })
})
