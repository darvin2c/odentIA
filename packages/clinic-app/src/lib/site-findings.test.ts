import { describe, expect, it } from "vitest"
import { findingsOfEncounter, groupFindings, toothCorrectedAway } from "./site-findings"

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

// QA del 16 nov, Q15: la caries de la 38 era de la 37; anulada, «Indicar un tratamiento» seguía
// trayendo la 38.
describe("la pieza que se corrigió no es la de partida al indicar", () => {
  const on = (id: string, toothNumber: number, voidedAt: string | null) => ({ ...finding(id, "occlusal"), toothNumber, voidedAt })

  it("con todo lo suyo de esta atención anulado, la pieza se corrigió", () => {
    expect(toothCorrectedAway([on("a", 38, at), on("b", 37, null)], 38)).toBe(true)
  })

  it("si le queda un hallazgo vigente, o nunca se le registró nada aquí, no", () => {
    const entries = [on("a", 38, at), on("b", 38, null), on("c", 37, null)]
    expect(toothCorrectedAway(entries, 38)).toBe(false)
    expect(toothCorrectedAway(entries, 37)).toBe(false)
    // La pieza abierta sin nada registrado (indicar una corona directo) se sigue trayendo.
    expect(toothCorrectedAway(entries, 36)).toBe(false)
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
