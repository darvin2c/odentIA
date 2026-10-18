import { describe, expect, it } from "vitest"
import { awayText } from "./home-away"

describe("mientras no estabas", () => {
  it("nombra solo lo que pasó, con singular y plural", () => {
    expect(awayText({ since: "", appointments: 6, recovered: 2, cases: 1 })).toBe(
      "Mientras no estabas, tus agentes agendaron 6 citas, trajeron de vuelta a 2 pacientes y te dejaron 1 caso.",
    )
    expect(awayText({ since: "", appointments: 1, recovered: 0, cases: null })).toBe(
      "Mientras no estabas, tus agentes agendaron 1 cita.",
    )
    expect(awayText({ since: "", appointments: null, recovered: null, cases: 3 })).toBe(
      "Mientras no estabas, tus agentes te dejaron 3 casos.",
    )
  })
})
