import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { clinicalFollowUp, encounter, patient, patientCharge, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { crmTask } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  ADVISOR_DETECTIONS,
  createAdvisorTasks,
  getAdvisorRecommendation,
  getAdvisorRecommendations,
  getAdvisorSettings,
  updateAdvisorSettings,
} from "./agent-advisor.js"
import { createRule, listRules, updateRule } from "./automation.js"
import { createContact } from "./contacts.js"
import { createOpportunity } from "./opportunities.js"
import { nextPatientNumber } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Asesor: cada cifra sale de una consulta, respeta los permisos de quien lee y solo deja la acción lista. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "advisor-owner"
const DENTIST = "advisor-dentist"
const DAY = 86_400_000
const all = () => true

let branchId: string
let chairId: string

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: OWNER, name: "Dueña", email: "owner@advisor.test", emailVerified: true },
    { id: DENTIST, name: "Dra. Carla Ríos", email: "carla@advisor.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
    { id: `m-${DENTIST}`, userId: DENTIST, organizationId: ORG, role: "dentist", createdAt: new Date() },
  ])
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Sede Asesor", timezone: "America/Lima" }).returning({ id: branch.id })
  branchId = site!.id
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: ORG, branchId, name: "Sillón Asesor" }).returning({ id: scheduleChair.id })
  chairId = chair!.id
})

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

async function person(name: string): Promise<string> {
  const [row] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: name, patientNumber: await nextPatientNumber(ownerDb, ORG) })
    .returning({ id: patient.id })
  return row!.id
}

async function futureAppointment(patientId: string, status = "programada") {
  const startsAt = new Date(Date.now() + 3 * DAY + Math.floor(Math.random() * 1000) * 60_000)
  await ownerDb.insert(appointment).values({
    organizationId: ORG, branchId, patientId, dentistUserId: DENTIST, chairId,
    startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status,
  })
}

describe("ajustes del asesor", () => {
  it("empieza apagado, con todas las detecciones listas y su umbral por defecto", async () => {
    const settings = await run((tx) => getAdvisorSettings(tx, OTHER), OTHER)
    expect(settings.enabled).toBe(false)
    expect(settings.detections.map((item) => item.key)).toEqual(ADVISOR_DETECTIONS.map((item) => item.key))
    expect(settings.detections.every((item) => item.on && item.snoozedUntil === null)).toBe(true)
    expect(settings.detections.find((item) => item.key === "presupuestos_sin_cita")).toMatchObject({ days: 7, defaultDays: 7 })
    // Apagado no recomienda nada; la vista previa sí calcula.
    expect(await run((tx) => getAdvisorRecommendations(tx, OTHER, all), OTHER)).toEqual({ enabled: false, recommendations: [], more: 0 })
  })

  it("valida el umbral y lo que no tiene umbral", async () => {
    await expect(run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { presupuestos_sin_cita: { days: 0 } } }))).rejects.toThrow(/1 a 365/)
    await expect(run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { controles_vencidos: { days: 10 } } }))).rejects.toThrow(/no tiene un umbral/)
    await expect(run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { inventada: { on: false } } }))).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { controles_vencidos: { snoozeDays: 100 } } }))).rejects.toThrow(/1 y 90/)
  })
})

describe("detecciones", () => {
  it("controles vencidos: solo pendientes, vencidos y de pacientes sin cita futura", async () => {
    const overdue = await person("Mariana Soto")
    const withAppointment = await person("Pedro Castillo")
    const notDue = await person("Rosa Quispe")
    const cancelledAppointment = await person("Andrés Vargas")
    await ownerDb.insert(clinicalFollowUp).values([
      { organizationId: ORG, patientId: overdue, kind: "mantenimiento", title: "Control de ortodoncia", dueAt: new Date(Date.now() - 40 * DAY) },
      { organizationId: ORG, patientId: withAppointment, kind: "mantenimiento", title: "Control de endodoncia", dueAt: new Date(Date.now() - 5 * DAY) },
      { organizationId: ORG, patientId: notDue, kind: "mantenimiento", title: "Control", dueAt: new Date(Date.now() + 5 * DAY) },
      { organizationId: ORG, patientId: cancelledAppointment, kind: "mantenimiento", title: "Mantenimiento periodontal", dueAt: new Date(Date.now() - 2 * DAY) },
      { organizationId: ORG, patientId: overdue, kind: "mantenimiento", title: "Ya cancelado", dueAt: new Date(Date.now() - 9 * DAY), status: "cancelado" },
    ])
    await futureAppointment(withAppointment)
    // Una cita cancelada no cuenta como cita futura.
    await futureAppointment(cancelledAppointment, "cancelada")
    const found = await run((tx) => getAdvisorRecommendation(tx, ORG, all, "controles_vencidos"))
    expect(found.total).toBe(2)
    expect(found.items.map((item) => item.personName)).toEqual(["Mariana Soto", "Andrés Vargas"])
    expect(found.items[0]?.line).toMatch(/^Control de ortodoncia · venció el \d+ de /)
    expect(found.title).toBe("2 controles vencidos de pacientes sin cita")
    expect(found.detail).toBe("El recordatorio de control está apagado. 1 venció hace más de 30 días.")
    expect(found.how).toContain("no tienen una cita programada o confirmada")
    expect(found.taskNoun).toEqual({ one: "tarea de llamada", many: "tareas de llamada" })
  })

  it("controles vencidos: dice si el recordatorio de control está encendido, sin encenderlo y solo a quien ve automatizaciones", async () => {
    const read = () => run((tx) => getAdvisorRecommendation(tx, ORG, all, "controles_vencidos"))
    // Sin regla: se ofrece crearla (ruleId null) y la tarjeta dice que está apagado.
    expect((await read()).automation).toMatchObject({ kind: "recordatorio_control", label: "recordatorio de control", ruleId: null, enabled: false, channel: "whatsapp" })
    expect((await read()).automation?.reach).toContain("próximas 48 horas")
    expect((await read()).automation?.reach).toContain("No escribe a quienes ya se les pasó la fecha")
    // Con la regla pausada: es esa la que se enciende. Leer la recomendación no la cambia.
    const rule = await run((tx) => createRule(tx, ORG, OWNER, { name: "Recordatorio de control", kind: "recordatorio_control", channel: "telegram", enabled: false }))
    expect((await read()).automation).toMatchObject({ ruleId: rule.id, enabled: false, channel: "telegram" })
    expect((await run((tx) => listRules(tx, ORG))).find((item) => item.id === rule.id)?.enabled).toBe(false)
    // Encendida con la operación de Automatizaciones: la tarjeta deja de decir «apagado».
    await run((tx) => updateRule(tx, ORG, OWNER, rule.id, { enabled: true }))
    const on = await read()
    expect(on.automation).toMatchObject({ ruleId: rule.id, enabled: true })
    expect(on.detail).toBe("1 venció hace más de 30 días.")
    // Quien no ve automatizaciones (crm.read) recibe la lista, no el estado de la regla.
    const reception = (permission: string) => permission === "appointments.read"
    const hidden = await run((tx) => getAdvisorRecommendation(tx, ORG, reception, "controles_vencidos"))
    expect(hidden.automation).toBeNull()
    expect(hidden.detail).toBe("1 venció hace más de 30 días.")
    await run((tx) => updateRule(tx, ORG, OWNER, rule.id, { enabled: false }))
  })

  it("las demás detecciones no tienen una automatización equivalente: su acción son las tareas", async () => {
    expect(ADVISOR_DETECTIONS.filter((item) => item.automation !== null).map((item) => item.key)).toEqual(["controles_vencidos"])
    expect(ADVISOR_DETECTIONS.find((item) => item.key === "atenciones_sin_firmar")?.taskNoun.many).toBe("tareas")
  })

  it("presupuestos aceptados sin cita: respeta el umbral de días y no muestra importes", async () => {
    const old = await person("Camila Ortiz")
    const recent = await person("Thiago Luna")
    for (const [index, [patientId, days]] of ([[old, 20], [recent, 3]] as const).entries()) {
      const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: ORG, patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
      await ownerDb.insert(treatmentBudget).values({
        organizationId: ORG, patientId, planId: plan!.id, budgetNumber: 9000 + index, title: "Ortodoncia", currency: "PEN",
        status: "aceptado", decidedAt: new Date(Date.now() - days * DAY),
      })
    }
    const week = await run((tx) => getAdvisorRecommendation(tx, ORG, all, "presupuestos_sin_cita"))
    expect(week.items.map((item) => item.personName)).toEqual(["Camila Ortiz"])
    expect(week.title).toBe("1 presupuesto aceptado hace más de 7 días, sin cita")
    expect(week.items[0]?.line).toMatch(/^Presupuesto N\.º 9000 · Ortodoncia · aceptado el /)
    expect(JSON.stringify(week)).not.toMatch(/S\/|PEN|cents/i)
    // «No me interesa» puede ser subir el umbral: con 2 días entran los dos.
    await run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { presupuestos_sin_cita: { days: 2 } } }))
    expect((await run((tx) => getAdvisorRecommendation(tx, ORG, all, "presupuestos_sin_cita"))).total).toBe(2)
    await run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { presupuestos_sin_cita: { days: null } } }))
  })

  it("atenciones sin firmar de días anteriores, seguimientos sin responsable y cuotas vencidas", async () => {
    const yesterday = await person("Elena Huamán")
    const today = await person("Lucía Fernández")
    await ownerDb.insert(encounter).values([
      { organizationId: ORG, patientId: yesterday, dentistUserId: DENTIST, reason: "Dolor", startedAt: new Date(Date.now() - 2 * DAY) },
      { organizationId: ORG, patientId: today, dentistUserId: DENTIST, reason: "Control", startedAt: new Date() },
    ])
    const unsigned = await run((tx) => getAdvisorRecommendation(tx, ORG, all, "atenciones_sin_firmar"))
    expect(unsigned.items.map((item) => item.personName)).toEqual(["Elena Huamán"])
    expect(unsigned.detail).toBe("Dra. Carla Ríos tiene 1.")

    const contact = await run((tx) => createContact(tx, ORG, { displayName: "Interesada sin dueño" }))
    const owned = await run((tx) => createContact(tx, ORG, { displayName: "Con responsable" }))
    await run((tx) => createOpportunity(tx, ORG, { contactId: contact.id, title: "Blanqueamiento" }, { userId: OWNER }))
    await run((tx) => createOpportunity(tx, ORG, { contactId: owned.id, title: "Implante", assignedUserId: OWNER }, { userId: OWNER }))
    const orphan = await run((tx) => getAdvisorRecommendation(tx, ORG, all, "seguimientos_sin_responsable"))
    expect(orphan.items.map((item) => item.personName)).toEqual(["Interesada sin dueño"])
    expect(orphan.items[0]).toMatchObject({ line: "Blanqueamiento · sin próxima acción", patientId: null })

    // Deuda vieja: cuenta lo que falta pagar del concepto, no cuotas con fecha.
    const debtor = await person("Deudor Antiguo")
    const fresh = await person("Deudor Reciente")
    await ownerDb.insert(patientCharge).values([
      { organizationId: ORG, patientId: debtor, description: "Ortodoncia", amountCents: 30000, currency: "PEN", createdAt: new Date(Date.now() - 45 * DAY) },
      { organizationId: ORG, patientId: fresh, description: "Limpieza", amountCents: 9000, currency: "PEN", createdAt: new Date(Date.now() - 5 * DAY) },
    ])
    const owed = await run((tx) => getAdvisorRecommendation(tx, ORG, all, "cobranza_vencida"))
    expect(owed.items.map((item) => item.personName)).toEqual(["Deudor Antiguo"])
    expect(owed.items[0]?.line).toMatch(/^Debe S\/\s300\.00 · desde el \d+ de .+$/)
    expect(owed.title).toBe("1 persona debe desde hace más de 30 días")
  })
})

describe("lo que recomienda y lo que deja hacer", () => {
  it("muestra a lo sumo tres, solo lo que el rol puede ver, y respeta apagar y posponer", async () => {
    await run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { enabled: true }))
    const everything = await run((tx) => getAdvisorRecommendations(tx, ORG, all))
    expect(everything.enabled).toBe(true)
    expect(everything.recommendations.map((item) => item.key)).toEqual(["controles_vencidos", "presupuestos_sin_cita", "atenciones_sin_firmar"])
    expect(everything.more).toBe(2)
    // La tarjeta trae pocas filas; el total es el real.
    expect(everything.recommendations[0]?.items.length).toBeLessThanOrEqual(4)
    expect((await run((tx) => getAdvisorRecommendations(tx, ORG, all, { all: true }))).recommendations).toHaveLength(5)

    // Caja solo ve cobranza; quien no tiene ningún permiso, nada.
    const cashier = (permission: string) => permission === "finance.read"
    expect((await run((tx) => getAdvisorRecommendations(tx, ORG, cashier))).recommendations.map((item) => item.key)).toEqual(["cobranza_vencida"])
    expect((await run((tx) => getAdvisorRecommendations(tx, ORG, () => false))).recommendations).toEqual([])
    await expect(run((tx) => getAdvisorRecommendation(tx, ORG, cashier, "atenciones_sin_firmar"))).rejects.toMatchObject({ status: 403 })

    await run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { controles_vencidos: { on: false }, presupuestos_sin_cita: { snoozeDays: 7 } } }))
    const less = await run((tx) => getAdvisorRecommendations(tx, ORG, all))
    expect(less.recommendations.map((item) => item.key)).toEqual(["atenciones_sin_firmar", "seguimientos_sin_responsable", "cobranza_vencida"])
    const settings = await run((tx) => getAdvisorSettings(tx, ORG))
    expect(settings.detections.find((item) => item.key === "presupuestos_sin_cita")?.snoozedUntil).toBeTruthy()
    await run((tx) => updateAdvisorSettings(tx, ORG, OWNER, { detections: { controles_vencidos: { on: true }, presupuestos_sin_cita: { snoozeDays: null } } }))
  })

  it("crea una tarea por persona solo cuando alguien lo pide, y repetirlo el mismo día no duplica", async () => {
    const before = (await ownerDb.select({ id: crmTask.id }).from(crmTask).where(eq(crmTask.organizationId, ORG))).length
    const first = await run((tx) => createAdvisorTasks(tx, ORG, OWNER, all, "controles_vencidos"))
    expect(first).toEqual({ created: 2, total: 2 })
    const tasks = await ownerDb.select({ title: crmTask.title, patientId: crmTask.patientId, createdBy: crmTask.createdBy }).from(crmTask).where(eq(crmTask.organizationId, ORG))
    expect(tasks.length).toBe(before + 2)
    expect(tasks.map((task) => task.title)).toContain("Llamar a Mariana Soto para agendar su control")
    expect(tasks.filter((task) => task.title.startsWith("Llamar a")).every((task) => task.patientId !== null && task.createdBy === "user")).toBe(true)
    expect(await run((tx) => createAdvisorTasks(tx, ORG, OWNER, all, "controles_vencidos"))).toEqual({ created: 0, total: 2 })
    await expect(run((tx) => createAdvisorTasks(tx, ORG, OWNER, () => false, "controles_vencidos"))).rejects.toMatchObject({ status: 403 })
    // Otra organización no ve nada de esta.
    expect((await run((tx) => getAdvisorRecommendations(tx, OTHER, all, { preview: true }), OTHER)).recommendations).toEqual([])
    expect(randomUUID()).toBeTruthy()
  })
})
