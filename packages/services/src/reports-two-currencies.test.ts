/**
 * Reportes y Argos con dos monedas: lo que ya pasó cuenta con el valor congelado y no
 * se mueve aunque cambie el dólar; lo que se debe va por moneda, con un total al cambio
 * de hoy; y una clínica que no activó nada ve lo mismo de siempre. Argos y Reportes dan
 * la misma cifra en la clínica de examen.
 */
import { randomUUID } from "node:crypto"
import { commissionOfValue, currencyFractionDigits, moneyValue } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { patientCharge, patientPayment } from "@odentia/db/schema/clinical"
import { expense } from "@odentia/db/schema/finance"
import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { getAdminRecommendation } from "./agent-admin.js"
import { formatArgosValue } from "./argos-answer.js"
import { argosCatalogText } from "./argos-catalog.js"
import { ARGOS_FIGURES, argosFigure, compileArgosFigure, listArgosNames } from "./argos-figures.js"
import { bindArgosPeriod, resolveArgosPeriod } from "./argos-period.js"
import { runArgosQuery } from "./argos-query.js"
import { buildTwoCurrencyExam, twoCurrencyClinic } from "./exam-two-currencies.js"
import {
  closeCashWindow,
  collectedByProfessional,
  collectedNetMany,
  getMonthExpenses,
  getMonthlyCommissions,
  listTickets,
} from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { setOrgExchangeRate } from "./organization-profile.js"
import { createCharge, getTicketReturnable, returnFromTicket, voidTicket } from "./payments.js"
import { agentTextsFor, productAgentTexts } from "./products.js"
import { computeFigure, type FigureContext } from "./report-figures.js"
import {
  collectedByMethod,
  collectedByTreatment,
  commissionsMany,
  debtAgingMany,
  expensesMany,
  getReportCommissions,
  getReportFinance,
  getReportOutlook,
} from "./report-finance.js"
import { reportScope } from "./report-scope.js"
import { getReportSummary, overdueDebtTotalsMany } from "./report-summary.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const month = () => {
  const now = new Date()
  return { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 86_400_000) }
}

const argos = async (orgId: string, query: string, memberRole = "owner") =>
  (await runArgosQuery(appDb, { orgId, memberRole, query })).rows
const one = async (orgId: string, query: string, memberRole = "owner") =>
  Number((await argos(orgId, query, memberRole))[0]?.v ?? 0)

describe("lo que ya pasó, con su valor congelado", () => {
  it("USD 1,000 a 3.75 repartidos en 333.33, 333.33 y 333.34 suman S/ 3,750.00 exactos", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Lucía Ramos")
    const charges = await c.attended(patient, [
      { description: "Implante", priceCents: 33_333, currency: "USD" },
      { description: "Implante", priceCents: 33_333, currency: "USD" },
      { description: "Implante", priceCents: 33_334, currency: "USD" },
    ])
    await c.collect(patient, {
      chargeIds: charges.map((charge) => charge.id),
      exchangeRate: "3.75",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 100_000 }],
    })
    const span = month()

    const [net] = await c.run((tx) => collectedNetMany(tx, c.orgId, [span]))
    // El impuesto (18 % incluido, 3 × USD 50.85) también sale con su parte del valor: 15,255 × 3.75.
    expect(net).toEqual([{ currency: "PEN", cents: 375_000, taxCents: 57_206 }])
    expect(
      (await c.run((tx) => collectedByProfessional(tx, c.orgId, span, "PEN"))).map(
        (row) => row.cobradoCents,
      ),
    ).toEqual([375_000])
    const [byMonth] = await c.run((tx) => commissionsMany(tx, c.orgId, [span], { currency: "PEN" }))
    expect(byMonth?.[0]).toMatchObject({
      baseCents: 375_000,
      commissionCents: 37_499 + 37_499 + 37_500,
    })
    expect(
      (await c.run((tx) => collectedByTreatment(tx, c.orgId, span, { currency: "PEN" }))).rows.map(
        (row) => row.cents,
      ),
    ).toEqual([375_000])

    // En Argos, las filas no se redondean una por una: la suma da lo mismo.
    const rows = await argos(c.orgId, "select importe from pagos_por_venta")
    expect(rows.map((row) => row.importe)).toEqual(expect.arrayContaining([1249.9875, 1250.025]))
    expect(await one(c.orgId, "select sum(importe) as v from pagos_por_venta")).toBe(3750)
    expect(await one(c.orgId, "select sum(base) as v from comisiones")).toBe(3750)
    expect(await one(c.orgId, "select sum(comision) as v from comisiones")).toBe(1124.98)

    // Finanzas › Comisiones: la misma cuenta, con la base redondeada una vez sobre la suma.
    const now = new Date()
    const view = await c.run((tx) =>
      getMonthlyCommissions(tx, c.orgId, {
        professionalUserId: c.actor,
        year: Number(
          new Intl.DateTimeFormat("en", { timeZone: "America/Lima", year: "numeric" }).format(now),
        ),
        month: Number(
          new Intl.DateTimeFormat("en", { timeZone: "America/Lima", month: "numeric" }).format(now),
        ),
      }),
    )
    expect(view).toMatchObject({ currency: "PEN", baseCents: 375_000, commissionCents: 112_498 })
    expect(view.lines.map((line) => line.baseCents).sort()).toEqual([124_999, 124_999, 125_003])
  })

  it("cambiar el «Cambio de hoy» no altera lo ya cobrado, pero sí el total aproximado de lo que se debe", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Lucía Ramos")
    const [paid] = await c.attended(patient, [
      { description: "Implante", priceCents: 100_000, currency: "USD" },
    ])
    await c.collect(patient, {
      chargeIds: [paid!.id],
      exchangeRate: "3.75",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 100_000 }],
    })
    const debtor = await c.person("Bruno Díaz")
    await c.run((tx) =>
      createCharge(tx, c.orgId, c.actor, debtor, {
        description: "Ortodoncia",
        amountCents: 10_000,
        currency: "USD",
        branchId: c.branchId,
      }),
    )
    const span = month()
    const at = new Date()
    const read = async () => {
      const [net] = await c.run((tx) => collectedNetMany(tx, c.orgId, [span]))
      const [commissions] = await c.run((tx) =>
        commissionsMany(tx, c.orgId, [span], { currency: "PEN" }),
      )
      const [aging] = await c.run((tx) =>
        debtAgingMany(tx, c.orgId, [new Date(at.getTime() + 60_000)], { currency: "PEN" }),
      )
      return {
        cobrado: net?.[0]?.cents,
        comision: commissions?.[0]?.commissionCents,
        argos: await one(c.orgId, "select sum(importe) as v from cobros"),
        debe: aging?.totalCents,
        argosDebe: await one(c.orgId, "select sum(saldo) as v from deudas"),
      }
    }
    expect(await read()).toEqual({
      cobrado: 375_000,
      comision: 112_500,
      argos: 3750,
      debe: 37_500,
      argosDebe: 375,
    })
    await c.run((tx) => setOrgExchangeRate(tx, c.orgId, c.actor, { exchangeRate: "4" }))
    expect(await read()).toEqual({
      cobrado: 375_000,
      comision: 112_500,
      argos: 3750,
      debe: 40_000,
      argosDebe: 400,
    })
  })

  it("un pago viejo en otra moneda sin factor no entra: una clínica que no activó nada ve lo mismo que antes", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
    const patient = await c.person("Lucía Ramos")
    const insert = (amountCents: number, currency: string) =>
      ownerDb.insert(patientPayment).values({
        organizationId: c.orgId,
        patientId: patient,
        branchId: c.branchId,
        amountCents,
        currency,
        paidAt: new Date(),
        methodName: "Efectivo",
        methodTypeCode: "10",
      })
    await insert(100_000, "PEN")
    await insert(50_000, "USD")
    await ownerDb.insert(patientCharge).values({
      organizationId: c.orgId,
      patientId: patient,
      branchId: c.branchId,
      description: "Viejo",
      amountCents: 7_000,
      currency: "USD",
    })
    await ownerDb.insert(expense).values({
      organizationId: c.orgId,
      branchId: c.branchId,
      concept: "Viejo",
      category: "Otros",
      amountCents: 9_000,
      currency: "USD",
      spentAt: new Date(),
      receiptKind: "ninguno",
      createdBy: c.actor,
    })
    const span = month()

    // Lo de antes: la otra moneda va aparte, nunca sumada 1 a 1.
    const [net] = await c.run((tx) => collectedNetMany(tx, c.orgId, [span]))
    expect(new Map(net?.map((row) => [row.currency, row.cents]))).toEqual(
      new Map([
        ["PEN", 100_000],
        ["USD", 50_000],
      ]),
    )
    const [spent] = await c.run((tx) => expensesMany(tx, c.orgId, [span]))
    expect(spent?.map((row) => [row.currency, row.totalCents])).toEqual([["USD", 9_000]])
    const finance = await c.run((tx) => getReportFinance(tx, c.orgId, { period: "este_mes" }))
    expect(finance.totals.current.cobradoCents).toBe(100_000)
    expect(finance.otherCurrencies).toEqual([{ currency: "USD", cobradoCents: 50_000 }])
    expect(finance).not.toHaveProperty("second")
    expect(finance).not.toHaveProperty("moneyFlow")
    expect(finance.debts.current).toEqual({ totalCents: 0, people: 0, ages: expect.any(Array) })
    expect(finance.debts.current.ages.every((age) => !("byCurrency" in age))).toBe(true)
    expect(finance.byMethod.methods).toEqual([{ label: "Efectivo", cash: true, cents: 100_000 }])
    expect(finance.byMethod.closures).toEqual({ count: 0, cashCents: 0 })
    expect(
      await c.run((tx) =>
        getMonthExpenses(tx, c.orgId, {
          year: finance.period.from.year,
          month: finance.period.from.month,
        }),
      ),
    ).toMatchObject({ totalCents: 0, shown: { count: 0, totalCents: 0 } })
    // Argos dice lo mismo: esa fila no tiene valor en la moneda de la clínica.
    expect(await one(c.orgId, "select sum(importe) as v from cobros")).toBe(1000)
    expect(await one(c.orgId, "select sum(saldo) as v from deudas")).toBe(0)
  })

  it("una moneda vieja que no es la otra de la clínica no usa su factor", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Lucía Ramos")
    await ownerDb.insert(patientPayment).values({
      organizationId: c.orgId,
      patientId: patient,
      branchId: c.branchId,
      amountCents: 50_000,
      currency: "EUR",
      paidAt: new Date(),
      methodName: "Efectivo",
    })
    const [net] = await c.run((tx) => collectedNetMany(tx, c.orgId, [month()]))
    expect(net).toEqual([{ currency: "EUR", cents: 50_000, taxCents: 0 }])
    expect(await one(c.orgId, "select sum(importe) as v from cobros")).toBe(0)
  })

  it("anular resta el valor entero y una devolución parcial cruzada, su parte", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Lucía Ramos")
    const [implant, crown] = await c.attended(patient, [
      { description: "Implante", priceCents: 100_000, currency: "USD" },
      { description: "Corona", priceCents: 10_000, currency: "USD" },
    ])
    const crossed = await c.collect(patient, {
      chargeIds: [implant!.id],
      tenderCurrency: "PEN",
      exchangeRate: "3.75",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 375_000 }],
    })
    const voided = await c.collect(patient, {
      chargeIds: [crown!.id],
      exchangeRate: "3.9",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 10_000 }],
    })
    const span = month()
    const cobrado = async () =>
      (await c.run((tx) => collectedNetMany(tx, c.orgId, [span])))[0]?.[0]?.cents
    expect(await cobrado()).toBe(375_000 + 39_000)
    await c.run((tx) =>
      voidTicket(tx, c.orgId, c.actor, patient, voided.ticket.id, {
        reason: "Error",
        allowPostClose: false,
      }),
    )
    expect(await cobrado()).toBe(375_000)
    const { lines } = await c.run((tx) =>
      getTicketReturnable(tx, c.orgId, patient, crossed.ticket.id),
    )
    await c.run((tx) =>
      returnFromTicket(tx, c.orgId, c.actor, patient, crossed.ticket.id, {
        branchId: c.branchId,
        lines: [{ chargeId: lines[0]!.chargeId, amountCents: 33_333 }],
        paymentMethodId: c.cash.id,
        reason: "Reclamo",
        requestId: randomUUID(),
      }),
    )
    // 33,333 × 375,000 ÷ 100,000 = 124,998.75: se resta sin redondear y se redondea la suma.
    expect(await cobrado()).toBe(375_000 - 124_999)
    expect(
      await one(c.orgId, "select sum(importe) as v from cobros where tipo = 'devolucion'"),
    ).toBe(-1249.9875)
    expect(await one(c.orgId, "select sum(importe) as v from cobros")).toBe(2500.0125)
    expect(
      await one(c.orgId, "select sum(importe) as v from cobros where tipo = 'anulacion'"),
    ).toBe(-390)
    // Lo que entró, en la moneda en que entró: de S/ 3,750 salieron S/ 1,249.99 (`refundTenderCents`).
    const { methods } = await c.run((tx) =>
      collectedByMethod(tx, c.orgId, span, { currency: "PEN" }),
    )
    expect(methods.find((row) => row.label === "Efectivo")).toMatchObject({
      cash: true,
      cents: 250_001,
    })
  })
})

describe("lo que se debe, por moneda", () => {
  it("quien debe en dos monedas cuenta una sola vez, con un total al cambio de hoy", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Bruno Díaz")
    await c.run((tx) =>
      createCharge(tx, c.orgId, c.actor, patient, {
        description: "Ortodoncia",
        amountCents: 30_000,
        currency: "USD",
        branchId: c.branchId,
      }),
    )
    await c.run((tx) =>
      createCharge(tx, c.orgId, c.actor, patient, {
        description: "Control",
        amountCents: 15_000,
        currency: "PEN",
        branchId: c.branchId,
      }),
    )
    await ownerDb.insert(patientCharge).values({
      organizationId: c.orgId,
      patientId: patient,
      branchId: c.branchId,
      description: "Antiguo",
      amountCents: 1_000,
      currency: "USD",
      createdAt: new Date(Date.now() - 45 * 86_400_000),
    })
    await ownerDb.insert(patientCharge).values({
      organizationId: c.orgId,
      patientId: patient,
      branchId: c.branchId,
      description: "Antiguo",
      amountCents: 2_000,
      currency: "PEN",
      createdAt: new Date(Date.now() - 45 * 86_400_000),
    })
    const at = new Date(Date.now() + 60_000)

    const [aging] = await c.run((tx) => debtAgingMany(tx, c.orgId, [at], { currency: "PEN" }))
    expect(aging).toMatchObject({
      people: 1,
      totalCents: 17_000 + 116_250,
      byCurrency: [
        { currency: "PEN", cents: 17_000 },
        { currency: "USD", cents: 31_000 },
      ],
    })
    expect(aging?.ages.find((age) => age.key === "31_60")).toMatchObject({ people: 1 })
    const [overdue] = await c.run((tx) =>
      overdueDebtTotalsMany(tx, c.orgId, undefined, [at], "PEN"),
    )
    expect(overdue).toMatchObject({ people: 1, cents: 17_000 + 116_250 })

    // En Argos: una fila por moneda, una sola persona.
    expect(
      await argos(
        c.orgId,
        "select otra_moneda, saldo, saldo_otra_moneda from deudas order by otra_moneda",
      ),
    ).toEqual([
      { otra_moneda: "USD", saldo: 1162.5, saldo_otra_moneda: 310 },
      { otra_moneda: null, saldo: 170, saldo_otra_moneda: null },
    ])
    const texts = agentTextsFor("dental")
    const compiled = compileArgosFigure(
      { cifra: "deudores" },
      {
        key: "gestion",
        compare: false,
        names: null,
        words: { productName: "odentIA", recallMonths: texts.recallMonths },
      },
    )
    if ("problem" in compiled) throw new Error(compiled.problem)
    expect(await one(c.orgId, compiled.sql.replace(/ as pacientes/, " as v"))).toBe(1)

    // Lo que dice la pantalla: lo que se debe por moneda y el cambio de hoy.
    const finance = await c.run((tx) => getReportFinance(tx, c.orgId, { period: "este_mes" }))
    expect(finance.second).toEqual({ currency: "USD", rate: "3.75" })
    expect(finance.debts.current.byCurrency).toEqual([
      { currency: "PEN", cents: 17_000 },
      { currency: "USD", cents: 31_000 },
    ])
    const summary = await c.run((tx) => getReportSummary(tx, c.orgId, { period: "este_mes" }))
    // Cada persona cuenta entera en el tramo de su concepto más antiguo, en cada moneda.
    expect(summary.overdue.current).toMatchObject({
      people: 1,
      cents: 17_000 + 116_250,
      byCurrency: [
        { currency: "PEN", cents: 17_000 },
        { currency: "USD", cents: 31_000 },
      ],
    })
  })

  it("en la deuda vieja, quien debe en dos monedas es una persona con dos filas, cada una con lo que vale hoy", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Bruno Díaz")
    const old = new Date(Date.now() - 45 * 86_400_000)
    for (const [amountCents, currency] of [
      [100_000, "USD"],
      [2_000, "PEN"],
    ] as const) {
      await ownerDb.insert(patientCharge).values({
        organizationId: c.orgId,
        patientId: patient,
        branchId: c.branchId,
        description: "Antiguo",
        amountCents,
        currency,
        createdAt: old,
      })
    }
    const seen = await c.run((tx) =>
      getAdminRecommendation(tx, c.orgId, () => true, "cobranza_vencida"),
    )
    expect(seen.title).toMatch(/^1 persona debe/)
    expect(seen.total).toBe(2)
    const lines = seen.items.map((item) => item.line.replace(/\u00a0/g, " ").split(" · ")[0])
    expect(lines.sort()).toEqual(["Debe S/ 20.00", "Debe USD 1,000.00 (hoy, unos S/ 3,750)"])
  })

  it("lo aceptado no tiene valor congelado: lo atendido sin cobrar va al cambio de hoy", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const patient = await c.person("Lucía Ramos")
    await c.attended(patient, [
      { description: "Implante", priceCents: 10_000, currency: "USD" },
      { description: "Resina", priceCents: 5_000, currency: "PEN" },
    ])
    const report = await c.run((tx) => getReportCommissions(tx, c.orgId, { period: "este_mes" }))
    expect(report.rows[0]).toMatchObject({
      attendedCents: 37_500 + 5_000,
      unpaidCents: 37_500 + 5_000,
      collectedCents: 0,
    })
    expect(
      await c.run((tx) => getReportOutlook(tx, c.orgId, { period: "este_mes" })),
    ).toMatchObject({ upcoming: { cents: 0, patients: 0 } })
  })
})

describe("la cuenta en SQL y en TypeScript", () => {
  it("la comisión da lo mismo en las dos, multiplicando antes de dividir", async () => {
    const cases: Array<[number, number, number | null, string, string | null, number]> = [
      [33_333, 100_000, 375_000, "USD", "3.75", 3000],
      [33_334, 100_000, 375_000, "USD", "3.75", 3000],
      [1, 3, 10_000, "USD", "3.75", 3000],
      [12_345, 67_891, 254_591, "USD", "3.75", 1250],
      [100, 100, null, "PEN", null, 3333],
      [12_345, 12_345, null, "USD", "3.7591", 777],
      [999, 999, null, "USD", null, 3000],
      [7, 9, 0, "USD", "3.75", 3000],
    ]
    for (const [part, amount, value, currency, factor, rate] of cases) {
      const [row] = await ownerDb.execute<{ commission: string | null; value: string | null }>(sql`
        select money_commission(${part}::numeric, ${amount}::numeric, ${value}::numeric, ${currency}, 'PEN', 'USD', ${factor}::numeric, ${rate}::numeric)::text as commission,
          org_money_value(${part}::numeric, ${amount}::numeric, ${value}::numeric, ${currency}, 'PEN', 'USD', ${factor}::numeric)::text as value`)
      const own = moneyValue({
        partCents: part,
        amountCents: amount,
        valueCents: value,
        currency,
        businessCurrency: "PEN",
        factor,
      })
      expect(row?.commission === null ? null : Number(row?.commission), `${part}/${amount}`).toBe(
        own ? commissionOfValue(own, rate) : null,
      )
      expect(row?.value === null, `${part}/${amount}`).toBe(own === null)
    }
  })

  it("los decimales de cada moneda son los de ICU", async () => {
    for (const currency of Intl.supportedValuesOf("currency")) {
      const unit = 10 ** currencyFractionDigits(currency)
      const [row] = await ownerDb.execute<{ major: string }>(
        sql`select money_major(123000, ${currency})::text as major`,
      )
      expect(Number(row?.major), currency).toBe(123_000 / unit)
    }
  })
})

describe("pesos sin decimales", () => {
  it("45.000 pesos chilenos no son 450: Argos y Reportes dicen lo mismo", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, {
      rate: "950",
      currency: "CLP",
      country: "CL",
      locale: "es-CL",
    })
    const patient = await c.person("Pía Rojas")
    const [local, foreign] = await c.attended(patient, [
      { description: "Limpieza", priceCents: 45_000, currency: "CLP" },
      { description: "Implante", priceCents: 10_000, currency: "USD" },
    ])
    await c.collect(patient, {
      chargeIds: [local!.id],
      payments: [{ paymentMethodId: c.cash.id, amountCents: 45_000 }],
    })
    await c.collect(patient, {
      chargeIds: [foreign!.id],
      exchangeRate: "950",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 10_000 }],
    })
    const rows = await argos(
      c.orgId,
      "select importe, importe_otra_moneda, otra_moneda from cobros order by importe",
    )
    expect(rows).toEqual([
      { importe: 45_000, importe_otra_moneda: null, otra_moneda: null },
      { importe: 95_000, importe_otra_moneda: 100, otra_moneda: "USD" },
    ])
    const [net] = await c.run((tx) => collectedNetMany(tx, c.orgId, [month()]))
    expect(net).toEqual([{ currency: "CLP", cents: 140_000, taxCents: 0 }])
    const zone = {
      locale: "es-CL",
      currency: "CLP",
      timezone: "America/Santiago",
      secondCurrency: "USD",
    }
    expect(formatArgosValue(45_000, { name: "cobrado_dinero", kind: "number" }, zone)).toMatch(
      /^\$\s?45\.000$/,
    )
    expect(formatArgosValue(100, { name: "dolares_otra_moneda", kind: "number" }, zone)).toMatch(
      /100,00/,
    )
    expect(formatArgosValue(100, { name: "dolares_otra_moneda", kind: "number" }, zone)).toMatch(
      /US\$|USD/,
    )
    expect(await one(c.orgId, "select sum(comision) as v from comisiones")).toBe(13_500 + 28_500)
  })
})

describe("la clínica de examen con dólares", () => {
  it("Argos y Reportes dan la misma cifra, y cada cifra corre con cada corte y con las llaves de Argos", async () => {
    const orgId = `examen-${randomUUID()}`
    const c = await buildTwoCurrencyExam(ownerDb, appDb, orgId)
    const now = new Date()
    const { zone, names, texts, scope } = await withOrgContext(appDb, orgId, async (tx) => ({
      zone: await getOrgLocale(tx, orgId),
      names: await listArgosNames(tx, orgId, "gestion"),
      texts: await productAgentTexts(tx, orgId),
      scope: await reportScope(tx, orgId, { period: "este_mes" }, now),
    }))
    const words = {
      productName: "odentIA",
      recallMonths: texts.recallMonths,
      secondCurrency: "USD",
    }
    const figure = async (key: string, por?: string[]) => {
      const compiled = compileArgosFigure(
        { cifra: key, ...(por ? { por } : {}) },
        { key: "gestion", compare: false, names, words },
      )
      if ("problem" in compiled) throw new Error(`${key}: ${compiled.problem}`)
      const period = resolveArgosPeriod(
        { periodo: argosFigure(key)?.time === "a_hoy" ? "a_hoy" : "este_mes", compara: "no" },
        zone,
        now,
      )
      const bound = bindArgosPeriod(compiled.sql, period, null)
      if ("problem" in bound) throw new Error(`${key}: ${bound.problem}`)
      const rows = await argos(orgId, bound.sql)
      return Number(rows[0]?.[compiled.column] ?? 0)
    }
    const report = (key: string) =>
      withOrgContext(appDb, orgId, async (tx) => {
        const ctx: FigureContext = { tx, orgId, scope, billing: true }
        return (await computeFigure(ctx, { figure: key, group: "total" })).total.value ?? 0
      })

    // Cada cifra de dinero que está en Reportes, como `eval:argos-cifras`.
    const money = ARGOS_FIGURES.filter((item) => item.report && item.unit === "dinero")
    expect(money.map((item) => item.key)).toEqual([
      "cobrado",
      "lo_que_deja",
      "gastos",
      "comisiones",
      "te_deben",
      "deuda_vencida",
      "lo_que_viene",
    ])
    for (const item of money) {
      const mine = await figure(item.key)
      const theirs = await report(item.report ?? "")
      expect(Math.abs(mine - theirs / 100), item.key).toBeLessThanOrEqual(0.011)
    }
    // Las cifras a mano, para que el cuadre no sea de dos errores iguales.
    // Cobrado: S/ 3,750 + S/ 760 + S/ 300, lo anulado no cuenta y salen S/ 375 devueltos.
    expect(await report("cobrado")).toBe(375_000 + 76_000 + 30_000 - 37_500)
    // Gastos: S/ 500 y USD 100 con su valor de S/ 370, más lo pagado de la compra (USD 100 sin valor congelado, al cambio de hoy).
    expect(await report("gastos")).toBe(50_000 + 37_000 + 37_500)
    // Comisión del 30 % sobre lo que queda de cada cobro.
    expect(await report("comisiones")).toBe(101_250 + 22_800 + 9_000)
    // Lo que deben: USD 50 de Lucía, USD 300 y S/ 150 de Bruno, USD 200 de Carla.
    expect(await report("te_deben")).toBe(Math.round(55_000 * 3.75) + 15_000)
    expect(await report("deuda_vencida")).toBe(75_000)
    expect(await figure("deudores")).toBe(3)

    // Lo que viene: un presupuesto con líneas en cada moneda, una fila y su total de hoy.
    expect(await report("lo_que_viene")).toBe(187_500 + 10_000)
    expect(
      await argos(
        orgId,
        "select valor, aceptado, sin_decidir, valor_otra_moneda, otra_moneda from presupuestos",
      ),
    ).toEqual([
      { valor: 1975, aceptado: 1975, sin_decidir: 0, valor_otra_moneda: 500, otra_moneda: "USD" },
    ])
    expect(
      await argos(
        orgId,
        "select importe, importe_otra_moneda, otra_moneda from lineas_presupuesto order by importe",
      ),
    ).toEqual([
      { importe: 100, importe_otra_moneda: null, otra_moneda: null },
      { importe: 1875, importe_otra_moneda: 500, otra_moneda: "USD" },
    ])
    expect(
      await argos(
        orgId,
        "select precio, precio_otra_moneda, otra_moneda from planes order by precio",
      ),
    ).toEqual([
      { precio: 100, precio_otra_moneda: null, otra_moneda: null },
      { precio: 1875, precio_otra_moneda: 500, otra_moneda: "USD" },
    ])
    expect(
      (await c.run((tx) => getReportOutlook(tx, orgId, { period: "este_mes" }))).upcoming,
    ).toMatchObject({
      cents: 197_500,
      patients: 1,
      unbooked: { cents: 197_500, patients: 1 },
      byCurrency: [
        { currency: "PEN", cents: 10_000 },
        { currency: "USD", cents: 50_000 },
      ],
    })

    // Cada cifra con cada corte: su consulta corre sobre estas vistas.
    for (const item of ARGOS_FIGURES) {
      for (const cut of [null, ...new Set(item.sources.flatMap((source) => source.cuts))])
        await figure(item.key, cut ? [cut] : undefined)
    }

    // Las llaves de Argos leen las vistas y sus funciones, con la RLS de su clínica.
    expect(await one(orgId, "select sum(importe) as v from cobros", "cashier")).toBeCloseTo(
      (375_000 + 76_000 + 30_000 - 37_500) / 100,
      6,
    )
    expect(await one(orgId, "select count(*) as v from pacientes", "reception")).toBe(4)
    expect(await one(orgId, "select count(*) as v from presupuestos", "clinician")).toBe(1)
    expect(await one("org_a", "select coalesce(sum(importe), 0) as v from cobros")).toBe(0)

    // Lo que entró, por moneda: es lo que se compara con cada caja.
    const span = month()
    const methods = await c.run((tx) => collectedByMethod(tx, orgId, span, { currency: "PEN" }))
    const cashRow = methods.methods.find((row) => row.label === "Efectivo")
    expect(cashRow?.entered).toEqual([
      { currency: "PEN", cents: 375_000 - 37_500, valueCents: 375_000 - 37_500 },
      { currency: "USD", cents: 8_000, valueCents: 30_000 },
    ])
    expect(methods.methods.find((row) => row.label === "Tarjeta")).toMatchObject({
      cents: 76_000,
      entered: [{ currency: "USD", cents: 20_000, valueCents: 76_000 }],
    })

    // Finanzas › Cobros va por lo que entró: S/ 3,750 y lo demás en dólares.
    const tickets = await c.run((tx) =>
      listTickets(tx, orgId, { branchId: c.branchId, state: "vigentes" }),
    )
    const byCurrency = new Map(tickets.totals?.map((row) => [row.currency, row]))
    expect(byCurrency.get("PEN")).toMatchObject({ cobradoCents: 375_000, refundedCents: 37_500 })
    expect(byCurrency.get("USD")).toMatchObject({
      cobradoCents: 28_000,
      refundedCents: 0,
      byMethod: [
        { name: "Tarjeta", cents: 20_000 },
        { name: "Efectivo", cents: 8_000 },
      ],
    })

    // La caja de cada moneda cuadra con lo que entró en efectivo en ella.
    await c.run((tx) =>
      closeCashWindow(tx, orgId, c.actor, {
        branchId: c.branchId,
        currency: "USD",
        countedCents: 10_000,
        retainedCents: 10_000,
        deliveredCents: 0,
      }),
    )
    await c.run((tx) =>
      closeCashWindow(tx, orgId, c.actor, {
        branchId: c.branchId,
        currency: "PEN",
        countedCents: 280_000,
        retainedCents: 280_000,
        deliveredCents: 0,
      }),
    )
    const closed = await c.run((tx) => collectedByMethod(tx, orgId, span, { currency: "PEN" }))
    expect(closed.closures).toMatchObject({
      count: 1,
      cashCents: 375_000 - 37_500,
      others: [{ currency: "USD", count: 1, cashCents: 8_000 }],
    })

    // Lo que entró menos lo que salió en cada moneda, y lo que la compra aún debe.
    const finance = await c.run((tx) => getReportFinance(tx, orgId, { period: "este_mes" }))
    expect(finance.moneyFlow).toEqual([
      // S/ 3,750 − S/ 375 devueltos − S/ 75 de vuelto − S/ 500 de guantes.
      { currency: "PEN", cents: 375_000 - 37_500 - 7_500 - 50_000 },
      // USD 200 + USD 80 + USD 20 del billete − USD 100 de laboratorio − USD 100 de la compra.
      { currency: "USD", cents: 20_000 + 8_000 + 2_000 - 10_000 - 10_000 },
    ])
    expect(finance.payables.purchases).toMatchObject({
      cents: 75_000,
      orders: 1,
      byCurrency: [{ currency: "USD", cents: 20_000 }],
    })
    expect(
      await argos(
        orgId,
        "select total, pagado, por_pagar, total_otra_moneda, otra_moneda from compras",
      ),
    ).toEqual([
      { total: 1125, pagado: 375, por_pagar: 750, total_otra_moneda: 300, otra_moneda: "USD" },
    ])
  }, 120_000)

  it("el modelo de una clínica de una moneda no lee las columnas nuevas; el de una con dos, sí", () => {
    const texts = agentTextsFor("dental")
    const one = argosCatalogText("gestion", texts)
    const two = argosCatalogText("gestion", texts, { secondCurrency: "USD" })
    expect(one).not.toContain("otra_moneda")
    expect(one).not.toContain("por_pagar")
    expect(two).toContain("importe_otra_moneda")
    expect(two).toContain("por_pagar")
    expect(two).toContain("La clínica también cobra en USD")
    expect(two).toContain("una fila por paciente y moneda")
  })
})
