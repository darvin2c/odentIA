import { describe, expect, it } from "vitest"
import {
  agreementWords,
  calculationGroups,
  type CommissionHistoryEvent,
  type CommissionLine,
  debtClosureWords,
  discountFromWords, historyLines, previousMonthsDiscounts,
  returnMethodWords,
  showAllLabel,
  summaryAmountWords,
  summaryDiscountWords,
} from "./commissions"

const lines = (counted: number, voided: number) => [
  ...Array.from({ length: counted }, () => ({ voidedAfterPaid: false })),
  ...Array.from({ length: voided }, () => ({ voidedAfterPaid: true })),
]

describe("«Ver los N cobros» cuenta lo mismo que el encabezado", () => {
  it("sin anulados, todos", () => {
    expect(showAllLabel(lines(16, 0))).toBe("Ver los 16 cobros")
  })

  it("el anulado después de pagado va aparte: el encabezado dice 15 cobros", () => {
    expect(showAllLabel(lines(15, 1))).toBe("Ver los 15 cobros y el anulado")
    expect(showAllLabel(lines(15, 2))).toBe("Ver los 15 cobros y los 2 anulados")
    expect(showAllLabel(lines(1, 1))).toBe("Ver el cobro y el anulado")
    expect(showAllLabel(lines(0, 5))).toBe("Ver los 5 anulados")
  })
})

it("lo que debe dice de qué pago se descuenta, y cuánto si no alcanza para todo", () => {
  const october = { year: 2026, month: 10 }
  expect(discountFromWords({ owedCents: 12000, currency: "PEN", discountFrom: { ...october, cents: 12000 } }, "es-PE")).toBe(
    "Se descuenta del pago de octubre de 2026, que tiene cobros por pagar.",
  )
  expect(discountFromWords({ owedCents: 30000, currency: "PEN", discountFrom: { ...october, cents: 15000 } }, "es-PE")).toMatch(
    /^Se descuentan S\/\s?150\.00 del pago de octubre de 2026, que tiene cobros por pagar, y el resto, de los próximos pagos\.$/,
  )
  expect(discountFromWords({ owedCents: 12000, currency: "PEN", discountFrom: null }, "es-PE")).toBe("Se descuenta del próximo pago.")
})

it("el medio de lo devuelto, para una frase", () => {
  expect(returnMethodWords("10")).toBe("en efectivo")
  expect(returnMethodWords("30")).toBe("por transferencia")
  expect(returnMethodWords("48")).toBe("con tarjeta")
  expect(returnMethodWords(null)).toBe("")
})

describe("el mes que le descuenta lo que debe dice lo mismo en la clínica y en «Mis honorarios»", () => {
  const october = {
    status: "por_pagar" as const,
    currency: "PEN",
    commissionCents: 555100,
    paidCents: 0,
    discountCents: 21000,
    pendingCents: 534100,
    owedCents: 0,
    discountFrom: null,
  }

  it("lo que se le pagará y el descuento, no la comisión entera", () => {
    expect(summaryAmountWords(october, "es-PE")).toMatch(/^Falta S\/\s?5,341\.00$/)
    expect(summaryDiscountWords(october, "es-PE")).toMatch(/^S\/\s?210\.00 por descontar$/)
  })

  it("sin descuento ni pago a cuenta, la comisión", () => {
    const plain = { ...october, discountCents: 0, pendingCents: 555100 }
    expect(summaryAmountWords(plain, "es-PE")).toMatch(/^S\/\s?5,551\.00$/)
    expect(summaryDiscountWords(plain, "es-PE")).toBeNull()
  })
})

it("por qué «Ya pagado» supera la comisión: lo devolvió o se dio por saldado, con su día", () => {
  const day = () => "8 de noviembre"
  expect(debtClosureWords({ settlementId: "s", kind: "devuelto", cents: 21000, settledAt: "2026-11-08T15:00:00Z", notes: "Lo trajo" }, "PEN", "es-PE", day)).toMatch(
    /^Devolvió S\/\s?210\.00 el 8 de noviembre$/,
  )
  expect(debtClosureWords({ settlementId: "s", kind: "saldado", cents: 21000, settledAt: "2026-11-08T15:00:00Z", notes: "Ya no trabaja aquí" }, "PEN", "es-PE", day)).toMatch(
    /^Se dio por saldado S\/\s?210\.00 el 8 de noviembre: Ya no trabaja aquí$/,
  )
})

describe("«Meses anteriores» reparte lo que debe una sola vez", () => {
  const month = (m: number, pendingCents: number, discountCents: number) => ({
    professionalUserId: "u",
    professionalName: "Luis",
    inTeam: true,
    year: 2026,
    month: m,
    currency: "PEN",
    rateBps: 3500,
    collections: 1,
    baseCents: 0,
    commissionCents: pendingCents + discountCents,
    paidCents: 0,
    pendingCents,
    discountCents,
    lastPaidAt: null,
    status: "por_pagar" as const,
  })

  it("del mes más antiguo al más nuevo: dos meses no descuentan la misma deuda", () => {
    // Cada mes, mirado solo, descontaría los 210 que debe: 100 de septiembre y 210 de octubre.
    const split = previousMonthsDiscounts([month(10, 34000, 21000), month(9, 0, 10000)], new Map([["PEN", 21000]]))
    expect(split.get("2026-9-PEN")).toEqual({ discountCents: 10000, pendingCents: 0 })
    expect(split.get("2026-10-PEN")).toEqual({ discountCents: 11000, pendingCents: 44000 })
  })

  it("sin deuda, nada que descontar", () => {
    expect(previousMonthsDiscounts([month(10, 555100, 0)], new Map()).get("2026-10-PEN")).toEqual({ discountCents: 0, pendingCents: 555100 })
  })
})

describe("«Cómo se calcula»: una fila por regla que suman lo que le corresponde", () => {
  let next = 0
  const line = (patch: Partial<CommissionLine>): CommissionLine => ({
    applicationId: `app-${next++}`,
    patientId: "p",
    patientName: "Paciente",
    description: "Resina",
    baseCents: 10000,
    rateBps: 4000,
    commissionCents: 4000,
    occurredAt: "2026-11-02T15:00:00Z",
    promotionName: null,
    slice: null,
    sessions: null,
    fixedCents: null,
    forService: false,
    settled: false,
    paidAt: null,
    voidedAfterPaid: false,
    ...patch,
  })

  it("el porcentaje general, cada servicio aparte y al final lo que no comisiona", () => {
    const lines = [
      line({}),
      line({ baseCents: 20000, commissionCents: 8000 }),
      line({ description: "Blanqueamiento dental", forService: true, rateBps: 4500, baseCents: 60000, commissionCents: 27000 }),
      line({ description: "Corona cerámica", forService: true, rateBps: null, fixedCents: 15000, baseCents: 90000, commissionCents: 15000 }),
      // Lo de antes de un cambio de porcentaje va en su propia fila.
      line({ rateBps: 3500, baseCents: 10000, commissionCents: 3500 }),
      line({ rateBps: null, unruled: true, commissionCents: 0, description: "Control" }),
      // Un cobro anulado después de pagado no cuenta, como en el total del servidor.
      line({ voidedAfterPaid: true, commissionCents: 9999 }),
    ]
    const groups = calculationGroups(lines, "es-PE", "PEN")
    expect(groups.map((group) => [group.label.replace(/\s/g, " "), group.count, group.baseCents, group.commissionCents])).toEqual([
      ["40 % de lo cobrado", 2, 30000, 12000],
      ["35 % de lo cobrado", 1, 10000, 3500],
      ["Blanqueamiento dental · 45 %", 1, 60000, 27000],
      ["Corona cerámica · S/ 150.00 por cada uno", 1, 90000, 15000],
      ["Sin comisión decidida", 1, 10000, 0],
    ])
    const counted = lines.filter((item) => !item.voidedAfterPaid).reduce((sum, item) => sum + item.commissionCents, 0)
    expect(groups.reduce((sum, group) => sum + group.commissionCents, 0)).toBe(counted)
  })

  it("el mismo servicio cobrado con dos textos es una sola fila, con su nombre del catálogo", () => {
    const endo = { serviceId: "svc-endo", serviceName: "Endodoncia", forService: true, rateBps: 5000 }
    const lines = [
      line({ ...endo, description: "Endodoncia", baseCents: 40000, commissionCents: 20000 }),
      line({ ...endo, description: "Endodoncia molar 46", baseCents: 30000, commissionCents: 15000 }),
      // El mismo servicio con otro porcentaje (antes de un cambio) va aparte.
      line({ ...endo, rateBps: 4500, description: "Endodoncia", baseCents: 10000, commissionCents: 4500 }),
      // Lo pagado sin su servicio sigue juntándose por el texto.
      line({ forService: true, rateBps: 5000, description: "Endodoncia", baseCents: 10000, commissionCents: 5000 }),
      line({ serviceId: "svc-corona", serviceName: "Corona", forService: true, rateBps: null, fixedCents: 15000, description: "Corona 2.1", commissionCents: 15000 }),
      line({ serviceId: "svc-corona", serviceName: "Corona", forService: true, rateBps: null, fixedCents: 15000, description: "Corona 2.2", commissionCents: 15000 }),
    ]
    expect(
      calculationGroups(lines, "es-PE", "PEN").map((group) => [group.label.replace(/\s/g, " "), group.count, group.commissionCents]),
    ).toEqual([
      ["Corona · S/ 150.00 por cada uno", 2, 30000],
      ["Endodoncia · 45 %", 1, 4500],
      ["Endodoncia · 50 %", 2, 35000],
      ["Endodoncia · 50 %", 1, 5000],
    ])
  })

  it("la comisión de cada profesional, en una frase", () => {
    expect(agreementWords({ hasRate: true, rateBps: 4000, exceptionCount: 0 }, "es-PE")).toBe("40 % de lo cobrado")
    expect(agreementWords({ hasRate: true, rateBps: 4000, exceptionCount: 2 }, "es-PE")).toBe(
      "40 % de lo cobrado y 2 servicios con comisión distinta",
    )
    expect(agreementWords({ hasRate: false, rateBps: 0, exceptionCount: 1 }, "es-PE")).toBe("Solo por 1 servicio")
    expect(agreementWords({ hasRate: true, rateBps: 0, exceptionCount: 0 }, "es-PE")).toBe("No cobra comisión")
    expect(agreementWords({ hasRate: false, rateBps: 0, exceptionCount: 0 }, "es-PE")).toBe("Sin comisión decidida")
  })
})

describe("el historial de una comisión, lo más nuevo primero", () => {
  const general = (rateBps: number) => ({ serviceId: null, serviceName: null, rateBps, fixedCents: null, fixedCurrency: null })
  const service = (rateBps: number | null, fixedCents: number | null = null) => ({
    serviceId: "svc-endo",
    serviceName: "Endodoncia",
    rateBps,
    fixedCents,
    fixedCurrency: fixedCents === null ? null : "PEN",
  })
  const event = (at: string, changes: CommissionHistoryEvent["changes"], patch: Partial<CommissionHistoryEvent> = {}) => ({
    at,
    byName: "Ana Torres",
    fromStart: false,
    changes,
    ...patch,
  })

  it("dice lo que quedó, cuándo, quién y el porcentaje de antes", () => {
    const lines = historyLines(
      [
        event("2026-11-08T15:00:00Z", [service(null)]),
        event("2026-10-20T15:00:00Z", [general(4000)], { byName: null }),
        event("2026-10-01T15:00:00Z", [service(null, 15000)]),
        event("2026-08-01T15:00:00Z", [general(3500)], { fromStart: true }),
      ],
      "es-PE",
      "America/Lima",
    )
    expect(lines.map((line) => [line.what.replace(/\s/g, " "), line.detail])).toEqual([
      ["Endodoncia: vuelve a su 40 %", "8 de noviembre de 2026 · Ana Torres"],
      ["40 % de lo cobrado", "20 de octubre de 2026 · Sin registro de quién · antes 35 %"],
      ["Endodoncia: S/ 150.00 por cada uno", "1 de octubre de 2026 · Ana Torres"],
      ["35 % de lo cobrado", "1 de agosto de 2026 · Ana Torres · la primera"],
    ])
  })

  it("dejar el porcentaje en 0 con servicios vigentes es comisionar solo por ellos", () => {
    const lines = historyLines(
      [event("2026-11-02T15:00:00Z", [general(0)]), event("2026-11-01T15:00:00Z", [general(4000), service(5000)], { fromStart: true })],
      "es-PE",
      "America/Lima",
    )
    expect(lines.map((line) => [line.what.replace(/\s/g, " "), line.detail])).toEqual([
      ["Solo por 1 servicio", "2 de noviembre de 2026 · Ana Torres · antes 40 %"],
      ["40 % de lo cobrado · Endodoncia: 50 %", "1 de noviembre de 2026 · Ana Torres · la primera"],
    ])
  })

  it("solo por un servicio, no cobrar comisión y quitar el único servicio", () => {
    const lines = historyLines(
      [
        event("2026-11-03T15:00:00Z", [general(0)]),
        event("2026-11-02T15:00:00Z", [service(null)]),
        event("2026-11-01T15:00:00Z", [general(0), service(5000)], { fromStart: true }),
      ],
      "es-PE",
      "America/Lima",
    )
    expect(lines.map((line) => line.what.replace(/\s/g, " "))).toEqual([
      "No cobra comisión",
      "Endodoncia: ya no comisiona",
      "Endodoncia: 50 % · lo demás no comisiona",
    ])
  })
})
