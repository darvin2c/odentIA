import { DICTATION_MAX_SUGGESTIONS, DICTATION_SOURCE_CHARS } from "@odentia/services"
import { dictationFindingsText } from "@odentia/services/dental"
import { describe, expect, it } from "vitest"
import { type DictationAsk, dictationMessages, groundSource, readDictation as readWith } from "../dictation.js"
import { DENTAL_DICTATION_PROFILE, demoExtraction, demoSegment } from "./dictation.js"

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
})
