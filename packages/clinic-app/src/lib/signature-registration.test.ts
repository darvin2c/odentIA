import { expect, it } from "vitest"
import { signatureRegistrationErrors } from "./encounters"

const ok = { professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345" }

it("la colegiatura del cierre pide título, colegio y un número válido, como el servidor, cada uno en su campo", () => {
  expect(signatureRegistrationErrors(ok)).toEqual({})
  expect(signatureRegistrationErrors({ ...ok, registrationNumber: " CMP-0987 " })).toEqual({})
  expect(signatureRegistrationErrors({ ...ok, registrationNumber: "  " })).toEqual({
    registrationNumber: "Escribe tu número de colegiatura",
  })
  expect(signatureRegistrationErrors({ ...ok, registrationNumber: "12 345" })).toEqual({
    registrationNumber: "La colegiatura lleva solo letras, números y guiones (hasta 20)",
  })
  expect(signatureRegistrationErrors({ ...ok, registrationBody: "" })).toEqual({
    registrationBody: "Escribe tu colegio profesional",
  })
  expect(signatureRegistrationErrors({ ...ok, registrationBody: "x".repeat(41) })).toEqual({
    registrationBody: "El colegio profesional admite hasta 40 caracteres",
  })
  expect(signatureRegistrationErrors({ ...ok, professionalTitle: "", registrationBody: "" })).toEqual({
    professionalTitle: "Escribe tu título profesional",
    registrationBody: "Escribe tu colegio profesional",
  })
})
