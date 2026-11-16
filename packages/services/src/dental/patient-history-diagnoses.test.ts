import { describe, expect, it } from "vitest"
import { DENTAL_FORMS } from "./forms.js"
import { dentalProductSite } from "./site.js"
import { formDiagnosesOf, formDiagnosisKey } from "../form-diagnoses.js"
import { encounterDiagnosisLines } from "../patient-history.js"
import type { ProductSite } from "../product-hooks.js"

const TITLES = new Map([
  ["ICD-10|K02.1", "Caries de la dentina"],
  ["ICD-10|K04.0", "Pulpitis"],
  ["ICD-10|K04.4", "Periodontitis apical aguda originada en la pulpa"],
])
const tooth = (toothNumber: number) => dentalProductSite.columns({ toothNumber })
const NO_SITE = { siteSystem: null, siteCode: null, siteQualifiers: [] }

// Estudio de la atención del 16 nov (B1, E10a): la Historia decía «Caries de la dentina» una sola vez
// para la 15 (definitivo) y la 24 (presuntivo), y «Pulpitis» sin pieza.
describe("la Historia dice cada diagnóstico con su pieza y su tipo", () => {
  it("la caries de la 15 y la de la 24 van en su línea, con su tipo, y la pulpitis con su pieza", () => {
    const lines = encounterDiagnosisLines({
      diagnoses: [
        { system: "ICD-10", code: "K02.1", type: "confirmed", status: "activo", site: tooth(15) },
        { system: "ICD-10", code: "K02.1", type: "provisional", status: "activo", site: tooth(24) },
        { system: "ICD-10", code: "K04.0", type: "confirmed", status: "activo", site: tooth(36) },
      ],
      procedures: [],
      titles: TITLES,
      site: dentalProductSite,
    })
    expect(lines).toEqual([
      "Caries de la dentina (CIE-10 K02.1) · pieza 15 · definitivo",
      "Caries de la dentina (CIE-10 K02.1) · pieza 24 · presuntivo",
      "Pulpitis (CIE-10 K04.0) · pieza 36 · definitivo",
    ])
  })

  it("«resuelto» va solo en la pieza que quedó resuelta", () => {
    const lines = encounterDiagnosisLines({
      diagnoses: [
        { system: "ICD-10", code: "K02.1", type: "confirmed", status: "resuelto", site: tooth(16) },
        { system: "ICD-10", code: "K02.1", type: "confirmed", status: "activo", site: tooth(26) },
      ],
      procedures: [],
      titles: TITLES,
      site: dentalProductSite,
    })
    expect(lines).toEqual([
      "Caries de la dentina (CIE-10 K02.1) · pieza 16 · definitivo · resuelto",
      "Caries de la dentina (CIE-10 K02.1) · pieza 26 · definitivo",
    ])
  })

  it("lo hecho con un código que no está en Diagnóstico no se pierde, y lo que ya está no se repite", () => {
    const lines = encounterDiagnosisLines({
      diagnoses: [{ system: "ICD-10", code: "K04.0", type: "confirmed", status: "activo", site: tooth(36) }],
      procedures: [
        { system: "ICD-10", code: "K04.0", site: tooth(36) },
        { system: "ICD-10", code: "K02.1", site: tooth(15) },
        { system: null, code: null, site: tooth(11) },
      ],
      titles: TITLES,
      site: dentalProductSite,
    })
    expect(lines).toEqual(["Caries de la dentina (CIE-10 K02.1) · pieza 15", "Pulpitis (CIE-10 K04.0) · pieza 36 · definitivo"])
  })

  it("sin «dónde» (latidIA), el diagnóstico y su tipo", () => {
    const noSite = { ...dentalProductSite, words: () => null } as ProductSite
    expect(
      encounterDiagnosisLines({
        diagnoses: [{ system: "ICD-10", code: "K04.0", type: "provisional", status: "activo", site: NO_SITE }],
        procedures: [],
        titles: TITLES,
        site: noSite,
      }),
    ).toEqual(["Pulpitis (CIE-10 K04.0) · presuntivo"])
  })
})

// E10b: la ficha de endodoncia llenada a mano dice el diagnóstico, y la Historia dice su término.
describe("lo que dice la ficha de endodoncia", () => {
  const endodontics = DENTAL_FORMS.suggestions.find((form) => form.kind === "endodoncia")!
  const row = (answers: Record<string, unknown>) => ({ id: "r1", encounterId: "e1", templateSnapshot: endodontics.schema, answers })

  it("propone K04.0 y K04.4 en la 36, con lo que su término le suma al código", () => {
    const said = formDiagnosesOf(
      [row({ pieza: 36, diagnostico_pulpar: "Pulpitis irreversible sintomática", diagnostico_apical: "Periodontitis apical sintomática" })],
      DENTAL_FORMS,
    )
    expect(said.map(({ code, qualifier, toothNumber, fieldId }) => ({ code, qualifier, toothNumber, fieldId }))).toEqual([
      { code: "K04.0", qualifier: "irreversible sintomática", toothNumber: 36, fieldId: "diagnostico_pulpar" },
      { code: "K04.4", qualifier: "sintomática", toothNumber: 36, fieldId: "diagnostico_apical" },
    ])
  })

  it("lo normal, lo ya tratado y la necrosis no suman término; lo que no es diagnóstico no se propone", () => {
    const said = formDiagnosesOf([row({ pieza: 46, diagnostico_pulpar: "Necrosis pulpar", diagnostico_apical: "Tejidos apicales normales", percusion: "Positiva" })], DENTAL_FORMS)
    expect(said.map(({ code, qualifier }) => ({ code, qualifier }))).toEqual([{ code: "K04.1", qualifier: null }])
  })

  it("sin el mapa del producto (latidIA y vistIA), nada", () => {
    expect(formDiagnosesOf([row({ pieza: 36, diagnostico_pulpar: "Pulpitis reversible" })], {})).toEqual([])
  })

  it("la Historia lee el término de la ficha de esa atención y esa pieza", () => {
    const [pulpal] = formDiagnosesOf([row({ pieza: 36, diagnostico_pulpar: "Pulpitis irreversible sintomática" })], DENTAL_FORMS)
    const qualifierOf = new Map([[formDiagnosisKey("e1", pulpal!.code, pulpal!.toothNumber), pulpal!.qualifier]])
    const lines = encounterDiagnosisLines({
      diagnoses: [
        {
          system: "ICD-10",
          code: "K04.0",
          type: "confirmed",
          status: "activo",
          site: tooth(36),
          qualifier: qualifierOf.get(formDiagnosisKey("e1", "K04.0", 36)) ?? null,
        },
      ],
      procedures: [],
      titles: TITLES,
      site: dentalProductSite,
    })
    expect(lines).toEqual(["Pulpitis (CIE-10 K04.0) · irreversible sintomática · pieza 36 · definitivo"])
  })
})
