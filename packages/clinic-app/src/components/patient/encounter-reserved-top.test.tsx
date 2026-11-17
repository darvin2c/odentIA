// @vitest-environment jsdom

/**
 * El alto de la línea fija del paciente es una sola variable (QA del 16 nov, Q12): el panel de la
 * pieza se pegaba con `top-4` y la línea, que llegó después, tapaba su cabecera y su «×». Con la
 * variable, lo que se pega arriba dentro de la atención lo hace debajo de la línea.
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { PATIENT_LINE_HEIGHT_VAR, useReservedTop } from "./encounter-patient-line"

afterEach(cleanup)

function Attention() {
  useReservedTop()
  return null
}

it("la atención abierta deja el alto de la línea en la ventana, y al salir lo quita", () => {
  const root = document.documentElement
  expect(root.style.getPropertyValue(PATIENT_LINE_HEIGHT_VAR)).toBe("")
  const page = render(<Attention />)
  expect(root.style.getPropertyValue(PATIENT_LINE_HEIGHT_VAR)).toBe("2.75rem")
  // El foco reserva el mismo alto: un campo enfocado no queda debajo de la línea.
  expect(root.style.scrollPaddingTop).toContain(`var(${PATIENT_LINE_HEIGHT_VAR})`)
  page.unmount()
  expect(root.style.getPropertyValue(PATIENT_LINE_HEIGHT_VAR)).toBe("")
  expect(root.style.scrollPaddingTop).toBe("")
})
