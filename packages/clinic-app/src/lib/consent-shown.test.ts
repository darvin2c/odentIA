import { expect, it } from "vitest"
import type { ConsentDocument } from "./clinical-forms"
import { personalRisksOf, personalRisksOnPaper, rememberPrintedSheet, shownRisksField } from "./consent-shown"

const sheet = (id: string, personalRisks?: string[]) =>
  ({ id, sectionsSnapshot: { purpose: "", procedure: "", benefits: [], risks: [], alternatives: [], consequences: "", personalRisks } }) as unknown as Pick<
    ConsentDocument,
    "id" | "sectionsSnapshot"
  >

it("la firma en papel dice los riesgos de la hoja que salió impresa, no los que se cambiaron después", () => {
  const printedA = sheet("doc-1", ["Toma apixabán: puede sangrar más."])
  rememberPrintedSheet(printedA)
  // Después de imprimirla, se cambiaron: la foto que se sube es de la hoja impresa.
  const editedB = sheet("doc-1", ["Toma apixabán: lo suspende 1 día."])
  expect(personalRisksOnPaper(editedB)).toEqual(["Toma apixabán: puede sangrar más."])
  // Sin imprimirla desde aquí, vale la hoja a la vista.
  expect(personalRisksOnPaper(sheet("doc-2", ["Usa prótesis."]))).toEqual(["Usa prótesis."])
  expect(personalRisksOf(sheet("doc-3"))).toEqual([])
})

it("sin riesgos propios no se manda nada; con ellos, van tal cual", () => {
  expect(shownRisksField([])).toEqual({})
  expect(shownRisksField(["Toma apixabán."])).toEqual({ personalRisksShown: ["Toma apixabán."] })
})
