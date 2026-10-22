import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationConsent, automationJob, automationRule } from "@odentia/db/schema/automation"
import {
  encounter,
  patientCharge,
  patientContact,
  patientPayment,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { agentConfig, crmTask, } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { ADMIN_LINES, flowOf } from "./admin-lines.js"
import {
  getAdminLine,
  getAdminOverview,
  getAdminPage,
  getAdminRecommendation,
  getAdminRecommendations,
  getAdminSettings,
  getAdminUnreached,
  runAdminLineOnce,
  syncTeamLines,
  tickAutomations,
  updateAdminLine,
  updateAdminSettings,
} from "./agent-admin.js"
import { deliverDueJobs, setLine, settleTasks } from "./automation.js"
import { nextPatientNumber } from "./patients.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { completeTask } from "./tasks.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

/**
 * El Administrador: una sola lista de líneas, cada una prendida o apagada y
 * diciendo quién lo hace. Cada cifra sale de una consulta y respeta los
 * permisos de quien lee. Nada se prende ni se apaga sin una persona.
 */
setupTestDb()
const KEY = secretsKeyFromEnv("cd".repeat(32))
const DAY = 86_400_000
const all = () => true

interface Clinic {
  orgId: string
  ownerId: string
  dentistId: string
  branchId: string
  chairId: string
}

async function clinic(options: { admin?: boolean; reception?: boolean } = {}): Promise<Clinic> {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  const dentistId = `dentist-${orgId}`
  await insertOrg(ownerDb, orgId, `admin-${orgId}`)
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Ana Ruiz", email: `${ownerId}@admin.test`, emailVerified: true },
    { id: dentistId, name: "Dra. Carla Ríos", email: `${dentistId}@admin.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${dentistId}`, userId: dentistId, organizationId: orgId, role: "dentist", createdAt: new Date() },
  ])
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: options.reception !== false,
    advisor: options.admin === false ? {} : { enabled: true },
    // A toda hora: el reloj de la prueba es el real.
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning({ id: scheduleChair.id })
  return { orgId, ownerId, dentistId, branchId: site!.id, chairId: chair!.id }
}

/** Quien llevaba atenciones y ya no está en el equipo: nadie las ve en «Te espera». */
async function formerDentist(c: Clinic): Promise<string> {
  const id = `ex-${c.orgId}`
  await ownerDb.insert(user).values({ id, name: "Dr. Luis Paz", email: `${id}@admin.test`, emailVerified: true }).onConflictDoNothing()
  return id
}

function run<T>(c: Clinic, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, c.orgId, fn)
}

async function person(c: Clinic, name: string): Promise<string> {
  const [row] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  return row!.id
}

let budgetNumber = 5000
async function acceptedBudget(c: Clinic, patientId: string, daysAgo: number) {
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
  await ownerDb.insert(treatmentBudget).values({
    organizationId: c.orgId, patientId, planId: plan!.id, budgetNumber: budgetNumber++, title: "Ortodoncia", currency: "PEN",
    status: "aceptado", decidedAt: new Date(Date.now() - daysAgo * DAY),
  })
}

async function noShow(c: Clinic, patientId: string, daysAgo: number) {
  const startsAt = new Date(Date.now() - daysAgo * DAY)
  await ownerDb.insert(appointment).values({
    organizationId: c.orgId, branchId: c.branchId, patientId, dentistUserId: c.dentistId, chairId: c.chairId,
    startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "no_asistio",
  })
}

const tasksOf = (c: Clinic) => ownerDb.select().from(crmTask).where(eq(crmTask.organizationId, c.orgId))
const jobsOf = (c: Clinic) => ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, c.orgId))
const deliver = (c: Clinic) => run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }))
/** La línea se prendió hace `daysAgo` días: lo que cumplió su condición antes no cuenta. */
async function turnedOn(c: Clinic, key: string, daysAgo: number, days?: number) {
  const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, key, { enabled: true, ...(days ? { days } : {}) }))
  await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - daysAgo * DAY) }).where(eq(automationRule.id, rule.id))
}

describe("ajustes", () => {
  it("empieza apagado y encenderlo no prende ninguna línea; a qué hora escribe lo dice el horario de Agente", async () => {
    const c = await clinic({ admin: false })
    expect(await run(c, (tx) => getAdminSettings(tx, c.orgId))).toEqual({ enabled: false })
    // Con él apagado no se puede prender una línea: no haría nada.
    await expect(run(c, (tx) => updateAdminLine(tx, c.orgId, c.ownerId, all, "cobranza_vencida", { enabled: true }))).rejects.toMatchObject({ code: "ADMIN_OFF" })
    expect(await run(c, (tx) => updateAdminSettings(tx, c.orgId, c.ownerId, { enabled: true }))).toEqual({ enabled: true })
    const page = await run(c, (tx) => getAdminPage(tx, c.orgId, all))
    expect(page.lines.every((line) => !line.enabled)).toBe(true)
    expect(await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))).toEqual([])
  })
})

describe("su página", () => {
  it("es una sola lista de nueve líneas y cada una dice quién lo hace", async () => {
    const c = await clinic()
    const page = await run(c, (tx) => getAdminPage(tx, c.orgId, all))
    expect(page.lines.map((line) => [line.key, line.actor])).toEqual([
      ["recordatorio_cita", "agente"],
      ["recordatorio_control", "agente"],
      ["seguimiento_presupuesto", "agente"],
      ["seguimiento_comercial", "agente"],
      ["seguimiento_no_asistencia", "agente"],
      ["invitar_a_volver", "agente"],
      ["presupuestos_sin_cita", "persona"],
      ["atenciones_sin_firmar", "persona"],
      ["cobranza_vencida", "persona"],
    ])
    expect(page.lines.map((line) => line.key)).toEqual(ADMIN_LINES.map((line) => line.key))
    const noShowLine = page.lines.find((line) => line.key === "seguimiento_no_asistencia")!
    // Apagada: se dice en condicional, y con cuántos casos empezaría hoy.
    expect(noShowLine).toMatchObject({
      trigger: "Una persona falta a su cita",
      description: "Sofi le escribiría al día siguiente para reprogramar. Si no puede, avisa por qué y cómo habilitarlo, y quedaría una tarea para el equipo de recepción.",
      enabled: false, hasAgent: true, agentPart: true, teamPart: true, todayCases: 0, recommended: false, week: null,
    })
    expect(page.lines.find((line) => line.key === "cobranza_vencida")).toMatchObject({
      trigger: "Un saldo pasa 30 días vencido", description: "Quedaría una tarea para el equipo de caja.", hasAgent: false, agentPart: false, days: 30,
    })
    expect(page).toMatchObject({ enabled: true, receptionOn: true, whatsapp: false, today: { recommendations: 0, done: 0, yours: 0 }, monthTemplates: 0 })
  })

  it("prendida habla en presente, cambia quién lo hace según sus partes y guarda quién la cambió", async () => {
    const c = await clinic()
    const change = (input: Parameters<typeof updateAdminLine>[5]) =>
      run(c, (tx) => updateAdminLine(tx, c.orgId, c.ownerId, all, "seguimiento_no_asistencia", input))
    const on = await change({ enabled: true })
    expect(on).toMatchObject({
      enabled: true, actor: "agente", week: "Esta semana: todavía nada", paused: null,
      description: "Sofi le escribe al día siguiente para reprogramar. Si no puede, avisa por qué y cómo habilitarlo, y queda una tarea para el equipo de recepción.",
    })
    expect(on.since).not.toBeNull()
    // El flujo dibuja solo lo que se ejecuta; el aviso de «no pude» no depende de ningún interruptor.
    expect(on.flow.main.map((step) => step.label)).toEqual(["Una persona falta a su cita", "Espera al día siguiente", "¿Puede escribirle Sofi?", "Le escribe", "Lo resuelve Sofi"])
    expect(on.flow.otherwise?.map((step) => [step.label, step.always])).toEqual([["Avisa por qué y cómo habilitarlo", true], ["Tarea de llamada", false], ["Le toca a una persona", false]])
    expect(on.message).toEqual({
      text: "Hola, Lucía. No pudimos verte en la cita del lunes 12 de octubre en Clínica Sonríe. ¿Te buscamos otro horario?",
      buttons: ["Sí, otro horario", "No enviar más"],
    })
    const noTask = await change({ teamPart: false })
    expect(noTask.description).toBe("Sofi le escribe al día siguiente para reprogramar. Si no puede, avisa por qué y cómo habilitarlo.")
    expect(noTask.flow.otherwise?.map((step) => step.label)).toEqual(["Avisa por qué y cómo habilitarlo", "Queda avisado"])
    // «Mejor que a quien falta lo llame una persona»: sin el agente, la línea le toca al equipo.
    const byPerson = await change({ teamPart: true, agentPart: false })
    expect(byPerson).toMatchObject({ actor: "persona", description: "Queda una tarea de llamada para el equipo de recepción." })
    expect(byPerson.flow).toMatchObject({ otherwise: null })
    expect(byPerson.flow.main.map((step) => step.label)).toEqual(["Una persona falta a su cita", "Espera al día siguiente", "Tarea de llamada", "Le toca a una persona"])
    // Apagada, el flujo entero sigue a la vista.
    expect(byPerson.fullFlow.main.map((step) => step.id)).toEqual(["inicio", "espera", "puede", "escribe", "fin"])
    expect(byPerson.changes.map((item) => [item.by, item.what])).toEqual([
      ["Ana Ruiz", "apagó «el agente le escribe» y prendió la tarea para el equipo"],
      ["Ana Ruiz", "apagó la tarea para el equipo"],
      ["Ana Ruiz", "la prendió"],
    ])
  })

  it("con Recepción apagada, la línea que escribe dice que está en pausa", async () => {
    const c = await clinic({ reception: false })
    const line = await run(c, (tx) => updateAdminLine(tx, c.orgId, c.ownerId, all, "recordatorio_cita", { enabled: true }))
    expect(line.paused).toBe("recepcion_apagada")
    expect((await run(c, (tx) => updateAdminLine(tx, c.orgId, c.ownerId, all, "cobranza_vencida", { enabled: true }))).paused).toBeNull()
  })

  it("el flujo de una línea que solo deja trabajo al equipo no tiene decisión ni aviso", () => {
    const line = ADMIN_LINES.find((item) => item.key === "atenciones_sin_firmar")!
    const flow = flowOf(line, { agentPart: false, teamPart: true }, { days: 2 })
    expect(flow.otherwise).toBeNull()
    expect(flow.main.map((step) => [step.label, step.actorLabel])).toEqual([
      ["Una atención lleva 2 días sin firmar", null],
      ["Espera 2 días", "Argos · agente"],
      ["Tarea para firmar", "Equipo clínico · persona"],
      ["Le toca a una persona", null],
    ])
  })
})

describe("lo que recomienda", () => {
  it("son las líneas apagadas que hoy tienen casos: tres como mucho, según el rol, y sin las que se pidió no recomendar", async () => {
    const c = await clinic()
    await acceptedBudget(c, await person(c, "Camila Ortiz"), 20)
    await noShow(c, await person(c, "Rosa Medina"), 3)
    await ownerDb.insert(patientCharge).values({
      organizationId: c.orgId, patientId: await person(c, "Pedro Lara"), description: "Cargo", amountCents: 25000, currency: "PEN",
      createdAt: new Date(Date.now() - 45 * DAY),
    })
    await ownerDb.insert(encounter).values({
      organizationId: c.orgId, patientId: await person(c, "Elena Vargas"), dentistUserId: await formerDentist(c), branchId: c.branchId,
      startedAt: new Date(Date.now() - 5 * DAY),
    })
    const advice = await run(c, (tx) => getAdminRecommendations(tx, c.orgId, all))
    expect(advice.recommendations.map((item) => [item.key, item.actor, item.total])).toEqual([
      ["seguimiento_no_asistencia", "agente", 1],
      ["presupuestos_sin_cita", "persona", 1],
      ["atenciones_sin_firmar", "persona", 1],
    ])
    expect(advice.more).toBe(1)
    expect(advice.recommendations[0]).toMatchObject({
      title: "1 persona faltó a su cita en los últimos 30 días y no tiene otra",
      once: { label: "Escribirles esta vez" },
    })
    expect(advice.recommendations[1]?.once).toEqual({ label: "Crear 1 tarea", detail: "Una tarea para el equipo de recepción, una por persona. No se envía ningún mensaje." })
    // Quien solo ve la caja recibe solo lo de la caja.
    const cashier = (permission: string) => permission === "finance.read"
    expect((await run(c, (tx) => getAdminRecommendations(tx, c.orgId, cashier))).recommendations.map((item) => item.key)).toEqual(["cobranza_vencida"])
    await expect(run(c, (tx) => getAdminRecommendation(tx, c.orgId, cashier, "atenciones_sin_firmar"))).rejects.toMatchObject({ code: "FORBIDDEN" })
    // En Inicio llega solo lo que quien lee puede atender: la caja puede dejar sus
    // tareas, pero no pedirle al agente que escriba ni prender la línea.
    const roleOf = (permissions: string[]) => (permission: string) => permissions.includes(permission)
    const cashierRole = roleOf(["finance.read", "tasks.write", "patients.read"])
    expect((await run(c, (tx) => getAdminRecommendations(tx, c.orgId, cashierRole, { actionable: true }))).recommendations.map((item) => item.key))
      .toEqual(["cobranza_vencida"])
    const dentistRole = roleOf(["appointments.read", "clinical.read", "tasks.write"])
    expect((await run(c, (tx) => getAdminRecommendations(tx, c.orgId, dentistRole, { actionable: true }))).recommendations.map((item) => item.key))
      .not.toContain("seguimiento_no_asistencia")
    const reception = roleOf(["appointments.read", "crm.read", "tasks.write", "agent.decide"])
    expect((await run(c, (tx) => getAdminRecommendations(tx, c.orgId, reception, { actionable: true }))).recommendations.map((item) => item.key))
      .toContain("seguimiento_no_asistencia")
    // «No recomendarla más» la deja en la lista, sin recomendarla; prendida, tampoco se recomienda.
    await run(c, (tx) => updateAdminLine(tx, c.orgId, c.ownerId, all, "presupuestos_sin_cita", { noRecommend: true }))
    await run(c, (tx) => updateAdminLine(tx, c.orgId, c.ownerId, all, "atenciones_sin_firmar", { enabled: true }))
    expect((await run(c, (tx) => getAdminRecommendations(tx, c.orgId, all))).recommendations.map((item) => item.key)).toEqual(["seguimiento_no_asistencia", "cobranza_vencida"])
    const page = await run(c, (tx) => getAdminPage(tx, c.orgId, all))
    expect(page.lines.find((line) => line.key === "presupuestos_sin_cita")).toMatchObject({ todayCases: 1, recommended: false, noRecommend: true })
    expect(page.today.recommendations).toBe(2)
    expect(await run(c, (tx) => getAdminOverview(tx, c.orgId, all))).toEqual({ enabled: true, on: 1, byAgent: 0, byTeam: 1, recommended: 2 })
    // Apagado no recomienda nada; la vista previa sí calcula.
    await run(c, (tx) => updateAdminSettings(tx, c.orgId, c.ownerId, { enabled: false }))
    expect(await run(c, (tx) => getAdminRecommendations(tx, c.orgId, all))).toEqual({ enabled: false, recommendations: [], more: 0 })
    expect((await run(c, (tx) => getAdminRecommendations(tx, c.orgId, all, { preview: true, all: true }))).recommendations).toHaveLength(2)
  })

  it("«solo esta vez» deja las tareas de hoy sin prender la línea, y repetirlo no duplica", async () => {
    const c = await clinic()
    const patientId = await person(c, "Camila Ortiz")
    await acceptedBudget(c, patientId, 20)
    const once = () => run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "presupuestos_sin_cita", { secretsKey: KEY }))
    expect(await once()).toEqual({ created: 1, total: 1, writes: false, all: 1 })
    expect(await once()).toEqual({ created: 0, total: 1, writes: false, all: 1 })
    expect(await tasksOf(c)).toMatchObject([
      { title: "Llamar a Camila Ortiz para agendar su tratamiento", createdBy: "admin", area: "recepcion", patientId, status: "open" },
    ])
    expect((await tasksOf(c))[0]?.reason).toMatch(/^Presupuesto N\.º \d+ · Ortodoncia · aceptado el /)
    expect((await run(c, (tx) => getAdminPage(tx, c.orgId, all))).lines.find((line) => line.key === "presupuestos_sin_cita")?.enabled).toBe(false)
    // Donde escribe el agente, los mensajes quedan para el siguiente ciclo, con sus comprobaciones.
    await noShow(c, await person(c, "Rosa Medina"), 3)
    expect(await run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "seguimiento_no_asistencia", { secretsKey: KEY }))).toEqual({ created: 1, total: 1, writes: true, all: 1 })
    expect((await jobsOf(c)).find((job) => job.kind === "seguimiento_no_asistencia")).toMatchObject({ status: "pendiente", payload: { once: true } })
    // Una línea que solo tiene sentido prendida no ofrece «solo esta vez».
    await expect(run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "recordatorio_cita", { secretsKey: KEY }))).rejects.toThrow(/solo se puede prender/)
  })
})

describe("las líneas que dejan trabajo al equipo", () => {
  it("dejan una tarea por caso nuevo desde que se prendieron, a su área o a quien lo lleva, con el motivo", async () => {
    const c = await clinic()
    const before = await person(c, "Ya debía")
    const after = await person(c, "Cumple hoy")
    await acceptedBudget(c, before, 30)
    await acceptedBudget(c, after, 8)
    const signer = await person(c, "Elena Vargas")
    await ownerDb.insert(encounter).values({
      organizationId: c.orgId, patientId: signer, dentistUserId: await formerDentist(c), branchId: c.branchId, startedAt: new Date(Date.now() - 2.5 * DAY),
    })
    // La de quien sigue atendiendo ya le sale en «Te espera»: la línea no le deja otra tarea.
    await ownerDb.insert(encounter).values({
      organizationId: c.orgId, patientId: await person(c, "Mario Soto"), dentistUserId: c.dentistId, branchId: c.branchId, startedAt: new Date(Date.now() - 2.5 * DAY),
    })
    // Prendidas hace dos días: el presupuesto de 30 días ya cumplía la condición antes y no cuenta.
    await turnedOn(c, "presupuestos_sin_cita", 2)
    await turnedOn(c, "atenciones_sin_firmar", 2)
    expect(await run(c, (tx) => syncTeamLines(tx, c.orgId, new Date()))).toBe(2)
    expect(await run(c, (tx) => syncTeamLines(tx, c.orgId, new Date()))).toBe(0)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["tarea", "tarea"])
    const tasks = await tasksOf(c)
    expect(tasks.map((task) => [task.title, task.area, task.assigneeUserId, task.createdBy]).sort()).toEqual([
      ["Llamar a Cumple hoy para agendar su tratamiento", "recepcion", null, "admin"],
      // Quien la llevaba ya no es del equipo: la tarea va al área clínica.
      ["Revisar y firmar la atención de Elena Vargas", "clinico", null, "admin"],
    ])
    expect(tasks.every((task) => task.dueAt !== null && !!task.reason)).toBe(true)
    const line = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "presupuestos_sin_cita"))
    expect(line.week).toBe("Esta semana: 1 tarea, 0 resueltas")
    expect(line.people).toMatchObject([{ personName: "Cumple hoy", outcome: "tarea", text: "Quedó una tarea para el equipo de recepción." }])
    // Resuelta la tarea, la línea lo cuenta.
    await run(c, (tx) => completeTask(tx, c.orgId, tasks.find((task) => task.area === "recepcion")!.id, { userId: c.ownerId }))
    const done = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "presupuestos_sin_cita"))
    expect(done.week).toBe("Esta semana: 1 tarea, 1 resuelta")
    expect(done.people[0]).toMatchObject({ outcome: "tarea_resuelta", text: "Una persona ya lo resolvió." })
    expect((await run(c, (tx) => getAdminPage(tx, c.orgId, all))).today).toMatchObject({ done: 2, yours: 1 })
  })

  it("si el motivo ya no está en pie cuando toca, no deja nada", async () => {
    const c = await clinic()
    const signer = await person(c, "Elena Vargas")
    const [visit] = await ownerDb.insert(encounter).values({
      organizationId: c.orgId, patientId: signer, dentistUserId: await formerDentist(c), branchId: c.branchId, startedAt: new Date(Date.now() - 2.5 * DAY),
    }).returning({ id: encounter.id })
    await turnedOn(c, "atenciones_sin_firmar", 1)
    expect(await run(c, (tx) => syncTeamLines(tx, c.orgId, new Date()))).toBe(1)
    // Alguien la firmó antes de que el ciclo lo atienda.
    await ownerDb.update(encounter).set({ status: "finalizada", finalizedAt: new Date(), signerName: "Dra. Carla Ríos", signerRegistration: "COP 1234" }).where(eq(encounter.id, visit!.id))
    expect(await deliver(c)).toMatchObject([{ outcome: "cancelado", detail: "La atención ya se firmó" }])
    expect(await tasksOf(c)).toEqual([])
  })

  it("lo que deja el Administrador se cierra solo cuando su motivo desaparece, y dice por qué", async () => {
    const c = await clinic()
    const late = await person(c, "Rosa Quispe")
    await acceptedBudget(c, late, 8)
    await turnedOn(c, "presupuestos_sin_cita", 0, 7)
    await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 2 * DAY) }).where(eq(automationRule.organizationId, c.orgId))
    expect(await run(c, (tx) => syncTeamLines(tx, c.orgId, new Date()))).toBe(1)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["tarea"])
    const [task] = await tasksOf(c)
    // La tarea dice de quién es: la propia persona del paciente, no un contacto vacío.
    expect(task).toMatchObject({ status: "open", patientId: late, createdBy: "admin" })
    // Mientras el motivo siga en pie, no se cierra.
    expect(await run(c, (tx) => settleTasks(tx, c.orgId, new Date()))).toBe(0)
    // Reservó su cita: la tarea ya no hace falta.
    const startsAt = new Date(Date.now() + 2 * DAY)
    await ownerDb.insert(appointment).values({
      organizationId: c.orgId, branchId: c.branchId, patientId: late, dentistUserId: c.dentistId, chairId: c.chairId,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada",
    })
    expect(await run(c, (tx) => settleTasks(tx, c.orgId, new Date()))).toBe(1)
    const [settled] = await tasksOf(c)
    expect(settled).toMatchObject({ status: "done", settledReason: "Rosa Quispe ya tiene otra cita reservada" })
    // «Qué pasó» no dice que la resolvió una persona.
    const line = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "presupuestos_sin_cita"))
    expect(line.people[0]).toMatchObject({ outcome: "tarea_resuelta", text: "Se cerró sola: Rosa Quispe ya tiene otra cita reservada." })
    // Repetir el ciclo no la toca otra vez.
    expect(await run(c, (tx) => settleTasks(tx, c.orgId, new Date()))).toBe(0)
  })

  it("las tareas que siguen en pie no tapan a las siguientes: la revisión avanza con un cursor entre ciclos", async () => {
    const c = await clinic()
    for (const name of ["Uno Pérez", "Dos Pérez", "Tres Pérez"]) await acceptedBudget(c, await person(c, name), 8)
    await turnedOn(c, "presupuestos_sin_cita", 2, 7)
    expect(await run(c, (tx) => syncTeamLines(tx, c.orgId, new Date()))).toBe(3)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["tarea", "tarea", "tarea"])
    // La tarea más nueva deja de hacer falta: su paciente ya tiene cita.
    const tasks = (await tasksOf(c)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    const last = tasks.at(-1)!
    const startsAt = new Date(Date.now() + 2 * DAY)
    await ownerDb.insert(appointment).values({
      organizationId: c.orgId, branchId: c.branchId, patientId: last.patientId!, dentistUserId: c.dentistId, chairId: c.chairId,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada",
    })
    // Con dos por ciclo, el primero revisa las dos más viejas (siguen en pie) y el siguiente sigue desde ahí.
    const cycle = () => run(c, (tx) => settleTasks(tx, c.orgId, new Date(), { batch: 1, perCycle: 2 }))
    expect(await cycle()).toBe(0)
    expect(await cycle()).toBe(1)
    expect((await tasksOf(c)).find((task) => task.id === last.id)).toMatchObject({ status: "done" })
    // Al llegar al final vuelve a empezar: nada más que cerrar.
    expect(await cycle()).toBe(0)
  })
})

describe("saldo vencido descuenta lo que la persona tiene a favor (decisión 22)", () => {
  const charge = (c: Clinic, patientId: string, amountCents: number) =>
    ownerDb.insert(patientCharge).values({
      organizationId: c.orgId, patientId, description: "Cargo", amountCents, currency: "PEN", createdAt: new Date(Date.now() - 45 * DAY),
    })
  const credit = (c: Clinic, patientId: string, amountCents: number) =>
    ownerDb.insert(patientPayment).values({
      organizationId: c.orgId, patientId, branchId: c.branchId, methodName: "Efectivo", methodTypeCode: "10", amountCents, currency: "PEN", paidAt: new Date(),
    })

  it("con lo que tiene a favor alcanzando no hay caso; si no alcanza, dice lo que falta, y la tarea se cierra cuando alcanza", async () => {
    const c = await clinic()
    const pedro = await person(c, "Pedro Lara")
    await charge(c, pedro, 25000)
    const lucia = await person(c, "Lucía Soto")
    await charge(c, lucia, 25000)
    await credit(c, lucia, 30000)
    const mario = await person(c, "Mario Cruz")
    await charge(c, mario, 25000)
    await credit(c, mario, 10000)
    const advice = await run(c, (tx) => getAdminRecommendation(tx, c.orgId, all, "cobranza_vencida"))
    expect(advice.total).toBe(2)
    expect(advice.items.map((item) => item.personName).sort()).toEqual(["Mario Cruz", "Pedro Lara"])
    expect(advice.items.find((item) => item.personName === "Mario Cruz")?.line).toMatch(/^Debe S\/\s?150\.00 · /)

    // La tarea de Mario se cierra sola cuando lo que tiene a favor cubre lo que debe.
    await turnedOn(c, "cobranza_vencida", 0, 30)
    await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 20 * DAY) }).where(eq(automationRule.organizationId, c.orgId))
    expect(await run(c, (tx) => syncTeamLines(tx, c.orgId, new Date()))).toBe(2)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["tarea", "tarea"])
    expect(await run(c, (tx) => settleTasks(tx, c.orgId, new Date()))).toBe(0)
    await credit(c, mario, 15000)
    expect(await run(c, (tx) => settleTasks(tx, c.orgId, new Date()))).toBe(1)
    const settled = (await tasksOf(c)).find((task) => task.patientId === mario)
    expect(settled).toMatchObject({ status: "done" })
    expect(settled?.settledReason).toMatch(/pagó/)
  })
})

describe("«Escribirles esta vez» escribe a todas las personas, como promete", () => {
  it("con más casos de los que caben en la lista, escribe a todos y dice el número real", async () => {
    const c = await clinic()
    for (let index = 0; index < 205; index++) await noShow(c, await person(c, `Persona ${index}`), 3)
    const advice = await run(c, (tx) => getAdminRecommendation(tx, c.orgId, all, "seguimiento_no_asistencia"))
    // La lista de la pantalla se corta en 200; lo que promete el botón, no.
    expect(advice.total).toBe(205)
    expect(advice.items).toHaveLength(200)
    expect(advice.once?.detail).toContain("estas 205 personas")
    const result = await run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "seguimiento_no_asistencia", { secretsKey: KEY }))
    expect(result).toEqual({ created: 205, total: 205, writes: true, all: 205 })
    expect((await jobsOf(c)).filter((job) => job.kind === "seguimiento_no_asistencia")).toHaveLength(205)
  })
})

describe("a quién no pudo escribirle", () => {
  it("junta por motivo a las personas de hoy, con cómo habilitar a cada una", async () => {
    const c = await clinic()
    // Los dos pidieron no recibir estos mensajes (su baja): es parte del servicio, pero la baja se respeta.
    for (const [name, days] of [["Tomás Rivas", 3], ["Pedro Lara", 4]] as const) {
      const patientId = await person(c, name)
      const [own] = await ownerDb.select({ contactId: patientContact.contactId }).from(patientContact)
        .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
      await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId: own!.contactId, purpose: "seguimiento", status: "revoked", source: "baja" })
      await noShow(c, patientId, days)
    }
    await run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "seguimiento_no_asistencia", { secretsKey: KEY }))
    // El agente no escribe, avisa, y queda la tarea de llamada.
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["omitido", "omitido"])
    const unreached = await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))
    expect(unreached.total).toBe(2)
    expect(unreached.byCause).toEqual([
      { cause: "sin_permiso", total: 2, reason: "pidió no recibir este tipo de mensaje", fix: "Si cambia de opinión, anótalo en su página, en Datos › Mensajes." },
    ])
    expect(unreached.people.map((row) => [row.personName, row.lineName, row.outcome]).sort()).toEqual([
      ["Pedro Lara", "Reprogramar tras una inasistencia", "no_pudo"],
      ["Tomás Rivas", "Reprogramar tras una inasistencia", "no_pudo"],
    ])
    expect(unreached.people[0]?.text).toBe("Sofi no pudo escribirle: pidió no recibir este tipo de mensaje. Lo tiene el equipo de recepción.")
    expect(await tasksOf(c)).toHaveLength(2)
    // Quien no ve la agenda no ve a esas personas.
    expect(await run(c, (tx) => getAdminUnreached(tx, c.orgId, (permission) => permission === "finance.read"))).toEqual({ total: 0, byCause: [], people: [] })
  })
})

describe("el ciclo del worker", () => {
  it("con el administrador apagado no hace nada; encendido, atiende solo lo prendido", async () => {
    const off = await clinic({ admin: false })
    const on = await clinic()
    for (const c of [off, on]) {
      await ownerDb.insert(patientCharge).values({
        organizationId: c.orgId, patientId: await person(c, "Rosa Medina"), description: "Cargo", amountCents: 9000, currency: "PEN",
        createdAt: new Date(Date.now() - 31 * DAY),
      })
      // La línea se prendió hace dos días: el saldo cumplió sus 30 días ayer.
      await ownerDb.insert(automationRule).values({
        organizationId: c.orgId, name: "Saldo vencido", kind: "cobranza_vencida", enabled: true, agentPart: false,
        enabledAt: new Date(Date.now() - 2 * DAY), createdBy: c.ownerId,
      })
    }
    await tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test" })
    expect(await tasksOf(off)).toEqual([])
    expect(await tasksOf(on)).toMatchObject([{ title: "Llamar a Rosa Medina por lo que debe", area: "caja", createdBy: "admin" }])
    expect((await tasksOf(on))[0]?.reason).toMatch(/^Debe .* · desde el /)
    // Otro ciclo no vuelve a dejar la misma tarea.
    await tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test" })
    expect(await tasksOf(on)).toHaveLength(1)
  })
})

describe("propone cambiar o apagar la línea que no sirve", () => {
  it("lo dice con su cifra cuando no pudo escribirle a la mayoría, y nunca lo aplica por su cuenta", async () => {
    const c = await clinic()
    await turnedOn(c, "seguimiento_presupuesto", 20)
    const [rule] = await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))
    const quiet = (await run(c, (tx) => getAdminPage(tx, c.orgId, all))).lines.find((line) => line.key === "seguimiento_presupuesto")!
    expect(quiet.suggestion).toBeNull()
    await ownerDb.insert(automationJob).values(
      Array.from({ length: 10 }, (_, index) => ({
        organizationId: c.orgId, ruleId: rule!.id, kind: "seguimiento_presupuesto", dedupeKey: `seguimiento_presupuesto:prueba-${index}`,
        scheduledFor: new Date(), status: "omitido", cause: "sin_permiso",
      })),
    )
    const line = (await run(c, (tx) => getAdminPage(tx, c.orgId, all))).lines.find((item) => item.key === "seguimiento_presupuesto")!
    expect(line.suggestion).toBe("En 30 días Sofi no pudo escribirle a 10 de 10 personas. Mira por qué antes de seguir: casi siempre es el permiso o un dato que falta.")
    expect(line.enabled).toBe(true)
  })
})

describe("decisión 14: un tratamiento en curso sin siguiente sesión cuenta en «Presupuesto aceptado sin cita»", () => {
  it("un presupuesto recién aceptado no cuenta; con un tratamiento en curso sin cita para su próxima sesión, sí", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe")
    const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId: rosa, title: "Plan" }).returning({ id: treatmentPlan.id })
    const [item] = await ownerDb
      .insert(treatmentPlanItem)
      .values({ organizationId: c.orgId, patientId: rosa, planId: plan!.id, title: "Endodoncia de la 36", currency: "PEN", status: "pendiente", decisionStatus: "aceptado" })
      .returning({ id: treatmentPlanItem.id })
    const [budget] = await ownerDb
      .insert(treatmentBudget)
      .values({ organizationId: c.orgId, patientId: rosa, planId: plan!.id, budgetNumber: budgetNumber++, title: "Endodoncia", currency: "PEN", status: "borrador" })
      .returning({ id: treatmentBudget.id })
    // Solo un presupuesto en borrador admite líneas: se acepta después.
    const optionId = randomUUID()
    await ownerDb.insert(treatmentBudgetOption).values({ id: optionId, organizationId: c.orgId, patientId: rosa, budgetId: budget!.id, position: 1 })
    await ownerDb
      .insert(treatmentBudgetItem)
      .values({ organizationId: c.orgId, patientId: rosa, planId: plan!.id, budgetId: budget!.id, optionId, planItemId: item!.id, title: "Endodoncia de la 36", currency: "PEN" })
    await ownerDb.update(treatmentBudget).set({ status: "aceptado", decidedAt: new Date(Date.now() - DAY) }).where(eq(treatmentBudget.id, budget!.id))
    // El presupuesto es de ayer y el tratamiento aún no empezó: nada que pedir todavía.
    expect((await run(c, (tx) => getAdminLine(tx, c.orgId, all, "presupuestos_sin_cita"))).todayCases).toBe(0)
    // Empezó y no tiene la siguiente sesión agendada: la línea lo pide a recepción.
    await ownerDb.update(treatmentPlanItem).set({ status: "en_curso" }).where(eq(treatmentPlanItem.id, item!.id))
    expect((await run(c, (tx) => getAdminLine(tx, c.orgId, all, "presupuestos_sin_cita"))).todayCases).toBe(1)
  })
})
