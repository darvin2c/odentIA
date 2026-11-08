import { describe, expect, it } from "vitest"
import {
  type Allergy,
  type Condition,
  isHealthReviewPending,
  type Medication,
  type PatientHealth,
  unaskedHealthGroups,
} from "./patients"

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

const TODAY = "2026-11-08"

// QA del 8 nov (A2): antes de anestesiar, nada pedía sus enfermedades ni su medicación.
describe("enfermedades y medicación que nunca se le preguntaron", () => {
  it("faltan las dos mientras sigan «no preguntado» y sin filas vigentes", () => {
    expect(unaskedHealthGroups(empty, TODAY)).toEqual(["conditions", "medications"])
  })
  it("«niega» o una fila vigente ya dicen algo; lo resuelto o terminado no", () => {
    expect(unaskedHealthGroups({ ...empty, reviewStatus: { ...empty.reviewStatus, conditions: "none" } }, TODAY)).toEqual([
      "medications",
    ])
    const condition = { id: "c1", name: "Hipertensión", status: "activa" } as Condition
    const medication = { id: "m1", name: "Warfarina" } as Medication
    expect(unaskedHealthGroups({ ...empty, conditions: [condition], medications: [medication] }, TODAY)).toEqual([])
    expect(
      unaskedHealthGroups({
        ...empty,
        conditions: [{ ...condition, status: "resuelta" }],
        medications: [{ ...medication, endDate: "2026-01-01" }],
      }, TODAY),
    ).toEqual(["conditions", "medications"])
    // La que termina más adelante la sigue tomando, como en la receta.
    expect(unaskedHealthGroups({ ...empty, medications: [{ ...medication, endDate: "2026-12-31" }] }, TODAY)).toEqual([
      "conditions",
    ])
  })
})
