import { describe, expect, it } from "vitest"
import {
  byCourier,
  chargeOf,
  courierCounts,
  type Delivery,
  dayCountText,
  noticeLink,
  noticeText,
  sections,
  wayText,
} from "./despachos"

const paid = {
  confirmedCents: 15200,
  pendingCents: 0,
  dueCents: 0,
  overCents: 0,
  paid: true,
  refundedCents: 0,
}
const due = (cents: number) => ({
  confirmedCents: 0,
  pendingCents: 0,
  dueCents: cents,
  overCents: 0,
  paid: false,
  refundedCents: 0,
})

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: over.number ?? "0150",
  number: "0150",
  state: "por_salir",
  customerName: "Valeria Soto",
  customerPhone: "987 654 321",
  address: "Av. Benavides 1234, Surco",
  deliveryName: "Reparto en Lima",
  deliveryType: "DeliveryModeOwnFleet",
  deliveryZone: "Surco",
  deliverOn: "2026-11-26",
  late: false,
  slot: { start: 540, end: 780, label: "9–13 h" },
  courierId: "kevin",
  courierName: "Kevin",
  agency: null,
  tracking: null,
  totalCents: 15200,
  paymentName: "Yape",
  paymentCollection: "comprobante",
  balance: paid,
  missed: null,
  ...over,
})

const money = (cents: number) => `S/ ${cents / 100}`

describe("las secciones del día", () => {
  it("primero «No se entregó», después cada franja en orden y al final «Sin franja»", () => {
    const list = [
      delivery({ number: "0156", slot: { start: 1080, end: 1260, label: "18–21 h" } }),
      delivery({ number: "0155", slot: null }),
      delivery({ number: "0150" }),
      delivery({
        number: "0142",
        slot: { start: 540, end: 780, label: "9–13 h" },
        missed: { reason: "No contestó", at: null, resolved: false },
      }),
    ]
    expect(sections(list).map((s) => [s.title, s.deliveries.map((d) => d.number)])).toEqual([
      ["No se entregó", ["0142"]],
      ["9–13 h", ["0150"]],
      ["18–21 h", ["0156"]],
      ["Sin franja", ["0155"]],
    ])
    expect(sections([])).toEqual([])
  })

  it("el filtro por repartidor, con cuántas lleva cada uno y las que no tienen", () => {
    const list = [
      delivery({ number: "1" }),
      delivery({ number: "2", courierId: "lucia", courierName: "Lucía" }),
      delivery({ number: "3", courierId: null, courierName: null }),
      delivery({ number: "4" }),
    ]
    expect(courierCounts(list)).toEqual({
      couriers: [
        { id: "kevin", name: "Kevin", count: 2 },
        { id: "lucia", name: "Lucía", count: 1 },
      ],
      without: 1,
    })
    expect(byCourier(list, "kevin").map((d) => d.number)).toEqual(["1", "4"])
    expect(byCourier(list, "sin").map((d) => d.number)).toEqual(["3"])
    expect(byCourier(list, "todos")).toHaveLength(4)
  })
})

describe("la fila", () => {
  it("la forma de entrega va en la fila, no entre los repartidores", () => {
    expect(wayText(delivery())).toBe("Surco · Envío")
    expect(wayText(delivery({ deliveryType: "OnSitePickup" }))).toBe("Recojo en tienda")
    expect(wayText(delivery({ deliveryType: "ParcelService", agency: "Shalom" }))).toBe(
      "Agencia Shalom",
    )
  })

  it("«Cobrar» sale del saldo único; lo que espera a una persona no es «Pagado»", () => {
    expect(chargeOf(due(20400))).toEqual({ tone: "charge", cents: 20400 })
    expect(chargeOf({ ...due(0), pendingCents: 3700 })).toEqual({ tone: "pending", cents: 3700 })
    expect(chargeOf(paid)).toEqual({ tone: "paid", cents: 0 })
  })

  it("la franja de días dice lo de cada uno", () => {
    const today = "2026-11-26"
    expect(dayCountText({ day: "2026-11-24", pending: 0, delivered: 5, missed: 0 }, today)).toBe(
      "5 entregados",
    )
    expect(dayCountText({ day: "2026-11-26", pending: 6, delivered: 0, missed: 1 }, today)).toBe(
      "6 por salir · 1 no se entregó",
    )
    expect(dayCountText({ day: "2026-11-28", pending: 0, delivered: 0, missed: 0 }, today)).toBe(
      "Nada",
    )
    // Un día que pasó sin entregas no dice «0 entregados».
    expect(dayCountText({ day: "2026-11-24", pending: 0, delivered: 0, missed: 0 }, today)).toBe(
      "Nada",
    )
  })
})

describe("«Avisar»", () => {
  it("escribe cuándo sale, quién lo lleva y lo que paga al recibir", () => {
    const jorge = delivery({
      customerName: "Jorge Paredes",
      number: "0142",
      balance: due(20400),
    })
    expect(noticeText(jorge, "2026-11-26", money)).toBe(
      "Hola Jorge, tu pedido 0142 sale hoy entre 9 y 13 h. Te lo lleva Kevin. Al recibir pagas S/ 204.",
    )
    const mariela = delivery({
      customerName: "Mariela Ríos",
      number: "0156",
      state: "en_camino",
      deliveryType: "ParcelService",
      agency: "Shalom",
      tracking: "77812",
    })
    expect(noticeText(mariela, "2026-11-26", money)).toBe(
      "Hola Mariela, tu pedido 0156 va en camino por Shalom. Número de envío: 77812.",
    )
  })

  it("abre el WhatsApp con el texto; sin un número que se pueda leer, no hay enlace", () => {
    expect(noticeLink("987 654 321", "Hola", "PE")).toBe("https://wa.me/51987654321?text=Hola")
    expect(noticeLink("987 654 321", "Hola", null)).toBeNull()
    expect(noticeLink(null, "Hola", "PE")).toBeNull()
  })
})
