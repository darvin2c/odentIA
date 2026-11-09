import { describe, expect, it } from "vitest"
import {
  defaultValidUntil,
  lensesFromExam,
  lensText,
  parsePrescriptionLenses,
  prescriptionNotices,
} from "./lens-prescription.js"

describe("la receta de lentes", () => {
  it("de anteojos: la refracción de cada ojo, sin datos de lentes de contacto", () => {
    expect(parsePrescriptionLenses("anteojos", { od: { esfera: -2, cilindro: -0.5, eje: 10 }, oi: { esfera: -1.75 } })).toEqual({
      ok: true,
      value: { od: { esfera: -2, cilindro: -0.5, eje: 10 }, oi: { esfera: -1.75 } },
    })
    expect(parsePrescriptionLenses("anteojos", { od: { esfera: -2, curvaBase: 8.6 } })).toMatchObject({ ok: false, path: "lentes.od" })
  })

  it("de lentes de contacto: con su curva base, su diámetro y su marca", () => {
    expect(
      parsePrescriptionLenses("contacto", { od: { esfera: -2.25, curvaBase: 8.6, diametro: 14.2, marca: " Acuvue Oasys " } }),
    ).toEqual({ ok: true, value: { od: { esfera: -2.25, curvaBase: 8.6, diametro: 14.2, marca: "Acuvue Oasys" } } })
    expect(parsePrescriptionLenses("contacto", { od: { esfera: -2, curvaBase: 6.5 } })).toMatchObject({ ok: false, path: "lentes.od.curvaBase" })
    expect(parsePrescriptionLenses("contacto", { od: { esfera: -2, diametro: 14.25 } })).toMatchObject({ ok: false, path: "lentes.od.diametro" })
  })

  it("sin ningún ojo graduado no hay receta", () => {
    expect(parsePrescriptionLenses("anteojos", {})).toMatchObject({ ok: false, path: "lentes" })
    expect(parsePrescriptionLenses("anteojos", { od: {} })).toMatchObject({ ok: false, path: "lentes" })
  })

  it("la del examen es su refracción tal cual", () => {
    expect(lensesFromExam({ od: { esfera: -1, adicion: 2 } })).toEqual({ od: { esfera: -1, adicion: 2 } })
    expect(lensesFromExam(undefined)).toBeNull()
  })

  it("se lee en una línea por ojo", () => {
    expect(lensText({ esfera: -2.25, curvaBase: 8.6, diametro: 14.2, marca: "Acuvue" })).toBe("−2,25 · CB 8,6 · Ø 14,2 · Acuvue")
  })

  it("vale un año, y el 29 de febrero pasa al último día del mes", () => {
    expect(defaultValidUntil("2026-11-08")).toBe("2027-11-08")
    expect(defaultValidUntil("2028-02-29")).toBe("2029-02-28")
  })

  it("vencida o sin verificar se avisa, no se impide", () => {
    expect(prescriptionNotices({ source: "examen", verifiedAt: "2026-01-01", validUntil: "2027-01-01" }, "2026-11-08")).toEqual([])
    expect(prescriptionNotices({ source: "externa", verifiedAt: null, validUntil: "2026-10-01" }, "2026-11-08")).toEqual([
      "Venció el 01/10/2026: conviene un examen nuevo.",
      "Transcrita, sin verificar: un optómetra todavía no la revisó.",
    ])
  })
})
