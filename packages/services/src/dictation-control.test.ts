import { describe, expect, it } from "vitest"
import { controlByAge } from "./dictation-control.js"

/**
 * «Su próximo control a los dos años» en un niño de 18 meses es cuando cumpla dos años, no dentro de
 * dos años (revisión del 26 nov). Es una propuesta: el profesional la ve y la cambia.
 */
describe("el control dicho por su edad", () => {
  const toddler = { birthDate: "2025-05-14", today: "2026-11-26" }

  it("«a los dos años» de un niño de 18 meses es cuando cumpla dos años", () => {
    expect(controlByAge("su próximo control a los dos años", toddler)).toEqual({
      dueAt: "2027-05-14T12:00:00.000Z",
      day: "2027-05-14",
      said: "a los dos años",
      age: "2 años",
    })
    expect(controlByAge("que vuelva cuando cumpla 3 años", toddler)?.day).toBe("2028-05-14")
    expect(controlByAge("el control a los dos años de edad", toddler)?.day).toBe("2027-05-14")
    // En meses, para un bebé: a los seis meses de un niño de tres.
    expect(controlByAge("control a los seis meses", { birthDate: "2026-08-26", today: "2026-11-26" })?.day).toBe("2027-02-26")
  })

  it("«en dos años», una edad que ya pasó o sin fecha de nacimiento: se cuenta desde hoy, como siempre", () => {
    expect(controlByAge("su próximo control en dos años", toddler)).toBeNull()
    expect(controlByAge("control dentro de dos años", toddler)).toBeNull()
    // Un adulto: «a los seis meses» es desde hoy.
    expect(controlByAge("control a los seis meses", { birthDate: "1980-03-02", today: "2026-11-26" })).toBeNull()
    expect(controlByAge("su próximo control a los dos años", { birthDate: null, today: "2026-11-26" })).toBeNull()
    // «A los dos años de la cirugía» no es su edad.
    expect(controlByAge("control a los dos años de la cirugía", toddler)).toBeNull()
    expect(controlByAge(undefined, toddler)).toBeNull()
  })

  it("el 29 de febrero cae el último día del mes", () => {
    expect(controlByAge("a los dos años", { birthDate: "2024-02-29", today: "2025-06-01" })?.day).toBe("2026-02-28")
  })
})
