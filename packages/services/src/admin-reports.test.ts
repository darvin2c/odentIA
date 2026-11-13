import { saasClient, saasOpportunity, saasProposal } from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import {
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSubscription,
} from "@odentia/db/schema/saas-billing"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { forecastReport, funnelReport, reportRatio, revenueReport } from "./admin-reports.js"
import { getCostMarginOverview } from "./saas-cost.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Reportes del ARM: embudo, ingresos y previsión, solo para Administración. */
setupTestDb()
const admin: AdminActor = { userId: "rp-admin", role: "admin" }
const support: AdminActor = { userId: "rp-support", role: "support" }
const LUCIA = "rp-lucia"
/** Mediodía del 12 de noviembre de 2026 en Lima. */
const NOW = new Date("2026-11-12T17:00:00Z")
const DAY = 86_400_000
/** Un instante de Lima: `day` a las 10:00 (UTC−5). */
const lima = (day: string) => new Date(`${day}T15:00:00Z`)

let usdPlan: string
let penPlan: string
const ids: Record<string, string> = {}

async function client(
  key: string,
  values: {
    name: string
    createdAt: Date
    origin?: string
    product?: string
    owner?: string | null
    org?: string
    archived?: boolean
  },
): Promise<string> {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({
      name: values.name,
      product: values.product ?? "dental",
      origin: values.origin ?? "otro",
      ownerUserId: values.owner ?? null,
      organizationId: values.org ?? null,
      archivedAt: values.archived ? values.createdAt : null,
      createdAt: values.createdAt,
      updatedAt: values.createdAt,
    })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("No se guardó el cliente de prueba")
  ids[key] = row.id
  return row.id
}

async function presentation(clientId: string, at: Date): Promise<void> {
  await ownerDb.insert(saasFollowUp).values({
    clientId,
    kind: "presentacion",
    body: "Presentamos la agenda y Sofi.",
    authorUserId: admin.userId,
    happenedAt: at,
    createdAt: at,
  })
}

async function proposal(
  clientId: string,
  values: {
    version: number
    status: string
    sentAt?: Date
    validUntil: string
    listPriceCents?: number
    discountBps?: number
  },
): Promise<string> {
  const [row] = await ownerDb
    .insert(saasProposal)
    .values({
      clientId,
      version: values.version,
      planId: usdPlan,
      listPriceCents: values.listPriceCents ?? 2900,
      currency: "USD",
      discountBps: values.discountBps ?? 0,
      validUntil: values.validUntil,
      status: values.status,
      sentAt: values.sentAt ?? null,
      createdBy: admin.userId,
    })
    .returning({ id: saasProposal.id })
  if (!row) throw new Error("No se guardó la propuesta de prueba")
  return row.id
}

async function subscription(
  orgId: string,
  values: {
    planId: string
    status: string
    isDemo?: boolean
    discountBps?: number
    discountEndsAt?: Date | null
    updatedAt?: Date
  },
): Promise<void> {
  const set = {
    planId: values.planId,
    status: values.status,
    isDemo: values.isDemo ?? false,
    discountBps: values.discountBps ?? 0,
    discountEndsAt: values.discountEndsAt ?? null,
    activatedAt: new Date(NOW.getTime() - 40 * DAY),
    currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
    updatedAt: values.updatedAt ?? NOW,
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: orgId, ...set })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set })
}

let paymentCount = 0
async function payment(
  orgId: string,
  values: {
    amountCents: number
    currency: string
    status: "confirmado" | "pendiente" | "reversado"
    at: Date
  },
): Promise<void> {
  paymentCount += 1
  await ownerDb.insert(saasPayment).values({
    organizationId: orgId,
    amountCents: values.amountCents,
    currency: values.currency,
    methodCode: "transferencia",
    status: values.status,
    idempotencyKey: `rp-${paymentCount}`,
    confirmedAt: values.status === "pendiente" ? null : values.at,
    confirmedBy: values.status === "pendiente" ? null : admin.userId,
    reversedAt: values.status === "reversado" ? values.at : null,
    reversedBy: values.status === "reversado" ? admin.userId : null,
    reverseReason: values.status === "reversado" ? "Cobro duplicado" : null,
    createdAt: values.at,
    updatedAt: values.at,
  })
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@reports.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@reports.test" },
    { id: LUCIA, name: "Lucía Ventas", email: "lucia@reports.test" },
  ])
  const [usd] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "rp-clinica",
      name: "Plan Clínica",
      currency: "USD",
      priceCents: 2900,
      product: "dental",
    })
    .returning({ id: saasPlan.id })
  const [pen] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "rp-consultorio",
      name: "Plan Consultorio",
      currency: "PEN",
      priceCents: 9900,
      product: "medical",
    })
    .returning({ id: saasPlan.id })
  if (!usd || !pen) throw new Error("No se guardaron los planes de prueba")
  usdPlan = usd.id
  penPlan = pen.id
  for (const [id, slug] of [
    ["rp-andes", "rp-andes"],
    ["rp-sur", "rp-sur"],
    ["rp-prueba", "rp-prueba"],
    ["rp-demo", "rp-demo"],
    ["rp-baja", "rp-baja"],
  ] as const)
    await insertOrg(ownerDb, id, slug)

  /* Embudo */
  // Andes: presentación → propuesta → entró (7, 10 y 11 días en cada etapa).
  const andes = await client("andes", {
    name: "Dental Andes (ficticia)",
    createdAt: lima("2026-09-03"),
    origin: "web",
    owner: admin.userId,
    org: "rp-andes",
  })
  await presentation(andes, lima("2026-09-10"))
  await proposal(andes, {
    version: 1,
    status: "aceptada",
    sentAt: lima("2026-09-20"),
    validUntil: "2026-10-20",
  })
  // Ya tiene cuenta: su propuesta enviada no entra en la previsión.
  await proposal(andes, {
    version: 2,
    status: "enviada",
    sentAt: lima("2026-11-01"),
    validUntil: "2026-12-01",
    listPriceCents: 5900,
  })
  await ownerDb.insert(saasOpportunity).values({
    clientId: andes,
    decision: "entro",
    decidedAt: lima("2026-10-01"),
    decidedBy: admin.userId,
    createdAt: lima("2026-09-03"),
  })
  // Piura: presentación y se perdió por precio.
  const piura = await client("piura", {
    name: "Dental Piura (ficticia)",
    createdAt: lima("2026-09-15"),
    origin: "referido",
  })
  await presentation(piura, lima("2026-09-25"))
  await ownerDb.insert(saasOpportunity).values({
    clientId: piura,
    decision: "perdido",
    reason: "precio",
    decidedAt: lima("2026-10-05"),
    decidedBy: admin.userId,
    createdAt: lima("2026-09-15"),
  })
  // Cusco: propuesta sin presentación (se la saltó), abierta; tres versiones enviadas, la primera vencida.
  const cusco = await client("cusco", {
    name: "Sonrisas Cusco (ficticia)",
    createdAt: lima("2026-10-02"),
    origin: "web",
    owner: admin.userId,
  })
  await proposal(cusco, {
    version: 1,
    status: "enviada",
    sentAt: lima("2026-10-10"),
    validUntil: "2026-11-01",
  })
  await proposal(cusco, {
    version: 2,
    status: "enviada",
    sentAt: lima("2026-10-11"),
    validUntil: "2026-11-20",
    listPriceCents: 2500,
  })
  await proposal(cusco, {
    version: 3,
    status: "enviada",
    sentAt: lima("2026-10-12"),
    validUntil: "2026-11-30",
    discountBps: 2000,
  })
  await ownerDb.insert(saasOpportunity).values({ clientId: cusco, createdAt: lima("2026-10-02") })
  // Arequipa (latidIA): no por ahora.
  const arequipa = await client("arequipa", {
    name: "Consultorio Arequipa (ficticia)",
    createdAt: lima("2026-10-20"),
    origin: "evento",
    product: "medical",
    owner: LUCIA,
  })
  await proposal(arequipa, { version: 1, status: "borrador", validUntil: "2026-12-31" })
  await ownerDb.insert(saasOpportunity).values({
    clientId: arequipa,
    decision: "no_por_ahora",
    reason: "no_es_el_momento",
    returnOn: "2027-02-01",
    decidedAt: lima("2026-10-28"),
    decidedBy: admin.userId,
    createdAt: lima("2026-10-20"),
  })
  // Trujillo: recién llegó.
  await client("trujillo", {
    name: "Dental Trujillo (ficticia)",
    createdAt: lima("2026-11-05"),
    origin: "web",
  })
  // No cuentan: archivada, demo y fuera de los meses.
  await client("archivada", {
    name: "Archivada (ficticia)",
    createdAt: lima("2026-11-06"),
    archived: true,
  })
  await client("demo", {
    name: "Demo para presentar",
    createdAt: lima("2026-11-02"),
    org: "rp-demo",
  })
  await client("vieja", { name: "Clínica de enero (ficticia)", createdAt: lima("2026-01-10") })

  /* Ingresos */
  await subscription("rp-andes", { planId: usdPlan, status: "activa", discountBps: 1000 })
  await payment("rp-andes", {
    amountCents: 2900,
    currency: "USD",
    status: "confirmado",
    at: lima("2026-10-03"),
  })
  await payment("rp-andes", {
    amountCents: 2900,
    currency: "USD",
    status: "confirmado",
    at: lima("2026-11-04"),
  })
  await payment("rp-andes", {
    amountCents: 1000,
    currency: "USD",
    status: "reversado",
    at: lima("2026-11-05"),
  })
  // Descuento vencido: no cuenta como vigente.
  await subscription("rp-sur", {
    planId: penPlan,
    status: "activa",
    discountBps: 500,
    discountEndsAt: lima("2026-11-01"),
  })
  await payment("rp-sur", {
    amountCents: 9900,
    currency: "PEN",
    status: "confirmado",
    at: lima("2026-11-02"),
  })
  // Activa sin ningún pago confirmado: no paga.
  await subscription("rp-prueba", { planId: usdPlan, status: "activa" })
  await payment("rp-prueba", {
    amountCents: 2900,
    currency: "USD",
    status: "pendiente",
    at: lima("2026-11-06"),
  })
  await subscription("rp-demo", { planId: usdPlan, status: "activa", isDemo: true })
  await payment("rp-demo", {
    amountCents: 5000,
    currency: "USD",
    status: "confirmado",
    at: lima("2026-11-03"),
  })
  await payment("rp-baja", {
    amountCents: 2900,
    currency: "USD",
    status: "confirmado",
    at: lima("2026-08-10"),
  })
  await subscription("rp-baja", {
    planId: usdPlan,
    status: "cancelada",
    updatedAt: lima("2026-10-15"),
  })
}, 180_000)

describe("quién los ve", () => {
  it("solo Administración: Soporte y el sistema reciben 403", async () => {
    for (const actor of [support, null]) {
      await expect(funnelReport(ownerDb, actor, {}, NOW)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      })
      await expect(revenueReport(ownerDb, actor, NOW)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      })
      await expect(forecastReport(ownerDb, actor, NOW)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      })
    }
  })

  it("los meses van de 1 a 24, con el error en su campo", async () => {
    await expect(funnelReport(ownerDb, admin, { months: 0 }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { months: expect.any(String) },
    })
    await expect(revenueReport(ownerDb, admin, NOW, { months: 25 })).rejects.toMatchObject({
      code: "VALIDATION",
    })
  })
})

describe("proporciones", () => {
  it("con pocos casos dice «n de m»; con 10 o más, el porcentaje", () => {
    expect(reportRatio(3, 7, "x").words).toBe("3 de 7")
    expect(reportRatio(3, 50, "x").words).toBe("3 de 50")
    expect(reportRatio(15, 20, "x")).toMatchObject({ pct: 75, words: "75 %" })
    expect(reportRatio(0, 0, "x")).toMatchObject({ pct: null, words: "Sin casos" })
  })
})

describe("embudo", () => {
  it("cuenta las etapas por los hechos, sin demos, archivadas ni meses de fuera", async () => {
    const report = await funnelReport(ownerDb, admin, {}, NOW)
    expect(report).toMatchObject({ from: "2026-06-01", to: "2026-11-12", months: 6 })
    expect(report.spanWords).toBe("junio a noviembre")
    expect(report.clients.value).toBe(5)
    // Cusco se saltó la presentación: cuenta como que pasó por ella.
    expect(report.stages.map((stage) => [stage.stage, stage.reached.value])).toEqual([
      ["contacto", 5],
      ["presentacion_hecha", 3],
      ["propuesta", 2],
      ["entro", 1],
    ])
    expect(report.stages.map((stage) => stage.fromPrevious?.words ?? null)).toEqual([
      null,
      "3 de 5",
      "2 de 3",
      "1 de 2",
    ])
    expect(report.conversion).toMatchObject({ n: 1, m: 5, words: "1 de 5" })
    for (const stage of report.stages)
      expect(stage.reached.howCalculated.length).toBeGreaterThan(20)
  })

  it("el tiempo típico es la mediana de días hasta el siguiente hecho", async () => {
    const report = await funnelReport(ownerDb, admin, {}, NOW)
    const [contacto, presentada, propuesta, entro] = report.stages
    // Andes 7, Piura 10, Cusco 8 (de contacto directo a propuesta).
    expect(contacto?.medianDays).toMatchObject({ value: 8, cases: 3, words: "8 días (3 casos)" })
    expect(presentada?.medianDays).toMatchObject({ value: 10, cases: 1 })
    expect(propuesta?.medianDays).toMatchObject({ value: 11, cases: 1, words: "11 días (1 caso)" })
    expect(entro?.medianDays).toBeNull()
    expect(contacto?.medianDays?.howCalculated).toContain("mediana")
  })

  it("resultados por mes, origen, producto y responsable, y los motivos de pérdida", async () => {
    const report = await funnelReport(ownerDb, admin, {}, NOW)
    expect(
      Object.fromEntries(
        Object.entries(report.outcomes).map(([key, figure]) => [key, figure.value]),
      ),
    ).toEqual({
      entro: 1,
      no_por_ahora: 1,
      perdido: 1,
      abierta: 2,
    })
    expect(report.cohorts.map((cohort) => [cohort.month, cohort.clients])).toEqual([
      ["2026-06", 0],
      ["2026-07", 0],
      ["2026-08", 0],
      ["2026-09", 2],
      ["2026-10", 2],
      ["2026-11", 1],
    ])
    const september = report.cohorts.find((cohort) => cohort.month === "2026-09")
    expect(september).toMatchObject({
      label: "setiembre",
      reached: { contacto: 2, presentacion_hecha: 2, propuesta: 1, entro: 1 },
      outcomes: { entro: 1, perdido: 1 },
      conversion: { words: "1 de 2" },
    })
    expect(
      report.byOrigin.map((row) => [row.key, row.label, row.clients, row.conversion.words]),
    ).toEqual([
      ["web", "Web", 3, "1 de 3"],
      ["evento", "Evento", 1, "0 de 1"],
      ["referido", "Referido", 1, "0 de 1"],
    ])
    expect(report.byProduct.map((row) => [row.label, row.clients])).toEqual([
      ["odentIA", 4],
      ["latidIA", 1],
    ])
    expect(report.byOwner.map((row) => [row.label, row.clients])).toEqual([
      ["Ada Administración", 2],
      ["Sin responsable", 2],
      ["Lucía Ventas", 1],
    ])
    expect(report.lostReasons).toEqual([{ reason: "precio", label: "Precio", count: 1 }])
    expect(report.lost.value).toBe(1)
  })

  it("con un mes solo mira el mes en curso", async () => {
    const report = await funnelReport(ownerDb, admin, { months: 1 }, NOW)
    expect(report.clients.value).toBe(1)
    expect(report.spanWords).toBe("noviembre")
  })
})

describe("ingresos", () => {
  it("la cuota de las que pagan, por moneda, y cuántas tienen descuento vigente", async () => {
    const report = await revenueReport(ownerDb, admin, NOW)
    expect(report).toMatchObject({ month: "2026-11", monthLabel: "noviembre" })
    expect(report.paying.value).toBe(2)
    expect(report.monthlyFee.amounts).toEqual([
      { currency: "PEN", cents: 9900 },
      { currency: "USD", cents: 2900 },
    ])
    expect(report.monthlyFee.words).toBe("PEN 99 y USD 29")
    expect(report.monthlyFee.howCalculated).toContain("no a la cuota")
    expect(report.withDiscount.value).toBe(1)
  })

  it("lo cobrado y confirmado del mes, sin reversos, pendientes ni demos", async () => {
    const report = await revenueReport(ownerDb, admin, NOW)
    expect(report.collected).toMatchObject({
      payments: 2,
      amounts: [
        { currency: "PEN", cents: 9900 },
        { currency: "USD", cents: 2900 },
      ],
    })
    expect(report.collected.howCalculated).toContain("noviembre")
  })

  it("altas por el primer pago confirmado y bajas por la cancelación", async () => {
    const report = await revenueReport(ownerDb, admin, NOW)
    expect(report.movements.map((row) => [row.month, row.starts, row.stops])).toEqual([
      ["2026-06", 0, 0],
      ["2026-07", 0, 0],
      ["2026-08", 1, 0],
      ["2026-09", 0, 0],
      ["2026-10", 1, 1],
      ["2026-11", 1, 0],
    ])
    expect(report.starts.value).toBe(3)
    expect(report.stops.value).toBe(1)
  })

  it("el costo y el margen son los de «Costo y margen»", async () => {
    const report = await revenueReport(ownerDb, admin, NOW)
    const overview = await getCostMarginOverview(ownerDb, NOW)
    expect(report.costMargin).toMatchObject({
      clinics: overview.clinics.length,
      chargedCents: overview.chargedCents,
      costMicros: overview.costMicros,
      marginPct: overview.marginPct,
    })
    expect(report.costMargin.margin.howCalculated).toContain("Costo y margen")
  })
})

describe("previsión", () => {
  it("la última propuesta enviada y vigente de cada cliente sin cuenta, sin probabilidades", async () => {
    const report = await forecastReport(ownerDb, admin, NOW)
    expect(report.today).toBe("2026-11-12")
    expect(report.rows).toEqual([
      expect.objectContaining({
        clientId: ids.cusco,
        version: 3,
        planName: "Plan Clínica",
        monthlyCents: 2900,
        discountBps: 2000,
        validUntil: "2026-11-30",
        daysLeft: 18,
      }),
    ])
    expect(report.proposals.value).toBe(1)
    expect(report.total).toMatchObject({
      amounts: [{ currency: "USD", cents: 2900 }],
      words: "USD 29",
    })
    expect(report.total.howCalculated).toContain("probabilidad")
  })
})
