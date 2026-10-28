import { expect, it } from "vitest"
import { signatureRegistrationError } from "./encounters"

const ok = { professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345" }

it("la colegiatura del cierre pide título, colegio y un número válido, como el servidor", () => {
  expect(signatureRegistrationError(ok)).toBeNull()
  expect(signatureRegistrationError({ ...ok, registrationNumber: " CMP-0987 " })).toBeNull()
  expect(signatureRegistrationError({ ...ok, registrationNumber: "  " })).toBe("Escribe tu número de colegiatura")
  expect(signatureRegistrationError({ ...ok, registrationNumber: "12 345" })).toBe(
    "La colegiatura lleva solo letras, números y guiones (hasta 20)",
  )
  expect(signatureRegistrationError({ ...ok, registrationBody: "" })).toBe("Escribe tu colegio profesional")
  expect(signatureRegistrationError({ ...ok, professionalTitle: "" })).toBe("Escribe tu título profesional")
})
