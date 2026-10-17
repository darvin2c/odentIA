/**
 * Reportes: una definición por cifra, igual en la tarjeta, en su lista y en la
 * comparación; el mes lo decide la zona horaria de la clínica y nada depende
 * de un país. Cada caso arma su propia clínica.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { agentHandoff } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { clinicalFollowUp, patientPayment } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { updateAdminSettings } from "./agent-admin.js"
import { setLine } from "./automation.js"
import {
  adjustBudgetLines,
  createBudget,
  decideBudget,
  deliverBudget,
  duplicateBudgetOption,
  getBudgetDetail,
  recommendBudgetOption,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import {
  getReportAdvice,
  getReportAgenda,
  getReportList,
  getReportMoney,
  getReportOverview,
  getReportSales,
  getReportService,
} from "./reports.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

/** Lunes 12 de octubre de 2026, 10:00 en Lima. */
const NOW = new Date("2026-10-12T15:00:00Z")

async function clinic(profile?: { country: string; currency: string; timezone: string; locale: string }) {
  const orgId = randomUUID()
  if (profile) {
    await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at")
      values (${orgId}, 'Clínica de prueba', ${`reportes-${orgId}`}, now())`)
    await ownerDb.execute(sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
      values (${orgId}, 'Clínica de prueba', ${profile.country}, ${profile.currency}, ${profile.timezone}, ${profile.locale})`)
  } else {
    await insertOrg(ownerDb, orgId, `reportes-${orgId}`)
  }
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const person = async (name: string, number: number) => {
    const [row] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber: number })
    return row!.id
  }
  const dentist = async (name: string) => {
    const id = randomUUID()
    await ownerDb.insert(user).values({ id, name, email: `${id}@reportes.test` })
    return id
  }
  const site = async (name: string) => {
    const [row] = await ownerDb.insert(branch).values({ organizationId: orgId, name }).returning()
    const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: row!.id, name: "Unidad dental 1" }).returning()
    return { branchId: row!.id, chairId: chair!.id }
  }
  const visit = (
    place: { branchId: string; chairId: string },
    dentistUserId: string,
    patientId: string,
    startsAt: string,
    status: string,
    source = "recepcion",
  ) =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      ...place,
      dentistUserId,
      patientId,
      serviceName: "Evaluación",
      startsAt: new Date(startsAt),
      endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000),
      durationMin: 30,
      status,
      source,
    })
  return { orgId, run, person, dentist, site, visit }
}

it("agenda: cada cita cae en un solo grupo, por su fecha en la zona de la clínica y por sede", async () => {
  const c = await clinic()
  const [a, b] = [await c.site("Sede A"), await c.site("Sede B")]
  const [ana, luis] = [await c.dentist("Ana"), await c.dentist("Luis")]
  const [p1, p2, p3, p4, p5] = [await c.person("Uno", 1), await c.person("Dos", 2), await c.person("Tres", 3), await c.person("Cuatro", 4), await c.person("Cinco", 5)]
  // Septiembre.
  await c.visit(a, ana, p1, "2026-09-03T15:00:00Z", "atendida")
  await c.visit(a, ana, p2, "2026-09-04T15:00:00Z", "atendida", "agente")
  await c.visit(b, luis, p3, "2026-09-05T15:00:00Z", "atendida", "enlace")
  await c.visit(a, ana, p4, "2026-09-08T15:00:00Z", "no_asistio")
  await c.visit(b, luis, p5, "2026-09-09T15:00:00Z", "cancelada")
  // Pasó y nadie la marcó.
  await c.visit(a, ana, p1, "2026-09-10T15:00:00Z", "programada")
  // 30 de septiembre a las 22:00 en Lima: sigue siendo septiembre aunque en UTC ya es octubre.
  await c.visit(b, luis, p3, "2026-10-01T03:00:00Z", "atendida")
  // Agosto, incluido el 31 a las 22:00 en Lima.
  await c.visit(a, ana, p1, "2026-08-10T15:00:00Z", "atendida")
  await c.visit(a, ana, p2, "2026-08-11T15:00:00Z", "no_asistio")
  await c.visit(b, luis, p4, "2026-09-01T03:00:00Z", "atendida")
  // Octubre: una atendida y una que todavía no ocurre.
  await c.visit(a, ana, p5, "2026-10-05T15:00:00Z", "atendida")
  await c.visit(a, ana, p2, "2026-10-20T15:00:00Z", "programada")

  const september = await c.run((tx) => getReportAgenda(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(september.appointments).toEqual({ total: 7, attended: 4, noShow: 1, cancelled: 1, unmarked: 1 })
  expect(september.previousAppointments).toEqual({ total: 3, attended: 2, noShow: 1, cancelled: 0, unmarked: 0 })
  expect(september.byProfessional).toEqual([
    { userId: ana, name: "Ana", total: 4, attended: 2, noShow: 1 },
    { userId: luis, name: "Luis", total: 3, attended: 2, noShow: 0 },
  ])
  expect(september.bySource).toEqual([
    { source: "recepcion", count: 5 },
    { source: "agente", count: 1 },
    { source: "enlace", count: 1 },
  ])
  // Un solo mes no trae serie; varios meses, una fila por mes.
  expect(september.series).toEqual([])

  const onlyA = await c.run((tx) => getReportAgenda(tx, c.orgId, { period: "2026-09", branchId: a.branchId }, NOW))
  expect(onlyA.appointments).toEqual({ total: 4, attended: 2, noShow: 1, cancelled: 0, unmarked: 1 })
  expect(onlyA.branch).toEqual({ id: a.branchId, name: "Sede A" })

  // El mes en curso no cuenta lo que aún no ocurre y se compara con los mismos días de septiembre.
  const october = await c.run((tx) => getReportAgenda(tx, c.orgId, { period: "este_mes" }, NOW))
  expect(october.appointments).toEqual({ total: 1, attended: 1, noShow: 0, cancelled: 0, unmarked: 0 })
  expect(october.previousAppointments.total).toBe(6)
  expect(october.period.partial).toBe(true)

  const quarter = await c.run((tx) => getReportAgenda(tx, c.orgId, { period: "ultimos_3_meses" }, NOW))
  expect(quarter.series.map((row) => [row.month, row.attended])).toEqual([
    [7, 0],
    [8, 2],
    [9, 4],
  ])

  // La lista tiene tantas filas como dice la cifra, y avisa de quien ya tiene otra cita.
  const noShow = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "no_show" }, NOW))
  expect(noShow.total).toBe(september.appointments.noShow)
  expect(noShow.rows).toEqual([
    expect.objectContaining({ patientId: p4, personName: "Cuatro", title: "Evaluación", professionalName: "Ana", branchName: "Sede A", hasNextAppointment: false }),
  ])
  const unmarked = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "unmarked" }, NOW))
  expect(unmarked.rows.map((row) => row.patientId)).toEqual([p1])

  // Pacientes nuevos: su primera cita atendida cae en el periodo.
  const sales = await c.run((tx) => getReportSales(tx, c.orgId, { period: "2026-09" }, NOW))
  expect([sales.newPatients, sales.previousNewPatients]).toEqual([2, 2])
  const salesA = await c.run((tx) => getReportSales(tx, c.orgId, { period: "2026-09", branchId: a.branchId }, NOW))
  expect(salesA.newPatients).toBe(1)
  const fresh = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "new_patients" }, NOW))
  expect(fresh.total).toBe(2)
  expect(fresh.rows.map((row) => [row.patientId, row.hasNextAppointment])).toEqual([
    [p3, false],
    [p2, true],
  ])

  // Las cuatro cifras de arriba salen de las mismas consultas.
  const overview = await c.run((tx) => getReportOverview(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(overview.agenda).toEqual({ attended: 4, previousAttended: 2 })
  expect(overview.sales).toEqual({ newPatients: 2, previousNewPatients: 2 })
  expect(overview.money).toEqual([])
  expect(overview.service).toEqual({ avgFirstResponseSeconds: null, previousAvgFirstResponseSeconds: null })
})

it("controles: los que tocaban en el periodo, según su estado a hoy", async () => {
  const c = await clinic()
  const [p1, p2] = [await c.person("Uno", 1), await c.person("Dos", 2)]
  await ownerDb.insert(clinicalFollowUp).values([
    { organizationId: c.orgId, patientId: p1, kind: "mantenimiento", title: "Control de limpieza", dueAt: new Date("2026-09-15T15:00:00Z") },
    { organizationId: c.orgId, patientId: p2, kind: "mantenimiento", title: "Control anual", dueAt: new Date("2026-09-16T15:00:00Z"), status: "cancelado", cancelledAt: new Date("2026-09-10T15:00:00Z"), cancelledReason: "Se mudó" },
    // Marcado como realizado sin una atención cerrada que lo respalde: no cuenta como venido.
    { organizationId: c.orgId, patientId: p2, kind: "mantenimiento", title: "Control antiguo", dueAt: new Date("2026-09-17T15:00:00Z"), status: "realizado" },
    { organizationId: c.orgId, patientId: p1, kind: "mantenimiento", title: "Control de octubre", dueAt: new Date("2026-10-20T15:00:00Z") },
  ])
  const report = await c.run((tx) => getReportAgenda(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(report.controls).toEqual({ due: 3, came: 0, pending: 1, cancelled: 1, unknown: 1 })
  expect(report.wholeClinic).toEqual([])
  const pending = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "controls_pending" }, NOW))
  expect(pending.total).toBe(report.controls.pending)
  expect(pending.rows).toEqual([expect.objectContaining({ patientId: p1, title: "Control de limpieza" })])
})

it("presupuestos: tres grupos que suman el total, y lo aceptado en parte cuenta por lo aceptado", async () => {
  const quote = async (decisions: Array<"aceptado" | "rechazado"> | null, lines = 1) => {
    const f = await clinicalFixture()
    const items: Array<{ id: string }> = []
    for (let i = 0; i < lines; i += 1)
      items.push(await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id })))
    const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: items.map((item) => item.id) }))
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    if (decisions)
      await f.run((tx) =>
        decideBudget(tx, ...f.args, budget.id, { decisions: items.map((item, index) => ({ planItemId: item.id, decision: decisions[index]! })) }),
      )
    return f
  }
  await quote(["aceptado"])
  await quote(["aceptado", "rechazado"], 2)
  const waiting = await quote(null)
  await quote(["rechazado"])

  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const sales = await run((tx) => getReportSales(tx, "org_a", { period: "este_mes" }))
  expect(sales.budgets).toEqual([
    {
      currency: "PEN",
      accepted: { count: 2, cents: 240000 },
      waiting: { count: 1, cents: 120000 },
      rejected: { count: 1, cents: 120000 },
    },
  ])
  const list = await run((tx) => getReportList(tx, "org_a", { period: "este_mes", list: "budgets_waiting" }))
  expect(list.total).toBe(1)
  expect(list.rows).toEqual([expect.objectContaining({ patientId: waiting.patient.id, cents: 120000, currency: "PEN" })])
})

it("presupuestos con opciones: cuenta la recomendada, como el resto de la aplicación, nunca la suma", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  const withTwo = await f.run((tx) => duplicateBudgetOption(tx, ...f.args, budget.id, budget.options[0]!.id))
  const optionB = withTwo.options[1]!
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, optionId: optionB.id, priceCents: 300000 }] }),
  )
  await f.run((tx) => recommendBudgetOption(tx, ...f.args, budget.id, optionB.id))
  // La clínica de prueba es compartida: se mide lo que suma este presupuesto.
  const waitingOf = async () =>
    (await f.run((tx) => getReportSales(tx, "org_a", { period: "este_mes" }))).budgets[0]?.waiting ?? { count: 0, cents: 0 }
  const before = await waitingOf()
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const detail = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))
  expect(detail.totalCents).toBe(300000)

  const after = await waitingOf()
  expect({ count: after.count - before.count, cents: after.cents - before.cents }).toEqual({ count: 1, cents: 300000 })
  const list = await f.run((tx) => getReportList(tx, "org_a", { period: "este_mes", list: "budgets_waiting" }))
  expect(list.rows.find((row) => row.id === budget.id)).toEqual(expect.objectContaining({ cents: detail.totalCents }))
})

it("atención: quién respondió primero, por dónde escribieron y qué pasó el agente al equipo", async () => {
  const c = await clinic()
  const [person] = await ownerDb.insert(contact).values({ organizationId: c.orgId, displayName: "Interlocutor" }).returning()
  const channel = async (name: string) => {
    const [row] = await ownerDb
      .insert(channelConnection)
      .values({ organizationId: c.orgId, channel: name, provider: "prueba", displayName: name, configEncrypted: "x", webhookSecret: "y" })
      .returning()
    return row!.id
  }
  const [whatsapp, instagram] = [await channel("whatsapp"), await channel("instagram")]
  const thread = async (connectionId: string, inboundAt: string, reply: { kind: "agent" | "user"; seconds: number } | null) => {
    const [row] = await ownerDb
      .insert(conversation)
      .values({ organizationId: c.orgId, contactId: person!.id, channelConnectionId: connectionId, externalThreadId: randomUUID() })
      .returning()
    const at = new Date(inboundAt)
    await ownerDb.insert(message).values({ organizationId: c.orgId, conversationId: row!.id, direction: "in", senderKind: "contact", status: "received", createdAt: at })
    if (reply) {
      const sentAt = new Date(at.getTime() + reply.seconds * 1000)
      await ownerDb.insert(message).values({
        organizationId: c.orgId, conversationId: row!.id, direction: "out", senderKind: reply.kind, status: "sent", externalId: `proveedor-${randomUUID()}`, createdAt: sentAt, sentAt,
      })
    }
    return row!.id
  }
  const handed = await thread(whatsapp, "2026-09-10T15:00:00Z", { kind: "agent", seconds: 60 })
  await thread(whatsapp, "2026-09-11T15:00:00Z", { kind: "agent", seconds: 120 })
  await thread(instagram, "2026-09-12T15:00:00Z", { kind: "user", seconds: 600 })
  await thread(whatsapp, "2026-09-13T15:00:00Z", null)
  await thread(whatsapp, "2026-08-13T15:00:00Z", { kind: "user", seconds: 300 })
  await ownerDb.insert(agentHandoff).values({ organizationId: c.orgId, conversationId: handed, contactId: person!.id, reason: "Pide hablar con alguien", summary: "Escribió", createdAt: new Date("2026-09-10T15:05:00Z") })

  const report = await c.run((tx) => getReportService(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(report.responses).toEqual({ conversations: 4, responded: 3, timedResponses: 3, avgFirstResponseSeconds: 260, byAgent: 2, byTeam: 1, handedOff: 1 })
  expect(report.previousResponses).toMatchObject({ conversations: 1, responded: 1, avgFirstResponseSeconds: 300 })
  expect(report.byChannel).toEqual([
    { channel: "whatsapp", count: 3 },
    { channel: "instagram", count: 1 },
  ])
  const overview = await c.run((tx) => getReportOverview(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(overview.service).toEqual({ avgFirstResponseSeconds: 260, previousAvgFirstResponseSeconds: 300 })
})

it("dinero: totales del periodo, del anterior y por mes, en la moneda y la zona de otra clínica", async () => {
  // Una clínica de otro país: euros y hora de Madrid.
  const c = await clinic({ country: "ES", currency: "EUR", timezone: "Europe/Madrid", locale: "es-ES" })
  const place = await c.site("Centro")
  const [doctor, p1] = [await c.dentist("Marta"), await c.person("Uno", 1)]
  const pay = (paidAt: string, amountCents: number) =>
    ownerDb.insert(patientPayment).values({ organizationId: c.orgId, patientId: p1, branchId: place.branchId, amountCents, currency: "EUR", paidAt: new Date(paidAt), methodName: "tarjeta" })
  await pay("2026-08-10T10:00:00Z", 10000)
  // 31 de agosto a las 22:30 UTC: en Madrid ya es 1 de septiembre.
  await pay("2026-08-31T22:30:00Z", 5000)
  await pay("2026-09-15T10:00:00Z", 20000)
  await c.visit(place, doctor, p1, "2026-08-31T22:30:00Z", "atendida")

  const september = await c.run((tx) => getReportMoney(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(september).toMatchObject({ timezone: "Europe/Madrid", locale: "es-ES", currency: "EUR", series: [] })
  expect(september.byCurrency).toEqual([expect.objectContaining({ currency: "EUR", netoCents: 25000, gastadoCents: 0, quedaCents: 25000 })])
  expect(september.previousTotals).toEqual([{ currency: "EUR", netoCents: 10000, gastadoCents: 0, quedaCents: 10000 }])

  const quarter = await c.run((tx) => getReportMoney(tx, c.orgId, { period: "ultimos_3_meses" }, NOW))
  expect(quarter.series.map((row) => [row.month, row.totals])).toEqual([
    [7, []],
    [8, [{ currency: "EUR", netoCents: 10000, gastadoCents: 0, quedaCents: 10000 }]],
    [9, [{ currency: "EUR", netoCents: 25000, gastadoCents: 0, quedaCents: 25000 }]],
  ])
  expect(quarter.previousTotals).toEqual([])

  const overview = await c.run((tx) => getReportOverview(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(overview.money).toEqual([{ currency: "EUR", quedaCents: 25000, previousQuedaCents: 10000 }])
  expect(overview.agenda.attended).toBe(1)
})

it("el asesor acompaña a la cifra solo si está encendido y hay algo que hacer", async () => {
  const c = await clinic()
  const [a, b] = [await c.site("Sede A"), await c.site("Sede B")]
  const [doctor, other, absent, present] = [await c.dentist("Ana"), await c.dentist("Luis"), await c.person("Falta", 1), await c.person("Viene", 2)]
  // Una inasistencia y una atendida hace veinte minutos: la detección mira desde ahora.
  const recent = new Date(Date.now() - 20 * 60_000)
  await c.visit(a, doctor, absent, recent.toISOString(), "no_asistio")
  await c.visit(b, other, present, recent.toISOString(), "atendida")
  // El mes de esas citas en la zona de la clínica (casi siempre el mes en curso).
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).format(recent)
  const everyone = (): boolean => true

  // Apagado no dice nada.
  expect(await c.run((tx) => getReportAdvice(tx, c.orgId, { period: month }, everyone))).toEqual({ enabled: false, notices: [] })

  await c.run((tx) => updateAdminSettings(tx, c.orgId, doctor, { enabled: true }))
  const advice = await c.run((tx) => getReportAdvice(tx, c.orgId, { period: month }, everyone))
  expect(advice.enabled).toBe(true)
  expect(advice.notices).toEqual([
    {
      tab: "agenda",
      key: "seguimiento_no_asistencia",
      title: "1 persona faltó a su cita en los últimos 30 días y no tiene otra",
      total: 1,
      rate: 50,
      previousRate: null,
      // Nombra la línea que sí lo atendería, que hoy está apagada.
      line: "Reprogramar tras una inasistencia",
    },
  ])

  // Quien no ve la agenda no recibe el aviso. Si se pidió no recomendarla más, o
  // si la línea ya está prendida (se está atendiendo), tampoco.
  expect((await c.run((tx) => getReportAdvice(tx, c.orgId, { period: month }, () => false))).notices).toEqual([])
  await c.run((tx) => setLine(tx, c.orgId, doctor, "seguimiento_no_asistencia", { noRecommend: true }))
  expect((await c.run((tx) => getReportAdvice(tx, c.orgId, { period: month }, everyone))).notices).toEqual([])
  await c.run((tx) => setLine(tx, c.orgId, doctor, "seguimiento_no_asistencia", { noRecommend: false, enabled: true }))
  expect((await c.run((tx) => getReportAdvice(tx, c.orgId, { period: month }, everyone))).notices).toEqual([])
})
