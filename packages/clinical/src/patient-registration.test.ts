import { describe, expect, it } from "vitest"
import { clinicalProfileFor, supplierDocumentTypes } from "./country-profiles.js"
import { documentText, documentTypeLabel, identityDocumentError, kinshipFromWords } from "./identity.js"
import {
  DEFAULT_REGISTRATION_CONFIG,
  missingPersonData,
  normalizePersonData,
  pendingRegistrationFields,
  registrationAnswersSchema,
  registrationConfigSchema,
  registrationFieldAsked,
  type RegistrationAnswers,
  validateDemographics,
  validateRegistrationAnswers,
} from "./patient-registration.js"
const config = { ...DEFAULT_REGISTRATION_CONFIG, enabled: true, privacyNotice: "Aviso de demostración" }
const adult: RegistrationAnswers = {
  demographics: { displayName: "María Pérez", birthDate: "1990-03-12", phone: "+51999999999" },
  respondent: "patient", privacyAccepted: true,
  health: { allergies: { state: "unanswered", items: [] }, conditions: { state: "unknown", items: [] }, medications: { state: "none", items: [] } },
}
const publicContext = { mode: "public", today: "2026-06-15", countryCode: "PE" } as const

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
    const minimal: RegistrationAnswers = { demographics: { displayName: "Carmen Huamán", givenNames: "Carmen", familyName: "Huamán", phone: "+51987654100" }, respondent: "staff", privacyAccepted: false }
    const internal = { ...publicContext, mode: "internal" } as const
    expect(validateRegistrationAnswers(saved, minimal, internal)).toHaveProperty("demographics.birthDate")
    expect(validateRegistrationAnswers(saved, minimal, { ...internal, scope: "essentials" })).toEqual({})
    expect(pendingRegistrationFields(saved, minimal).map((field) => field.key)).toEqual(["birthDate"])
    // Solo lo esencial: nombres y apellidos, sin datos fuera de la identidad ni de salud.
    expect(validateRegistrationAnswers(saved, { ...minimal, demographics: { displayName: "Carmen" } }, { ...internal, scope: "essentials" })).toHaveProperty("demographics.givenNames")
    expect(validateRegistrationAnswers(saved, { ...minimal, demographics: { ...minimal.demographics, occupation: "Abogada" } }, { ...internal, scope: "essentials" })).toHaveProperty("demographics.occupation")
    expect(validateRegistrationAnswers(saved, { ...minimal, health: adult.health }, { ...internal, scope: "essentials" })).toHaveProperty("health")
  })
  it("al reservar desde su enlace se pide lo obligatorio que ese paso sabe pedir; lo demás queda para «Tus datos»", () => {
    const saved = { ...config, version: 1, fields: { ...config.fields, sex: "required" as const, address: "required" as const } }
    const booking = { ...publicContext, scope: "essentials" } as const
    const answers: RegistrationAnswers = {
      demographics: {
        displayName: "Rosa Pérez Quispe", givenNames: "Rosa", familyName: "Pérez Quispe", docType: "DNI", docNumber: "45678912",
        phone: "+51987654321", birthDate: "1990-05-14", sex: "F",
      },
      respondent: "patient", privacyAccepted: true, acceptsReminders: true, acceptsMessages: false,
    }
    expect(validateRegistrationAnswers(saved, answers, booking)).toEqual({})
    // La fecha de nacimiento y el sexo que la clínica exige no se saltan, ni siquiera «Para mí».
    expect(validateRegistrationAnswers(saved, { ...answers, demographics: { ...answers.demographics, birthDate: null } }, booking)).toHaveProperty("demographics.birthDate")
    expect(validateRegistrationAnswers(saved, { ...answers, demographics: { ...answers.demographics, sex: null } }, booking)).toHaveProperty("demographics.sex")
    // La dirección no se pide en ese paso: queda pendiente para «Tus datos», sin bloquear la reserva.
    expect(pendingRegistrationFields(saved, answers).map((field) => field.key)).toEqual(["address"])
    // Lo censal y la salud nunca se piden al reservar.
    expect(validateRegistrationAnswers(saved, { ...answers, demographics: { ...answers.demographics, occupation: "Abogada" } }, booking)).toHaveProperty("demographics.occupation")
    expect(validateRegistrationAnswers(saved, { ...answers, health: adult.health }, booking)).toHaveProperty("health")
  })
  it("el teléfono de quien habla por la persona cuenta como suyo, en el registro y en lo que falta de su ficha", () => {
    const saved = { ...config, version: 1 }
    const child: RegistrationAnswers = { demographics: { displayName: "Mateo Quispe", givenNames: "Mateo", familyName: "Quispe", birthDate: "2020-03-01" }, respondent: "staff", privacyAccepted: false,
      representative: { displayName: "Rosa Quispe", relationship: "guardian", relationshipDetail: "Madre", phone: "+51987654301", docType: "DNI", docNumber: "45678901" } }
    expect(pendingRegistrationFields(saved, child).map((field) => field.key)).not.toContain("phone")
    expect(missingPersonData(saved, child.demographics, { representativeContact: true }).map((field) => field.key)).not.toContain("phone")
    expect(missingPersonData(saved, child.demographics, { representativeContact: false }).map((field) => field.key)).toContain("phone")
    // Lo demás que la clínica pide sigue faltando, y el nombre nunca falta.
    const withDocument = { ...saved, fields: { ...saved.fields, docType: "required" as const, docNumber: "required" as const } }
    expect(missingPersonData(withDocument, child.demographics, { representativeContact: true }).map((field) => field.key)).toEqual(["docType", "docNumber"])
  })
  it("el aviso cuenta siempre lo necesario para atender y nunca los datos censales", () => {
    // La clínica no puede volver obligatorio el estado civil, la ocupación ni la procedencia.
    for (const key of ["maritalStatus", "educationLevel", "occupation", "referralSource", "origin"] as const)
      expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, [key]: "required" } }).success).toBe(false)
    expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, occupation: "optional" } }).success).toBe(true)
    // Nombre, nacimiento y un teléfono o correo se piden siempre.
    expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, birthDate: "optional" } }).success).toBe(false)
    expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, phone: "hidden" } }).success).toBe(false)
    // Sin apellidos separados, sin nacimiento y sin teléfono ni correo: falta lo necesario.
    expect(missingPersonData(config, { displayName: "Lucía" }, { representativeContact: false }).map((field) => field.key))
      .toEqual(["givenNames", "familyName", "birthDate", "phone"])
    // El correo basta como medio de contacto, aunque falte el teléfono.
    expect(missingPersonData(config, { givenNames: "Lucía", familyName: "Fernández", birthDate: "1995-07-30", email: "lucia@example.com" }, { representativeContact: false })).toEqual([])
  })
  it("un documento se lee con la etiqueta del catálogo, nunca con su código", () => {
    expect(documentText("PASAPORTE", "AB1234567")).toBe("Pasaporte AB1234567")
    expect(documentText("CE", "001234567")).toBe("Carné de extranjería 001234567")
    expect(documentText("DNI", "12345678")).toBe("DNI 12345678")
    expect(documentText("NACIONAL", "12.345.678-5")).toBe("Documento nacional 12.345.678-5")
    expect(documentText(null, "12345678")).toBe("12345678")
    // Los tributarios también; lo escrito a mano antes de la lista, tal cual.
    expect(documentText("RUC", "20123456789")).toBe("RUC 20123456789")
    expect(documentText("TRIBUTARIO", "900123456")).toBe("Documento tributario 900123456")
    expect(documentText("NIT", "900123456")).toBe("NIT 900123456")
    expect(documentTypeLabel("toString")).toBe("toString")
  })
  it("los errores del documento dicen qué arreglar", () => {
    expect(identityDocumentError("DNI", "456789")).toBe("El DNI tiene 8 números; faltan 2")
    expect(identityDocumentError("DNI", "456789011")).toBe("El DNI tiene 8 números; sobra 1")
    expect(identityDocumentError("DNI", "4567890A")).toBe("El DNI solo lleva números")
    expect(identityDocumentError("NACIONAL", "12.345.678-5")).toBeNull()
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
  it("publica únicamente con aviso; el documento funciona como pareja", () => {
    expect(registrationConfigSchema.safeParse(config).success).toBe(true)
    expect(registrationConfigSchema.safeParse({ ...config, privacyNotice: " " }).success).toBe(false)
    expect(registrationConfigSchema.safeParse({ ...config, fields: { ...config.fields, docType: "hidden" } }).success).toBe(false)
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "DNI", docNumber: "123" } }, publicContext)).toHaveProperty("demographics.docNumber")
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "PASAPORTE", docNumber: "ABC123", docCountry: "VE" } }, publicContext)).toEqual({})
    // Un documento extranjero no lo emite el país de la clínica: hay que elegir su país.
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "DIE", docNumber: "ABC123" } }, publicContext)).toHaveProperty("demographics.docCountry")
    expect(validateRegistrationAnswers(config, { ...adult, demographics: { ...adult.demographics, docType: "DIE", docNumber: "ABC123", docCountry: "PE" } }, publicContext)).toHaveProperty("demographics.docCountry")
  })
})

it("nombres y apellidos van juntos en un paciente; quien aún no lo es puede tener lo que se sepa", () => {
  const onlyGiven = { displayName: "Carla", givenNames: "Carla" }
  const onlyFamily = { displayName: "Quispe", familyName: "Quispe" }
  expect(validateDemographics(onlyGiven)).toMatchObject({ familyName: "Escribe los apellidos" })
  expect(validateDemographics(onlyFamily)).toMatchObject({ givenNames: "Escribe los nombres" })
  expect(validateDemographics(onlyGiven, undefined, undefined, undefined, { partialName: true })).toEqual({})
  expect(validateDemographics(onlyFamily, undefined, undefined, undefined, { partialName: true })).toEqual({})
})

it("el parentesco escrito a mano se lee como su código HL7, y lo ambiguo queda sin código", () => {
  expect(kinshipFromWords("Madre")).toBe("MTH")
  expect(kinshipFromWords(" mamá ")).toBe("MTH")
  expect(kinshipFromWords("PADRE.")).toBe("FTH")
  expect(kinshipFromWords("Abuela paterna")).toBe("PGRPRN")
  expect(kinshipFromWords("Tía")).toBe("AUNT")
  expect(kinshipFromWords("abuela")).toBeNull()
  expect(kinshipFromWords("Tutor legal")).toBeNull()
  expect(kinshipFromWords("")).toBeNull()
})

describe("lo de cada país en los datos de la persona", () => {
  const chile = clinicalProfileFor("CL")
  const peru = clinicalProfileFor("PE")
  it("los documentos, seguros y regiones de Perú solo valen en clínicas de Perú", () => {
    expect(validateDemographics({ displayName: "Andrea", docType: "DNI", docNumber: "45678904" }, undefined, "CL")).toHaveProperty("docType")
    expect(validateDemographics({ displayName: "Andrea", docType: "NACIONAL", docNumber: "12.345.678-5" }, undefined, "CL")).toEqual({})
    expect(validateDemographics({ displayName: "Lucía", docType: "NACIONAL", docNumber: "45678904" }, undefined, "PE")).toHaveProperty("docType")
    expect(validateDemographics({ displayName: "Andrea", insuranceType: "PUBLICO", insuranceScheme: "SIS" }, undefined, "CL")).toHaveProperty("insuranceScheme")
    expect(validateDemographics({ displayName: "Lucía", insuranceScheme: "EPS" }, undefined, "PE")).toEqual({})
    // En Perú el departamento se elige de la lista; fuera, la región se escribe.
    expect(validateDemographics({ displayName: "Lucía", addressRegion: "Lima" }, undefined, "PE")).toHaveProperty("addressRegion")
    expect(validateDemographics({ displayName: "Lucía", addressRegion: "PE-LMA" }, undefined, "PE")).toEqual({})
    expect(validateDemographics({ displayName: "Andrea", addressRegion: "Región Metropolitana" }, undefined, "CL")).toEqual({})
  })
  it("lo ya guardado conserva su norma aunque la clínica cambie de país", () => {
    const stored = { displayName: "Lucía", docType: "DNI", docNumber: "45678904", docCountry: "PE" }
    expect(validateDemographics({ ...stored, phone: "+56912345678" }, undefined, "CL", stored)).toEqual({})
    expect(validateDemographics({ ...stored, docNumber: "45678905" }, undefined, "CL", stored)).toEqual({})
  })
  it("el documento toma su país emisor y el seguro su tipo general", () => {
    expect(normalizePersonData({ docType: "DNI", docNumber: "45678904" }, peru).docCountry).toBe("PE")
    expect(normalizePersonData({ docType: "NACIONAL", docNumber: "12.345.678-5" }, chile).docCountry).toBe("CL")
    expect(normalizePersonData({ docType: "PASAPORTE", docNumber: "AB123456", docCountry: "ar" }, chile).docCountry).toBe("AR")
    expect(normalizePersonData({ docType: "DIE", docNumber: "AB123456" }, peru).docCountry).toBeNull()
    // El pasaporte no supone el país de la clínica.
    expect(normalizePersonData({ docType: "PASAPORTE", docNumber: "AB123456" }, chile).docCountry).toBeNull()
    expect(normalizePersonData({ insuranceScheme: "ESSALUD" }, peru).insuranceType).toBe("PUBLICO")
    expect(normalizePersonData({ insuranceScheme: "EPS" }, peru).insuranceType).toBe("PRIVADO")
    expect(normalizePersonData({ address: "Av. Providencia 1234" }, chile).addressCountry).toBe("CL")
  })
  it("a un proveedor se le ofrecen los documentos tributarios del país, los de persona que sirven a quien vende y «Otro»", () => {
    expect(peru.taxDocumentTypes).toEqual(["RUC"])
    // Ni el certificado de nacido vivo ni el documento extranjero identifican a quien vende.
    expect(supplierDocumentTypes(peru)).toEqual(["RUC", "DNI", "CE", "PASAPORTE", "OTRO"])
    // Sin perfil propio, el núcleo: un documento tributario genérico, nunca el RUC.
    expect(supplierDocumentTypes(chile)).toEqual(["TRIBUTARIO", "NACIONAL", "PASAPORTE", "OTRO"])
    expect(supplierDocumentTypes(clinicalProfileFor(null))).toEqual(["TRIBUTARIO", "NACIONAL", "PASAPORTE", "OTRO"])
  })
  it("fuera de Perú el registro no pregunta la procedencia", () => {
    const asksOrigin = { ...config, fields: { ...config.fields, origin: "optional" as const } }
    expect(validateRegistrationAnswers(asksOrigin, { ...adult, demographics: { ...adult.demographics, origin: "Arequipa" } }, publicContext)).toEqual({})
    expect(validateRegistrationAnswers(asksOrigin, { ...adult, demographics: { ...adult.demographics, phone: "+56912345678", origin: "Arequipa" } }, { ...publicContext, countryCode: "CL" })).toHaveProperty("demographics.origin")
  })
})

describe("«Tu boca» es del producto dental (ADR 0079)", () => {
  const asksBoca = {
    ...DEFAULT_REGISTRATION_CONFIG,
    fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, "dental.bruxismo": "optional" as const },
  }
  it("una clínica dental la pregunta si la pide; una médica nunca", () => {
    expect(registrationFieldAsked(asksBoca, "dental.bruxismo", "PE")).toBe(true)
    expect(registrationFieldAsked(asksBoca, "dental.bruxismo", "PE", "dental")).toBe(true)
    expect(registrationFieldAsked(asksBoca, "dental.bruxismo", "PE", "medical")).toBe(false)
    // Lo común se pregunta igual en los dos productos.
    expect(registrationFieldAsked(asksBoca, "allergies", "PE", "medical")).toBe(true)
  })
})
