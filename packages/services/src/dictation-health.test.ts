import { describe, expect, it } from "vitest"
import {
  groundHealthNames,
  healthByDeclarant,
  healthRows,
  healthSaidBy,
  healthSaidOf,
  mergeHealth,
  prepareHealth,
  saidInDoubt,
  splitHealthDenials,
  withoutSettledHealth,
  withSaidPhrases,
} from "./dictation-health.js"
import { doubtfulAllergy } from "./encounter-dictation.js"
import { productHooksFor } from "./products.js"

const DENTAL = productHooksFor("dental").dictation!.health

/*
 * Lo de salud dicho en la conversación, sin base (revisión del 21 nov 2026 de «Clío en una consulta
 * conversada»): las reglas puras que deciden qué se propone, de quién y qué se guarda.
 */

describe("A1 · «no sé» y «quizá» con tilde son duda", () => {
  it("se reconocen con la tilde al final, como los escribe la voz de Chrome", () => {
    // Con `\b`, JavaScript no veía la «é» ni la «á» como letras: estas daban `false`.
    expect(saidInDoubt("no sé")).toBe(true)
    expect(saidInDoubt("No sé, doctora")).toBe(true)
    expect(saidInDoubt("¿alergias? no sé.")).toBe(true)
    expect(saidInDoubt("quizá")).toBe(true)
    expect(saidInDoubt("quizás sí")).toBe(true)
    expect(saidInDoubt("no se")).toBe(true)
    // Lo que no es duda sigue sin serlo: la frase dentro de otra palabra no cuenta.
    expect(saidInDoubt("no sería mala idea")).toBe(false)
    expect(saidInDoubt("tomo losartán")).toBe(false)
  })

  it("«¿Alérgica a algo? — No sé» no queda «No tiene alergias»", () => {
    const draft = doubtfulAllergy({ kind: "alergia", payload: { none: true }, sourceText: "No sé" })
    expect(draft).toEqual({ kind: "salud", payload: { declarante: "no_se_sabe", allergies: { state: "unknown" } }, sourceText: "No sé" })
  })

  it("un «no» a las enfermedades dicho con «no sé» queda como que no sabe", () => {
    const ready = prepareHealth({ declarante: "paciente", conditions: { state: "none", items: [] } }, "No sé, creo que nada", {})
    expect(ready?.payload["conditions"]).toEqual({ state: "unknown", items: [] })
  })
})

describe("A2 · «Lo revisé con…» no guarda un «No» de paso", () => {
  it("lo que nombró y lo que no sabe se guardan; el «No» queda esperando su fila", () => {
    const { kept, denied } = splitHealthDenials({
      declarante: "paciente",
      medications: { state: "recorded", items: [{ name: "losartán" }] },
      conditions: { state: "none", items: [] },
      allergies: { state: "unknown", items: [] },
      dental: { ansiedadDental: "alta", bruxismo: false },
    })
    expect(Object.keys(kept).filter((key) => key !== "quien").sort()).toEqual(["allergies", "declarante", "dental", "medications"])
    expect(kept["dental"]).toEqual({ ansiedadDental: "alta" })
    expect(denied["conditions"]).toEqual({ state: "none", items: [] })
    expect(denied["dental"]).toEqual({ bruxismo: false })
    expect(denied["medications"]).toBeUndefined()
  })

  it("las filas dicen cuál es un «No»", () => {
    const rows = healthRows({ declarante: "paciente", conditions: { state: "none", items: [] }, anticoagulants: { state: "recorded", detail: "apixabán" } })
    expect(rows.map((row) => [row.key, row.denied])).toEqual([
      ["anticoagulants", false],
      ["conditions", true],
    ])
  })
})

describe("A4 · cada dato con quien lo dijo", () => {
  const patient = prepareHealth({ declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }] } }, "tomo losartán", {})!.payload
  const daughter = prepareHealth({ declarante: "acompanante", vinculo: "hija", medications: { state: "recorded", items: [{ name: "metformina" }] } }, "también toma metformina", {})!.payload

  it("la metformina que dijo su hija no queda a nombre del paciente", () => {
    // Antes, la propuesta tenía un solo declarante: el primero que habló.
    const merged = prepareHealth(mergeHealth(patient, daughter).payload, undefined, {})!.payload
    expect(healthSaidBy(merged)).toEqual({ "medications:losartan": { declarante: "paciente" }, "medications:metformina": { declarante: "acompanante", vinculo: "hija" } })
    expect(healthRows(merged)[0]?.value).toBe("losartán · metformina (lo dijo su hija)")
    // Al confirmarla, una declaración por persona.
    expect(healthByDeclarant(merged).map((person) => [person.by, person.payload["medications"]])).toEqual([
      [{ declarante: "paciente" }, { state: "recorded", items: [{ name: "losartán" }] }],
      [{ declarante: "acompanante", vinculo: "hija" }, { state: "recorded", items: [{ name: "metformina" }] }],
    ])
  })

  it("«señora» es cómo le habló la doctora, no su parentesco: no se guarda como vínculo (QA del 21 nov)", () => {
    const said = prepareHealth({ declarante: "acompanante", vinculo: "Señora", conditions: { state: "recorded", items: [{ name: "asma" }] } }, "tiene asma", {})!.payload
    expect(said["vinculo"]).toBeUndefined()
    expect(healthRows(said)[0]?.value).not.toContain("señora")
  })

  it("lo de la entrevista también, campo por campo", () => {
    const fear = prepareHealth({ declarante: "paciente", dental: { ansiedadDental: "alta" } }, "me da miedo", DENTAL)!.payload
    const grind = prepareHealth({ declarante: "acompanante", vinculo: "esposo", dental: { bruxismo: true } }, "rechina de noche", DENTAL)!.payload
    const merged = mergeHealth(fear, grind).payload
    expect(healthRows(merged).map((row) => [row.key, row.by.declarante])).toEqual([
      ["dental.ansiedadDental", "paciente"],
      ["dental.bruxismo", "acompanante"],
    ])
    expect(healthByDeclarant(merged)).toHaveLength(2)
  })
})

describe("A5 · lo que nombra sale de su frase", () => {
  it("un anticoagulante o una medicina que no se dijo no se propone", () => {
    const heard = groundHealthNames(
      { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" }, medications: { state: "recorded", items: [{ name: "losartán 50 mg" }, { name: "metformina" }] } },
      "Tomo warfarina y losartan de cincuenta",
    )
    expect(heard.notHeard).toEqual(["metformina", "apixabán"])
    expect(heard.payload?.["anticoagulants"]).toEqual({ state: "recorded" })
    expect(heard.payload?.["medications"]).toEqual({ state: "recorded", items: [{ name: "losartán 50 mg" }] })
  })

  it("se reconoce por una palabra que lo distingue o por cómo suena", () => {
    expect(groundHealthNames({ medications: { state: "recorded", items: [{ name: "inhalador de salbutamol" }] } }, "usa salbutamol").notHeard).toEqual([])
    expect(groundHealthNames({ conditions: { state: "recorded", items: [{ name: "diabetes" }] } }, "es diabética").notHeard).toEqual([])
    expect(groundHealthNames({ anticoagulants: { state: "recorded", detail: "Eliquis" } }, "toma el eliquis").notHeard).toEqual([])
    // Una lista que se queda sin nada de lo que nombró no se propone.
    expect(groundHealthNames({ conditions: { state: "recorded", items: [{ name: "asma" }] } }, "tiene presión alta").payload).toBeNull()
  })
})

describe("A6 · lo resuelto no se vuelve a proponer", () => {
  it("lo que quedó en Antecedentes se quita de una propuesta nueva", () => {
    const resolved = [{ medications: { state: "recorded", items: [{ name: "losartán" }] } }]
    expect(withoutSettledHealth({ declarante: "paciente", medications: { state: "recorded", items: [{ name: "Losartan" }] } }, resolved)).toBeNull()
  })
})

// QA del 22 nov (UX-3): el aviso de su salud no decía qué se oyó en cada fila; la propuesta juntaba
// las frases de varias pausas en una sola, sin saber de qué dato era cada una.
describe("cada dato de su salud con la frase en que se oyó", () => {
  it("cada fila lleva la frase de la pausa que la dijo; dicha otra vez, la última", () => {
    const first = { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }] } }
    const second = { declarante: "paciente", allergies: { state: "unknown" }, medications: { state: "recorded", items: [{ name: "losartán" }, { name: "metformina" }] } }
    const said = healthSaidOf(second, "y metformina en el almuerzo, y alergias no que yo sepa", healthSaidOf(first, "si tomo losartan para la presion"))
    const rows = withSaidPhrases(healthRows({ ...second, medications: second.medications }), said)
    expect(Object.fromEntries(rows.map((row) => [row.key, row.said]))).toEqual({
      medications: "y metformina en el almuerzo, y alergias no que yo sepa",
      allergies: "y metformina en el almuerzo, y alergias no que yo sepa",
    })
    // Sin frase no se inventa una.
    expect(healthSaidOf(first, "  ", { medications: "antes" })).toEqual({ medications: "antes" })
    expect(withSaidPhrases(healthRows(first))[0]?.said).toBeUndefined()
  })
})
