import { parseEyeExam, referralSigns } from "@odentia/optical"
import { describe, expect, it } from "vitest"
import { DEMO_COUNTRIES } from "../demo-recipes.js"
import { generator } from "../seed-reports.js"
import { OPTICAL_DEMO_KINDS } from "./demo-kinds.js"

/**
 * El examen de la vista de las demos (entrega 3): pasa la misma validación que uno
 * escrito a mano, la medida de cada persona es la misma en todas sus visitas y un
 * menor queda con quien lo acompaña.
 */
describe("el examen de la vista de las demos de vistIA", () => {
  it("es válido, estable por persona y sin derivaciones inventadas", () => {
    const at = new Date("2026-06-15T15:00:00Z")
    for (const kind of OPTICAL_DEMO_KINDS) {
      const random = generator(20_261_109)
      let exams = 0
      for (let index = 0; index < 300; index += 1) {
        const person = kind.person(random, DEMO_COUNTRIES.PE)
        const name = person.guardian ? "Examen de la vista para niños" : "Examen de la vista"
        const first = kind.note({ name }, random, person, at)
        const again = kind.note({ name: "Control de la vista" }, random, person, at)
        if (!first.examination) continue
        exams += 1
        const parsed = parseEyeExam(first.examination)
        expect(parsed.ok, JSON.stringify(first.examination)).toBe(true)
        if (!parsed.ok) continue
        // La demo no inventa alarmas: corrige a 20/20 y no mide la presión.
        expect(referralSigns(parsed.value)).toEqual([])
        expect(again.examination?.refraccion).toEqual(first.examination.refraccion)
        if (person.guardian) expect(parsed.value?.acompanante?.nombre).toContain(person.guardian.givenNames)
      }
      expect(exams, kind.key).toBeGreaterThan(100)
    }
  })
})
