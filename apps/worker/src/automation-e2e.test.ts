import { randomUUID } from "node:crypto"
import { type OutboundMessageJob, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { patientContact } from "@odentia/db/schema/clinical"
import { agentConfig, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { createConnection, getAdminUnreached, nextPatientNumber, setLine } from "@odentia/services"
import { insertTestPatients } from "@odentia/services/test-patient"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { runAutomationTick } from "./automation.js"
import { processOutbound } from "./outbound.js"
import { appDb, KEY, ownerDb, setupTestDb, storageStub } from "./test-setup.js"

/**
 * El recorrido completo, con las piezas reales del worker: la señal del minuto
 * (`automation_ticks`), Argos anota el aviso de la cita, Sofi escribe, el mensaje
 * sale por el worker; y lo que no se puede entregar queda a la vista del equipo.
 * El envío es el de demostración (`senderMode: "mock"`): no prueba a WhatsApp.
 */
setupTestDb()

const HOUR = 3_600_000
const PRODUCTS = ["dental", "medical"] as const

async function patient(ORG: string, whatsappId: string, name: string, options: { whatsapp: boolean }) {
  const [row] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: name, patientNumber: await nextPatientNumber(ownerDb, ORG) })
  const [link] = await ownerDb.select({ contactId: patientContact.contactId }).from(patientContact).where(eq(patientContact.patientId, row!.id))
  if (options.whatsapp) {
    const phone = `519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`
    const [identity] = await ownerDb
      .insert(contactIdentity)
      .values({ organizationId: ORG, contactId: link!.contactId, channel: "whatsapp", externalUserId: phone, isPrimary: true })
      .returning({ id: contactIdentity.id })
    await ownerDb.insert(conversation).values({
      organizationId: ORG, contactId: link!.contactId, contactIdentityId: identity!.id, channelConnectionId: whatsappId,
      externalThreadId: phone, lastInboundAt: new Date(),
    })
  }
  return row!.id
}
it.each(PRODUCTS)("Argos programa el aviso, Sofi escribe, el worker lo envía; y a quien no se puede, el equipo lo ve (%s)", async (product) => {
  // Una clínica por producto, para que los dos recorridos no se mezclen.
  const ORG = `e2e-${product}-${randomUUID().slice(0, 8)}`
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica', ${ORG}, now())`)
  await ownerDb.execute(sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale", "product")
    values (${ORG}, 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE', ${product}) on conflict do nothing`)
  const ownerId = `owner-e2e-${randomUUID().slice(0, 8)}`
  await ownerDb.insert(user).values({ id: ownerId, name: "Ana Ruiz", email: `${ownerId}@e2e.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: ORG, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({
    organizationId: ORG, enabled: true, advisor: { enabled: true },
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: ORG, branchId: site!.id, name: "Unidad 1" }).returning({ id: scheduleRoom.id })
  const connection = await withOrgContext(appDb, ORG, (tx) =>
    createConnection(tx, ORG, KEY, { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", config: { phoneNumberId: "PNID", wabaId: "WABA", accessToken: "t", appSecret: "s" } }, { fetch, validateExternal: false }),
  )
  const whatsappId = connection.id
  await withOrgContext(appDb, ORG, (tx) => setLine(tx, ORG, ownerId, "recordatorio_cita", { enabled: true, hoursBefore: [3] }))

  // Dos pacientes con cita en unas 3 horas: una se puede escribir por WhatsApp y otra no tiene a dónde.
  const reachable = await patient(ORG, whatsappId, "Lucía Paredes", { whatsapp: true })
  const unreachable = await patient(ORG, whatsappId, "Beto Sin Datos", { whatsapp: false })
  // Citas de 15 minutos, una tras otra, a unas 3 horas: el aviso de 3 horas de cada una ya venció.
  for (const [patientId, hours] of [[reachable, 2.9], [unreachable, 2.6]] as const) {
    const when = new Date(Date.now() + hours * HOUR)
    await ownerDb.insert(appointment).values({
      organizationId: ORG, branchId: site!.id, patientId, professionalUserId: ownerId, roomId: room!.id,
      startsAt: when, endsAt: new Date(when.getTime() + 15 * 60_000), durationMin: 15, status: "programada",
    })
  }

  // La señal del minuto (pg_cron la manda) y el trabajador del ciclo.
  await ownerDb.execute(sql`select pgmq.send('automation_ticks', '{}'::jsonb)`)
  expect(await runAutomationTick({ appDb, ownerDb, secretsKey: KEY, publicBaseUrl: "https://clinica.test", senderMode: "mock", storage: storageStub })).toBe(true)

  // Argos anotó y entregó: a Lucía le escribió Sofi; a Beto no se pudo.
  const jobs = await ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, ORG))
  const hers = jobs.find((job) => job.patientId === reachable)
  const his = jobs.find((job) => job.patientId === unreachable)
  expect(hers).toMatchObject({ kind: "recordatorio_cita", status: "enviado", cause: null })
  expect(his).toMatchObject({ kind: "recordatorio_cita", status: "fallido", cause: "sin_destino" })

  // El mensaje de Sofi está en cola y el worker lo envía.
  const [queued] = await ownerDb.select().from(message).where(eq(message.id, hers!.sentMessageId!))
  expect(queued).toMatchObject({ senderKind: "agent", status: "queued" })
  const job: { msg_id: number; read_ct: number; message: OutboundMessageJob } = { msg_id: 1, read_ct: 0, message: { orgId: ORG, messageId: queued!.id } }
  expect(await processOutbound(appDb, { storage: storageStub, fetch, secretsKey: KEY, senderMode: "mock", ownerDb }, job)).toBe("done")
  const [sent] = await ownerDb.select({ status: message.status }).from(message).where(eq(message.id, queued!.id))
  expect(sent?.status).toBe("sent")

  // Y el equipo ve a quien no se pudo: en «no pude» y con una tarea de llamada.
  const unreached = await withOrgContext(appDb, ORG, (tx) => getAdminUnreached(tx, ORG, () => true))
  expect(unreached.people.map((row) => [row.personName, row.lineKey])).toEqual([["Beto Sin Datos", "recordatorio_cita"]])
  const tasks = await ownerDb.select({ title: crmTask.title }).from(crmTask).where(and(eq(crmTask.organizationId, ORG), eq(crmTask.createdBy, "admin")))
  expect(tasks.map((task) => task.title)).toEqual(["Llamar a Beto Sin Datos para recordarle su cita"])
})
