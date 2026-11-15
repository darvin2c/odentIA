import { describe, expect, it } from "vitest"
// Por el índice, que carga primero los productos (ver `index.ts`).
import { anatomyFromName } from "./index.js"
import { type DictationFormQuestion, formNetMisses, formQuestionsOf, prepareFormAnswer } from "../dictation-forms.js"
import { dictatedService } from "../encounter-dictation.js"
import type { ProductSite } from "../product-hooks.js"
import { productHooksFor } from "../products.js"

/**
 * Lo que encontró la tercera prueba con voz del 15 nov (corrida c3, sobre
 * fa4f5e8d), tal como lo oyó Chrome: la pulpectomía de leche en la 36 de una
 * adulta, la segunda lectura con la frase de otra pregunta y «reglamentamos el
 * bracket» con la aparatología.
 */

const FDI: ProductSite = {
  code: (value: unknown) => (typeof value === "number" && /^[1-4][1-8]$|^[5-8][1-5]$/.test(String(value)) ? String(value) : null),
  invalid: (value: unknown) => `${String(value)} no es una pieza`,
} as unknown as ProductSite

// El tarifario de la demo de odentIA en lo que toca a estos dictados.
const DEMO = [
  "Apertura cameral",
  "Endodoncia anterior vital",
  "Endodoncia posterior vital",
  "Endodoncia posterior no vital",
  "Pulpectomía anterior, deciduo",
  "Pulpectomía posterior, deciduo",
  "Corona de acero prefabricada, deciduo",
  "Exodoncia de diente permanente unirradicular",
  "Restauración temporal",
  "Control de ortodoncia",
  "Aparatología fija de ortodoncia",
  "Aparatología removible de ortodoncia",
  "Limpieza dental (profilaxis)",
]
const adult = { adult: true }
const child = { adult: false }

describe("lo de diente de leche no se propone para una pieza permanente, ni lo de permanente para una temporal (v06)", () => {
  it("«la pulpectomía» en la 36 de una adulta no ofrece las pulpectomías de leche", () => {
    expect(dictatedService("pulpectomía", DEMO, "dental", { toothNumber: 36 }, adult)).toEqual({ match: null, candidates: [] })
    // Escrita como el servicio, tampoco: la 36 es permanente.
    expect(dictatedService("Pulpectomía posterior, deciduo", DEMO, "dental", { toothNumber: 36 }, adult).match).toBeNull()
    // En la 75 de un niño, la posterior: la pieza decide el grupo, y queda una sola.
    expect(dictatedService("pulpectomía", DEMO, "dental", { toothNumber: 75 }, child)).toEqual({ match: "Pulpectomía posterior, deciduo", candidates: [] })
    // Una temporal que le queda a un adulto sigue la pieza.
    expect(dictatedService("pulpectomía", DEMO, "dental", { toothNumber: 53 }, adult).match).toBe("Pulpectomía anterior, deciduo")
  })

  it("sin pieza, a un adulto no se le ofrece lo de leche; a un niño o sin edad, sí", () => {
    expect(dictatedService("pulpectomía", DEMO, "dental", {}, adult).candidates).toEqual([])
    expect(dictatedService("corona de acero", DEMO, "dental", {}, adult).candidates).toEqual([])
    expect(dictatedService("pulpectomía", DEMO, "dental", {}, child).candidates).toHaveLength(2)
    expect(dictatedService("pulpectomía", DEMO, "dental").candidates).toHaveLength(2)
  })

  it("lo de permanente no va en una temporal, y la versión anterior o posterior sigue la pieza", () => {
    expect(dictatedService("exodoncia", DEMO, "dental", { toothNumber: 84 }, child).candidates).not.toContain("Exodoncia de diente permanente unirradicular")
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, adult).candidates).toEqual(["Endodoncia posterior vital", "Endodoncia posterior no vital"])
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 11 }, adult).match).toBe("Endodoncia anterior vital")
    expect(dictatedService("endodoncia anterior vital", DEMO, "dental", { toothNumber: 46 }, adult).match).toBeNull()
    // Sin la de su grupo, la de otro se ofrece para elegir, nunca dada por buena; la de otra dentición, nunca.
    expect(dictatedService("endodoncia", ["Endodoncia anterior vital", "Pulpectomía posterior, deciduo"], "dental", { toothNumber: 36 }, adult)).toEqual({ match: null, candidates: ["Endodoncia anterior vital"] })
    expect(dictatedService("pulpectomía", ["Pulpectomía posterior, deciduo"], "dental", { toothNumber: 36 }, adult)).toEqual({ match: null, candidates: [] })
  })

  it("sin la anatomía de la biblioteca, la marca sale del nombre o del código; «temporal» solo no es de leche", () => {
    expect(anatomyFromName({ name: "Corona de acero prefabricada, deciduo" })).toEqual({ groups: [], dentition: "deciduous" })
    expect(anatomyFromName({ name: "Extracción de diente de leche" })).toEqual({ groups: [], dentition: "deciduous" })
    expect(anatomyFromName({ name: "Exodoncia de diente permanente unirradicular" })).toEqual({ groups: [], dentition: "permanent" })
    expect(anatomyFromName({ name: "Pulpectomía posterior, deciduo" })).toEqual({ groups: ["premolar", "molar"], dentition: "deciduous" })
    expect(anatomyFromName({ name: "Endodoncia", code: "ENDO_ANTERIOR" })).toEqual({ groups: ["anterior"], dentition: null })
    expect(anatomyFromName({ name: "Radiografía periapical premolares" })).toEqual({ groups: ["premolar"], dentition: null })
    expect(anatomyFromName({ name: "Restauración temporal" })).toBeNull()
    expect(anatomyFromName({ name: "Limpieza dental (profilaxis)" })).toBeNull()
  })
})

describe("«recementar el bracket» es el control de ortodoncia, nunca aparatología (v03)", () => {
  it("tal como lo oyó Chrome, «reglamentamos el bracket», solo ofrece el control", () => {
    expect(dictatedService("reglamentamos el bracket", DEMO, "dental", { toothNumber: 41 }, child)).toEqual({ match: null, candidates: ["Control de ortodoncia"] })
    expect(dictatedService("recementamos el bracket", DEMO, "dental").candidates).toEqual(["Control de ortodoncia"])
    expect(dictatedService("recolocamos el bracket de la 41", DEMO, "dental").candidates).toEqual(["Control de ortodoncia"])
    // Con un servicio de recementado de bracket en la lista, ese calza.
    expect(dictatedService("recementamos el bracket", [...DEMO, "Recementado de bracket"], "dental").match).toBe("Recementado de bracket")
    // «Los brackets» siguen siendo la ortodoncia entera: ponerlos es aparatología.
    expect(dictatedService("colocamos los brackets", DEMO, "dental").candidates).toContain("Aparatología fija de ortodoncia")
  })
})

describe("la segunda lectura vale solo con una frase que nombra su pregunta (v02)", () => {
  const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === "ficha-de-ortodoncia")
  if (!form) throw new Error("ficha-de-ortodoncia")
  const ortho: DictationFormQuestion[] = formQuestionsOf([{ id: "orto", title: form.title, snapshot: form.schema, answers: {} }])
  const number = (fieldId: string) => ortho.find((item) => item.fieldId === fieldId)?.number ?? 0
  const heard =
    "Okay este seguimos con la ficha overjat de 6 no perdón de 4 mm Pásame el espejo por favor abre un poquito más ya así over byte de Point de tres molar derecha clase 2 división 1 la izquierda clase 1"
  const reread = (answer: string, said: string) => prepareFormAnswer({ payload: { question: number("overbite"), answer }, sourceText: said, reread: true }, ortho, FDI, heard)

  it("«de 6 no perdón de 4 mm» es del overjet: no se propone como overbite y el aviso de la red se queda", () => {
    expect(reread("4", "de 6 no perdón de 4 mm")).toBeNull()
    const overjet = { kind: "ficha", payload: { question: number("overjet"), answer: "4" }, sourceText: "overjat de 6 no perdón de 4 mm" }
    expect(formNetMisses([overjet], ortho, FDI, heard).some((miss) => miss.questions.includes(number("overbite")))).toBe(true)
  })

  it("con la frase que nombra el overbite, queda por revisar con su valor", () => {
    expect(reread("3", "over byte de Point de tres")).toMatchObject({ status: "por_revisar", payload: { value: 3, reread: true } })
  })

  it("la frase que nombra el overbite no responde el overjet (medición del 15 nov, orto-21)", () => {
    const said = "Overbite de tres, no, perdón, de dos y medio."
    expect(prepareFormAnswer({ payload: { question: number("overjet"), answer: "2.5" }, sourceText: said }, ortho, FDI, said)).toBeNull()
  })

  it("en una oración que solo habla del overbite, la corrección dicha vale aunque no lo repita", () => {
    const said = "Overbite de tres, no, perdón, de dos y medio."
    const draft = { payload: { question: number("overbite"), answer: "2.5" }, sourceText: "de dos y medio", reread: true }
    expect(prepareFormAnswer(draft, ortho, FDI, `Control de ortodoncia. ${said} La derecha en clase dos.`)).toMatchObject({ status: "por_revisar", payload: { value: 2.5 } })
  })
})
