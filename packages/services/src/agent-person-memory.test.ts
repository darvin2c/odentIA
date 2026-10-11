import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentPersonFact } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { conversation } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  addPersonFact,
  formatPersonMemoryForPrompt,
  getPersonMemory,
  listPersonFacts,
  looksClinical,
  PERSON_FACT_LIMIT,
  removePersonFact,
} from "./agent-person-memory.js"
import { createConnection } from "./connections.js"
import { createContact } from "./contacts.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { getOrgLocale } from "./locale.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Memoria de la persona: datos prácticos con fecha y origen, nunca clínicos, que se reemplazan o se quitan. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "memory-owner"
const KEY = secretsKeyFromEnv("ab".repeat(32))

beforeAll(async () => {
  await ownerDb.insert(user).values([{ id: OWNER, name: "Carmen", email: "carmen@memory.test", emailVerified: true }])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
  ])
})

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const unused = async (): Promise<never> => {
  throw new Error("no usado")
}
const storageStub: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

/** Una persona que escribió por Telegram: su contacto y su conversación. */
async function person(sender: string): Promise<{ contactId: string; conversationId: string }> {
  const connectionId = await run((tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: `Bot ${sender}`, config: { botToken: sender } },
      { fetch, validateExternal: false }).then((c) => c.id))
  const event: NormalizedInbound = {
    externalEventId: `evt-${sender}`, externalMessageId: `evt-${sender}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text: "Hola" }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId, event }
  const { conversationId } = await run((tx) => ingestInbound(tx, job, stubAdapter, deps))
  const [thread] = await ownerDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId))
  return { contactId: thread!.contactId, conversationId }
}

describe("filtro de información de salud", () => {
  it("rechaza lo clínico y deja pasar lo práctico", () => {
    for (const text of [
      "Le duele la muela desde ayer",
      "Es alérgica a la penicilina",
      "Está embarazada de 5 meses",
      "Toma medicación para la presión alta",
      "Tiene diabetes",
      "Viene por su tratamiento de conducto",
    ]) expect(looksClinical(text), text).toBe(true)
    for (const text of [
      "Prefiere citas por la tarde",
      "Quiere que la llamen Lucha",
      "Escribe por su hijo Mateo",
      "Solo puede los sábados",
      "Paga con tarjeta",
      "Viaja en octubre",
    ]) expect(looksClinical(text), text).toBe(false)
  })
})

describe("memoria de la persona", () => {
  it("guarda con origen, no duplica, reemplaza sin borrar la historia y quita al instante", async () => {
    const lucia = await person("lucia-mem")
    const fromAgent = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, {
        contactId: lucia.contactId, text: "  Prefiere citas   por la tarde ", conversationId: lucia.conversationId,
      }))
    expect(fromAgent).toMatchObject({ text: "Prefiere citas por la tarde", source: "agente", channel: "telegram", createdByName: null })
    const fromTeam = await run((tx) =>
      addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: lucia.contactId, text: "Quiere que la llamen Lucha" }))
    expect(fromTeam).toMatchObject({ source: "equipo", channel: null, createdByName: "Carmen" })

    // Decir lo mismo otra vez no crea otro dato.
    const again = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, { contactId: lucia.contactId, text: "prefiere citas por la tarde" }))
    expect(again.id).toBe(fromAgent.id)
    expect(await run((tx) => listPersonFacts(tx, ORG, lucia.contactId))).toHaveLength(2)

    // Cambió de preferencia: el nuevo reemplaza al anterior, que queda en la historia.
    const changed = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, {
        contactId: lucia.contactId, text: "Prefiere citas por la mañana", replacesId: fromAgent.id, conversationId: lucia.conversationId,
      }))
    expect((await run((tx) => listPersonFacts(tx, ORG, lucia.contactId))).map((fact) => fact.text)).toEqual([
      "Quiere que la llamen Lucha", "Prefiere citas por la mañana",
    ])
    const [old] = await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.id, fromAgent.id))
    expect(old).toMatchObject({ status: "reemplazado", replacedById: changed.id })

    await run((tx) => removePersonFact(tx, ORG, OWNER, lucia.contactId, fromTeam.id))
    expect((await run((tx) => listPersonFacts(tx, ORG, lucia.contactId))).map((fact) => fact.id)).toEqual([changed.id])
    const [removed] = await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.id, fromTeam.id))
    expect(removed).toMatchObject({ status: "quitado", removedBy: OWNER })
    await expect(run((tx) => removePersonFact(tx, ORG, OWNER, lucia.contactId, fromTeam.id))).rejects.toMatchObject({ code: "NOT_FOUND" })

    // La auditoría dice quién y de quién, sin repetir el dato.
    const audits = await ownerDb.select().from(auditEvent).where(eq(auditEvent.entityId, changed.id))
    expect(JSON.stringify(audits)).not.toContain("mañana")
    expect(audits[0]?.metadata).toMatchObject({ contactId: lucia.contactId, source: "agente", replaced: fromAgent.id })
  })

  it("nunca guarda nada clínico, venga del agente o del equipo", async () => {
    const andres = await person("andres-mem")
    for (const actor of [{ userId: null, source: "agente" as const }, { userId: OWNER, source: "equipo" as const }]) {
      await expect(run((tx) => addPersonFact(tx, ORG, actor, { contactId: andres.contactId, text: "Es alérgico al látex" })))
        .rejects.toMatchObject({ code: "PERSON_FACT_CLINICAL" })
    }
    await expect(run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: andres.contactId, text: "   " })))
      .rejects.toThrow(/Escribe el dato/)
    await expect(run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: andres.contactId, text: "x".repeat(201) })))
      .rejects.toThrow(/200/)
    expect(await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.contactId, andres.contactId))).toEqual([])
  })

  it("es de una persona y de una organización: no se mezcla ni pasa el tope", async () => {
    const elena = await person("elena-mem")
    const other = await person("otra-mem")
    // La conversación tiene que ser de esa persona.
    await expect(run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, { contactId: elena.contactId, text: "Prefiere WhatsApp", conversationId: other.conversationId }),
    )).rejects.toMatchObject({ code: "NOT_FOUND" })
    for (let index = 0; index < PERSON_FACT_LIMIT; index += 1) {
      await run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: elena.contactId, text: `Dato práctico número ${index}` }))
    }
    await expect(run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: elena.contactId, text: "Uno más" })))
      .rejects.toMatchObject({ code: "PERSON_FACT_LIMIT" })
    // Reemplazar no cuenta contra el tope.
    const [first] = await run((tx) => listPersonFacts(tx, ORG, elena.contactId))
    await run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: elena.contactId, text: "Uno más", replacesId: first!.id }))
    expect(await run((tx) => listPersonFacts(tx, ORG, other.contactId))).toEqual([])
    await expect(run((tx) => getPersonMemory(tx, OTHER, elena.contactId), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("al agente le llega con fecha y origen, y sin datos si no hay nada", async () => {
    const zone = await run((tx) => getOrgLocale(tx, ORG))
    const empty = await run((tx) => createContact(tx, ORG, { displayName: "Sin memoria" }))
    expect(formatPersonMemoryForPrompt(await run((tx) => getPersonMemory(tx, ORG, empty.id)), zone)).toBeNull()

    const mateo = await person("mateo-mem")
    const fact = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, { contactId: mateo.contactId, text: "Solo puede los sábados", conversationId: mateo.conversationId }))
    await run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: mateo.contactId, text: "Paga con tarjeta" }))
    const block = formatPersonMemoryForPrompt(await run((tx) => getPersonMemory(tx, ORG, mateo.contactId)), zone)
    const day = new Date().toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
    expect(block).toContain(`- Solo puede los sábados (id ${fact.id}; lo dijo por Telegram el ${day})`)
    expect(block).toContain(`lo anotó el equipo el ${day})`)
    expect(block).toContain("si hoy dice otra cosa, vale lo de hoy")
  })
})
