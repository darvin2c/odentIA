import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationJob, automationRule } from "@odentia/db/schema/automation"
import { patientCharge } from "@odentia/db/schema/clinical"
import { agentConfig, channelTemplate, crmTask } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { getAdminUnreached, listAdminLinePeople, tickAutomations } from "./agent-admin.js"
import { deliverDueJobs, enqueueAppointmentNotice, failureRecipients, setLine } from "./automation.js"
import { createConnection } from "./connections.js"
import { nextPatientNumber } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { createSaasPlan } from "./saas-billing.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Cómo Argos avisa cuando algo falla (análisis del 27 oct): el ciclo no se cae por un
 * caso, los avisos de cita cuentan como «no pude», lo que falló se ve tres días,
 * «Invitar a volver» no escribe a todo el atraso, los avisos de WhatsApp llegan a
 * quienes administran y a nadie se lo calla un lote lleno. Para odentIA y latidIA.
 */
setupTestDb()
configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
const KEY = secretsKeyFromEnv("cd".repeat(32))
const DAY = 86_400_000
const all = () => true
const PRODUCTS = ["dental", "medical"] as const

async function clinic(product: (typeof PRODUCTS)[number] = "dental") {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  await insertOrg(ownerDb, orgId, `avisos-${orgId}`)
  if (product === "medical") await ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values({ id: ownerId, name: "Ana Ruiz", email: `${ownerId}@avisos.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: true,
    advisor: { enabled: true },
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Sala 1" }).returning({ id: scheduleRoom.id })
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
const tick = (templatesFetch?: typeof fetch) =>
  tickAutomations(ownerDb, appDb, new Date(), { secretsKey: KEY, publicBaseUrl: "https://clinica.test", ...(templatesFetch ? { templates: { fetch: templatesFetch } } : {}) })

async function overdueDebt(c: Clinic, name: string) {
  await ownerDb.insert(patientCharge).values({
    organizationId: c.orgId, patientId: await person(c, name), description: "Cargo", amountCents: 9000, currency: "PEN",
    createdAt: new Date(Date.now() - 31 * DAY),
  })
  const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "cobranza_vencida", { enabled: true, agentPart: false }))
  await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 2 * DAY) }).where(eq(automationRule.id, rule.id))
}

async function cancelledAppointment(c: Clinic, patientId: string) {
  const startsAt = new Date(Date.now() + DAY)
  const [appt] = await ownerDb.insert(appointment).values({
    organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: c.professionalId, roomId: c.roomId,
    startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "cancelada",
  }).returning({ id: appointment.id })
  return appt!.id
}

describe("un caso que falla no tumba el ciclo", () => {
  it("la clínica siguiente recibe lo suyo y el caso que siempre falla termina como «no pude»", async () => {
    const poisoned = await clinic()
    const healthy = await clinic()
    await overdueDebt(poisoned, "Rosa Medina")
    await overdueDebt(healthy, "Luis Prado")
    // Cualquier fallo al dejar la tarea (restricción, dato raro…) sirve: aquí, un disparador.
    await ownerDb.execute(sql.raw(`create or replace function avisos_boom() returns trigger language plpgsql as $$ begin raise exception 'fallo al crear la tarea'; end $$`))
    await ownerDb.execute(sql.raw(`create trigger avisos_boom before insert on task for each row when (new.organization_id = '${poisoned.orgId}') execute function avisos_boom()`))
    try {
      await tick()
      // La sana (después en la lista) recibió su tarea en el mismo ciclo.
      expect(await tasksOf(healthy)).toHaveLength(1)
      expect(await tasksOf(poisoned)).toEqual([])
      const [first] = await jobsOf(poisoned)
      expect(first).toMatchObject({ status: "pendiente", attempts: 1 })
      expect(first?.scheduledFor.getTime()).toBeGreaterThan(Date.now())
      // Tras los reintentos deja de repetirse cada minuto y queda a la vista.
      for (let attempt = 0; attempt < 4; attempt++) {
        await ownerDb.update(automationJob).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(automationJob.organizationId, poisoned.orgId))
        await tick()
      }
      expect((await jobsOf(poisoned))[0]).toMatchObject({ status: "fallido", cause: "proveedor", attempts: 5 })
      expect(await tasksOf(healthy)).toHaveLength(1)
    } finally {
      await ownerDb.execute(sql.raw("drop trigger if exists avisos_boom on task"))
    }
  })
})

describe.each(PRODUCTS)("los avisos de cita que no salieron (%s)", (product) => {
  it("cuentan en «no pude» de Recordar la cita y la cancelación deja una tarea", async () => {
    const c = await clinic(product)
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    const cancelled = await person(c, "Ana Cancelada")
    const booked = await person(c, "Beto Reservó")
    const cancelledId = await cancelledAppointment(c, cancelled)
    expect(await run(c, (tx) => enqueueAppointmentNotice(tx, c.orgId, cancelledId, "cancelada"))).toEqual({ queued: true })
    const startsAt = new Date(Date.now() + 2 * DAY)
    const [stands] = await ownerDb.insert(appointment).values({
      organizationId: c.orgId, branchId: c.branchId, patientId: booked, professionalUserId: c.professionalId, roomId: c.roomId,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada",
    }).returning({ id: appointment.id })
    expect(await run(c, (tx) => enqueueAppointmentNotice(tx, c.orgId, stands!.id, "reservada"))).toEqual({ queued: true })
    // Ninguno de los dos tiene a dónde escribirle.
    await run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }))
    expect((await jobsOf(c)).filter((job) => job.cause === "sin_destino").map((job) => job.kind).sort()).toEqual(["aviso_cita_cancelada", "aviso_cita_reservada"])
    const unreached = await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))
    expect(unreached.total).toBe(2)
    expect(unreached.people.map((row) => [row.lineKey, row.lineName])).toEqual([
      ["recordatorio_cita", "Recordar la cita"],
      ["recordatorio_cita", "Recordar la cita"],
    ])
    expect((await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "recordatorio_cita", { only: "no-pudo" }))).total).toBe(2)
    // Quien no sabrá que su cita se canceló necesita una llamada; la reserva la cubre su recordatorio.
    expect((await tasksOf(c)).map((task) => task.title)).toEqual(["Avisarle a Ana Cancelada que su cita se canceló"])
  })
})

describe("el saldo de prueba agotado", () => {
  it("un aviso de cita queda como tarea de verdad, no como «tarea» sin tarea", async () => {
    const c = await clinic()
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    const id = await person(c, "Ana Cancelada")
    await run(c, async (tx) => enqueueAppointmentNotice(tx, c.orgId, await cancelledAppointment(c, id), "cancelada"))
    await ownerDb.insert(user).values({ id: "avisos-admin", name: "Administración", email: "admin@avisos.test" }).onConflictDoNothing()
    await ownerDb.update(saasPlan).set({ isDefault: false })
    await createSaasPlan(ownerDb, "avisos-admin", {
      code: `avisos-${randomUUID().slice(0, 6)}`, name: "Plan avisos", currency: "USD", priceCents: 2900, creditCents: 2900,
      conversationMicros: 500_000, consultationMicros: 400_000, recoveryMicros: 4_000_000,
      trialCreditCents: 5000, trialMaxCreditCents: 13000, isDefault: true,
    })
    const now = Date.now()
    await ownerDb.update(saasSubscription).set({
      status: "prueba", trialStartedAt: new Date(now - 25 * DAY), trialEndsAt: new Date(now + 5 * DAY),
      currentPeriodStart: new Date(now - 25 * DAY), currentPeriodEnd: new Date(now + 5 * DAY), trialCreditCents: 5000,
    }).where(eq(saasSubscription.organizationId, c.orgId))
    await ownerDb.insert(saasAction).values(
      Array.from({ length: 200 }, (_, index) => ({
        organizationId: c.orgId, kind: "conversacion", tier: "gestiona", occurredAt: new Date(now - (index + 1) * 60_000),
        contactId: randomUUID(), detail: "Atendió una conversación por WhatsApp", currency: "USD",
        basePriceMicros: 500_000, priceMicros: 500_000, dedupeKey: randomUUID(),
      })),
    )
    await run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }))
    const [job] = await jobsOf(c)
    expect(job?.status).toBe("tarea")
    expect(job?.taskId).not.toBeNull()
    expect((await tasksOf(c)).map((task) => task.title)).toEqual(["Avisarle a Ana Cancelada que su cita se canceló"])
  })
})

describe("lo que falló se ve tres días", () => {
  it("un fallo del viernes sigue en Inicio el lunes; uno de hace cuatro días ya no", async () => {
    const c = await clinic()
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia", { enabled: true }))
    for (const [name, hours] of [["Carla Reciente", 60], ["Dora Antigua", 100]] as const) {
      await ownerDb.insert(automationJob).values({
        organizationId: c.orgId, ruleId: rule.id, kind: "seguimiento_no_asistencia", dedupeKey: `avisos:${randomUUID()}`,
        scheduledFor: new Date(Date.now() - hours * 3_600_000), status: "fallido", cause: "sin_conexion", patientId: await person(c, name),
        updatedAt: new Date(Date.now() - hours * 3_600_000),
      })
    }
    const unreached = await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))
    expect(unreached.people.map((row) => row.personName)).toEqual(["Carla Reciente"])
  })
})

describe.each(PRODUCTS)("«Invitar a volver» no escribe a todo el atraso (%s)", (product) => {
  it("al prenderla solo entran quienes cumplieron el plazo después", async () => {
    const c = await clinic(product)
    const months = product === "medical" ? 12 : 6
    const visit = (daysPast: number) => {
      const when = new Date()
      when.setMonth(when.getMonth() - months)
      return new Date(when.getTime() - daysPast * DAY)
    }
    const old = await person(c, "Atraso Viejo")
    const fresh = await person(c, "Recién Cumple")
    for (const [patientId, when] of [[old, visit(60)], [fresh, visit(1)]] as const) {
      await ownerDb.insert(appointment).values({
        organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: c.professionalId, roomId: c.roomId,
        startsAt: when, endsAt: new Date(when.getTime() + 30 * 60_000), durationMin: 30, status: "atendida",
      })
    }
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "invitar_a_volver", { enabled: true }))
    await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 5 * DAY) }).where(eq(automationRule.id, rule.id))
    await tick()
    const queued = (await jobsOf(c)).filter((job) => job.kind === "invitar_a_volver")
    expect(queued.map((job) => job.patientId)).toEqual([fresh])
  })
})

describe("los avisos de WhatsApp llegan a quienes administran", () => {
  it("una solicitud que Meta rechaza avisa a la dueña y a los administradores, no a uno solo", async () => {
    const c = await clinic()
    const adminId = `admin-${c.orgId}`
    await ownerDb.insert(user).values({ id: adminId, name: "Beto Admin", email: `${adminId}@avisos.test`, emailVerified: true })
    await ownerDb.insert(member).values({ id: `m-${adminId}`, userId: adminId, organizationId: c.orgId, role: "admin", createdAt: new Date() })
    const connection = await run(c, (tx) =>
      createConnection(tx, c.orgId, KEY, { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", config: { phoneNumberId: "PNID", wabaId: "WABA", accessToken: "clave-1", appSecret: "secreto" } }, { fetch, validateExternal: false }),
    )
    await ownerDb.delete(channelTemplate).where(and(eq(channelTemplate.connectionId, connection.id), eq(channelTemplate.name, "odentia_retomar_conversacion_v1")))
    expect(await run(c, (tx) => failureRecipients(tx, c.orgId))).toEqual([c.ownerId, adminId])
    await tick((async () => new Response(JSON.stringify({ error: { message: "Invalid token" } }), { status: 400 })) as unknown as typeof fetch)
    const notices = await ownerDb.select({ userId: workspaceNotification.userId }).from(workspaceNotification).where(eq(workspaceNotification.organizationId, c.orgId))
    expect(notices.map((notice) => notice.userId).sort()).toEqual([c.ownerId, adminId].sort())
  })
})

describe("quien nunca aceptó novedades no es un fallo", () => {
  it("no suma a «no pude» y, en la línea, se dice como lo que es", async () => {
    const c = await clinic()
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_presupuesto", { enabled: true }))
    await ownerDb.insert(automationJob).values({
      organizationId: c.orgId, ruleId: rule.id, kind: "seguimiento_presupuesto", dedupeKey: `avisos:${randomUUID()}`,
      scheduledFor: new Date(), status: "omitido", cause: "sin_permiso", patientId: await person(c, "Nora Nunca"),
      lastError: "La persona no aceptó novedades y promociones",
    })
    expect((await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))).total).toBe(0)
    const people = await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_presupuesto", { only: "no-pudo" }))
    expect(people.items[0]?.text).toContain("no aceptó novedades y promociones")
    expect(people.items[0]?.text).not.toContain("pidió no recibir")
  })
})

describe("pacientes sin contacto no tapan al resto del lote", () => {
  it("205 citas sin contacto delante no dejan sin recordatorio a la siguiente, y quedan a la vista", async () => {
    const c = await clinic()
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    // A 10 horas: el aviso de 24 h ya no cabe, el de 3 h sí.
    const start = Date.now() + 10 * 3_600_000
    const ids: string[] = []
    for (let i = 0; i < 205; i++) ids.push(await person(c, `Sin contacto ${i}`))
    const reachable = await person(c, "Con contacto")
    await ownerDb.execute(sql`update contact set is_active = false where organization_id = ${c.orgId}
      and id in (select contact_id from patient_contact where organization_id = ${c.orgId}
        and patient_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}))`)
    const everyone = [...ids, reachable]
    const professionals = everyone.map((_, index) => `prof-${c.orgId}-${index}`)
    await ownerDb.insert(user).values(professionals.map((id) => ({ id, name: `Dr. ${id.slice(-3)}`, email: `${id}@avisos.test`, emailVerified: true })))
    await ownerDb.insert(member).values(professionals.map((id) => ({ id: `m-${id}`, userId: id, organizationId: c.orgId, role: "clinician", createdAt: new Date() })))
    const rooms = await ownerDb.insert(scheduleRoom).values(everyone.map((_, index) => ({ organizationId: c.orgId, branchId: c.branchId, name: `Sala ${index}` }))).returning({ id: scheduleRoom.id })
    await ownerDb.insert(appointment).values(
      everyone.map((patientId, index) => {
        const startsAt = new Date(start + index * 1000)
        return { organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: professionals[index]!, roomId: rooms[index]!.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada" as const }
      }),
    )
    await tick()
    await tick()
    const queued = (await jobsOf(c)).filter((job) => job.kind === "recordatorio_cita")
    expect(queued.some((job) => job.patientId === reachable)).toBe(true)
    expect(queued.filter((job) => job.contactId === null).length).toBeGreaterThanOrEqual(205)
    // Y al vencer, los que no tienen a dónde escribirles quedan como «no pude».
    await ownerDb.update(automationJob).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(automationJob.organizationId, c.orgId))
    await run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }, 300))
    const unreached = await run(c, (tx) => getAdminUnreached(tx, c.orgId, all))
    expect(unreached.byCause.map((row) => row.cause)).toContain("sin_destino")
  })
})
