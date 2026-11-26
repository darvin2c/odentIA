import { describe, expect, it } from "vitest"
import { localAnesthesiaWords } from "./local-anesthesia.js"
import { formatVitals, weightForAgeAlert } from "./vitals.js"

describe("el peso imposible para su edad (mesa del 25 nov, entrega 3)", () => {
  it("«230 kg» a los 7 años avisa; 23 kg no; sin edad no se supone", () => {
    expect(weightForAgeAlert(230, 7)).toBe("230 kg no es un peso posible a los 7 años: revísalo antes de usarlo.")
    expect(weightForAgeAlert(23, 7)).toBeNull()
    expect(weightForAgeAlert(2, 7)).toContain("no es un peso posible")
    expect(weightForAgeAlert(230, null)).toBeNull()
    // Desde los 18 vale el rango de siempre.
    expect(weightForAgeAlert(150, 40)).toBeNull()
  })

  it("la anestesia no da una dosis con un peso imposible: lo avisa", () => {
    const words = localAnesthesiaWords({ weightKg: 230, anesthetic: "lidocaina-2-epinefrina", ageYears: 7, epinephrine: null })
    expect(words.dose).toBeNull()
    expect(words.warnings).toContain("230 kg no es un peso posible a los 7 años: revísalo antes de usarlo.")
    expect(localAnesthesiaWords({ weightKg: 23, anesthetic: "lidocaina-2-epinefrina", ageYears: 7, epinephrine: null }).dose).toContain("23 kg")
  })
})

describe("revisión del 25 nov", () => {
  it("no confunde a un niño con obesidad grave con un error; dice «con 1 año»", () => {
    expect(weightForAgeAlert(140, 13)).toBeNull()
    expect(weightForAgeAlert(210, 16)).toBeNull()
    expect(weightForAgeAlert(150, 1)).toBe("150 kg no es un peso posible con 1 año: revísalo antes de usarlo.")
  })
  it("la presión con un solo número dice cuál falta", () => {
    expect(formatVitals({ presionSistolica: 160 })).toBe("PA 160/? mmHg")
  })
})
