import { expect, it } from "vitest"
import { assessmentsNote } from "./odontogram-assessments"

// QA del 18 nov: decía «la atención que cambia el gráfico», y una sesión que solo trata también lo
// cambia sin firmar copia.
it("la nota de «Odontogramas firmados» dice que una sesión que solo trata no firma copia", () => {
  const note = assessmentsNote("NTS 188")
  expect(note).not.toContain("cambia el gráfico")
  expect(note).toContain("Una sesión que solo trata no firma copia")
  expect(note).toContain("(NTS 188)")
})
