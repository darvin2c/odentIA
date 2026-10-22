import { describe, expect, it } from "vitest"
import { ALLERGY_SEVERITIES, CONDITION_STATUSES } from "./catalogs.js"
import {
  ALLERGY_CATEGORY_FHIR,
  ALLERGY_CRITICALITY_FHIR,
  ALLERGY_SEVERITY_FHIR,
  ALLERGY_TYPE_FHIR,
  ALLERGY_VERIFICATION_FHIR,
  APPOINTMENT_STATUS_FHIR,
  CONDITION_CLINICAL_STATUS_FHIR,
  CONSENT_STATUS_FHIR,
  ENCOUNTER_STATUS_FHIR,
  fhirCode,
  PRESCRIPTION_STATUS_FHIR,
  SEX_TO_FHIR_GENDER,
} from "./fhir.js"
import { SEX_CODES } from "./identity.js"

// Los value sets de HL7 FHIR R4 (4.0.1) a los que se traduce.
const R4 = {
  gender: ["male", "female", "other", "unknown"],
  encounter: ["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled", "entered-in-error", "unknown"],
  appointment: ["proposed", "pending", "booked", "arrived", "fulfilled", "cancelled", "noshow", "entered-in-error", "checked-in", "waitlist"],
  conditionClinical: ["active", "recurrence", "relapse", "inactive", "remission", "resolved"],
  allergyType: ["allergy", "intolerance"],
  allergyCriticality: ["low", "high", "unable-to-assess"],
  allergyVerification: ["unconfirmed", "confirmed", "refuted", "entered-in-error"],
  allergyCategory: ["food", "medication", "environment", "biologic"],
  severity: ["mild", "moderate", "severe"],
  medicationRequest: ["active", "on-hold", "cancelled", "completed", "entered-in-error", "stopped", "draft", "unknown"],
  consent: ["draft", "proposed", "active", "rejected", "inactive", "entered-in-error"],
}

describe("equivalencias con FHIR R4 (issue 45)", () => {
  it("cada código propio de las listas cerradas tiene su equivalencia", () => {
    for (const sex of SEX_CODES) expect(SEX_TO_FHIR_GENDER[sex]).toBeDefined()
    for (const status of CONDITION_STATUSES) expect(fhirCode(CONDITION_CLINICAL_STATUS_FHIR, status)).not.toBeNull()
    for (const s of ["borrador", "finalizada", "anulada"]) expect(fhirCode(ENCOUNTER_STATUS_FHIR, s)).not.toBeNull()
    for (const s of ["programada", "confirmada", "atendida", "no_asistio", "cancelada"])
      expect(fhirCode(APPOINTMENT_STATUS_FHIR, s)).not.toBeNull()
    for (const s of ["pendiente", "firmado", "revocado", "anulado"]) expect(fhirCode(CONSENT_STATUS_FHIR, s)).not.toBeNull()
    for (const s of ["emitida", "anulada"]) expect(fhirCode(PRESCRIPTION_STATUS_FHIR, s)).not.toBeNull()
  })

  it("todo lo que se traduce es un código válido de R4", () => {
    const within = (table: Record<string, string>, set: string[]) => {
      for (const code of Object.values(table)) expect(set).toContain(code)
    }
    within(SEX_TO_FHIR_GENDER, R4.gender)
    within(ENCOUNTER_STATUS_FHIR, R4.encounter)
    within(APPOINTMENT_STATUS_FHIR, R4.appointment)
    within(CONDITION_CLINICAL_STATUS_FHIR, R4.conditionClinical)
    within(ALLERGY_TYPE_FHIR, R4.allergyType)
    within(ALLERGY_CRITICALITY_FHIR, R4.allergyCriticality)
    within(ALLERGY_VERIFICATION_FHIR, R4.allergyVerification)
    within(ALLERGY_CATEGORY_FHIR, R4.allergyCategory)
    within(ALLERGY_SEVERITY_FHIR, R4.severity)
    within(PRESCRIPTION_STATUS_FHIR, R4.medicationRequest)
    within(CONSENT_STATUS_FHIR, R4.consent)
  })

  it("lo que no tiene equivalencia segura no se inventa", () => {
    // «desconocida» y las categorías propias (material, otro) van como texto.
    expect(ALLERGY_SEVERITIES).toContain("desconocida")
    expect(fhirCode(ALLERGY_SEVERITY_FHIR, "desconocida")).toBeNull()
    expect(fhirCode(ALLERGY_CATEGORY_FHIR, "material")).toBeNull()
    expect(fhirCode(ALLERGY_CATEGORY_FHIR, null)).toBeNull()
  })
})
