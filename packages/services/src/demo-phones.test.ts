import { describe, expect, it } from "vitest"
import { demoFictionPhones } from "./demo-build.js"

// Las semillas dejan libre +44 7700 900800–900999 para lo que crea la QA (QA del 10 nov, D1).
const SEED_RANGE = /^447700900[0-7]\d\d$/

describe("teléfonos de ficción de la demo", () => {
  it("usa solo de +44 7700 900000 a 900799, sin repetir, y deja libre el tramo de la QA", () => {
    const { clinic, writers } = demoFictionPhones()
    const all = [clinic, ...writers]
    expect(all.filter((phone) => !SEED_RANGE.test(phone))).toEqual([])
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(800)
    expect(writers[0]).toBe("447700900000")
    expect(clinic).toBe("447700900799")
  })
})
