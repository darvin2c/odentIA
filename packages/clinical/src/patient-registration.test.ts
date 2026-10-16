import { describe, expect, it } from "vitest"
import { documentText } from "./identity.js"
import { DEFAULT_REGISTRATION_CONFIG, pendingRegistrationFields, registrationAnswersSchema, registrationConfigSchema, validateRegistrationAnswers, type RegistrationAnswers } from "./patient-registration.js"
const config = { ...DEFAULT_REGISTRATION_CONFIG, enabled: true, privacyNotice: "Aviso de demostración" }
const adult: RegistrationAnswers = {
  demographics: { displayName: "María Pérez", birthDate: "1990-03-12", phone: "+51999999999" },
  respondent: "patient", privacyAccepted: true,
  health: { allergies: { state: "unanswered", items: [] }, conditions: { state: "unknown", items: [] }, medications: { state: "none", items: [] } },
}
const publicContext = { mode: "public", today: "2026-06-15" } as const

describe("contrato de registro", () => {
  it("permite alta interna rápida sin imponer requisitos públicos", () => {
    expect(validateRegistrationAnswers(config, { demographics: { displayName: "Ana" }, respondent: "staff", privacyAccepted: false }, { ...publicContext, mode: "internal" })).toEqual({})
    expect(validateRegistrationAnswers(config, adult, publicContext)).toEqual({})
    // Con configuración guardada, lo obligatorio también lo es para recepción.
    const saved = { ...config, version: 1, fields: { ...config.fields, docType: "required" as const, docNumber: "required" as const } }
    expect(validateRegistrationAnswers(saved, { demographics: { displayName: "Ana", birthDate: "1990-01-01", phone: "+51999999999" }, respondent: "staff", privacyAccepted: false }, { ...publicContext, mode: "internal" })).toHaveProperty("demographics.docNumber")
  })
  it("lo mínimo del equipo al reservar no exige lo que pide la clínica: queda pendiente", () => {
    const saved = { ...config, version: 1 }
    const minimal: RegistrationAnswers = { demographics: { displayName: "Carmen Huamán", givenNames: "Carmen", paternalSurname: "Huamán", phone: "+51987654100" }, respondent: "staff", privacyAccepted: false }
    const internal = { ...publicContext, mode: "internal" } as const
    expect(validateRegistrationAnswers(saved, minimal, internal)).toHaveProperty("demographics.birthDate")
    expect(validateRegistrationAnswers(saved, minimal, { ...internal, scope: "essentials" })).toEqual({})
    expect(pendingRegistrationFields(saved, minimal).map((field) => field.key)).toEqual(["birthDate"])
    // Solo lo esencial: nombres y apellidos, sin datos fuera de la identidad ni de salud.
    expect(validateRegistrationAnswers(saved, { ...minimal, demographics: { displayName: "Carmen" } }, { ...internal, scope: "essentials" })).toHaveProperty("demographics.givenNames")
    expect(validateRegistrationAnswers(saved, { ...minimal, demographics: { ...minimal.demographics, occupation: "Abogada" } }, { ...internal, scope: "essentials" })).toHaveProperty("demographics.occupation")
    expect(validateRegistrationAnswers(saved, { ...minimal, health: adult.health }, { ...internal, scope: "essentials" })).toHaveProperty("health")
  })
  it("un documento se lee con la etiqueta del catálogo, nunca con su código", () => {
    expect(documentText("PASAPORTE", "AB1234567")).toBe("Pasaporte AB1234567")
    expect(documentText("CE", "001234567")).toBe("Carné de extranjería 001234567")
    expect(documentText("DNI", "12345678")).toBe("DNI 12345678")
    expect(documentText(null, "12345678")).toBe("12345678")
  })
  it("distingue desconocimiento, ausencia y falta de respuesta sin filas ocultas", () => {
    const required = { ...config, fields: { ...config.fields, allergies: "required" as const } }
    expect(validateRegistrationAnswers(required, adult, publicContext)).toHaveProperty("health.allergies")
    expect(validateRegistrationAnswers(required, { ...adult, health: { ...adult.health, allergies: { state: "unknown", items: [] } } }, publicContext)).toEqual({})
    expect(registrationAnswersSchema.safeParse({ ...adult, health: { allergies: { state: "none", items: [{ substance: "Penicilina", severity: "severa" }] } } }).success).toBe(false)
  })
  it("exige responsable para menores y acepta su medio de contacto", () => {
    const child: RegistrationAnswers = { ...adult, demographics: { displayName: "Pedro", birthDate: "2016-01-01" }, respondent: "representative" }
    expect(validateRegistrationAnswers(config, child, publicContext)).toHaveProperty("representative")
    expect(validateRegistrationAnswers(config, { ...child, representative: { displayName: "María", relationship: "guardian", relationshipDetail: "Madre", phone: "+51999999999", docType: "DNI", docNumber: "12345678" } }, publicContext)).toEqual({})
    // El representante legal de un menor se identifica con su documento.
    expect(validateRegistrationAnswers(config, { ...child, representative: { displayName: "María", relationship: "guardian", relationshipDetail: "Madre", phone: "+51999999999" } }, publicContext)).toHaveProperty("representative.docNumber")
    expect(validateRegistrationAnswers(config, { ...child, respondent: "staff" }, { ...publicContext, mode: "internal" })).toHaveProperty("representative")
  })
  it("valida fecha real y la frontera de mayoría de edad", () => {
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, birthDate: "2025-02-29" } }, publicContext)).toHaveProperty("demographics.birthDate")
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, birthDate: "2027-01-01" } }, publicContext)).toHaveProperty("demographics.birthDate")
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, birthDate: "2008-06-15" } }, publicContext)).toEqual({})
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, birthDate: "2008-06-16" } }, publicContext)).toHaveProperty("representative")
  })
  it("rechaza campos ocultos, IDs clínicos y atribución pública a personal", () => {
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, occupation: "" } }, publicContext)).toHaveProperty("demographics.occupation")
    expect(registrationAnswersSchema.safeParse({ ...adult, health: { conditions: { state: "recorded", items: [{ id: "ajeno", name: "Asma" }] } } }).success).toBe(false)
    expect(validateRegistrationAnswers(config, { ...adult, respondent: "staff" }, publicContext)).toHaveProperty("respondent")
  })
  it("publica únicamente con aviso y contacto obligatorio; documento funciona como pareja", () => {
    expect(registrationConfigSchema.safeParse(config).success).toBe(true)
    expect(registrationConfigSchema.safeParse({ ...config, privacyNotice: " " }).success).toBe(false)
    expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, phone: "hidden" } }).success).toBe(false)
    expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, docType: "hidden" } }).success).toBe(false)
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "DNI", docNumber: "123" } }, publicContext)).toHaveProperty("demographics.docNumber")
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "PASAPORTE", docNumber: "ABC123", docCountry: "VE" } }, publicContext)).toEqual({})
    // Un documento emitido fuera del Perú exige el país emisor.
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "PASAPORTE", docNumber: "ABC123" } }, publicContext)).toHaveProperty("demographics.docCountry")
  })
})
