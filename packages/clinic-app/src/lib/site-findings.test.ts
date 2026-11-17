import { describe, expect, it } from "vitest"
import { findingsOfEncounter, groupFindings } from "./site-findings"

const at = "2026-11-08T22:15:00.000Z"
const finding = (id: string, surface: string | null, createdAt = at, condition = "caries") => ({
  id,
  toothNumber: 46,
  surface,
  condition,
  status: "pendiente",
  diagnosisCode: "K04.0",
  createdAt,
})

// QA del 16 nov, Q14: el hallazgo recién registrado y su «Anular» quedaban dentro del pliegue de la
// historia. Lo de esta atención se muestra aparte, arriba.
describe("lo registrado en esta atención", () => {
  it("solo lo de esta atención, cada hallazgo con sus caras; lo de antes no", () => {
    const entries = [
      { ...finding("a", "distal"), encounterId: "hoy" },
      { ...finding("b", "occlusal"), encounterId: "hoy" },
      { ...finding("c", "mesial", "2026-05-02T15:00:00.000Z"), encounterId: "mayo" },
      { ...finding("d", null, "2025-01-10T15:00:00.000Z", "fractura"), encounterId: null },
    ]
    expect(findingsOfEncounter(entries, "hoy").map((group) => [group.ids, group.surfaces])).toEqual([
      [["a", "b"], ["distal", "occlusal"]],
    ])
    // Fuera de una atención (la ficha) no hay nada que anular.
    expect(findingsOfEncounter(entries, undefined)).toEqual([])
  })
})

describe("un hallazgo de varias caras es uno solo", () => {
  it("junta las caras de un mismo registro (QA del 8 nov: una caries DO contaba 2)", () => {
    const groups = groupFindings([finding("a", "distal"), finding("b", "occlusal")])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ ids: ["a", "b"], surfaces: ["distal", "occlusal"] })
  })

  it("lo registrado en otro momento o con otra condición sigue aparte", () => {
    const groups = groupFindings([
      finding("a", "distal"),
      finding("b", "mesial", "2026-11-08T22:20:00.000Z"),
      finding("c", null, at, "fractura"),
    ])
    expect(groups.map((group) => group.ids)).toEqual([["a"], ["b"], ["c"]])
  })
})
