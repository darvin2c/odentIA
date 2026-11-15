import { describe, expect, it } from "vitest"
import { suggestedDentition } from "./dentition"

describe("dentición sugerida por edad", () => {
  const today = "2026-10-07"
  it("temporal hasta 5, mixta de 6 a 12 y permanente desde 13", () => {
    expect(suggestedDentition("2022-01-01", today)).toBe("primary")
    expect(suggestedDentition("2018-03-01", today)).toBe("mixed")
    expect(suggestedDentition("2014-01-01", today)).toBe("mixed")
    expect(suggestedDentition("2013-01-01", today)).toBe("adult")
    expect(suggestedDentition("1972-05-20", today)).toBe("adult")
  })
  it("no supone edad sin una fecha válida", () => {
    expect(suggestedDentition(null, today)).toBeNull()
    expect(suggestedDentition("no-es-fecha", today)).toBeNull()
    expect(suggestedDentition("2030-01-01", today)).toBeNull()
  })
})

// QA de formularios del 15 nov (K13): con la fecha leída como medianoche UTC, en Lima
// el niño pasaba a la dentición permanente un día antes. Se cuenta con el día de la clínica.
describe("dentición con el día de la clínica", () => {
  it("la víspera de cumplir 13 sigue mixta; ese día, permanente", () => {
    expect(suggestedDentition("2013-11-15", "2026-11-14")).toBe("mixed")
    expect(suggestedDentition("2013-11-15", "2026-11-15")).toBe("adult")
  })
})
