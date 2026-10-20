/**
 * Fases 5 y 6 de Reportes (ADR 0070 y 0071): Argos responde con la consulta
 * de la pestaña y deja su fila sin el texto; las respuestas fijadas, las
 * metas por mes y el resumen del lunes. Cada caso arma su propia clínica.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { patientPayment } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { reportQuestion } from "@odentia/db/schema/reports"
import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { updateAdminSettings } from "./agent-admin.js"
import { answerFor, listReportPinKeys, listReportPins, pinReportAnswer, prepareReportQuestion, REPORT_DAILY_LIMIT, resolveReportQuestion, unpinReportAnswer } from "./report-ask.js"
import { claimReportDigest, composeReportDigest, dueReportDigests, getReportDigest, setReportDigest } from "./report-digest.js"
import { goalsForMonth, setReportGoal } from "./report-goals.js"
import { getReportSummary } from "./report-summary.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

/** Lunes 12 de octubre de 2026, 10:00 en Lima. */
const NOW = new Date("2026-10-12T15:00:00Z")
const OPTIONS = { billing: true, can: () => true, now: NOW }

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `argos-${orgId}`)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const person = async (name: string, number: number) => (await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber: number }))[0]!.id
  const staff = async (name: string, role = "dentist") => {
    const id = randomUUID()
    await ownerDb.insert(user).values({ id, name, email: `${id}@argos.test` })
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: id, role, createdAt: new Date() })
    return id
  }
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning()
  const visit = (dentistUserId: string, patientId: string, startsAt: string, status: string) =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      branchId: site!.id,
      chairId: chair!.id,
      dentistUserId,
      patientId,
      serviceName: "Evaluación",
      startsAt: new Date(startsAt),
      endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000),
      durationMin: 30,
      status,
      source: "recepcion",
    })
  return { orgId, run, person, staff, visit, branchId: site!.id }
}

describe("Argos responde con la consulta de la pestaña", () => {
  it("no vinieron, en total y por profesional, con la misma regla de Agenda", async () => {
    const c = await clinic()
    const [ana, luis] = [await c.staff("Ana Torres"), await c.staff("Luis Prado")]
    const [p1, p2, p3, p4] = [await c.person("Uno", 1), await c.person("Dos", 2), await c.person("Tres", 3), await c.person("Cuatro", 4)]
    await c.visit(ana, p1, "2026-09-03T15:00:00Z", "atendida")
    await c.visit(ana, p2, "2026-09-04T15:00:00Z", "atendida")
    await c.visit(luis, p3, "2026-09-05T15:00:00Z", "no_asistio")
    await c.visit(luis, p4, "2026-09-06T15:00:00Z", "atendida")

    const total = await c.run((tx) => answerFor(tx, c.orgId, { period: "2026-09", figure: "no_vinieron", group: "total" }, OPTIONS))
    expect(total.sentence.map((part) => part.text).join("")).toContain("No vinieron: 25 % (1 de 4 citas) en setiembre de 2026")
    expect(total.list).toEqual({ key: "no_show", label: "Ver la cita" })
    expect(total.followUps.map((item) => item.label)).toEqual(["¿Y en agosto?", "Por sede", "Por profesional", "¿Quiénes no vinieron?"])

    const byDoctor = await c.run((tx) => answerFor(tx, c.orgId, { period: "2026-09", figure: "no_vinieron", group: "profesional" }, OPTIONS))
    expect(byDoctor.title).toBe("No vinieron, por profesional")
    expect(byDoctor.sentence.map((part) => part.text).join("")).toBe("Luis Prado: 50 % (1 de 2 citas). En toda la clínica fue 25 % en setiembre de 2026.")
    expect(byDoctor.chart).toMatchObject({ kind: "bars", rows: [{ label: "Luis Prado", valueText: "50 %", note: "1 de 2" }, { label: "Ana Torres", valueText: "0 %" }] })
  })

  it("una agrupación que la cifra no tiene se responde con la suya y se dice", async () => {
    const c = await clinic()
    const answer = await c.run((tx) => answerFor(tx, c.orgId, { period: "2026-09", figure: "nos_buscaron", group: "profesional" }, OPTIONS))
    expect(answer.query.group).toBe("total")
  })

  it("lo pagado a odentIA no se calcula para quien no ve Facturación", async () => {
    const c = await clinic()
    await expect(c.run((tx) => answerFor(tx, c.orgId, { period: "2026-09", figure: "agente_pagado", group: "total" }, { ...OPTIONS, billing: false }))).rejects.toThrow(/no está entre/)
  })

  it("cada pregunta deja su fila sin el texto, y las del modelo cuentan para el tope de la clínica", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    await c.run((tx) => updateAdminSettings(tx, c.orgId, ana, { enabled: true }))
    const result = await c.run((tx) =>
      resolveReportQuestion(tx, c.orgId, ana, "¿cuánto cobramos?", { interpretation: { kind: "cifra", figure: "cobrado", group: "total", focus: null, period: null, branch: null, allBranches: false }, model: "guion", usage: null }, { period: "2026-09" }, OPTIONS),
    )
    expect(result.kind).toBe("respuesta")
    const rows = await ownerDb.execute<{ outcome: string; figure: string; used_model: boolean }>(sql`select outcome, figure, used_model from report_question where organization_id = ${c.orgId}`)
    expect([...rows]).toEqual([{ outcome: "respondida", figure: "cobrado", used_model: true }])

    const ready = await c.run((tx) => prepareReportQuestion(tx, c.orgId, NOW))
    expect(ready).toMatchObject({ enabled: true, timezone: "America/Lima", branches: [{ name: "Centro" }] })
    await ownerDb.insert(reportQuestion).values(Array.from({ length: REPORT_DAILY_LIMIT }, () => ({ organizationId: c.orgId, userId: ana, outcome: "respondida", usedModel: true })))
    expect((await c.run((tx) => prepareReportQuestion(tx, c.orgId))).roomLeft).toBe(0)
  })

  it("«escríbeles» no le toca: dice qué línea prender", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    const result = await c.run((tx) => resolveReportQuestion(tx, c.orgId, ana, "Escríbeles a los que no vinieron", { interpretation: { kind: "accion" }, model: "guion", usage: null }, { period: "2026-09" }, OPTIONS))
    expect(result).toMatchObject({ kind: "accion", line: { key: "seguimiento_no_asistencia", name: "Reprogramar tras una inasistencia" } })
  })
})

describe("fijar en el Resumen", () => {
  it("se recalcula con la pantalla, no se repite y caben cuatro", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    const first = await c.run((tx) => pinReportAnswer(tx, c.orgId, ana, { figure: "no_vinieron", group: "profesional" }, true))
    const again = await c.run((tx) => pinReportAnswer(tx, c.orgId, ana, { figure: "no_vinieron", group: "profesional" }, true))
    expect(again.id).toBe(first.id)
    for (const figure of ["cobrado", "atendidas", "pacientes_nuevos"]) await c.run((tx) => pinReportAnswer(tx, c.orgId, ana, { figure, group: "total" }, true))
    await expect(c.run((tx) => pinReportAnswer(tx, c.orgId, ana, { figure: "canceladas", group: "total" }, true))).rejects.toMatchObject({ code: "REPORT_PIN_LIMIT", status: 409 })

    const pins = await c.run((tx) => listReportPins(tx, c.orgId, { period: "2026-09" }, OPTIONS))
    expect(pins.pins).toHaveLength(4)
    expect(pins.pins[0]).toMatchObject({ pinnedBy: "Ana Torres", answer: { title: "No vinieron, por profesional", scope: "Setiembre de 2026 · Todas las sedes" } })
    expect((await c.run((tx) => listReportPinKeys(tx, c.orgId)))[0]).toEqual({ id: first.id, figure: "no_vinieron", group: "profesional", focus: null })
    await c.run((tx) => unpinReportAnswer(tx, c.orgId, first.id))
    expect((await c.run((tx) => listReportPins(tx, c.orgId, { period: "2026-09" }, OPTIONS))).pins).toHaveLength(3)
    // Quitada desde el Resumen, la respuesta del panel ya no la ve fijada.
    expect((await c.run((tx) => listReportPinKeys(tx, c.orgId))).map((pin) => pin.figure)).not.toContain("no_vinieron")
  })
})

describe("metas", () => {
  it("valen desde el mes en que se guardan; cambiarla no reescribe los meses pasados", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    await c.run((tx) => setReportGoal(tx, c.orgId, ana, { metric: "cobrado", amount: 4_000_000 }, new Date("2026-09-10T15:00:00Z")))
    await c.run((tx) => setReportGoal(tx, c.orgId, ana, { metric: "cobrado", amount: 5_000_000 }, NOW))
    await c.run((tx) => setReportGoal(tx, c.orgId, ana, { metric: "cobrado", amount: 5_500_000 }, NOW))
    expect((await c.run((tx) => goalsForMonth(tx, c.orgId, { year: 2026, month: 9 }))).cobrado?.amount).toBe(4_000_000)
    expect((await c.run((tx) => goalsForMonth(tx, c.orgId, { year: 2026, month: 10 }))).cobrado).toMatchObject({ amount: 5_500_000, currency: "PEN", fromMonth: "2026-10" })
    expect((await c.run((tx) => goalsForMonth(tx, c.orgId, { year: 2026, month: 8 }))).cobrado).toBeUndefined()
    await c.run((tx) => setReportGoal(tx, c.orgId, ana, { metric: "cobrado", amount: null }, NOW))
    expect((await c.run((tx) => goalsForMonth(tx, c.orgId, { year: 2026, month: 10 }))).cobrado).toBeUndefined()
    await expect(c.run((tx) => setReportGoal(tx, c.orgId, ana, { metric: "cobrado", amount: 0 }, NOW))).rejects.toThrow()
  })

  it("el Resumen dice el avance del mes en curso y cuánto del mes ya pasó", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    const patient = await c.person("Rosa", 1)
    await ownerDb.insert(patientPayment).values({ organizationId: c.orgId, patientId: patient, branchId: c.branchId, amountCents: 1_000_000, currency: "PEN", paidAt: new Date("2026-10-05T15:00:00Z"), methodName: "Efectivo" })
    await c.run((tx) => setReportGoal(tx, c.orgId, ana, { metric: "cobrado", amount: 4_000_000 }, NOW))
    const summary = await c.run((tx) => getReportSummary(tx, c.orgId, { period: "este_mes" }, NOW))
    expect(summary.goals).toMatchObject({ month: "2026-10", editable: true, cobrado: { amount: 4_000_000, value: 1_000_000, percent: 25, remaining: 3_000_000 }, pacientesNuevos: null })
    expect(summary.goals?.elapsedPercent).toBe(37)
    expect(summary.goals?.daysLeft).toBe(20)
    // Con una sede elegida no hay metas: son de toda la clínica.
    expect((await c.run((tx) => getReportSummary(tx, c.orgId, { period: "este_mes", branchId: c.branchId }, NOW))).goals).toBeNull()
  })
})

describe("el resumen del lunes", () => {
  it("le toca el lunes desde las 8:00 de su clínica, una vez por semana, y solo a quien lo prendió", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    expect(await c.run((tx) => getReportDigest(tx, c.orgId, ana))).toEqual({ enabled: false })
    await c.run((tx) => setReportDigest(tx, c.orgId, ana, true))
    const mine = (list: Array<{ orgId: string }>) => list.filter((item) => item.orgId === c.orgId)
    // Lunes 7:30 en Lima: todavía no.
    expect(mine(await dueReportDigests(ownerDb, new Date("2026-10-12T12:30:00Z")))).toEqual([])
    expect(mine(await dueReportDigests(ownerDb, NOW))).toEqual([{ orgId: c.orgId, userId: ana, week: "2026-10-05" }])
    // Martes: ya no.
    expect(mine(await dueReportDigests(ownerDb, new Date("2026-10-13T15:00:00Z")))).toEqual([])
    const claimed = await c.run((tx) => claimReportDigest(tx, c.orgId, ana, "2026-10-05"))
    expect(claimed).toBeTruthy()
    expect(await c.run((tx) => claimReportDigest(tx, c.orgId, ana, "2026-10-05"))).toBeNull()
    expect(mine(await dueReportDigests(ownerDb, NOW))).toEqual([])
  })

  it("sin movimientos no se envía; quien ya no ve Reportes no lo recibe; con cobros, dice las cifras", async () => {
    const c = await clinic()
    const ana = await c.staff("Ana Torres", "owner")
    const caja = await c.staff("Caja", "cashier")
    const key = Buffer.alloc(32, 1)
    expect(await c.run((tx) => composeReportDigest(tx, c.orgId, ana, "2026-10-05", { secretsKey: key, now: NOW }))).toEqual({ skip: "sin_movimientos" })
    expect(await c.run((tx) => composeReportDigest(tx, c.orgId, caja, "2026-10-05", { secretsKey: key, now: NOW }))).toEqual({ skip: "sin_permiso" })
    const patient = await c.person("Rosa", 1)
    await ownerDb.insert(patientPayment).values({ organizationId: c.orgId, patientId: patient, branchId: c.branchId, amountCents: 1_160_000, currency: "PEN", paidAt: new Date("2026-10-07T15:00:00Z"), methodName: "Efectivo" })
    const composed = await c.run((tx) => composeReportDigest(tx, c.orgId, ana, "2026-10-05", { secretsKey: key, now: NOW }))
    expect("mail" in composed).toBe(true)
    if (!("mail" in composed)) return
    expect(composed.to).toBe(`${ana}@argos.test`)
    expect(composed.mail.subject).toMatch(/^Tu semana: S\/\s?11[,.]600\.00 cobrados/)
    expect(composed.mail.text).toContain("Así fue la semana del 5 al 11 de octubre de 2026")
    expect(composed.mail.text).toMatch(/Cobrado: S\/\s?11[,.]600\.00 · Sin la semana anterior para comparar/)
  })
})
