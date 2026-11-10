import { describe, expect, it } from "vitest"
import type { Random } from "../seed-reports.js"
import { DENTAL_DEMO_KINDS } from "./demo-kinds.js"

/** Elige siempre el primero, o el último: alcanza para ver todas las piezas posibles. */
function pickAt(at: "first" | "last"): Random {
  return { pick: <T>(list: readonly T[]) => (at === "first" ? list[0] : list[list.length - 1]) } as unknown as Random
}

const general = DENTAL_DEMO_KINDS.find((kind) => kind.key === "general")!
const MOLARS = /pieza [1-4]\.[678]\b/
const ANTERIORS = /pieza [1-4]\.[123]\b/

describe("la demo de clínica general (QA del 8 nov)", () => {
  it("trae la endodoncia de molar, no solo la anterior", () => {
    const templates = general.services.map((service) => service.template)
    expect(templates).toContain("endodoncia-posterior-vital")
    expect(templates).toContain("endodoncia-anterior-vital")
  })
  it("la historia pone cada endodoncia en una pieza que le corresponde", () => {
    for (const at of ["first", "last"] as const) {
      const anterior = general.note!({ name: "Endodoncia anterior vital" } as never, pickAt(at), null, new Date())
      const posterior = general.note!({ name: "Endodoncia posterior vital" } as never, pickAt(at), null, new Date())
      expect(anterior.evolution).toMatch(ANTERIORS)
      expect(posterior.evolution).toMatch(MOLARS)
    }
  })
})
