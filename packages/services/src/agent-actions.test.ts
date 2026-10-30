import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentActionLog, agentProposal } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { lastAgentActions, listAgentActions, recordAgentAction } from "./agent-actions.js"
import { createHandoff } from "./agent-operations.js"
import { listInboxConversations } from "./inbox.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Lo que hizo el agente, en palabras, para verlo en el hilo y en la fila de la Bandeja. */
setupTestDb()

const ALL = { appointments: true, budgets: true, crm: true, agent: true }

async function seed() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `acciones-${orgId}`)
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: orgId, channel: "telegram", provider: "telegram_bot_api", displayName: "Bot",
    configEncrypted: "config", webhookSecret: "secret", status: "active",
  }).returning()
  if (!connection) throw new Error("conexión")
  const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: "Rosa Quispe" }).returning()
  if (!person) throw new Error("contacto")
  const thread = async () => {
    const [row] = await ownerDb.insert(conversation).values({
      organizationId: orgId, contactId: person.id, channelConnectionId: connection.id,
      externalThreadId: `tg:${randomUUID()}`, agentStatus: "on", lastMessageAt: new Date(),
    }).returning()
    if (!row) throw new Error("conversación")
    return row.id
  }
  const proposal = (conversationId: string, action: string, values: Partial<typeof agentProposal.$inferInsert> = {}) =>
    ownerDb.insert(agentProposal).values({
      organizationId: orgId, contactId: person.id, conversationId, action, payload: {},
      afterSummary: "Cita: mar 4 nov, 09:00", idempotencyKey: randomUUID(), ...values,
    })
  const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, orgId, fn)
  return { orgId, personId: person.id, thread, proposal, run }
}

it("dice lo que hizo en todos los canales de la persona, por hora y sin sus mensajes", async () => {
  const { orgId, thread, proposal, run } = await seed()
  const one = await thread()
  const other = await thread()
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000)
  await proposal(one, "enviar_mensaje", { status: "ejecutada", executedAt: at(30), createdAt: at(30) })
  await proposal(one, "reservar_cita", { status: "ejecutada", executedAt: at(20), createdAt: at(21) })
  await proposal(other, "crear_oportunidad", { status: "ejecutada", executedAt: at(15), createdAt: at(15), afterSummary: "Corona" })
  await proposal(one, "reprogramar_cita", { status: "propuesta", mode: "confirmar_usuario", createdAt: at(10) } as never)
  await run((tx) => createHandoff(tx, orgId, null, { conversationId: other, reason: "Pide una persona", summary: "Pide una persona", priority: "media", createdBy: "agent" }))
  await run((tx) => recordAgentAction(tx, orgId, { conversationId: one, kind: "etiquetas", title: "agregó la etiqueta «Corona»" }))

  const items = await run((tx) => listAgentActions(tx, orgId, one, ALL))
  const titles = items.map((item) => item.title)
  expect(titles).toContain("reservó una cita")
  expect(titles).toContain("creó una oportunidad")
  expect(titles).toContain("le pasó este tema al equipo")
  expect(titles).toContain("agregó la etiqueta «Corona»")
  // Sus mensajes ya se ven como mensajes.
  expect(items.some((item) => item.action === "enviar_mensaje")).toBe(false)
  expect([...items].sort((a, b) => a.at.localeCompare(b.at)).map((item) => item.id)).toEqual(items.map((item) => item.id))

  const booked = items.find((item) => item.title === "reservó una cita")
  expect(booked).toMatchObject({ style: "tarjeta", state: "hecho", opens: "citas", what: "mar 4 nov, 09:00" })
  expect(items.find((item) => item.title === "creó una oportunidad")).toMatchObject({ style: "linea" })
  const waiting = items.find((item) => item.title === "propuso mover una cita")
  expect(waiting).toMatchObject({ state: "espera", style: "tarjeta" })
})

it("lo que falló y lo que venció se dicen; lo que venció ya no espera a nadie", async () => {
  const { orgId, thread, proposal, run } = await seed()
  const id = await thread()
  await proposal(id, "reservar_cita", { status: "fallida", error: "SLOT_TAKEN: Ese horario ya se ocupó" })
  await proposal(id, "cancelar_cita", { status: "propuesta", createdAt: new Date(Date.now() - 49 * 3_600_000) })
  const items = await run((tx) => listAgentActions(tx, orgId, id, ALL))
  expect(items.find((item) => item.title === "no pudo reservar la cita")).toMatchObject({ state: "no_se_pudo", detail: "Ese horario ya se ocupó" })
  const expired = items.find((item) => item.title === "propuso cancelar una cita")
  expect(expired).toMatchObject({ state: "vencio", proposalId: null })
})

it("sin ver al agente, o sin ver esa área, queda la línea sin el detalle", async () => {
  const { orgId, thread, proposal, run } = await seed()
  const id = await thread()
  await proposal(id, "reservar_cita", { status: "propuesta", mode: "confirmar_usuario" } as never)
  await run((tx) => recordAgentAction(tx, orgId, { conversationId: id, kind: "presupuesto", title: "reenvió su presupuesto", detail: "Presupuesto 12" }))

  const noAgent = await run((tx) => listAgentActions(tx, orgId, id, { ...ALL, agent: false }))
  const cita = noAgent.find((item) => item.title === "propuso una cita")
  expect(cita).toMatchObject({ style: "linea", what: null, detail: null, opens: null })

  const noBudgets = await run((tx) => listAgentActions(tx, orgId, id, { ...ALL, budgets: false }))
  expect(noBudgets.find((item) => item.title === "reenvió su presupuesto")).toMatchObject({ style: "linea", what: null, opens: null })
})

it("la fila dice lo último que hizo, salvo que la persona haya vuelto a escribir", async () => {
  const { orgId, thread, proposal, run } = await seed()
  const id = await thread()
  await proposal(id, "reservar_cita", { status: "ejecutada", executedAt: new Date(Date.now() - 60_000) })
  await proposal(id, "enviar_mensaje", { status: "ejecutada", executedAt: new Date() })
  const last = await run((tx) => lastAgentActions(tx, orgId, [id]))
  expect(last.get(id)).toMatchObject({ title: "reservó una cita", what: "mar 4 nov, 09:00", state: "hecho" })
  const { items } = await run((tx) => listInboxConversations(tx, orgId, {}))
  expect(items.find((item) => item.id === id)?.lastAction).toMatchObject({ title: "reservó una cita" })

  await ownerDb.update(conversation).set({ lastInboundAt: new Date() }).where(eq(conversation.id, id))
  expect((await run((tx) => lastAgentActions(tx, orgId, [id]))).get(id)).toBeUndefined()
})

it("la fila no dice que espera una propuesta vencida", async () => {
  const { orgId, thread, proposal, run } = await seed()
  const id = await thread()
  await proposal(id, "reservar_cita", { status: "propuesta", createdAt: new Date(Date.now() - 49 * 3_600_000) })
  expect((await run((tx) => lastAgentActions(tx, orgId, [id]))).get(id)).toBeUndefined()
})

it("el registro no se repite en un reintento, solo se anexa y es de cada clínica", async () => {
  const { orgId, thread, run } = await seed()
  const other = await seed()
  const id = await thread()
  const triggerMessageId = randomUUID()
  const note = () => run((tx) => recordAgentAction(tx, orgId, { conversationId: id, triggerMessageId, kind: "tarea", title: "dejó una tarea a recepción: llamar" }))
  await note()
  await note()
  const rows = await run((tx) => tx.select().from(agentActionLog))
  expect(rows).toHaveLength(1)
  await expect(run((tx) => tx.update(agentActionLog).set({ title: "otra" }).where(eq(agentActionLog.conversationId, id)))).rejects.toThrow()
  await expect(run((tx) => tx.delete(agentActionLog).where(eq(agentActionLog.conversationId, id)))).rejects.toThrow()
  expect(await other.run((tx) => tx.select().from(agentActionLog))).toEqual([])
  // Borrar la conversación (una prueba del chat web) se lleva su registro.
  await ownerDb.delete(conversation).where(eq(conversation.id, id))
  expect(await run((tx) => tx.select().from(agentActionLog))).toEqual([])
})
