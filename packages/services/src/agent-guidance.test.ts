import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { agentLesson } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  addAgentGuidance,
  editAgentGuidance,
  findRuleConflict,
  listAgentGuidance,
  removeAgentGuidance,
  simpleRulesConflict,
} from "./agent-guidance.js"
import {
  approveLesson,
  formatLessonRules,
  LESSON_RULE_LIMIT,
  lessonsForTurn,
  listLessons,
  RULE_BODY_CHARS,
  restoreLesson,
} from "./agent-learning.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * «Lo que el agente debe saber» (decisión 24): una sola lista con lo que
 * escribe la clínica y lo que aprendió, cada línea con su origen; al aprobar
 * una regla que contradice otra se avisa antes, y al agente le llega una sola
 * lista.
 */
setupTestDb()

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `saber-${orgId}`)
  const ownerId = `owner-${orgId}`
  const receptionId = `recep-${orgId}`
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Ana Torres", email: `${ownerId}@saber.test`, emailVerified: true },
    { id: receptionId, name: "Carmen", email: `${receptionId}@saber.test`, emailVerified: true },
  ])
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({ organizationId: orgId, channel: "telegram", provider: "telegram_bot_api", displayName: "Canal", configEncrypted: "c", webhookSecret: "s", status: "active" })
    .returning()
  const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: "Rosa Díaz" }).returning()
  const [thread] = await ownerDb
    .insert(conversation)
    .values({ organizationId: orgId, contactId: person!.id, channelConnectionId: connection!.id, externalThreadId: `t:${randomUUID()}` })
    .returning()
  const run = <T,>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  /** Una regla que propone el agente al corregirlo, salida de la conversación con Rosa. */
  const proposedRule = async (body: string) => {
    const [row] = await ownerDb
      .insert(agentLesson)
      .values({
        organizationId: orgId, kind: "regla", scope: "recepcion", title: body, body, failure: "otra_cosa",
        status: "propuesta", conversationId: thread!.id, proposedBy: receptionId,
      })
      .returning({ id: agentLesson.id })
    return row!.id
  }
  return { orgId, ownerId, receptionId, conversationId: thread!.id, run, proposedRule }
}

describe("una sola lista con su origen", () => {
  it("lo escrito por la clínica y lo aprendido, con quién, cuándo y de qué conversación; se filtran por origen", async () => {
    const c = await clinic()
    const written = await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "  No ofrezcas citas los sábados.  "))
    expect(written).toMatchObject({ body: "No ofrezcas citas los sábados.", source: "escrita", byName: "Ana Torres", conversationId: null })
    const learnedId = await c.proposedRule("A los menores de 6 años ofrece siempre a la Dra. Ana.")
    await c.run((tx) => approveLesson(tx, c.orgId, c.receptionId, learnedId))
    const all = await c.run((tx) => listAgentGuidance(tx, c.orgId))
    expect(all.counts).toEqual({ all: 2, escrita: 1, aprendida: 1 })
    // Primero lo escrito por la clínica; lo aprendido dice de quién salió y quién lo aprobó.
    expect(all.items.map((item) => [item.source, item.byName, item.contactName])).toEqual([
      ["escrita", "Ana Torres", null],
      ["aprendida", "Carmen", "Rosa Díaz"],
    ])
    expect(all.items[1]!.conversationId).toBe(c.conversationId)
    expect((await c.run((tx) => listAgentGuidance(tx, c.orgId, { source: "aprendida" }))).items.map((item) => item.id)).toEqual([learnedId])
    await expect(c.run((tx) => listAgentGuidance(tx, c.orgId, { source: "otra" }))).rejects.toMatchObject({ code: "VALIDATION" })
    // «Aprender» no la cuenta como aprendida.
    expect((await c.run((tx) => listLessons(tx, c.orgId, "activa"))).map((lesson) => lesson.id)).toEqual([learnedId])
  })

  it("todas se editan y se borran igual, y al agente le llega una sola lista, primero lo de la clínica", async () => {
    const c = await clinic()
    const learnedId = await c.proposedRule("Si preguntan por estacionamiento, di que hay uno frente a la sede.")
    await c.run((tx) => approveLesson(tx, c.orgId, c.ownerId, learnedId))
    const written = await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "Despídete recordando la dirección."))
    const edited = await c.run((tx) => editAgentGuidance(tx, c.orgId, c.ownerId, learnedId, "Hay estacionamiento gratis frente a la sede Centro."))
    expect(edited).toMatchObject({ source: "aprendida", body: "Hay estacionamiento gratis frente a la sede Centro." })
    const turn = await c.run((tx) => lessonsForTurn(tx, c.orgId, "recepcion", "hola"))
    expect(turn.rules.map((rule) => rule.body)).toEqual(["Despídete recordando la dirección.", "Hay estacionamiento gratis frente a la sede Centro."])
    expect(formatLessonRules(turn.rules)).toMatch(/^Lo que debes saber de tu clínica/)
    await c.run((tx) => removeAgentGuidance(tx, c.orgId, c.ownerId, written.id))
    await c.run((tx) => removeAgentGuidance(tx, c.orgId, c.ownerId, learnedId))
    expect((await c.run((tx) => lessonsForTurn(tx, c.orgId, "recepcion", "hola"))).rules).toEqual([])
    expect((await c.run((tx) => listAgentGuidance(tx, c.orgId))).counts).toEqual({ all: 0, escrita: 0, aprendida: 0 })
    // Borrar no pierde la historia: la aprendida queda retirada.
    const [row] = await ownerDb.select({ status: agentLesson.status }).from(agentLesson).where(eq(agentLesson.id, learnedId))
    expect(row?.status).toBe("retirada")
    await expect(c.run((tx) => editAgentGuidance(tx, c.orgId, c.ownerId, written.id, "otra"))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("al aprobar una regla que contradice otra, se avisa antes", () => {
  it("la comparación simple: hablan de lo mismo y una lo prohíbe", () => {
    expect(simpleRulesConflict("Los sábados atiende la Dra. Ana.", "No ofrezcas citas los sábados.")).toBe(true)
    expect(simpleRulesConflict("A los menores de 6 años ofrece siempre a la Dra. Ana.", "No ofrezcas citas los sábados.")).toBe(false)
    expect(simpleRulesConflict("Los sábados abrimos de 9 a 13.", "Los sábados atiende la Dra. Ana.")).toBe(false)
  })

  it("sin modelo de decisión usa la comparación simple; «Reemplazar» deja solo la nueva", async () => {
    const c = await clinic()
    const old = await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "No ofrezcas citas los sábados."))
    const unrelated = await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "Responde en español."))
    const candidate = await c.proposedRule("Los sábados atiende la Dra. Ana.")
    expect(await c.run((tx) => findRuleConflict(tx, c.orgId, candidate))).toEqual({
      conflictWith: { id: old.id, body: "No ofrezcas citas los sábados." },
      method: "comparacion",
      full: null,
    })
    await c.run((tx) => approveLesson(tx, c.orgId, c.ownerId, candidate, { replaceId: old.id }))
    expect((await c.run((tx) => listAgentGuidance(tx, c.orgId))).items.map((item) => item.id).sort()).toEqual([candidate, unrelated.id].sort())
  })

  it("con modelo de decisión le pregunta solo por las que hablan de lo mismo; si falla, la comparación simple", async () => {
    const c = await clinic()
    await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "Responde en español."))
    const old = await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "No ofrezcas citas los sábados."))
    const candidate = await c.proposedRule("Los sábados atiende la Dra. Ana.")
    const asked: string[] = []
    const says = (answer: boolean) => async (_candidate: string, existing: string) => {
      asked.push(existing)
      return answer
    }
    expect(await c.run((tx) => findRuleConflict(tx, c.orgId, candidate, says(true)))).toEqual({
      conflictWith: { id: old.id, body: old.body },
      method: "modelo",
      full: null,
    })
    expect(asked).toEqual(["No ofrezcas citas los sábados."])
    // El modelo dice que no chocan: «Mantener las dos» no hace falta preguntarlo.
    expect(await c.run((tx) => findRuleConflict(tx, c.orgId, candidate, says(false)))).toEqual({ conflictWith: null, method: "modelo", full: null })
    const failing = async () => Promise.reject(new Error("sin modelo"))
    expect((await c.run((tx) => findRuleConflict(tx, c.orgId, candidate, failing))).method).toBe("comparacion")
    // «Mantener las dos»: se aprueba sin reemplazar.
    await c.run((tx) => approveLesson(tx, c.orgId, c.ownerId, candidate))
    expect((await c.run((tx) => listAgentGuidance(tx, c.orgId))).counts).toEqual({ all: 3, escrita: 2, aprendida: 1 })
  })
})

describe("las reglas no pasan del tope ni del largo (ADR 0119)", () => {
  it("con 40 activas no se agrega otra, la que se aprueba reemplaza una y lo largo no entra", async () => {
    const c = await clinic()
    const added: Array<{ id: string }> = []
    for (let index = 0; index < LESSON_RULE_LIMIT; index++) {
      added.push(await c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, `Regla número ${index + 1}.`)))
    }
    await expect(c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, "Una más."))).rejects.toMatchObject({ code: "RULE_LIMIT" })
    // Aprobar una regla nueva pide elegir cuál reemplaza: la lista llega con el aviso.
    const candidate = await c.proposedRule("Despídete con el nombre de la clínica.")
    const check = await c.run((tx) => findRuleConflict(tx, c.orgId, candidate))
    expect(check.full).toMatchObject({ limit: LESSON_RULE_LIMIT })
    expect(check.full?.rules).toHaveLength(LESSON_RULE_LIMIT)
    await expect(c.run((tx) => approveLesson(tx, c.orgId, c.ownerId, candidate))).rejects.toMatchObject({ code: "RULE_LIMIT" })
    const first = added[0]!
    await c.run((tx) => approveLesson(tx, c.orgId, c.ownerId, candidate, { replaceId: first.id }))
    expect((await c.run((tx) => listAgentGuidance(tx, c.orgId))).counts.all).toBe(LESSON_RULE_LIMIT)
    // Restaurar la reemplazada tampoco pasa del tope.
    await expect(c.run((tx) => restoreLesson(tx, c.orgId, c.ownerId, first.id))).rejects.toMatchObject({ code: "RULE_LIMIT" })
    // Lo largo no se escribe ni se aprueba: llegaría cortado.
    const long = "a".repeat(RULE_BODY_CHARS + 1)
    await c.run((tx) => removeAgentGuidance(tx, c.orgId, c.ownerId, added[1]!.id))
    await expect(c.run((tx) => addAgentGuidance(tx, c.orgId, c.ownerId, long))).rejects.toMatchObject({ fields: { body: expect.any(String) } })
    const longRule = await c.proposedRule(long)
    await expect(c.run((tx) => approveLesson(tx, c.orgId, c.ownerId, longRule))).rejects.toMatchObject({ fields: { body: expect.any(String) } })
  })
})
