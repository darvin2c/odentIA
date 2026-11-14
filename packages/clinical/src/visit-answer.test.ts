import { describe, expect, it } from "vitest"
import {
  DEFAULT_REGISTRATION_CONFIG,
  newRegistrationQuestions,
  OPTIONAL_ONLY_REGISTRATION_FIELDS,
  registrationConfigSchema,
  validateRegistrationAnswers,
} from "./patient-registration.js"
import { visitAnswerLine, visitAnswerSchema, visitQuestionsOf, visitReasonForEncounter } from "./visit-answer.js"

describe("antes de cada cita (mesa del 13 nov, entrega 8)", () => {
  it("una clínica nueva pregunta lo de la visita como opcional, y nunca es obligatorio", () => {
    expect(DEFAULT_REGISTRATION_CONFIG.fields["visit.reason"]).toBe("optional")
    expect(DEFAULT_REGISTRATION_CONFIG.fields["visit.pain"]).toBe("optional")
    expect(OPTIONAL_ONLY_REGISTRATION_FIELDS).toEqual(expect.arrayContaining(["visit.reason", "visit.pain", "visit.more"]))
    const required = { ...DEFAULT_REGISTRATION_CONFIG, fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, "visit.pain": "required" as const } }
    expect(registrationConfigSchema.safeParse(required).success).toBe(false)
    // A quien administra una clínica que ya existía se le avisa: son preguntas nuevas.
    expect(newRegistrationQuestions(3).map((item) => item.key)).toEqual(["visit.reason", "visit.pain", "visit.more"])
  })

  it("en una sesión o un control se le dice a qué viene y solo se le pregunta si le duele", () => {
    expect(visitQuestionsOf(DEFAULT_REGISTRATION_CONFIG, null)).toEqual({ reason: true, pain: true, more: true })
    expect(visitQuestionsOf(DEFAULT_REGISTRATION_CONFIG, "sesión 2 de endodoncia")).toEqual({ reason: false, pain: true, more: false })
    const hidden = { fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, "visit.pain": "hidden" as const } }
    expect(visitQuestionsOf(hidden, "sesión 2 de endodoncia")).toEqual({ reason: false, pain: false, more: false })
  })

  it("cuánto le duele va solo con «Sí, me duele», de 0 a 10", () => {
    expect(visitAnswerSchema.safeParse({ pain: "si", painLevel: 8 }).success).toBe(true)
    expect(visitAnswerSchema.safeParse({ pain: "no", painLevel: 3 }).success).toBe(false)
    expect(visitAnswerSchema.safeParse({ pain: "si", painLevel: 11 }).success).toBe(false)
    expect(visitAnswerSchema.safeParse({}).success).toBe(true)
  })

  it("lo que contó se lee igual en todas partes, y como motivo van sus palabras", () => {
    const marta = { reason: "Me duele la muela de abajo", pain: "si" as const, painLevel: 8, more: null, toldPurpose: null }
    expect(visitAnswerLine(marta)).toBe("«Me duele la muela de abajo» · dolor ahora: 8 de 10")
    expect(visitReasonForEncounter(marta)).toBe("Me duele la muela de abajo")
    const session = { reason: null, pain: "no" as const, painLevel: null, more: null, toldPurpose: "sesión 2 de endodoncia" }
    expect(visitAnswerLine(session)).toBe("Vino a: sesión 2 de endodoncia · sin dolor")
    expect(visitReasonForEncounter(session)).toBeNull()
  })

  it("el registro no pide lo de la visita", () => {
    const errors = validateRegistrationAnswers(
      DEFAULT_REGISTRATION_CONFIG,
      {
        demographics: { displayName: "Marta Ríos", givenNames: "Marta", familyName: "Ríos", birthDate: "1960-03-04", phone: "987654321" },
        respondent: "patient",
        privacyAccepted: true,
        health: { allergies: { state: "none", items: [] }, conditions: { state: "none", items: [] }, medications: { state: "none", items: [] } },
      },
      { mode: "public", today: "2026-11-14", countryCode: "PE" },
    )
    expect(Object.keys(errors).filter((key) => key.includes("visit"))).toEqual([])
  })
})
