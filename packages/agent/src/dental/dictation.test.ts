import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { DICTATION_MAX_SUGGESTIONS, DICTATION_SOURCE_CHARS, type DictationFormQuestion, formQuestionsOf, productHooksFor } from "@odentia/services"
import { dictationFindingsText } from "@odentia/services/dental"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  askDictationModel,
  DICTATION_FORMS_RULES,
  type DictationAsk,
  dictationFormsText,
  dictationMessages,
  groundSource,
  readDictation as readWith,
  rereadFormSentences,
} from "../dictation.js"
import { createConfiguredChatModel, resolveLlmSpec } from "../llm.js"
import { cacheMarked, fakeProvider, messageContent, systemBlock, toolCallReply } from "../test-provider.js"
import { DENTAL_DICTATION_PROFILE, demoExtraction, demoSegment } from "./dictation.js"

it("el dictado de odentIA no razona: va por Chat Completions con su parte fija marcada y prompt_cache_options", async () => {
  const provider = await fakeProvider((_, response, url) => toolCallReply(response, url, "registrar_dictado"))
  try {
    const spec = resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
    const profile = DENTAL_DICTATION_PROFILE
    // Como `extractDictation`: con el razonamiento del perfil, que en odentIA no hay.
    const model = await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) })
    const pause = { services: ["Consulta"], diagnosisList: "CIE-10 (OMS)", catalog: dictationFindingsText(), transcript: "Viene por dolor en la dieciséis.", context: "", pending: [] }
    await askDictationModel(model, spec, { ...pause, provider: spec.provider, zone: { locale: "es-PE", timezone: "America/Lima" }, now: new Date("2026-10-29T15:00:00Z") }, profile)
    expect(provider.requests.map((request) => request.url)).toEqual(["/v1/chat/completions"])
    expect(systemBlock(provider.requests[0])).toEqual(cacheMarked("text"))
    // Por Chat Completions el proveedor guarda solo hasta el corte.
    expect(provider.requests[0]?.body).toMatchObject({ prompt_cache_options: { mode: "explicit" } })
    // Con una ficha empezada, cómo se responden va al final de las instrucciones, antes de su corte, y la pausa después, sin él.
    const forms = formQuestionsOf([{ id: "endo", title: "Evaluación de endodoncia", snapshot: productHooksFor("dental").forms.suggestions.find((item) => item.key === "evaluacion-de-endodoncia")?.schema, answers: {} }])
    await askDictationModel(model, spec, { ...pause, forms, provider: spec.provider, zone: { locale: "es-PE", timezone: "America/Lima" }, now: new Date("2026-10-29T15:01:00Z") }, profile)
    expect(systemBlock(provider.requests[1])).toEqual(cacheMarked("text"))
    expect((systemBlock(provider.requests[1]) as { text: string }).text.endsWith(DICTATION_FORMS_RULES)).toBe(true)
    expect(JSON.stringify(messageContent(provider.requests[1], 1))).toContain("Lo nuevo que dictó")
    expect(JSON.stringify(messageContent(provider.requests[1], 1))).not.toContain("prompt_cache_breakpoint")
    expect(messageContent(provider.requests[1], 2)).toBeUndefined()
  } finally {
    await provider.close()
  }
})

/** La lectura de una respuesta con las listas de odentIA. */
const readDictation = (args: unknown, transcript: string, pendingCount: number) =>
  readWith(args, transcript, pendingCount, DENTAL_DICTATION_PROFILE.parts)

/** Extracción de demostración: reglas simples para ver el recorrido sin proveedor. No mide a ningún modelo. */
const SERVICES = ["Resina compuesta", "Endodoncia multirradicular", "Profilaxis dental"]
const NOW = new Date("2026-10-12T15:00:00Z")

describe("dictado en modo de demostración", () => {
  it("ordena motivo, diagnóstico, indicaciones con su pieza y un control", () => {
    const drafts = demoExtraction(
      "Viene por dolor al masticar del lado derecho. En la dieciséis hay caries en dentina. Le ponemos una resina en la cara oclusal de la dieciséis. En la veintiséis hacemos endodoncia. Control en 6 meses.",
      SERVICES,
      NOW,
    )
    expect(drafts.map((draft) => draft.kind)).toEqual(["nota", "diagnostico", "plan", "plan", "control"])
    expect(drafts[0]).toMatchObject({ payload: { reason: "Viene por dolor al masticar del lado derecho." } })
    expect(drafts[1]).toMatchObject({
      payload: { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16 },
      sourceText: "En la dieciséis hay caries en dentina.",
    })
    // Una pieza ausente va al odontograma.
    expect(demoExtraction("La cuarenta y seis está ausente.", SERVICES, NOW)).toEqual([
      { kind: "odontograma", payload: { toothNumber: 46, condition: "missing_tooth" }, sourceText: "La cuarenta y seis está ausente." },
    ])
    expect(drafts[2]?.payload).toEqual({ service: "Resina compuesta", toothNumber: 16, surfaces: ["oclusal"] })
    expect(drafts[3]?.payload).toEqual({ service: "Endodoncia multirradicular", toothNumber: 26 })
    expect(drafts[4]?.payload).toMatchObject({ title: "Control en 6 meses" })
    expect(new Date(String(drafts[4]?.payload["dueAt"])).toISOString().slice(0, 7)).toBe("2027-04")
  })

  it("lee la pieza en cifras o en palabras y no inventa lo que no se dijo", () => {
    expect(demoExtraction("Profilaxis en toda la boca.", SERVICES, NOW)).toEqual([
      { kind: "plan", payload: { service: "Profilaxis dental" }, sourceText: "Profilaxis en toda la boca." },
    ])
    expect(demoExtraction("Resina en la pieza 46, cara mesial y distal.", SERVICES, NOW)[0]?.payload).toEqual({
      service: "Resina compuesta", toothNumber: 46, surfaces: ["mesial", "distal"],
    })
    expect(demoExtraction("Endodoncia en la cuarenta y seis.", SERVICES, NOW)[0]?.payload).toMatchObject({ toothNumber: 46 })
    expect(demoExtraction("Buenos días, tome asiento.", SERVICES, NOW)).toEqual([])
  })

  it("al seguir dictando reconoce una corrección de pieza y un «quita…» sobre lo pendiente", () => {
    const pending = [{ label: "Diagnóstico: K02.1 Caries de la dentina, Pieza 16" }, { label: "Plan de tratamiento: Endodoncia multirradicular, Pieza 25" }]
    expect(demoSegment("No, es la veintiséis.", SERVICES, NOW, pending)).toEqual({
      drafts: [],
      corrections: [{ index: 1, changes: { toothNumber: 26 }, sourceText: "No, es la veintiséis." }],
      removals: [],
      omitted: 0,
      unused: [],
    })
    expect(demoSegment("Quita la endodoncia.", SERVICES, NOW, pending)).toEqual({ drafts: [], corrections: [], removals: [{ index: 1, sourceText: "Quita la endodoncia." }], omitted: 0, unused: [] })
    // La corrección sigue a algo dicho en el mismo tramo: cambia eso, no lo pendiente.
    const same = demoSegment("En la veinticinco hacemos endodoncia. No, es la veintiséis.", SERVICES, NOW, pending)
    expect(same.corrections).toEqual([])
    expect(same.drafts[0]?.payload).toEqual({ service: "Endodoncia multirradicular", toothNumber: 26 })
    // Sin nada pendiente ni dicho, no hay qué corregir ni quitar.
    expect(demoSegment("No, es la veintiséis. Quita la corona.", SERVICES, NOW, [])).toEqual({ drafts: [], corrections: [], removals: [], omitted: 0, unused: [] })
  })

  it("solo conserva como «lo que dijiste» lo que de verdad está en lo dictado", () => {
    const heard = "En la dieciséis hay caries en dentina,  le ponemos una resina. Control en 6 meses."
    expect(groundSource("en la dieciséis hay caries en dentina", heard)).toBe("en la dieciséis hay caries en dentina")
    expect(groundSource("Control en 6 meses. El paciente tiene diabetes.", heard)).toBe("Control en 6 meses.")
    expect(groundSource("Caries profunda en la pieza 16", heard)).toBe("")
    expect(groundSource(undefined, heard)).toBe("")
  })

  it("las comillas con que el modelo copia lo dictado no lo dejan sin frase (medición del 15 nov)", () => {
    // Lo dictado le llega entre comillas y a veces las copia: «Frankl tres» sigue siendo lo que dijo.
    expect(groundSource("«Frankl tres»", "Frankl tres, colaboró bien.")).toBe("Frankl tres")
    expect(groundSource("«Frankl tres».", "Frankl tres, colaboró bien.")).toBe("Frankl tres")
    expect(groundSource("«Dolor a la percusión en la cuatro seis, ocho de diez.»", "Dolor a la percusión en la cuatro seis, ocho de diez.")).toBe(
      "Dolor a la percusión en la cuatro seis, ocho de diez.",
    )
    // Ni los puntos suspensivos con que marca que cita un pedazo.
    expect(groundSource("«...en la cuarenta y seis.»", "Dolor espontáneo desde hace tres días en la cuarenta y seis.")).toBe("en la cuarenta y seis.")
    expect(groundSource("…en la cuarenta y seis", "Dolor espontáneo en la cuarenta y seis.")).toBe("en la cuarenta y seis")
    // Sin las comillas, lo que no se dijo sigue sin valer; y lo citado de verdad se conserva tal cual.
    expect(groundSource("«Frankl cuatro»", "Frankl tres, colaboró bien.")).toBe("")
    expect(groundSource("dice «me duele»", "La mamá dice «me duele» al masticar.")).toBe("dice «me duele»")
  })

  it("lo que el modelo salta con «...» no se junta: queda el pedazo más largo, tal cual (medición del 16 nov)", () => {
    // Juntos, «cinco con extracción indicada» no se dijo: el cinco era de «cariados».
    const heard = "sé o d cinco cariados dos con extracción indicada ser obturados"
    expect(groundSource("cinco ... con extracción indicada", heard)).toBe("con extracción indicada")
    expect(groundSource("«cinco… con extracción indicada»", heard)).toBe("con extracción indicada")
    // Con los puntos solo al principio o al final, es un pedazo y queda como siempre.
    expect(groundSource("cinco cariados...", heard)).toBe("cinco cariados")
  })

  it("en una respuesta de varias opciones, cada pedazo llega aparte para comprobar cada opción en el suyo (prueba con voz c7, v03)", () => {
    const heard = "Claro que sí volar derecha clase 2 división 1 hábitos respiración bucal o sea duerme con la boca abierta y se come las uñas diagnóstico"
    const ortho = formQuestionsOf([{ id: "orto", title: "Ficha de ortodoncia", snapshot: productHooksFor("dental").forms.suggestions.find((item) => item.key === "ficha-de-ortodoncia")?.schema, answers: {} }])
    const habitos = ortho.find((question) => question.fieldId === "habitos")?.number
    const molar = ortho.find((question) => question.fieldId === "clase_molar_derecha")?.number
    const read = readWith(
      {
        fichas: [
          { question: habitos, answers: ["Respiración bucal", "Onicofagia"], dicho: "hábitos respiración bucal ... y se come las uñas" },
          { question: molar, answer: "Clase II división 1", dicho: "claro que sí ... derecha clase 2 división 1" },
          { question: molar, answer: "Clase II división 1", dicho: "derecha clase 2 división 1" },
        ],
      },
      heard,
      0,
      DENTAL_DICTATION_PROFILE.parts,
      ortho,
    )
    // Lo que se muestra sigue siendo un pedazo dicho tal cual; los pedazos van aparte y el servidor decide si los usa.
    expect(read?.drafts[0]).toMatchObject({ sourceText: "hábitos respiración bucal", pieces: ["hábitos respiración bucal", "y se come las uñas"] })
    expect(read?.drafts[1]).toMatchObject({ sourceText: "derecha clase 2 división 1", pieces: ["claro que sí", "derecha clase 2 división 1"] })
    // Citada de una vez, sin pedazos.
    expect(read?.drafts[2]?.pieces).toBeUndefined()
  })

  it("las respuestas de ficha que Clío repite como correcciones de lo que no está pendiente no dan un «4» suelto (prueba con voz c7, v11)", () => {
    // Lo que respondió el modelo al repetir el tramo, tal cual: con una sola pendiente (la nota), corrige la 2 y la 3.
    const heard = "para confirmarse 6 perdidos 2 obturados 4 simplificado 1,8"
    const estomato = formQuestionsOf([{ id: "ee", title: "Ficha odontoestomatológica", snapshot: productHooksFor("dental").forms.suggestions.find((item) => item.key === "ficha-odontoestomatologica")?.schema, answers: {} }])
    const args = {
      fichas: [
        { question: 2, answer: "6", dicho: "6 perdidos" },
        { question: 3, answer: "2", dicho: "2 obturados" },
      ],
      correcciones: [
        { sugerencia: 1, cambios: { answer: "6" }, dicho: "para confirmarse 6 perdidos" },
        { sugerencia: 2, cambios: { answer: "2" }, dicho: "6 perdidos 2 obturados" },
        { sugerencia: 3, cambios: { answer: "4" }, dicho: "4" },
      ],
    }
    const read = readWith(args, heard, 1, DENTAL_DICTATION_PROFILE.parts, estomato)
    expect(read?.unused).toEqual([])
    expect(read?.omitted).toBe(0)
    // La de la pendiente que sí existe sigue llegando: el servicio decide si cambia algo.
    expect(read?.corrections.map((item) => item.index)).toEqual([0])
    // Sin ficha, una corrección de lo que no está pendiente se sigue avisando con su frase.
    expect(readWith({ correcciones: args.correcciones }, heard, 1, DENTAL_DICTATION_PROFILE.parts)?.unused).toEqual(["6 perdidos 2 obturados", "4"])
  })
})

/**
 * Lo que responde un modelo real, leído parte por parte. Los tramos son los de
 * la medición del 2026-10-17 (dictados inventados): ahí ChatGPT 6 copiaba el
 * tramo largo entero en la cita de la nota, y un odontograma inicial pasaba de
 * 10 diagnósticos; los dos botaban la pausa entera.
 */
describe("lo que responde el modelo, parte por parte", () => {
  const LARGO =
    "Bien, entonces vamos a dejar registrado que en la cuarenta y seis la caries es oclusal y también mesial, llega a dentina, así que la resina va a ser compuesta posterior en oclusal y mesial. " +
    "En la treinta y siete hay una restauración antigua de amalgama fracturada por distal, con caries secundaria, indicamos cambiar por resina compuesta posterior. " +
    "En el sector anterior inferior hay sarro abundante y la encía sangra al sondaje, diagnóstico gingivitis asociada a placa, hacemos profilaxis y destartraje supragingival hoy. " +
    "La once tiene una fractura de esmalte en el borde incisal, la dejamos en observación. Le indico enjuague con clorhexidina dos veces al día por siete días y control en quince días para ver la encía. " +
    "Pronóstico favorable si mejora la higiene."
  const DENSO =
    "Odontograma inicial. Caries oclusal que llega a dentina en la dieciséis, diecisiete, veintiséis, veintisiete, treinta y seis, treinta y siete, cuarenta y seis y cuarenta y siete; " +
    "en todas, resina compuesta posterior por oclusal. Caries por mesial en la once y en la veintiuno, resina compuesta anterior en las dos. " +
    "La dieciocho y la cuarenta y ocho están impactadas: extracción de tercera molar impactada de las dos. Gingivitis asociada a placa generalizada: profilaxis y destartraje supragingival."

  it("una cita de 760 caracteres llega entera si se dijo, y lo demás de la pausa también", () => {
    expect(LARGO.length).toBeGreaterThan(760)
    expect(LARGO.length).toBeGreaterThan(DICTATION_SOURCE_CHARS)
    const read = readDictation(
      {
        nota: { evolution: "Profilaxis y destartraje supragingival.", prognosis: "Favorable si mejora la higiene.", dicho: LARGO },
        diagnosticos: [{ diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 46, surfaces: ["oclusal", "mesial"], dicho: "en la cuarenta y seis la caries es oclusal y también mesial" }],
        controles: [{ title: "Control en quince días", dueAt: "2026-11-01T15:00:00-05:00", dicho: "control en quince días para ver la encía" }],
      },
      LARGO,
      0,
    )
    expect(read?.omitted).toBe(0)
    expect(read?.drafts.map((draft) => draft.kind)).toEqual(["nota", "diagnostico", "control"])
    expect(read?.drafts[0]).toEqual({ kind: "nota", payload: { evolution: "Profilaxis y destartraje supragingival.", prognosis: "Favorable si mejora la higiene." }, sourceText: LARGO })
    // Lo que se le agrega a la cita y no se dijo no se muestra como «lo que dijiste».
    const padded = readDictation({ nota: { evolution: "Profilaxis.", dicho: `${LARGO} El paciente tiene diabetes.` } }, LARGO, 0)
    expect(padded?.drafts[0]?.sourceText).not.toContain("diabetes")
    expect(padded?.drafts[0]?.sourceText?.length).toBeGreaterThan(DICTATION_SOURCE_CHARS)
  })

  it("los 13 diagnósticos de un odontograma inicial llegan los 13", () => {
    const teeth = [16, 17, 26, 27, 36, 37, 46, 47, 11, 21, 18, 48]
    const diagnosticos = [
      ...teeth.map((toothNumber) => ({ diagnosisCode: toothNumber === 18 || toothNumber === 48 ? "K01.1" : "K02.1", diagnosisType: "confirmed", toothNumber })),
      { diagnosisCode: "K05.1", diagnosisType: "confirmed", dicho: "Gingivitis asociada a placa generalizada" },
    ]
    expect(diagnosticos).toHaveLength(13)
    const read = readDictation({ diagnosticos, indicaciones: teeth.map((toothNumber) => ({ service: "resina compuesta", toothNumber })) }, DENSO, 0)
    expect(read?.omitted).toBe(0)
    expect(read?.drafts.filter((draft) => draft.kind === "diagnostico").map((draft) => draft.payload["toothNumber"] ?? null)).toEqual([...teeth, null])
    expect(read?.drafts.filter((draft) => draft.kind === "plan")).toHaveLength(12)
    expect(read?.drafts.at(12)?.sourceText).toBe("Gingivitis asociada a placa generalizada")
  })

  it("12 «quita» en una pausa no quitan nada: las 12 sugerencias se quedan y se cuenta para avisar", () => {
    // Medido: más de 10 «quita» en una pausa eran sugerencias que nadie pidió quitar, a veces en una charla.
    const quitar = Array.from({ length: 12 }, (_, index) => ({ sugerencia: index + 1, dicho: "quita todo lo de la arcada superior" }))
    const read = readDictation({ quitar }, "Quita todo lo de la arcada superior.", 12)
    expect(read?.removals).toEqual([])
    expect(read?.omitted).toBe(12)
    // La frase se muestra una vez, no doce.
    expect(read?.unused).toEqual(["quita todo lo de la arcada superior"])
    // Igual con más de 10 correcciones: lo pendiente se queda como estaba.
    const correcciones = Array.from({ length: 12 }, (_, index) => ({ sugerencia: index + 1, cambios: { toothNumber: 16 } }))
    expect(readDictation({ correcciones }, "En la dieciséis.", 12)).toMatchObject({ corrections: [], omitted: 12 })
  })

  it("un «quita» se aplica solo con lo que se dijo para pedirlo; un número que no está no se adivina", () => {
    const read = readDictation(
      {
        quitar: [{ sugerencia: 2, dicho: "Quita la endodoncia." }, { sugerencia: 1 }, { sugerencia: 3, dicho: "Quita también el control." }, { sugerencia: 13, dicho: "Quita la endodoncia." }],
        correcciones: [{ sugerencia: "3", cambios: { toothNumber: 26 } }, { sugerencia: 0, cambios: { toothNumber: 11 } }],
      },
      "Quita la endodoncia. No, la tercera es la veintiséis.",
      12,
    )
    // Sin cita, o con una que no se dijo, la sugerencia se queda pendiente.
    expect(read?.removals).toEqual([{ index: 1, sourceText: "Quita la endodoncia." }])
    // El número entre comillas es el mismo número; el 0 y el 13 no son de ninguna pendiente.
    expect(read?.corrections).toEqual([{ index: 2, changes: { toothNumber: 26 }, sourceText: "" }])
    expect(read?.omitted).toBe(4)
    // Para avisar se muestra lo que de verdad se dijo; lo que no está en lo dictado no se cita.
    expect(read?.unused).toEqual(["Quita la endodoncia."])
  })

  it("un dato que no encaja llega igual, solo con los campos de su operación, para que el servicio lo deje por revisar", () => {
    const read = readDictation(
      {
        diagnosticos: [
          { diagnosisCode: "K02.1", diagnosisType: "seguro", toothNumber: 16, description: "Caries", _meta: { segments: ["x"] }, dicho: "caries en la dieciséis" },
          { dicho: "caries en la dieciséis" },
          "K02.1",
        ],
        indicaciones: { service: "resina" },
        controles: [{ title: "Control en 6 meses", dueAt: "en seis meses" }],
      },
      "Hay caries en la dieciséis. Control en 6 meses.",
      0,
    )
    expect(read?.drafts).toEqual([
      { kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "seguro", toothNumber: 16 }, sourceText: "caries en la dieciséis" },
      { kind: "control", payload: { title: "Control en 6 meses", dueAt: "en seis meses" }, sourceText: "" },
    ])
    // Un diagnóstico sin ningún dato, uno que no es un registro y un bloque que no es una lista.
    expect(read?.omitted).toBe(3)
  })

  it("lo que pasa de lo que el servicio guarda de un tramo se cuenta para avisar", () => {
    const diagnosticos = Array.from({ length: DICTATION_MAX_SUGGESTIONS + 5 }, () => ({ diagnosisCode: "K02.1", diagnosisType: "provisional" }))
    const read = readDictation({ nota: { reason: "Revisión" }, diagnosticos }, "Revisión.", 0)
    expect(read?.drafts).toHaveLength(DICTATION_MAX_SUGGESTIONS)
    expect(read?.drafts[0]?.kind).toBe("nota")
    expect(read?.omitted).toBe(6)
  })

  it("solo una respuesta que no es un objeto no se puede leer", () => {
    for (const args of [null, undefined, "No entendí.", [], 3]) expect(readDictation(args, "Hola.", 0)).toBeNull()
    expect(readDictation({}, "Abre un poquito más.", 0)).toEqual({ drafts: [], corrections: [], removals: [], omitted: 0, unused: [] })
  })
})

describe("lo que recibe el modelo en cada pausa", () => {
  // odentIA dicta sin razonar, por Chat Completions (`responses` en false); `llm.test.ts` sigue los dos caminos hasta el proveedor.
  const ask =(provider: DictationAsk["provider"], now: Date, transcript: string) =>
    dictationMessages({
      provider,
      services: SERVICES,
      diagnosisList: "CIE-10 (OMS)",
      catalog: dictationFindingsText(),
      zone: { locale: "es-PE", timezone: "America/Lima" },
      now,
      transcript,
      context: "",
      pending: [],
    }, DENTAL_DICTATION_PROFILE, false)

  it("la parte fija es igual en todas las pausas y va marcada para la caché; la fecha va con lo dictado", () => {
    const [first, firstHuman] = ask("openai", NOW, "Viene por dolor.")
    const [later, laterHuman] = ask("openai", new Date(NOW.getTime() + 61_234), "Control en 6 meses.")
    // Una pausa un minuto después repite la parte fija tal cual: la caché del proveedor la lee.
    expect(later?.content).toEqual(first?.content)
    const [block] = (first?.content ?? []) as Array<Record<string, unknown>>
    expect(block).toMatchObject({ prompt_cache_breakpoint: { mode: "explicit" } })
    expect(String(block?.["text"])).not.toContain("2026")
    expect(firstHuman?.content).toContain("2026-10-12T15:00:00.000Z")
    expect(laterHuman?.content).toContain("2026-10-12T15:01:01.234Z")
    expect(laterHuman?.content).toContain("Lo nuevo que dictó:\n«Control en 6 meses.»")
    // Un modelo sin caché (el de demostración) recibe el mismo texto, sin marca.
    expect(ask("fake", NOW, "Viene por dolor.")[0]?.content).toBe(((ask("openai", NOW, "x")[0]?.content ?? []) as Array<{ text: string }>)[0]?.text)
  })

  it("las preguntas de las fichas van en el mensaje de la pausa y cómo se responden, al final de las instrucciones; sin ficha, todo es lo de siempre", () => {
    const forms = [
      { number: 1, responseId: "r1", formTitle: "Ficha de ortodoncia", fieldId: "clase", label: "Clase molar derecha (Angle)", type: "opcion_unica" as const, options: ["Clase I", "Clase II división 1"], unit: null, min: null, max: null, order: 0, dependsOn: null },
      { number: 2, responseId: "r1", formTitle: "Ficha de ortodoncia", fieldId: "overjet", label: "Overjet", type: "numero" as const, options: null, unit: "mm", min: -10, max: 20, order: 1, dependsOn: null },
    ]
    const base = { provider: "openai" as const, services: SERVICES, diagnosisList: "CIE-10 (OMS)", catalog: dictationFindingsText(), zone: { locale: "es-PE", timezone: "America/Lima" }, now: NOW, transcript: "Overjet de seis.", context: "", pending: [] }
    const textOf = (content: unknown) => (content as Array<{ text: string }>)[0]?.text ?? ""
    const [systemWith, pauseWith] = dictationMessages({ ...base, forms }, DENTAL_DICTATION_PROFILE, false)
    const without = dictationMessages(base, DENTAL_DICTATION_PROFILE, false)
    // Las instrucciones de siempre y, detrás, cómo se responden las fichas, antes del corte.
    expect(systemWith?.content).toEqual([{ type: "text", text: `${textOf(without[0]?.content)}\n\n${DICTATION_FORMS_RULES}`, prompt_cache_breakpoint: { mode: "explicit" } }])
    expect(DICTATION_FORMS_RULES).toContain("el silencio no es «No»")
    // Las preguntas, en la pausa, junto a lo nuevo.
    expect(pauseWith?.content).toMatch(/^Hoy es /)
    expect(pauseWith?.content).toContain(
      ["Ficha de ortodoncia:", "1. Clase molar derecha (Angle) · una opción: Clase I | Clase II división 1", "2. Overjet · número en mm, de -10 a 20", "", "Lo nuevo que dictó:\n«Overjet de seis.»"].join("\n"),
    )
    expect(String(pauseWith?.content)).not.toContain("Fichas abiertas")
    // Sin ficha, la pausa es la de siempre: el mensaje de sistema y el de la pausa, sin nada de fichas.
    expect(without).toHaveLength(2)
    expect(textOf(without[0]?.content)).not.toContain("Fichas abiertas")
    expect(String(without[1]?.content)).not.toContain("Ficha")
    // Sin caché (el modelo de demostración), el mismo texto, sin marca.
    expect(dictationMessages({ ...base, provider: "fake", forms }, DENTAL_DICTATION_PROFILE, false)[0]?.content).toBe(textOf(systemWith?.content))
  })

  it("con ficha, cómo se responden es igual entre pausas y se lee de la caché; las preguntas y lo que ya dicen van con lo que cambia", () => {
    const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === "ficha-de-ortodoncia")
    const questionsOf = (answers: Record<string, unknown>) => formQuestionsOf([{ id: "orto", title: form?.title ?? null, snapshot: form?.schema, answers }])
    const base = { provider: "openai" as const, services: SERVICES, diagnosisList: "CIE-10 (OMS)", catalog: dictationFindingsText(), zone: { locale: "es-PE", timezone: "America/Lima" }, pending: [] }
    const first = dictationMessages({ ...base, now: NOW, transcript: "Overjet de seis.", context: "", forms: questionsOf({}) }, DENTAL_DICTATION_PROFILE, false)
    // La pausa siguiente: otra hora, lo ya ordenado, una pendiente y el overjet ya aceptado en la ficha.
    const next = dictationMessages(
      { ...base, now: new Date(NOW.getTime() + 95_000), transcript: "Overbite de dos.", context: "Overjet de seis.", pending: [{ label: "Fichas · Overjet: 6" }], forms: questionsOf({ overjet: 6 }) },
      DENTAL_DICTATION_PROFILE,
      false,
    )
    // Todo hasta el corte, con cómo se responden las fichas, es igual: la pausa siguiente lo lee de la caché.
    expect(next[0]?.content).toEqual(first[0]?.content)
    expect(next).toHaveLength(2)
    const overjet = questionsOf({}).find((item) => item.fieldId === "overjet")
    const pauseNext = String(next[1]?.content)
    expect(pauseNext).toContain(`${overjet?.number}. ${overjet?.label} · número en mm, de -10 a 20 · ya dice «6 mm»`)
    // Lo que cambia va después, como siempre: la fecha, lo ya ordenado, lo pendiente, las preguntas y lo nuevo.
    const order = ["Hoy es ", "Ya ordenado antes", "Sugerencias pendientes", "Ficha de ortodoncia:", "Lo nuevo que dictó"].map((words) => pauseNext.indexOf(words))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

/** Lo que encontró la prueba con voz real del 15 nov (corrida c2), tal como lo oyó Chrome. */
describe("la prueba con voz del 15 nov", () => {
  const base = { provider: "openai" as const, services: SERVICES, diagnosisList: "CIE-10 (OMS)", catalog: dictationFindingsText(), zone: { locale: "es-PE", timezone: "America/Lima" }, now: NOW, pending: [] }
  const pause = (transcript: string, context = "") => dictationMessages({ ...base, transcript, context }, DENTAL_DICTATION_PROFILE, false)
  const endo = formQuestionsOf([
    { id: "endo", title: "Evaluación de endodoncia", snapshot: productHooksFor("dental").forms.suggestions.find((item) => item.key === "evaluacion-de-endodoncia")?.schema, answers: {} },
  ])
  const fixed = String(((pause("x")[0]?.content ?? []) as Array<{ text: string }>)[0]?.text)
  const before = "sin dolor presenta fístula a nivel apical por vestibular tumefacción intraoral leve frío sin respuesta calor"
  const now = "sin respuesta también percusión negativa palpación positiva"

  it("la frase que corta la pausa se lee junta, y lo que cita desde lo anterior vale (v07)", async () => {
    const human = String(pause(now, before)[1]?.content)
    expect(human).toContain(`Lo nuevo que dictó (empieza con «frío sin respuesta calor», el final de lo anterior: la pausa cortó ahí la frase):\n«frío sin respuesta calor ${now}»`)
    // Un tramo que empieza otra frase no lleva ese aviso.
    expect(String(pause("percusión negativa", before)[1]?.content)).not.toContain("la pausa cortó")
    // La frase unida se encuentra en lo dictado, con el final de lo anterior delante.
    const calor = endo.find((item) => item.fieldId === "calor")?.number ?? 0
    const reply = new AIMessage({ content: "", tool_calls: [{ id: "1", name: "registrar_dictado", args: { fichas: [{ question: calor, answer: "Sin respuesta", dicho: "calor sin respuesta también" }] } }] })
    const model = { invoke: async () => reply }
    const ask = { ...base, transcript: now, context: before, forms: endo }
    const { read, heard } = await askDictationModel(model, { provider: "openai", modelName: "prueba" }, ask, DENTAL_DICTATION_PROFILE)
    expect(read?.drafts).toEqual([{ kind: "ficha", payload: { question: calor, answer: "Sin respuesta" }, sourceText: "calor sin respuesta también" }])
    // Con eso mismo comprueban la red y el servidor.
    expect(heard).toBe(`frío sin respuesta calor ${now}`)
    // Sin lo anterior, esa frase no se dijo: no se muestra.
    const alone = await askDictationModel(model, { provider: "openai", modelName: "prueba" }, { ...ask, context: "" }, DENTAL_DICTATION_PROFILE)
    expect(alone.read?.drafts[0]?.sourceText).toBe("")
  })

  it("lo que se le indica al paciente va en las indicaciones de la consulta, no en el plan (v03)", () => {
    expect(fixed).toContain("En `indicaciones` va solo lo que hará la clínica más adelante")
    expect(fixed).toContain("aunque se diga con «le indico», va en las indicaciones de la consulta (`indications`)")
  })

  it("el relato no recoge lo que se le dice al paciente ni lo que llora mientras lo atienden, en toda pausa (v08)", () => {
    expect(fixed).toContain("No son el motivo ni el relato lo que se le dice, pregunta o pide al paciente")
    expect(fixed).toContain("«tranquila, ya casi terminamos»")
    expect(fixed).toContain("«¡me duele!», «no quiero», «mamá»")
  })

  it("el tiempo de enfermedad cuenta desde lo que se fecha, y el diagnóstico de la ficha va también a Diagnóstico (v07)", () => {
    expect(fixed).toContain("Si lo que le pasa empezó con algo que se fecha («un golpe hace dos años»")
    expect(DICTATION_FORMS_RULES).toContain("Un diagnóstico que nombró va en `diagnosticos`, con su código, aunque también responda una de estas preguntas: va en los dos.")
  })

  // Tercera prueba (c3, v10): «hoy solo hacemos adaptación y profilaxis y los citamos en una semana».
  it("«hoy hacemos…» es lo hecho hoy, la cita no es para lo de hoy y nadie pidió el presupuesto (v10)", () => {
    expect(fixed).toContain("contado como hecho («le hice la profilaxis», «terminamos la resina de la 36») o como lo de hoy («hoy hacemos…», «hoy solo…»), uno por prestación")
    expect(fixed).toContain("en `service` para qué vuelve, solo si lo dijo: lo que se hace hoy no es para qué vuelve")
    expect(fixed).toContain("Sin ese pedido no va nada: reservar una cita, indicar un tratamiento o contar lo que se hizo no lo piden.")
  })
})

describe("las respuestas de una ficha", () => {
  /** La ficha de ortodoncia de odentIA, con sus preguntas numeradas como las ve Clío. */
  const ortho: DictationFormQuestion[] = (() => {
    const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === "ficha-de-ortodoncia")
    if (!form) throw new Error("falta la ficha de ortodoncia")
    return formQuestionsOf([{ id: "orto", title: form.title, snapshot: form.schema, answers: {} }])
  })()
  const numberOf = (fieldId: string) => ortho.find((item) => item.fieldId === fieldId)?.number ?? 0

  it("una respuesta a una pregunta que no se le dio no se adivina: se avisa con su frase", () => {
    const transcript = "Overjet de seis milímetros. Overbite de tres."
    const read = readWith(
      { fichas: [{ question: 1, answer: "6", dicho: "Overjet de seis milímetros." }, { question: 99, answer: "3", dicho: "Overbite de tres." }] },
      transcript,
      0,
      DENTAL_DICTATION_PROFILE.parts,
      ortho,
    )
    expect(read?.drafts).toEqual([{ kind: "ficha", payload: { question: 1, answer: "6" }, sourceText: "Overjet de seis milímetros." }])
    expect(read?.omitted).toBe(1)
    expect(read?.unused).toEqual(["Overbite de tres."])
  })

  it("la frase se encuentra aunque Clío escriba bien lo que Chrome oyó mal, tal como se dictó", () => {
    const transcript = "al examen Claro que sí volar derecha clase 2 división 1 la izquierda también clase dos"
    const question = numberOf("clase_molar_derecha")
    const read = readWith(
      { fichas: [{ question, answer: "Clase II división 1", dicho: "«molar derecha clase 2 división 1»" }] },
      transcript,
      0,
      DENTAL_DICTATION_PROFILE.parts,
      ortho,
    )
    expect(read?.drafts).toEqual([{ kind: "ficha", payload: { question, answer: "Clase II división 1" }, sourceText: "volar derecha clase 2 división 1" }])
    // Solo en las fichas, y solo lo que suena igual o está en la lista revisada: lo que no se dijo no aparece.
    const other = readWith({ fichas: [{ question, answer: "Clase III", dicho: "molar derecha clase 3" }] }, transcript, 0, DENTAL_DICTATION_PROFILE.parts, ortho)
    expect(other?.drafts[0]?.sourceText).toBe("")
  })

  it("con una ficha empezada, Clío sabe que lo dictado viene de la voz y copia la frase como llegó", () => {
    expect(DICTATION_FORMS_RULES).toContain("Lo dictado viene del reconocimiento de voz del navegador")
    expect(DICTATION_FORMS_RULES).toContain("una sigla con espacios entre sus letras")
    expect(DICTATION_FORMS_RULES).toContain("En `dicho` copia la frase tal como llegó, con la palabra mal escrita")
    expect(dictationFormsText(ortho)).toMatch(/^Ficha de ortodoncia:\n1\. /)
    // Sin ficha, nada nuevo: la pausa de siempre.
    expect(dictationFormsText([])).toBe("")
  })

  it("la segunda lectura: cada oración sola con sus preguntas y un texto corto, y vuelve por revisar", async () => {
    const seen: BaseMessage[][] = []
    const overbite = numberOf("overbite")
    const overjet = numberOf("overjet")
    const model = {
      bindTools: (tools: Array<{ name: string }>) => {
        expect(tools.map((item) => item.name)).toEqual(["registrar_fichas"])
        return {
          invoke: async (messages: BaseMessage[]) => {
            seen.push(messages)
            return new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "relectura-1",
                  name: "registrar_fichas",
                  args: {
                    fichas: [
                      { question: overbite, answer: "4", dicho: "over byte de 4" },
                      // Una pregunta que no era de esa oración, y una frase que no se dijo: no vuelven.
                      { question: overjet, answer: "7", dicho: "over byte de 4" },
                      { question: overbite, answer: "5", dicho: "overbite de cinco" },
                    ],
                  },
                },
              ],
            })
          },
        }
      },
    }
    const drafts = await rereadFormSentences(model, { provider: "openai", modelName: "gpt-6-luna" }, [{ said: "a ver over byte de 4 succión por favor", questions: [overbite] }], ortho)
    expect(drafts).toEqual([{ kind: "ficha", payload: { question: overbite, answer: "4" }, sourceText: "over byte de 4", reread: true }])
    const [system, human] = seen[0] ?? []
    expect(String(system?.content)).toContain("Lees de nuevo oraciones de un dictado")
    expect(String(system?.content).length).toBeLessThan(1500)
    expect(String(human?.content)).toBe(`1. «a ver over byte de 4 succión por favor»\n   Ficha de ortodoncia: ${overbite}. Overbite · número en mm, de -10 a 15`)
  })

  it("sin oraciones que leer de nuevo, no llama al modelo", async () => {
    const model = { bindTools: () => ({ invoke: async () => { throw new Error("no debía llamar") } }) }
    expect(await rereadFormSentences(model, { provider: "openai", modelName: "gpt-6-luna" }, [], ortho)).toEqual([])
    expect(await rereadFormSentences(model, { provider: "openai", modelName: "gpt-6-luna" }, [{ said: "algo", questions: [99] }], ortho)).toEqual([])
  })
})

/**
 * Lo de salud dicho en la conversación (mesa del 20 nov 2026, P3): Clío no tenía dónde ponerlo
 * (la warfarina y la metformina caían en el relato, el asma de un niño se perdía) y «no que yo
 * sepa» se volvía «No tiene alergias».
 */
describe("lo de salud dicho en la conversación", () => {
  const fixed = DENTAL_DICTATION_PROFILE.systemPrompt({ services: SERVICES, diagnosisList: "CIE-10 (OMS)", catalog: dictationFindingsText() })
  const schema = z.toJSONSchema(DENTAL_DICTATION_PROFILE.extraction) as { properties: Record<string, { properties?: Record<string, unknown> }> }

  it("tiene su parte `salud`, con quién lo dijo, lo de su registro y lo de la boca", () => {
    const salud = schema.properties["salud"]?.properties ?? {}
    expect(Object.keys(salud)).toEqual(
      expect.arrayContaining(["declarante", "vinculo", "allergies", "conditions", "medications", "anticoagulants", "boneMedicines", "personal", "dental", "medical", "dicho"]),
    )
    const dental = (salud["dental"] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
    expect(Object.keys(dental)).toEqual(
      expect.arrayContaining(["problemaAnestesia", "corazon", "ansiedadDental", "bruxismo", "habitos", "ultimaVisita", "biberon", "dulcesEntreComidas"]),
    )
    // El alcohol lo pregunta solo latidIA.
    expect(Object.keys((salud["medical"] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})).not.toContain("alcohol")
  })

  it("solo lo dicho: «no que yo sepa» es no sabe, el silencio no es «No» y lo de un familiar no es del paciente", () => {
    expect(fixed).toContain("«No que yo sepa», «creo que no», «no sé» o «no me acuerdo» son `unknown` (no sabe), nunca `none`")
    expect(fixed).toContain("Lo que no se preguntó ni se dijo no va: el silencio no es «No».")
    expect(fixed).toContain("«mi papá es diabético»")
    expect(fixed).toContain("no es del paciente: no va en `salud` ni en `alergias`")
    expect(fixed).toContain("El peso o la talla que alguien calcula o recuerda («debe pesar 24», «pesaba 22 hace seis meses») no es una medida")
    // Lo de su salud no va al relato.
    expect(fixed).toContain("Sus medicinas de siempre, sus enfermedades y lo de la anestesia van en `salud`, no en el relato")
    // La alergia dictada con duda tampoco es `none`.
    expect(fixed).toContain("«No que yo sepa», «creo que no» o «no sé» no son `none`")
  })

  it("se lee como una sola entrada, con su frase", () => {
    const transcript = "Tiene asma, usa salbutamol. Yo soy diabética."
    const read = readDictation(
      {
        salud: {
          declarante: "acompanante",
          vinculo: "madre",
          conditions: { state: "recorded", items: [{ name: "asma" }] },
          medications: { state: "recorded", items: [{ name: "salbutamol" }] },
          dicho: "Tiene asma, usa salbutamol.",
        },
      },
      transcript,
      0,
    )
    expect(read?.omitted).toBe(0)
    expect(read?.drafts).toEqual([
      {
        kind: "salud",
        payload: {
          declarante: "acompanante",
          vinculo: "madre",
          conditions: { state: "recorded", items: [{ name: "asma" }] },
          medications: { state: "recorded", items: [{ name: "salbutamol" }] },
        },
        sourceText: "Tiene asma, usa salbutamol.",
      },
    ])
  })
})
