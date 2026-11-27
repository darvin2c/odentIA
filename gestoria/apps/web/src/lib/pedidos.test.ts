/**
 * Cómo dice la pantalla el estado de un pedido con su saldo (lienzo «gestorIA como odentIA»,
 * tablero 7) y qué día es en la tienda (tablero 3). El saldo lo calcula el servidor; aquí solo se
 * nombra.
 */
import { describe, expect, it } from "vitest"
import {
  type Balance,
  dayName,
  missedReason,
  nextDay,
  type OrderEvent,
  stateName,
  storeToday,
} from "./pedidos"

const balance = (over: Partial<Balance>): Balance => ({
  confirmedCents: 0,
  pendingCents: 0,
  dueCents: 11700,
  overCents: 0,
  paid: false,
  ...over,
})

describe("el estado con su saldo", () => {
  it("Diana pagó S/ 80 de S/ 117: sale, pero falta cobrar (nunca «Pagado»)", () => {
    const name = stateName({
      state: "por_salir",
      paymentCollection: "comprobante",
      balance: balance({ confirmedCents: 8000, dueCents: 3700 }),
    })
    expect(name).toBe("Por salir · falta cobrar")
  })

  it("«Pagado» solo sin nada que cobrar y con todo confirmado", () => {
    const paid = balance({ confirmedCents: 11700, dueCents: 0, paid: true })
    expect(stateName({ state: "por_salir", paymentCollection: "comprobante", balance: paid })).toBe(
      "Pagado · por salir",
    )
    const waiting = balance({ confirmedCents: 8000, pendingCents: 3700, dueCents: 0 })
    expect(
      stateName({ state: "por_salir", paymentCollection: "comprobante", balance: waiting }),
    ).toBe("Por salir · pago por confirmar")
  })

  it("al recibir, sin pagos: se cobra en la puerta", () => {
    expect(
      stateName({ state: "por_salir", paymentCollection: "al_recibir", balance: balance({}) }),
    ).toBe("Por salir · cobra al recibir")
  })

  it("entregado con algo por cobrar lo dice", () => {
    expect(
      stateName({
        state: "entregado",
        paymentCollection: "al_recibir",
        balance: balance({ confirmedCents: 10000, dueCents: 1700 }),
      }),
    ).toBe("Entregado · falta cobrar")
  })
})

describe("el día de la tienda", () => {
  it("a las 19:30 del martes en Lima es martes, aunque en UTC ya sea miércoles", () => {
    const at = new Date("2026-11-26T00:30:00Z")
    expect(storeToday("America/Lima", at)).toBe("2026-11-25")
    expect(dayName("2026-11-26", storeToday("America/Lima", at))).toBe("mañana")
    expect(dayName("2026-11-25", storeToday("America/Lima", at))).toBe("hoy")
  })
})

describe("volvió sin entregar (tablero 6)", () => {
  const event = (
    action: OrderEvent["action"],
    detail: Record<string, unknown> = {},
  ): OrderEvent => ({
    id: action,
    action,
    detail,
    createdAt: "2026-11-25T19:05:00Z",
    actorName: "Kevin",
    byLink: false,
  })

  it("el 0142 no contestó y vuelve a salir: se dice el motivo hasta que sale otra vez", () => {
    const back = [event("salio"), event("no_entregado", { motivo: "No contestó" })]
    expect(missedReason({ state: "por_salir", events: back })).toBe("No contestó")
    expect(missedReason({ state: "en_camino", events: [...back, event("salio")] })).toBeNull()
    expect(missedReason({ state: "por_salir", events: [event("salio")] })).toBeNull()
  })

  it("«Mañana» es el día siguiente en el calendario, también a fin de mes", () => {
    expect(nextDay("2026-11-26")).toBe("2026-11-27")
    expect(nextDay("2026-11-30")).toBe("2026-12-01")
    expect(nextDay("2026-12-31")).toBe("2027-01-01")
  })
})
