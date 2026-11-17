// @vitest-environment jsdom
import { expect, it } from "vitest"
import { focusesReasonOnOpen } from "./opening-focus"

it("con teclado y sin nada enfocado, el cursor va al motivo al abrir la atención", () => {
  expect(focusesReasonOnOpen(document.body, false)).toBe(true)
  expect(focusesReasonOnOpen(null, false)).toBe(true)
})

it("si otra cosa ya tomó el foco (la pieza pedida por enlace), no se lo quita", () => {
  const tooth = document.createElement("button")
  document.body.append(tooth)
  expect(focusesReasonOnOpen(tooth, false)).toBe(false)
  tooth.remove()
})

it("en el teléfono o la tablet no enfoca el motivo: subiría el teclado sin que nadie lo pida", () => {
  expect(focusesReasonOnOpen(document.body, true)).toBe(false)
})
