import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { missingFiliation, type Patient } from "./patients"
import { isPeopleView } from "./people"

const patient = (extra: Partial<Patient>): Patient => ({
  id: "p",
  patientNumber: 1,
  displayName: "Rosa Quispe",
  isActive: true,
  createdAt: "2026-10-15T00:00:00Z",
  ...extra,
})

describe("lo que le falta a la filiación: un solo criterio, el de «Registro de pacientes»", () => {
  it("cuenta solo lo que la clínica marcó como obligatorio y la ficha no tiene", () => {
    const config = {
      fields: {
        ...DEFAULT_REGISTRATION_CONFIG.fields,
        birthDate: "required",
        docType: "required",
        docNumber: "required",
        occupation: "optional",
      },
    } as typeof DEFAULT_REGISTRATION_CONFIG
    expect(missingFiliation(config, patient({ birthDate: "1990-01-01" }), [])).toEqual(
      expect.arrayContaining(["tipo de documento", "número de documento"]),
    )
    expect(missingFiliation(config, patient({ birthDate: "1990-01-01" }), [])).not.toContain(
      "ocupación",
    )
    expect(missingFiliation(config, patient({}), [])).toContain("fecha de nacimiento")
    // El nombre lo tiene siempre: nunca falta.
    expect(missingFiliation(config, patient({}), [])).not.toContain("nombre completo")
  })

  it("a Mateo, de 6 años, no le falta teléfono si el de su madre está: la misma regla que el registro", () => {
    const config = {
      fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, phone: "required" },
    } as typeof DEFAULT_REGISTRATION_CONFIG
    const mateo = patient({ displayName: "Mateo Quispe", birthDate: "2020-03-01" })
    const mother = { relationship: "guardian" as const, isActive: true, phone: "+51987654301", email: null }
    expect(missingFiliation(config, mateo, [])).toContain("teléfono")
    expect(missingFiliation(config, mateo, [mother])).not.toContain("teléfono")
    // Su propio vínculo o un contacto archivado no hablan por él.
    expect(missingFiliation(config, mateo, [{ ...mother, relationship: "self" as const }])).toContain("teléfono")
    expect(missingFiliation(config, mateo, [{ ...mother, isActive: false }])).toContain("teléfono")
  })
})

describe("vistas de la lista única", () => {
  it("solo valen las vistas que tienen chip", () => {
    expect(isPeopleView("por_registrar")).toBe(true)
    expect(isPeopleView("contactos")).toBe(false)
    expect(isPeopleView(undefined)).toBe(false)
  })
})
