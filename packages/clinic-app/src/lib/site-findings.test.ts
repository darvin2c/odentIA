import { describe, expect, it } from "vitest"
import { groupFindings } from "./site-findings"

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
