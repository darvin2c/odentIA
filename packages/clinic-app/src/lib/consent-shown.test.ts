import { expect, it } from "vitest"
import type { ConsentDocument } from "./clinical-forms"
import { personalRisksOf, shownRisksField } from "./consent-shown"

const sheet = (personalRisks?: string[]) =>
  ({
    sectionsSnapshot: {
      purpose: "",
      procedure: "",
      benefits: [],
      risks: [],
      alternatives: [],
      consequences: "",
      personalRisks,
    },
  }) as unknown as Pick<ConsentDocument, "sectionsSnapshot">

it("los riesgos propios de la hoja a la vista; sin ellos, ninguno", () => {
  expect(personalRisksOf(sheet(["Usa prótesis."]))).toEqual(["Usa prótesis."])
  expect(personalRisksOf(sheet())).toEqual([])
})

it("sin riesgos propios no se manda nada; con ellos, van tal cual", () => {
  expect(shownRisksField([])).toEqual({})
  expect(shownRisksField(["Toma apixabán."])).toEqual({ personalRisksShown: ["Toma apixabán."] })
})
