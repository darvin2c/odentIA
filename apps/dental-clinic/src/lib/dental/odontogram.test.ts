import { setOrgLocale } from "@odentia/clinic-app/lib/locale"
import { afterEach, describe, expect, it } from "vitest"
import { earlierEvolutionWords } from "./odontogram"

afterEach(() => setOrgLocale(undefined, undefined))

/**
 * Segundo repaso de la atención (9 nov): a la derecha del odontograma quedaba
 * «▶ ODONTOGRAMA / Evolución» vacío. Ahora, si hay registros anteriores, una
 * sola fila plegada bajo el arco que dice cuántos y de cuándo.
 */
describe("la fila de la evolución anterior en la atención", () => {
  it("uno: cuántos y su día; varios: cuántos y el día del último, en la zona de la clínica", () => {
    setOrgLocale("es-PE", "America/Lima")
    expect(earlierEvolutionWords([{ createdAt: "2026-11-09T16:00:00.000Z" }])).toBe(
      "Evolución · 1 registro anterior (9 nov)",
    )
    expect(
      earlierEvolutionWords([
        { createdAt: "2026-11-02T16:00:00.000Z" },
        // 00:30 del 10 en UTC es aún el 9 en Lima.
        { createdAt: "2026-11-10T00:30:00.000Z" },
        { createdAt: "2026-10-20T16:00:00.000Z" },
      ]),
    ).toBe("Evolución · 3 registros anteriores (el último, 9 nov)")
  })
})
