import { describe, expect, it } from "vitest"
import { extendedReadOnlyAt } from "./subscription-status"

// La línea de la prórroga en la tarjeta de estado de Plan y pagos: solo cuando la prórroga de un
// comprobante es el día que manda, con el día que dice el servidor (`readOnlyAt`).
describe("la prórroga en la tarjeta de estado", () => {
  const graceEndsAt = "2026-11-15T15:00:00.000Z"

  it("se dice en gracia cuando la prórroga va más allá del fin de la gracia", () => {
    expect(extendedReadOnlyAt({ status: "gracia", graceEndsAt, readOnlyAt: "2026-11-17T15:00:00.000Z" })).toBe(true)
  })

  it("vencida, o sin prórroga, el día es el fin de la gracia y no se dice", () => {
    expect(extendedReadOnlyAt({ status: "gracia", graceEndsAt, readOnlyAt: graceEndsAt })).toBe(false)
  })

  it("fuera de la gracia no se dice, aunque quede una fecha guardada", () => {
    expect(extendedReadOnlyAt({ status: "activa", graceEndsAt: null, readOnlyAt: null })).toBe(false)
    expect(extendedReadOnlyAt({ status: "restringida", graceEndsAt, readOnlyAt: null })).toBe(false)
  })
})
