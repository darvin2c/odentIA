import { expect, it } from "vitest"
import { medicalProfessionalFor } from "./professional.js"

it("en Perú se propone «Médico cirujano» y el CMP; en otro país, nada", () => {
  expect(medicalProfessionalFor("PE")).toEqual({
    title: "Médico cirujano",
    registrationBody: "CMP",
  })
  expect(medicalProfessionalFor("pe")).toEqual({
    title: "Médico cirujano",
    registrationBody: "CMP",
  })
  expect(medicalProfessionalFor("CO")).toBeNull()
  expect(medicalProfessionalFor(null)).toBeNull()
})
