import { expect, it } from "vitest"
import { isRegistrationNumber } from "./professional-registration.js"

// QA del 16 nov, Q8: «abc» se guardó como colegiatura y quedó «COP abc» en un consentimiento firmado.
it("el número de colegiatura son solo dígitos: las letras son del colegio", () => {
  expect(isRegistrationNumber("12345")).toBe(true)
  expect(isRegistrationNumber("045678")).toBe(true)
  for (const wrong of ["abc", "COP12345", "CMP-0987", "12 345", "12-345", "12.345", "", "1".repeat(21)])
    expect(isRegistrationNumber(wrong), wrong).toBe(false)
})
