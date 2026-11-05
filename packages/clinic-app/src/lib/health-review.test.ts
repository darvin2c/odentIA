import { describe, expect, it } from "vitest"
import { type Allergy, isHealthReviewPending, type PatientHealth } from "./patients"

const empty: PatientHealth = {
  revision: 0,
  reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
  allergies: [],
  conditions: [],
  medications: [],
  bloodGroup: null,
  reviewedAt: null,
  reviewedBy: null,
  latestAnamnesis: null,
}
const allergy = { id: "a1", allergen: "Penicilina" } as unknown as Allergy

describe("«Declarado por el paciente · pendiente de revisión»", () => {
  it("una alergia que agregó el equipo no deja nada pendiente ni se dice declarada", () => {
    const byTeam: PatientHealth = {
      ...empty,
      revision: 1,
      allergies: [allergy],
      reviewStatus: { ...empty.reviewStatus, allergies: "recorded" },
      allergiesReviewedAt: "2026-11-05T10:00:00Z",
    }
    expect(isHealthReviewPending(byTeam)).toBe(false)
  })

  it("lo que declaró la persona y nadie revisó sí queda pendiente", () => {
    const declared: PatientHealth = { ...empty, revision: 1, allergies: [allergy], reviewStatus: { ...empty.reviewStatus, allergies: "recorded" } }
    expect(isHealthReviewPending(declared)).toBe(true)
    // Con las alergias revisadas, lo demás que declaró sigue esperando.
    const withConditions: PatientHealth = {
      ...declared,
      allergiesReviewedAt: "2026-11-05T10:00:00Z",
      reviewStatus: { ...declared.reviewStatus, conditions: "recorded" },
    }
    expect(isHealthReviewPending(withConditions)).toBe(true)
    expect(isHealthReviewPending({ ...withConditions, reviewedAt: "2026-11-05T11:00:00Z" })).toBe(false)
  })

  it("sin nada registrado no hay nada que revisar", () => {
    expect(isHealthReviewPending(empty)).toBe(false)
  })
})
