import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationJob, automationRule } from "@odentia/db/schema/automation"
import { patientCharge, patientContact } from "@odentia/db/schema/clinical"
import { agentConfig, channelTemplate, crmTask } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { adminLineOf, jobKindsOfLine, lineOfJobKind } from "./admin-lines.js"
import { getAdminUnreached, listAdminLinePeople, runAdminLineOnce, tickAutomations } from "./agent-admin.js"
import { deliverDueJobs, enqueueAppointmentNotice, failureRecipient, setLine } from "./automation.js"
import { createConnection } from "./connections.js"
import { createSaasPlan } from "./saas-billing.js"
import { getAgentSpendGate } from "./saas-terms.js"
import { configurePublicLinks } from "./public-links.js"
import { nextPatientNumber } from "./patients.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * SONDEO (no es una prueba de regresión): ejecuta contra una base real los
 * fallos que el análisis de Argos y sus avisos encontró en el código. Cada
 * `it` afirma lo que HOY pasa; si algún día se arregla, la prueba avisa.
 */
setupTestDb()
const KEY = secretsKeyFromEnv("cd".repeat(32))
const DAY = 86_400_000
const all = () => true

async function clinic() {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  await insertOrg(ownerDb, orgId, `sondeo-${orgId}`)
  await ownerDb.insert(user).values({ id: ownerId, name: "Ana Ruiz", email: `${ownerId}@sondeo.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: true,
    advisor: { enabled: true },
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad 1" }).returning({ id: scheduleRoom.id })
  return { orgId, ownerId, branchId: site!.id, roomId: room!.id, professionalId: ownerId }
}
type Clinic = Awaited<ReturnType<typeof clinic>>
const run = <T>(c: Clinic, fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, c.orgId, fn)

async function person(c: Clinic, name: string) {
  const [row] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  return row!.id
}
const jobsOf = (c: Clinic) => ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, c.orgId))
const tasksOf = (c: Clinic) => ownerDb.select().from(crmTask).where(eq(crmTask.organizationId, c.orgId))

async function overdueDebt(c: Clinic, name: string) {
  await ownerDb.insert(patientCharge).values({
    organizationId: c.orgId, patientId: await person(c, name), description: "Cargo", amountCents: 9000, currency: "PEN",
    createdAt: new Date(Date.now() - 31 * DAY),
  })
  const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "cobranza_vencida", { enabled: true, agentPart: false }))
  await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 2 * DAY) }).where(eq(automationRule.id, rule.id))
}

describe("sondeo 1: un caso que falla tumba el ciclo de todas las clínicas siguientes", () => {
  it("la clínica con el caso venenoso se reintenta cada minuto y la siguiente nunca recibe su tarea", async () => {
    const poisoned = await clinic()
    const healthy = await clinic()
    await overdueDebt(poisoned, "Rosa Medina")
    await overdueDebt(healthy, "Luis Prado")
    // Cualquier fallo al dejar la tarea (restricción, dato raro…) sirve: aquí, un disparador.
    await ownerDb.execute(sql.raw(`create or replace function sondeo_boom() returns trigger language plpgsql as $$ begin raise exception 'sondeo: fallo al crear la tarea'; end $$`))
    await ownerDb.execute(sql.raw(`create trigger sondeo_boom before insert on task for each row when (new.organization_id = '${poisoned.orgId}') execute function sondeo_boom()`))
    const tick = () => tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test" })
    try {
      await expect(tick()).rejects.toThrow()
      await expect(tick()).rejects.toThrow()
      // La sana, que estaba después en la lista, no recibió nada en dos ciclos.
      expect(await tasksOf(healthy)).toEqual([])
      expect((await jobsOf(poisoned)).map((job) => job.status)).toEqual(["pendiente"])
    } finally {
      await ownerDb.execute(sql.raw("drop trigger if exists sondeo_boom on task"))
    }
    // Sin el fallo, el siguiente ciclo sí la atiende: el daño era solo del ciclo.
    await tick()
    expect(await tasksOf(healthy)).toHaveLength(1)
    expect(await tasksOf(poisoned)).toHaveLength(1)
  })
})

describe("sondeo 2: los avisos de cita no aparecen en ninguna lista de «no pude»", () => {
  it("un aviso de cancelación que no salió no se cuenta, pero el seguimiento de una inasistencia igual sí", async () => {
    const c = await clinic()
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia", { enabled: true }))
    await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 5 * DAY) }).where(eq(automationRule.id, rule.id))
    // Paciente A: la cita de mañana se canceló y se le debe avisar.
    const a = await person(c, "Ana Cancelada")
    const startsAt = new Date(Date.now() + DAY)
    const [appt] = await ownerDb.insert(appointment).values({
      organizationId: c.orgId, branchId: c.branchId, patientId: a, professionalUserId: c.professionalId, roomId: c.roomId,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "cancelada",
    }).returning({ id: appointment.id })
    expect(await run(c, (tx) => enqueueAppointmentNotice(tx, c.orgId, appt!.id, "cancelada"))).toEqual({ queued: true })
    // Paciente B: faltó y el seguimiento no puede escribirle por la misma razón que a A.
    const b = await person(c, "Beto Faltó")
    const past = new Date(Date.now() - 3 * DAY)
    await ownerDb.insert(appointment).values({
      organizationId: c.orgId, branchId: c.branchId, patientId: b, professionalUserId: c.professionalId, roomId: c.roomId,
      startsAt: past, endsAt: new Date(past.getTime() + 30 * 60_000), durationMin: 30, status: "no_asistio",
    })
    await run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "seguimiento_no_asistencia", { secretsKey: KEY }))
    const results = await run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }))
    const jobs = await jobsOf(c)
    const failed = jobs.filter((job) => job.cause !== null)
    // Los dos fallaron con motivo...
    expect(failed.map((job) => job.kind).sort()).toEqual(["aviso_cita_cancelada", "seguimiento_no_asistencia"])
    console.log("[sondeo 2] resultados:", results.map((r) => r.outcome), "causas:", failed.map((j) => `${j.kind}:${j.cause}`))
    // ...pero «no pudo escribirle a N personas» solo cuenta a uno.
    const unreached = await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))
    expect(unreached.total).toBe(1)
    expect(unreached.people.map((p) => p.lineKey)).toEqual(["seguimiento_no_asistencia"])
    // Y en la página de su propia línea tampoco están.
    const people = await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "recordatorio_cita", { only: "no-pudo" }))
    expect(people.total).toBe(0)
    // La causa: la lista de claves de la línea existe y nadie la usa.
    expect(jobKindsOfLine("recordatorio_cita")).toContain("aviso_cita_cancelada")
    expect(adminLineOf("aviso_cita_cancelada")).toBeNull()
    expect(lineOfJobKind("aviso_cita_cancelada")?.key).toBe("recordatorio_cita")
  })
})

describe("sondeo 3: lo que falló hace más de 24 horas desaparece de «Te espera»", () => {
  it("un fallo de ayer por la tarde ya no se cuenta hoy por la mañana", async () => {
    const c = await clinic()
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia", { enabled: true }))
    const patientId = await person(c, "Carla Antigua")
    await ownerDb.insert(automationJob).values({
      organizationId: c.orgId, ruleId: rule.id, kind: "seguimiento_no_asistencia", dedupeKey: `sondeo:${randomUUID()}`,
      scheduledFor: new Date(Date.now() - 30 * 3_600_000), status: "fallido", cause: "sin_conexion", patientId,
      updatedAt: new Date(Date.now() - 30 * 3_600_000),
    })
    expect((await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))).total).toBe(0)
    // La página de su línea sí la conserva: la información existe, pero Inicio ya no la dice.
    expect((await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_no_asistencia", { only: "no-pudo" }))).total).toBe(1)
  })
})

describe("sondeo 4: «Invitar a volver» no respeta desde cuándo se prendió", () => {
  it("al prenderla programa de golpe a todo el atraso (hasta 200 por ciclo)", async () => {
    const c = await clinic()
    // 12 pacientes cuya última visita fue hace un año.
    for (let i = 0; i < 12; i++) {
      const id = await person(c, `Paciente ${i}`)
      const when = new Date(Date.now() - 400 * DAY)
      await ownerDb.insert(appointment).values({
        organizationId: c.orgId, branchId: c.branchId, patientId: id, professionalUserId: c.professionalId, roomId: c.roomId,
        startsAt: when, endsAt: new Date(when.getTime() + 30 * 60_000), durationMin: 30, status: "atendida",
      })
    }
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "invitar_a_volver", { enabled: true }))
    await tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test" })
    const queued = (await jobsOf(c)).filter((job) => job.kind === "invitar_a_volver")
    console.log("[sondeo 4] invitaciones anotadas en el primer ciclo tras prender:", queued.length, "estados:", queued.map((j) => j.status))
    expect(queued.length).toBe(12)
  })
})

// ---------------------------------------------------------------- ronda 2 ---

configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
const WA_CONFIG = { phoneNumberId: "PNID", wabaId: "WABA", accessToken: "clave-1", appSecret: "secreto" }

/** Clínica con WhatsApp conectado y un mensaje del agente sin pedir todavía. Dos personas administran. */
async function clinicWithWhatsApp() {
  const c = await clinic()
  const adminId = `admin-${c.orgId}`
  await ownerDb.insert(user).values({ id: adminId, name: "Beto Admin", email: `${adminId}@sondeo.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${adminId}`, userId: adminId, organizationId: c.orgId, role: "admin", createdAt: new Date() })
  const connection = await run(c, (tx) =>
    createConnection(tx, c.orgId, KEY, { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", config: WA_CONFIG }, { fetch, validateExternal: false }),
  )
  await ownerDb.delete(channelTemplate).where(and(eq(channelTemplate.connectionId, connection.id), eq(channelTemplate.name, "odentia_retomar_conversacion_v1")))
  return { ...c, adminId }
}

const metaFetch = (answer: () => Response | Promise<Response>) => (async () => answer()) as unknown as typeof fetch
const tickWith = (templatesFetch: typeof fetch) =>
  tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test", templates: { fetch: templatesFetch } })

describe("sondeo 5: una caída de Meta (algo que pasa de verdad) tumba el ciclo de las demás clínicas", () => {
  for (const [name, answer] of [
    ["la red falla (fetch lanza)", () => { throw new TypeError("fetch failed") }],
    ["Meta responde 502 con HTML", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    ["Meta responde 200 con basura", () => new Response("no es json", { status: 200 })],
    ["Meta responde 400 con su error", () => new Response(JSON.stringify({ error: { message: "Invalid token" } }), { status: 400 })],
  ] as const) {
    it(name, async () => {
      const broken = await clinicWithWhatsApp()
      const healthy = await clinic()
      await overdueDebt(healthy, "Luis Prado")
      let outcome = "el ciclo terminó"
      try {
        await tickWith(metaFetch(answer))
      } catch (error) {
        outcome = `el ciclo se cayó: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`
      }
      const healthyTasks = (await tasksOf(healthy)).length
      const notices = await ownerDb.select({ userId: workspaceNotification.userId }).from(workspaceNotification).where(eq(workspaceNotification.organizationId, broken.orgId))
      console.log(`[sondeo 5] ${name}: ${outcome}; tareas de la clínica sana=${healthyTasks}; avisos en la campana de la clínica de Meta=${notices.length} para ${notices.map((n) => (n.userId === broken.ownerId ? "dueña" : "admin")).join(",") || "nadie"}`)
    })
  }
})

describe("sondeo 6: failureRecipient elige a una sola persona", () => {
  it("con dueña y administrador, el aviso de WhatsApp llega a uno solo", async () => {
    const c = await clinicWithWhatsApp()
    const chosen = await run(c, (tx) => failureRecipient(tx, c.orgId, null))
    const again = await run(c, (tx) => failureRecipient(tx, c.orgId, null))
    console.log(`[sondeo 6] elegido=${chosen === c.ownerId ? "dueña" : chosen === c.adminId ? "administrador" : chosen}; repetido=${again === chosen}`)
    expect([c.ownerId, c.adminId]).toContain(chosen)
  })
})

describe("sondeo 7: saldo de prueba agotado y un aviso de cita", () => {
  it("el aviso queda como «tarea» pero sin ninguna tarea creada", async () => {
    const c = await clinic()
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    const patientId = await person(c, "Ana Cancelada")
    const startsAt = new Date(Date.now() + DAY)
    const [appt] = await ownerDb.insert(appointment).values({
      organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: c.professionalId, roomId: c.roomId,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "cancelada",
    }).returning({ id: appointment.id })
    await run(c, (tx) => enqueueAppointmentNotice(tx, c.orgId, appt!.id, "cancelada"))
    // Sin un plan por defecto con precios no hay saldo de prueba que agotar.
    await ownerDb.insert(user).values({ id: "sondeo-admin", name: "Administración", email: "admin@sondeo.test" }).onConflictDoNothing()
    await ownerDb.update(saasPlan).set({ isDefault: false })
    await createSaasPlan(ownerDb, "sondeo-admin", {
      code: `sondeo-${randomUUID().slice(0, 6)}`, name: "Plan sondeo", currency: "USD", priceCents: 2900, creditCents: 2900,
      conversationMicros: 500_000, consultationMicros: 400_000, recoveryMicros: 4_000_000,
      trialCreditCents: 5000, trialMaxCreditCents: 13000, isDefault: true,
    })
    // Se acaba el saldo de la prueba.
    const now = Date.now()
    await ownerDb.update(saasSubscription).set({
      status: "prueba", trialStartedAt: new Date(now - 25 * DAY), trialEndsAt: new Date(now + 5 * DAY),
      currentPeriodStart: new Date(now - 25 * DAY), currentPeriodEnd: new Date(now + 5 * DAY),
      trialCreditCents: 5000,
    }).where(eq(saasSubscription.organizationId, c.orgId))
    await ownerDb.insert(saasAction).values(
      Array.from({ length: 200 }, (_, index) => ({
        organizationId: c.orgId, kind: "conversacion", tier: "gestiona", occurredAt: new Date(now - (index + 1) * 60_000),
        contactId: randomUUID(), detail: "Atendió una conversación por WhatsApp", currency: "USD",
        basePriceMicros: 500_000, priceMicros: 500_000, dedupeKey: randomUUID(),
      })),
    )
    console.log("[sondeo 7] puerta de gasto:", await run(c, (tx) => getAgentSpendGate(tx, c.orgId)))
    const results = await run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }))
    const [job] = await jobsOf(c)
    console.log("[sondeo 7] resultado:", results.map((r) => r.outcome), "estado:", job?.status, "taskId:", job?.taskId, "tareas:", (await tasksOf(c)).length)
    expect(job?.status).toBe("tarea")
    expect(job?.taskId).toBeNull()
    expect(await tasksOf(c)).toEqual([])
  })
})

describe("sondeo 8: «no aceptó novedades» se lee como «pidió no recibir»", () => {
  it("Inicio lo cuenta como fallo y dice otra cosa de lo que pasó", async () => {
    const c = await clinic()
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_presupuesto", { enabled: true }))
    const patientId = await person(c, "Nora Nunca")
    await ownerDb.insert(automationJob).values({
      organizationId: c.orgId, ruleId: rule.id, kind: "seguimiento_presupuesto", dedupeKey: `sondeo:${randomUUID()}`,
      scheduledFor: new Date(), status: "omitido", cause: "sin_permiso", patientId,
      lastError: "La persona no aceptó novedades y promociones",
    })
    const unreached = await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))
    console.log("[sondeo 8] en Inicio:", unreached.total, "|", unreached.byCause[0]?.reason, "| lo que pasó de verdad:", (await jobsOf(c))[0]?.lastError)
    expect(unreached.total).toBe(1)
    expect(unreached.byCause[0]?.reason).toBe("pidió no recibir este tipo de mensaje")
  })
})

// Sin ejecutar: la agenda no deja 206 citas superpuestas con el mismo profesional y sala; se dejó solo por lectura.
describe.skip("sondeo 9: pacientes sin contacto ocupan el lote de 200 y tapan a los demás", () => {
  it("205 citas próximas sin ningún contacto dejan sin recordatorio a la cita 206, que sí lo tiene", async () => {
    const c = await clinic()
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    const start = Date.now() + 2 * 3_600_000
    const ids: string[] = []
    for (let i = 0; i < 205; i++) ids.push(await person(c, `Sin contacto ${i}`))
    const reachable = await person(c, "Con contacto")
    // Los 205 pierden todo vínculo con una persona a quien escribirle.
    await ownerDb.execute(sql`update contact set is_active = false where organization_id = ${c.orgId}
      and id in (select contact_id from patient_contact where organization_id = ${c.orgId}
        and patient_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}))`)
    const rows = [...ids, reachable].map((patientId, index) => {
      const startsAt = new Date(start + index * 60_000)
      return { organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: c.professionalId, roomId: c.roomId, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada" as const }
    })
    await ownerDb.insert(appointment).values(rows)
    await tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test" })
    await tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test" })
    const queued = (await jobsOf(c)).filter((job) => job.kind === "recordatorio_cita")
    console.log("[sondeo 9] recordatorios anotados tras dos ciclos:", queued.length, "(la cita con contacto es la 206)")
    expect(queued.length).toBe(0)
  })
})
