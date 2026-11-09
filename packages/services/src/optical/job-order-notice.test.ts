import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patientContact } from "@odentia/db/schema/clinical"
import { agentConfig, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { jobOrder } from "@odentia/db/schema/orders"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { setMessageChoice } from "../automation.js"
import { listClinicMessages } from "../clinic-messages.js"
import { createConnection } from "../connections.js"
import { sendOrderReadyNotice } from "../job-order-notice.js"
import { listAgentPatientOrders } from "../agent-operations.js"
import { advanceJobOrder, createJobOrderSale, getJobOrder } from "../job-orders.js"
import { nextPatientNumber } from "../patients.js"
import { secretsKeyFromEnv } from "../secrets.js"
import { insertTestPatients } from "../test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "../test-setup.js"

/**
 * «Tus lentes están listos» (entrega 5 del plan de vistIA, ADR 0169): sale al
 * marcar «Listo», por la plantilla aprobada, la respuesta dentro de las 24 horas
 * o el correo; el pedido dice si salió o por qué no, y un aviso dudoso no se
 * reenvía a ciegas. Sin proveedor real: «aprobada» es la que declara la conexión.
 */
setupTestDb()
const KEY = secretsKeyFromEnv("ef".repeat(32))

async function optica(options: { approved?: string[]; product?: "optical" | "dental" } = {}) {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  await insertOrg(ownerDb, orgId, `pedido-${orgId}`)
  await ownerDb.update(orgProfile).set({ tradeName: "Óptica Clara", product: options.product ?? "optical" }).where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values({ id: ownerId, name: "Dueña", email: `${ownerId}@pedido.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true, writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]) })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const templates = (options.approved ?? []).map((name) => ({ name, language: "es" }))
  const connection = await withOrgContext(appDb, orgId, (tx) =>
    createConnection(tx, orgId, KEY, {
      channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
      config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates },
    }, { fetch, validateExternal: false }))
  return { orgId, ownerId, branchId: site!.id, whatsappId: connection.id }
}

type Optica = Awaited<ReturnType<typeof optica>>
const run = <T>(c: Optica, fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, c.orgId, fn)

/** Una persona con su WhatsApp; `openWindow`: escribió hace poco. */
async function client(c: Optica, name: string, options: { openWindow?: boolean } = {}) {
  const [row] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  const [link] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, c.orgId), eq(patientContact.patientId, row!.id)))
  const phone = `519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: c.orgId, contactId: link!.contactId, channel: "whatsapp", externalUserId: phone, isPrimary: true })
    .returning({ id: contactIdentity.id })
  await ownerDb.insert(conversation).values({
    organizationId: c.orgId, contactId: link!.contactId, contactIdentityId: identity!.id, channelConnectionId: c.whatsappId,
    externalThreadId: phone, lastInboundAt: options.openWindow ? new Date() : null,
  })
  return { patientId: row!.id, contactId: link!.contactId }
}

/** Un pedido vendido y llevado hasta «Listo». */
async function readyOrder(c: Optica, patientId: string) {
  const promisedOn = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
  const { order } = await run(c, (tx) =>
    createJobOrderSale(tx, c.orgId, c.ownerId, patientId, {
      branchId: c.branchId,
      requestId: randomUUID(),
      title: "Anteojos monofocales",
      maker: "Taller propio",
      promisedOn,
      lines: [{ kind: "lunas", description: "Lunas monofocales", amountCents: 12_000 }],
    }),
  )
  return run(c, (tx) => advanceJobOrder(tx, c.orgId, c.ownerId, order.id, { status: "listo" }))
}

describe("«Tus lentes están listos» (entrega 5)", () => {
  it("al marcar «Listo» sale con la plantilla aprobada de vistIA, una sola vez", async () => {
    const c = await optica({ approved: ["vistia_lentes_listos_v1"] })
    const p = await client(c, "Rosa Quispe")
    const ready = await readyOrder(c, p.patientId)
    expect(ready.readyNotice).toMatchObject({ status: "en_cola", channel: "whatsapp", canResend: false })
    const [row] = await ownerDb.select().from(jobOrder).where(eq(jobOrder.id, ready.id))
    const [sent] = await ownerDb.select().from(message).where(eq(message.id, row!.readyMessageId!))
    expect(sent).toMatchObject({ templateName: "vistia_lentes_listos_v1", templateParams: ["Rosa", "Óptica Clara"] })
    // Entregar no lo vuelve a enviar, y no se reenvía lo que ya salió.
    const delivered = await run(c, (tx) => advanceJobOrder(tx, c.orgId, c.ownerId, ready.id, { status: "entregado" }))
    expect(delivered.readyNotice?.status).toBe("en_cola")
    const messages = await ownerDb.select({ id: message.id }).from(message).where(and(eq(message.organizationId, c.orgId), eq(message.direction, "out")))
    expect(messages).toHaveLength(1)
  })

  it("un aviso que no se sabe si llegó no se reenvía a ciegas", async () => {
    const c = await optica({ approved: ["vistia_lentes_listos_v1"] })
    const p = await client(c, "Luis Paz")
    const ready = await readyOrder(c, p.patientId)
    await expect(run(c, (tx) => sendOrderReadyNotice(tx, c.orgId, c.ownerId, ready.id, { resend: true }))).rejects.toMatchObject({
      code: "NOTICE_ALREADY_SENT",
    })
    const [row] = await ownerDb.select().from(jobOrder).where(eq(jobOrder.id, ready.id))
    await ownerDb.update(message).set({ status: "unknown" }).where(eq(message.id, row!.readyMessageId!))
    const doubtful = await run(c, (tx) => getJobOrder(tx, c.orgId, ready.id))
    expect(doubtful.readyNotice).toMatchObject({ status: "dudoso", canResend: false })
    expect(doubtful.readyNotice?.words).toMatch(/No sabemos si llegó/)
    await expect(run(c, (tx) => sendOrderReadyNotice(tx, c.orgId, c.ownerId, ready.id, { resend: true }))).rejects.toMatchObject({
      code: "NOTICE_DOUBTFUL",
    })
    const again = await run(c, (tx) => sendOrderReadyNotice(tx, c.orgId, c.ownerId, ready.id, { resend: true, confirmDoubtful: true }))
    expect(again?.status).toBe("en_cola")
    // Uno que falló se reenvía sin preguntar.
    const [now] = await ownerDb.select().from(jobOrder).where(eq(jobOrder.id, ready.id))
    await ownerDb.update(message).set({ status: "failed", error: "131026" }).where(eq(message.id, now!.readyMessageId!))
    expect((await run(c, (tx) => getJobOrder(tx, c.orgId, ready.id))).readyNotice).toMatchObject({ status: "fallo", canResend: true })
    expect((await run(c, (tx) => sendOrderReadyNotice(tx, c.orgId, c.ownerId, ready.id, { resend: true })))?.status).toBe("en_cola")
  })

  it("dentro de las 24 horas sale escrito; sin plantilla ni ventana, el pedido dice por qué para que lo llamen", async () => {
    const c = await optica()
    const writing = await client(c, "Ana Ruiz", { openWindow: true })
    const answered = await readyOrder(c, writing.patientId)
    expect(answered.readyNotice?.status).toBe("en_cola")
    const [row] = await ownerDb.select().from(jobOrder).where(eq(jobOrder.id, answered.id))
    const [sent] = await ownerDb.select().from(message).where(eq(message.id, row!.readyMessageId!))
    expect(sent?.body).toBe("Hola, Ana. Tus lentes ya están listos para recoger en Óptica Clara. Si tienes alguna pregunta, responde este mensaje.")
    const silent = await client(c, "Marco Díaz")
    const pending = await readyOrder(c, silent.patientId)
    expect(pending.readyNotice).toMatchObject({ status: "no_salio", canResend: true })
    expect(pending.readyNotice?.words).toMatch(/Llámalo para decirle que puede recogerlo/)
  })

  it("quien pidió no recibir ningún mensaje no lo recibe, y el pedido lo dice", async () => {
    const c = await optica({ approved: ["vistia_lentes_listos_v1"] })
    const p = await client(c, "Elsa Vega")
    await run(c, (tx) => setMessageChoice(tx, c.orgId, c.ownerId, p.contactId, { choice: "ninguno", receive: false, source: "telefono" }))
    const ready = await readyOrder(c, p.patientId)
    expect(ready.readyNotice?.status).toBe("no_salio")
  })

  it("«Pedido listo» está entre los mensajes de una óptica y no entre los de odentIA", async () => {
    const optical = await optica()
    const dental = await optica({ product: "dental" })
    const keys = async (c: Optica) => (await run(c, (tx) => listClinicMessages(tx, c.orgId, c.whatsappId))).map((item) => item.id)
    expect(await keys(optical)).toContain("pedido_listo")
    expect(await keys(dental)).not.toContain("pedido_listo")
  })

  it("Sofi lee los pedidos de quien escribe: el paso, la fecha prometida y lo que falta pagar", async () => {
    const c = await optica()
    const p = await client(c, "Nora Díaz")
    const ready = await readyOrder(c, p.patientId)
    const result = await run(c, (tx) => listAgentPatientOrders(tx, c.orgId, p.contactId, p.patientId))
    expect(result.withMoney).toBe(true)
    expect(result.orders).toEqual([
      expect.objectContaining({ orderNumber: ready.orderNumber, title: "Anteojos monofocales", statusLabel: "Listo", dueCents: 12_000, currency: "PEN" }),
    ])
    // A otra persona sin vínculo con ella no le dice nada.
    const other = await client(c, "Otra Persona")
    await expect(run(c, (tx) => listAgentPatientOrders(tx, c.orgId, other.contactId, p.patientId))).rejects.toThrow()
  })
})

