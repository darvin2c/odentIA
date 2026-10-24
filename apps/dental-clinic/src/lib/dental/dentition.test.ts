import { describe, expect, it } from "vitest"
import { suggestedDentition } from "./dentition"

describe("dentición sugerida por edad", () => {
  const today = new Date("2026-10-07T12:00:00Z")
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
