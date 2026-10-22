/**
 * Reportes: una definición por cifra, igual en la tarjeta, en su lista y en la
 * comparación; el mes lo decide la zona horaria de la clínica y nada depende
 * de un país. Cada caso arma su propia clínica.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { agentHandoff } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { clinicalFollowUp, encounter, encounterProcedure, patientPayment } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
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
import { createPromotion } from "./promotions.js"
import { getAgendaReport } from "./report-agenda.js"
import { getReportAgent } from "./report-agent.js"
import { getReportCommissions, getReportFinance, getReportOutlook, getReportPromotions } from "./report-finance.js"
import { getPatientReportList, getReportPatients } from "./report-patients.js"
import { getReportAdvice, getReportList } from "./reports.js"
import { getReportSummary } from "./report-summary.js"
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
  const professional = async (name: string) => {
    const id = randomUUID()
    await ownerDb.insert(user).values({ id, name, email: `${id}@reportes.test` })
    return id
  }
  const site = async (name: string) => {
    const [row] = await ownerDb.insert(branch).values({ organizationId: orgId, name }).returning()
    const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: row!.id, name: "Unidad dental 1" }).returning()
    return { branchId: row!.id, roomId: room!.id }
  }
  const visit = (
    place: { branchId: string; roomId: string },
    professionalUserId: string,
    patientId: string,
    startsAt: string,
    status: string,
    source = "recepcion",
  ) =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      ...place,
      professionalUserId,
      patientId,
      serviceName: "Evaluación",
      startsAt: new Date(startsAt),
      endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000),
      durationMin: 30,
      status,
      source,
    })
  return { orgId, run, person, professional, site, visit }
}

it("agenda: cada cita cae en un solo grupo, por su fecha en la zona de la clínica y por sede", async () => {
  const c = await clinic()
  const [a, b] = [await c.site("Sede A"), await c.site("Sede B")]
  const [ana, luis] = [await c.professional("Ana"), await c.professional("Luis")]
  const [p1, p2, p3, p4, p5] = [await c.person("Uno", 1), await c.person("Dos", 2), await c.person("Tres", 3), await c.person("Cuatro", 4), await c.person("Cinco", 5)]
  // Septiembre.
  await c.visit(a, ana, p1, "2026-09-03T15:00:00Z", "atendida")
  await c.visit(a, ana, p2, "2026-09-04T15:00:00Z", "atendida", "agent")
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

  const september = await c.run((tx) => getAgendaReport(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(september.appointments.current).toEqual({ total: 7, attended: 4, noShow: 1, cancelled: 1, unmarked: 1 })
  expect(september.appointments.previous).toEqual({ total: 3, attended: 2, noShow: 1, cancelled: 0, unmarked: 0 })
  expect(
    september.professionals.map(({ userId, name, attended, noShow, cancelled, unmarked }) => ({ userId, name, attended, noShow, cancelled, unmarked })),
  ).toEqual([
    { userId: ana, name: "Ana", attended: 2, noShow: 1, cancelled: 0, unmarked: 1 },
    { userId: luis, name: "Luis", attended: 2, noShow: 0, cancelled: 1, unmarked: 0 },
  ])

  const onlyA = await c.run((tx) => getAgendaReport(tx, c.orgId, { period: "2026-09", branchId: a.branchId }, NOW))
  expect(onlyA.appointments.current).toEqual({ total: 4, attended: 2, noShow: 1, cancelled: 0, unmarked: 1 })
  expect(onlyA.branch).toEqual({ id: a.branchId, name: "Sede A" })

  // El mes en curso no cuenta lo que aún no ocurre y se compara con los mismos días de septiembre.
  const october = await c.run((tx) => getAgendaReport(tx, c.orgId, { period: "este_mes" }, NOW))
  expect(october.appointments.current).toEqual({ total: 1, attended: 1, noShow: 0, cancelled: 0, unmarked: 0 })
  expect(october.appointments.previous.total).toBe(6)
  expect(october.period.partial).toBe(true)

  // Varios meses: su línea de 12 meses termina en el último del periodo.
  const quarter = await c.run((tx) => getAgendaReport(tx, c.orgId, { period: "ultimos_3_meses" }, NOW))
  const lastThree = quarter.appointments.months.slice(-3)
  expect(quarter.months.slice(-3).map((month, index) => [month.key, lastThree[index]?.attended])).toEqual([
    ["2026-07", 0],
    ["2026-08", 2],
    ["2026-09", 4],
  ])

  // La lista tiene tantas filas como dice la cifra, y avisa de quien ya tiene otra cita.
  const noShow = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "no_show" }, NOW))
  expect(noShow.total).toBe(september.appointments.current.noShow)
  expect(noShow.rows).toEqual([
    expect.objectContaining({ patientId: p4, personName: "Cuatro", title: "Evaluación", professionalName: "Ana", branchName: "Sede A", hasNextAppointment: false }),
  ])
  const unmarked = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "unmarked" }, NOW))
  expect(unmarked.rows.map((row) => row.patientId)).toEqual([p1])

  // Pacientes nuevos (Reportes › Pacientes): su primera cita atendida cae en el periodo, y en la sede elegida.
  const patients = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(patients.newPatients).toEqual({ current: 2, previous: 2 })
  const patientsA = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-09", branchId: a.branchId }, NOW))
  expect(patientsA.newPatients.current).toBe(1)
  const fresh = await c.run((tx) => getReportList(tx, c.orgId, { period: "2026-09", list: "new_patients" }, NOW))
  expect(fresh.total).toBe(2)
  expect(fresh.rows.map((row) => [row.patientId, row.hasNextAppointment])).toEqual([
    [p3, false],
    [p2, true],
  ])

  // El Resumen dice las mismas cifras que su pestaña: son la misma consulta por tramos.
  const summary = await c.run((tx) => getReportSummary(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(summary.newPatients).toMatchObject({ current: 2, previous: 2 })
  expect(summary.noShow.current).toEqual({ noShow: september.appointments.current.noShow, total: september.appointments.current.total })
  expect(summary.noShow.previous).toEqual({ noShow: september.appointments.previous.noShow, total: september.appointments.previous.total })
  // Doce meses que terminan en septiembre: el último es el periodo.
  expect(summary.months.map((month) => month.key).slice(-2)).toEqual(["2026-08", "2026-09"])
  expect(summary.newPatients.months.slice(-2)).toEqual([2, 2])
  expect(summary.collected).toMatchObject({ current: 0, previous: 0 })
  // Un rango usa la misma cifra: del 3 al 9 de septiembre hubo cuatro citas que ya pasaron.
  const range = await c.run((tx) => getAgendaReport(tx, c.orgId, { period: "2026-09-03..2026-09-09" }, NOW))
  expect(range.appointments.current).toEqual({ total: 5, attended: 3, noShow: 1, cancelled: 1, unmarked: 0 })
  expect(range.period).toMatchObject({ kind: "range", grain: "day", days: { from: "2026-09-03", to: "2026-09-09" } })
})

it("lo atendido: un acto con cantidad vale precio × cantidad, como su cargo", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(encounterProcedure).values({
    organizationId: "org_a",
    encounterId: f.encounter.id,
    description: "Sellante",
    quantity: 3,
    priceCents: 4_000,
    currency: "PEN",
  })
  // Sin hora de fin: el inicio lo puso el reloj de la base y un fin del reloj de la prueba puede quedar antes (`encounter_end_check`).
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), finalizedBy: f.actor, signerName: "Clínico", signerRegistration: "1" })
    .where(eq(encounter.id, f.encounter.id))
  // Reportes › Finanzas › Comisiones: lo que atendió quien firmó, y todavía sin cobrar.
  const commissions = await f.run((tx) => getReportCommissions(tx, "org_a", { period: "este_mes" }))
  expect(commissions.rows.find((row) => row.userId === f.actor)).toMatchObject({ attendedCents: 12_000, unpaidCents: 12_000, collectedCents: 0 })
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
  // Reportes › Pacientes, «Si vuelven».
  const september = await c.run((tx) => getReportPatients(tx, c.orgId, { period: "2026-09" }, NOW))
  const controls = september.controls.current
  expect(controls).toEqual({ due: 3, came: 0, pending: 1, cancelled: 1, unknown: 1 })
  // «Ver los que no vinieron» trae tantas filas como dice la cifra: los que tocaban y no cuentan como venidos.
  const missed = await c.run((tx) => getPatientReportList(tx, c.orgId, { period: "2026-09", list: "controls_missed" }, NOW))
  expect(missed.total).toBe(controls.due - controls.came)
  expect(missed.rows.map((row) => [row.patientId, row.title])).toEqual([
    [p1, "Control de limpieza"],
    [p2, "Control anual"],
    [p2, "Control antiguo"],
  ])
})

it("presupuestos: el aceptado en parte es uno aceptado y cuenta por lo aceptado", async () => {
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  // La clínica de prueba es compartida: se mide lo que suman estos presupuestos.
  const acceptance = async () => (await run((tx) => getReportSummary(tx, "org_a", { period: "este_mes" }))).acceptance.current
  const upcoming = async () => (await run((tx) => getReportOutlook(tx, "org_a", { period: "este_mes" }))).upcoming
  const [acceptedBefore, upcomingBefore] = [await acceptance(), await upcoming()]
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
  const partial = await quote(["aceptado", "rechazado"], 2)
  await quote(null)
  await quote(["rechazado"])

  // Cuatro presentados y dos aceptados: el aceptado en parte cuenta una vez.
  const acceptedAfter = await acceptance()
  expect({ presented: acceptedAfter.presented - acceptedBefore.presented, accepted: acceptedAfter.accepted - acceptedBefore.accepted }).toEqual({
    presented: 4,
    accepted: 2,
  })
  // Reportes › Finanzas, «Lo que viene»: solo lo aceptado, a su precio; del aceptado en parte, su línea aceptada.
  const upcomingAfter = await upcoming()
  expect({ cents: upcomingAfter.cents - upcomingBefore.cents, patients: upcomingAfter.patients - upcomingBefore.patients }).toEqual({
    cents: 240_000,
    patients: 2,
  })
  // Su lista dice lo mismo de cada persona.
  const list = await run((tx) => getReportList(tx, "org_a", { period: "este_mes", list: "upcoming_unbooked" }))
  expect(list.rows.find((row) => row.patientId === partial.patient.id)).toMatchObject({ cents: 120_000, currency: "PEN" })
})

it("presupuestos con opciones: vale la recomendada mientras decide y la elegida después, como el resto de la aplicación, nunca la suma", async () => {
  const f = await clinicalFixture()
  const DAY = 86_400_000
  const promotion = (name: string, priceCents: number) =>
    f.run((tx) =>
      createPromotion(tx, "org_a", f.actor, {
        name: `${name} ${randomUUID().slice(0, 6)}`,
        startsAt: new Date(Date.now() - DAY).toISOString(),
        endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
        conditions: null,
        items: [{ serviceId: f.service.id, mode: "fixed", priceCents }],
      }),
    )
  // La tarifa es 1 200: la opción A lleva una promoción a 1 000 y la B, la recomendada, otra a 900.
  const [inA, inB] = [await promotion("En la A", 100_000), await promotion("En la B", 90_000)]
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  const optionA = budget.options[0]!
  const optionB = (await f.run((tx) => duplicateBudgetOption(tx, ...f.args, budget.id, optionA.id))).options[1]!
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, {
      lines: [
        { planItemId: item.id, optionId: optionA.id, promotionId: inA.id },
        { planItemId: item.id, optionId: optionB.id, promotionId: inB.id },
      ],
    }),
  )
  await f.run((tx) => recommendBudgetOption(tx, ...f.args, budget.id, optionB.id))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  expect((await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))).totalCents).toBe(90_000)

  // Mientras decide vale la recomendada: en «Qué dejó cada promoción» usó la de la B, no las dos.
  const promotions = async () => (await f.run((tx) => getReportPromotions(tx, "org_a", { period: "este_mes" }))).promotions
  const deciding = await promotions()
  expect(deciding.find((row) => row.promotionId === inB.id)).toMatchObject({ people: 1, accepted: 0 })
  expect(deciding.find((row) => row.promotionId === inA.id)).toBeUndefined()

  // Elige la A: desde entonces vale la elegida, también en «Lo que viene» (su precio, nunca la suma).
  const upcoming = async () => (await f.run((tx) => getReportOutlook(tx, "org_a", { period: "este_mes" }))).upcoming.cents
  const before = await upcoming()
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { optionId: optionA.id, decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const decided = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))
  expect(decided.totalCents).toBe(100_000)
  expect((await upcoming()) - before).toBe(decided.totalCents)
  const chosen = await promotions()
  expect(chosen.find((row) => row.promotionId === inA.id)).toMatchObject({ people: 1, accepted: 1, discountCents: 20_000 })
  expect(chosen.find((row) => row.promotionId === inB.id)).toBeUndefined()
})

it("cómo respondimos: quién respondió primero, por dónde escribieron y qué pasó el agente al equipo, frente al mes anterior", async () => {
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

  // Reportes › Agente: medianas del agente (60 y 120 s) y del equipo (600 s), por separado.
  const report = await c.run((tx) => getReportAgent(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(report.responses.current).toEqual({ conversations: 4, responded: 3, byAgent: 2, byTeam: 1, agentMedianSeconds: 90, teamMedianSeconds: 600 })
  expect(report.responses.handedOff).toBe(1)
  expect(report.responses.previous).toEqual({ conversations: 1, responded: 1, byAgent: 0, byTeam: 1, agentMedianSeconds: null, teamMedianSeconds: 300 })
  expect(report.responses.byChannel).toEqual([
    { channel: "whatsapp", count: 3 },
    { channel: "instagram", count: 1 },
  ])
})

it("lo cobrado: el periodo, el anterior y por mes, en la moneda y la zona de otra clínica", async () => {
  // Una clínica de otro país: euros y hora de Madrid.
  const c = await clinic({ country: "ES", currency: "EUR", timezone: "Europe/Madrid", locale: "es-ES" })
  const place = await c.site("Centro")
  const [doctor, p1] = [await c.professional("Marta"), await c.person("Uno", 1)]
  const pay = (paidAt: string, amountCents: number) =>
    ownerDb.insert(patientPayment).values({ organizationId: c.orgId, patientId: p1, branchId: place.branchId, amountCents, currency: "EUR", paidAt: new Date(paidAt), methodName: "tarjeta" })
  await pay("2026-08-10T10:00:00Z", 10000)
  // 31 de agosto a las 22:30 UTC: en Madrid ya es 1 de septiembre.
  await pay("2026-08-31T22:30:00Z", 5000)
  await pay("2026-09-15T10:00:00Z", 20000)
  await c.visit(place, doctor, p1, "2026-08-31T22:30:00Z", "atendida")

  // Reportes › Finanzas: sin gastos, todo lo cobrado queda en caja.
  const september = await c.run((tx) => getReportFinance(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(september).toMatchObject({ timezone: "Europe/Madrid", locale: "es-ES", currency: "EUR", otherCurrencies: [] })
  expect(september.totals.current).toMatchObject({ cobradoCents: 25000, otherExpensesCents: 0, leavesCents: 25000, cashLeftCents: 25000 })
  expect(september.totals.previous).toMatchObject({ cobradoCents: 10000, cashLeftCents: 10000 })

  // Por mes, en los meses de Madrid; tres meses se comparan con los tres anteriores, que no cobraron nada.
  const quarter = await c.run((tx) => getReportFinance(tx, c.orgId, { period: "ultimos_3_meses" }, NOW))
  expect(quarter.chart.slice(-3).map((row) => [row.key, row.cobradoCents])).toEqual([
    ["2026-07", 0],
    ["2026-08", 10000],
    ["2026-09", 25000],
  ])
  expect(quarter.totals).toMatchObject({ current: { cobradoCents: 35000 }, previous: { cobradoCents: 0 } })

  // El Resumen cobra lo mismo que Finanzas, ahora y en sus 12 meses, con la regla de lo neto.
  const summary = await c.run((tx) => getReportSummary(tx, c.orgId, { period: "2026-09" }, NOW))
  expect(summary.collected).toMatchObject({ currency: "EUR", current: 25000, previous: 10000 })
  expect(summary.collected.months.slice(-3)).toEqual([0, 10000, 25000])
  expect(summary.chart.slice(-1)).toEqual([expect.objectContaining({ key: "2026-09", cents: 25000, previousCents: 0 })])
})

it("el asesor acompaña a la cifra solo si está encendido y hay algo que hacer", async () => {
  const c = await clinic()
  const [a, b] = [await c.site("Sede A"), await c.site("Sede B")]
  const [doctor, other, absent, present] = [await c.professional("Ana"), await c.professional("Luis"), await c.person("Falta", 1), await c.person("Viene", 2)]
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
