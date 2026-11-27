import { vitalsWarnings } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { prepareDictatedVitals } from "./dictation-vitals.js"

const ALL = ["presionSistolica", "presionDiastolica", "temperatura", "glucosaCapilar", "peso"] as const

// QA del 26 nov (desarrollo, H10): tecleado, «Aviso: … fuera de lo habitual … revísalo» y se guarda;
// dictado, «Glucosa fuera de rango (20–600 mg/dL). Corrígelo o dilo de nuevo.»: pedía corregir un valor real.
describe("lo dictado fuera de lo habitual avisa igual que lo tecleado", () => {
  it("la glucosa de 650 y la temperatura de 29 dicen el mismo aviso y conservan el valor", () => {
    for (const said of [{ glucosaCapilar: 650 }, { temperatura: 29 }]) {
      const prepared = prepareDictatedVitals(said, ALL, 40)
      expect(prepared.payload).toEqual(said)
      expect(prepared.note).toBe(Object.values(vitalsWarnings(said, ALL)).join(" "))
      expect(prepared.note).toMatch(/^Aviso: .* fuera de lo habitual .*: revísalo\.$/)
      expect(prepared.note).not.toContain("Corrígelo")
    }
  })

  it("la presión a medias también: se guarda la que se dijo, con su aviso", () => {
    const prepared = prepareDictatedVitals({ presionSistolica: 150 }, ALL, 40)
    expect(prepared.payload).toEqual({ presionSistolica: 150 })
    expect(prepared.note).toBe("Aviso: falta la diastólica. Se guarda la sistólica sola.")
  })

  it("lo habitual va listo, y lo que no es una medida pide decirlo de nuevo", () => {
    expect(prepareDictatedVitals({ presionSistolica: 118, presionDiastolica: 76 }, ALL, 40)).toMatchObject({ status: "lista", note: null })
    expect(prepareDictatedVitals({ temperatura: 0 }, ALL, 40).note).toContain("Corrígelo o dilo de nuevo")
  })
})
