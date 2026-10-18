process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

/**
 * Recepción y el presupuesto de la persona (fase 3, decisiones 4 y 5): lo
 * reenvía cuando lo pide (solo lo que la clínica ya entregó; si no está listo
 * o no hay por dónde, deja la tarea a recepción) y anota su respuesta solo
 * después de su sí a la lista.
 */
import { randomUUID } from "node:crypto"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { type ChannelAdapter, telegramBotApiAdapter, whatsappCloudApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { encounter, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { professionalProfile } from "@odentia/db/schema/clinical-forms"
import { contact, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  addBudgetItems,
  addPlanItem,
  AGENT_ROLES,
  createBudget,
  createConnection,
  deliverBudget,
  duplicateBudgetOption,
  getBudgetDetail,
  grantResponsibility,
  ingestInbound,
  isAffirmative,
  listAnswerTraces,
  listProposals,
  nextPatientNumber,
  READ_TOOLS,
  removeBudgetItems,
  secretsKeyFromEnv,
  setPatientContact,
  type Storage,
  TOOL_OPERATION,
  toolsDisabledBy,
  upsertAgentConfig,
} from "@odentia/services"
import { and, eq, inArray, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { ROUTE_TOOLS, routeInstruction, widenDescription } from "./decision/route.js"
import { type AgentRuntime, processAgentRun } from "./run.js"
import { type AgentSandbox, type AgentToolCtx, makeAgentTools, TOOL_SOURCES } from "./tools.js"
import { insertTestPatients } from "@odentia/services/test-patient"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv(`${"aa".repeat(31)}ab`)
const ORG = "org_a"
const BUDGET_TOOLS = ["ver_presupuesto", "reenviar_presupuesto", "anotar_respuesta_presupuesto"]
/** Soles como los escribe la clínica (es-PE): el símbolo va con un espacio que no se parte. */
const S = "S/ "

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let runtime: AgentRuntime
let tgConnId: string
let waConnId: string
/** Quien indica y prepara los presupuestos, y los dos servicios por pieza que cotiza. */
let clinic: { actor: string; resina: string; corona: string }

const storageStub: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async ({ orgId, conversationId, bytes, contentType }) => ({
    objectKey: `${orgId}/${conversationId}/presupuesto.pdf`,
    mimeType: contentType,
    filename: "presupuesto.pdf",
    size: bytes.byteLength,
  }),
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

const inOrg = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, ORG, fn)

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const ownerUri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(ownerUri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica', 'norte', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`,
  )
  runtime = { platform: { fake: true }, secretsKey: KEY, storage: storageStub }
  tgConnId = (
    await inOrg((tx) =>
      createConnection(tx, ORG, KEY, { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } }, { fetch, validateExternal: false }),
    )
  ).id
  waConnId = (
    await inOrg((tx) =>
      createConnection(
        tx,
        ORG,
        KEY,
        { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" } },
        { fetch, validateExternal: false },
      ),
    )
  ).id
  await inOrg((tx) => upsertAgentConfig(tx, ORG, { enabled: true }))
  // Quien prepara: odontólogo con colegiatura (entregar un presupuesto lo firma).
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Dra. Ruiz", email: `${actor}@example.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: ORG, userId: actor, role: "dentist", createdAt: new Date() })
  await ownerDb
    .insert(professionalProfile)
    .values({ organizationId: ORG, userId: actor, professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345" })
  const service = async (name: string, priceCents: number) => {
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: ORG, name, scope: "tooth", source: "custom", priceCents, currency: "PEN" })
      .returning({ id: serviceCatalog.id })
    return row!.id
  }
  clinic = { actor, resina: await service("Resina compuesta", 18_000), corona: await service("Corona", 90_000) }
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

/* ---------- Ayudas ---------- */

async function ingest(adapter: ChannelAdapter, connectionId: string, thread: string, eventId: string, text: string) {
  return inOrg((tx) =>
    ingestInbound(
      tx,
      {
        orgId: ORG,
        connectionId,
        event: {
          externalEventId: eventId,
          externalMessageId: eventId,
          externalThreadId: thread,
          senderExternalId: thread,
          senderDisplayName: "Lucía",
          content: { type: "text", text },
          sentAt: new Date().toISOString(),
        },
      },
      adapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
}

const byTelegram = (thread: string, eventId: string, text: string) => ingest(telegramBotApiAdapter, tgConnId, thread, eventId, text)

async function contactOf(conversationId: string): Promise<string> {
  const [row] = await inOrg((tx) => tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  return row!.contactId
}

function toolCtx(conversationId: string, contactId: string, extra: Partial<AgentToolCtx> = {}): AgentToolCtx {
  return {
    db: appDb,
    orgId: ORG,
    conversationId,
    contactId,
    triggerId: `trig-${randomUUID()}`,
    secretsKey: KEY,
    dryRun: false,
    handedOff: false,
    replySettled: false,
    toolsUsed: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 0, reported: false, cacheReported: false },
    ...extra,
  }
}

const call = async (ctx: AgentToolCtx, name: string, input: Record<string, unknown>) => {
  const found = makeAgentTools(ctx).find((item) => item.name === name)
  if (!found) throw new Error(`Sin la herramienta ${name}`)
  return String(await (found as unknown as { invoke: (args: unknown) => Promise<unknown> }).invoke(input))
}

/** Paciente cuya propia persona es quien escribe en la conversación. */
async function patientOf(contactId: string, name: string, relationship: "self" | "family" = "self"): Promise<string> {
  const [row] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: name, patientNumber: await nextPatientNumber(ownerDb, ORG) })
  await inOrg((tx) => setPatientContact(tx, ORG, clinic.actor, row!.id, { contactId, relationship, isPreferred: relationship === "self" }))
  return row!.id
}

/**
 * Resinas en la 16, la 26 y la 36 (S/ 180 cada una), en un presupuesto. Con
 * `crown`, una opción B con la corona en la 36 en vez de su resina.
 */
async function budgetOf(patientId: string, options: { deliver: boolean; crown?: boolean }) {
  const [session] = await ownerDb
    .insert(encounter)
    .values({ organizationId: ORG, patientId, dentistUserId: clinic.actor, reason: "Consulta" })
    .returning({ id: encounter.id })
  const tooth: Record<number, string> = {}
  for (const piece of [16, 26, 36]) {
    const item = await inOrg((tx) => addPlanItem(tx, ORG, clinic.actor, patientId, { serviceId: clinic.resina, sourceEncounterId: session!.id, toothNumber: piece }))
    tooth[piece] = item.id
  }
  let budget = await inOrg((tx) => createBudget(tx, ORG, clinic.actor, patientId, { itemIds: Object.values(tooth) }))
  let crown: string | null = null
  if (options.crown) {
    crown = (await inOrg((tx) => addPlanItem(tx, ORG, clinic.actor, patientId, { serviceId: clinic.corona, sourceEncounterId: session!.id, toothNumber: 36 }))).id
    budget = await inOrg((tx) => duplicateBudgetOption(tx, ORG, clinic.actor, patientId, budget.id, budget.options[0]!.id))
    const optionB = budget.options[1]!.id
    await inOrg((tx) => removeBudgetItems(tx, ORG, clinic.actor, patientId, budget.id, { itemIds: [tooth[36]!], optionId: optionB }))
    budget = await inOrg((tx) => addBudgetItems(tx, ORG, clinic.actor, patientId, budget.id, { itemIds: [crown!], optionId: optionB }))
  }
  if (options.deliver) await inOrg((tx) => deliverBudget(tx, ORG, clinic.actor, patientId, budget.id))
  return { budgetId: budget.id, tooth, crown, options: budget.options.map((option) => option.id), encounterId: session!.id }
}

async function tasksOf(contactId: string) {
  return inOrg((tx) =>
    tx
      .select({ title: crmTask.title, area: crmTask.area, createdBy: crmTask.createdBy, reason: crmTask.reason, patientId: crmTask.patientId })
      .from(crmTask)
      .where(eq(crmTask.contactId, contactId)),
  )
}

async function agentMessages(conversationId: string) {
  return inOrg((tx) =>
    tx
      .select({ body: message.body, contentType: message.contentType, replyButtons: message.replyButtons })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent"))),
  )
}

async function firstNameOf(contactId: string): Promise<string> {
  const [row] = await inOrg((tx) => tx.select({ givenNames: contact.givenNames, displayName: contact.displayName }).from(contact).where(eq(contact.id, contactId)))
  return (row?.givenNames?.trim() || row?.displayName.trim() || "").split(/\s+/)[0] ?? ""
}

/** Modelo guionizado: decide cada respuesta a partir de lo que ve. */
class ScriptedModel extends BaseChatModel {
  seen: BaseMessage[][] = []
  constructor(private readonly script: (messages: BaseMessage[], call: number) => AIMessage) {
    super({})
  }
  _llmType(): string {
    return "scripted-chat"
  }
  override bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages)
    const reply = this.script(messages, this.seen.length)
    return { generations: [{ text: String(reply.content), message: reply }] }
  }
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] })

const runWith = (model: ScriptedModel, conversationId: string, messageId: string) =>
  processAgentRun(appDb, { ...runtime, createModel: async () => model }, {
    msg_id: 1,
    read_ct: 0,
    message: { kind: "inbound_message", orgId: ORG, conversationId, messageId },
  })

/* ---------- Pruebas ---------- */

it("«Presupuestos» es una función de Recepción con sus tres herramientas, en el camino de información, y apagarla las quita", () => {
  const fn = AGENT_ROLES.recepcion.functions.find((item) => item.id === "presupuestos")
  expect(fn).toMatchObject({ label: "Presupuestos", fixed: false })
  expect([...(fn?.tools ?? [])].sort()).toEqual([...BUDGET_TOOLS].sort())
  expect(fn?.whenOff).toContain("create_task")
  expect(toolsDisabledBy("recepcion", ["presupuestos"]).sort()).toEqual([...BUDGET_TOOLS].sort())
  // Escribe con la operación que comparte con la pantalla; leer es solo leer.
  expect(TOOL_OPERATION).toMatchObject({ reenviar_presupuesto: "presupuesto.reenviar", anotar_respuesta_presupuesto: "presupuesto.respuesta" })
  expect(READ_TOOLS).toContain("ver_presupuesto")
  // Lo que devuelven es fuente para comprobar los importes que repite.
  expect(TOOL_SOURCES.ver_presupuesto).toBeDefined()
  expect(TOOL_SOURCES.anotar_respuesta_presupuesto).toBeDefined()
  // Quien pide su presupuesto cae en el camino de información; los demás caminos lo piden ampliando.
  expect(ROUTE_TOOLS.informacion).toEqual(expect.arrayContaining(BUDGET_TOOLS))
  for (const path of ["saludo", "cita", "cambio_cita", "clinico"] as const) expect(widenDescription(path)).toContain("presupuesto")
  expect(routeInstruction("informacion")).toContain("ver_presupuesto")
  // Con «Presupuestos» apagada no nombra sus herramientas: deja la tarea a recepción, si tiene create_task.
  const off = routeInstruction("informacion", null, { budgets: false, tools: new Set(["send_reply", "create_task"]) })
  expect(off).not.toContain("ver_presupuesto")
  expect(off).toContain("create_task")
  expect(routeInstruction("informacion", null, { budgets: false, tools: new Set(["send_reply"]) })).not.toContain("presupuesto")
  // «Sí, es correcto» a la pregunta de la lista es un sí; «No, la 36 también», no.
  expect(isAffirmative("Sí, es correcto")).toBe(true)
  expect(isAffirmative("Correcto")).toBe(true)
  expect(isAffirmative("No, la 36 también")).toBe(false)
})

it("ver_presupuesto muestra lo que recibió la persona, nunca lo que la clínica aún prepara ni el de otro paciente", async () => {
  const { conversationId } = await byTelegram("tg:ver-presu", "evt-ver-presu", "¿Me recuerdas mi presupuesto?")
  const contactId = await contactOf(conversationId)
  const patientId = await patientOf(contactId, "Lucía Ver")
  const delivered = await budgetOf(patientId, { deliver: true })
  // Lo que se indica después del envío abre un borrador: aún no se le entrega.
  const crown = await inOrg((tx) => addPlanItem(tx, ORG, clinic.actor, patientId, { serviceId: clinic.corona, sourceEncounterId: delivered.encounterId, toothNumber: 46 }))
  await inOrg((tx) => createBudget(tx, ORG, clinic.actor, patientId, { itemIds: [crown.id] }))
  const ctx = toolCtx(conversationId, contactId)
  const seen = await call(ctx, "ver_presupuesto", { patientId })
  expect(seen).toContain("Enviado · espera respuesta. Puede responderlo.")
  expect(seen).toContain(`[budgetId ${delivered.budgetId}]`)
  expect(seen).toContain(`Resina compuesta de la pieza 16: ${S}180.00 — sin responder [planItemId ${delivered.tooth[16]}]`)
  expect(seen).toContain(`Total ${S}540.00`)
  expect(seen).toContain("aún prepara")
  // Del borrador no se dice qué lleva ni cuánto cuesta.
  expect(seen).not.toContain("Corona")
  expect(seen).not.toContain("900.00")
  // Un paciente con el que no tiene vínculo: nada.
  const stranger = await byTelegram("tg:ver-otro", "evt-ver-otro", "Hola")
  const other = await patientOf(await contactOf(stranger.conversationId), "Otra Persona")
  await budgetOf(other, { deliver: true })
  const refused = await call(ctx, "ver_presupuesto", { patientId: other })
  expect(refused).toContain("No puedes ver los presupuestos de ese paciente")
  expect(refused).not.toContain("S/")
})

it("reenviar lo que aún no está listo no envía nada y deja la tarea a recepción; sin vía, tampoco envía y la tarea dice por qué", async () => {
  const { conversationId } = await byTelegram("tg:reenviar", "evt-reenviar", "Mándame mi presupuesto, por favor")
  const contactId = await contactOf(conversationId)
  const patientId = await patientOf(contactId, "Lucía Reenvío")
  const who = await firstNameOf(contactId)
  const ctx = toolCtx(conversationId, contactId, { storage: storageStub })
  // Sin ningún presupuesto preparado.
  const none = await call(ctx, "reenviar_presupuesto", { patientId })
  expect(none).toContain("no tiene un presupuesto preparado")
  // Preparado pero sin entregar: el agente no lo entrega.
  const draft = await budgetOf(patientId, { deliver: false })
  ctx.triggerId = "trig-reenviar-borrador"
  const notReady = await call(ctx, "reenviar_presupuesto", { patientId })
  expect(notReady).toContain("todavía no está listo")
  expect(notReady).toContain("«Tu presupuesto todavía no está listo. Ya le avisé al equipo para que te lo envíen apenas esté.»")
  // Reentregar el mismo mensaje no deja otra tarea.
  await call(ctx, "reenviar_presupuesto", { patientId })
  expect((await getBudgetDetailOf(patientId, draft.budgetId)).status).toBe("borrador")
  expect(await agentMessages(conversationId)).toEqual([])
  let tasks = await tasksOf(contactId)
  expect(tasks).toHaveLength(2)
  for (const task of tasks) {
    expect(task).toMatchObject({ title: `${who} pidió su presupuesto: enviarlo`, area: "recepcion", createdBy: "agent", patientId })
  }
  expect(tasks.map((task) => task.reason).sort()).toEqual(["Aún no está listo: revísalo y envíaselo.", "No tiene un presupuesto preparado."])
  // Entregado, pero por Telegram y sin WhatsApp ni correo: no hay por dónde.
  await inOrg((tx) => deliverBudget(tx, ORG, clinic.actor, patientId, draft.budgetId))
  ctx.triggerId = "trig-reenviar-sin-via"
  const noRoute = await call(ctx, "reenviar_presupuesto", { patientId })
  expect(noRoute).toContain("No hubo por dónde enviarlo")
  expect(noRoute).toContain("«No pude enviártelo por aquí.")
  tasks = await tasksOf(contactId)
  expect(tasks).toHaveLength(3)
  expect(tasks.find((task) => task.reason?.startsWith("No se pudo enviar:"))).toBeDefined()
  expect(await agentMessages(conversationId)).toEqual([])
})

async function getBudgetDetailOf(patientId: string, budgetId: string) {
  return inOrg((tx) => getBudgetDetail(tx, ORG, patientId, budgetId))
}

it("por WhatsApp, reenviarlo deja el documento en su conversación una sola vez", async () => {
  const thread = `wa:5199${String(Date.now()).slice(-7)}`
  const { conversationId } = await ingest(whatsappCloudApiAdapter, waConnId, thread, "evt-wa-presu", "¿Me reenvías mi presupuesto?")
  const contactId = await contactOf(conversationId)
  const patientId = await patientOf(contactId, "Lucía WhatsApp")
  const { budgetId } = await budgetOf(patientId, { deliver: true })
  const ctx = toolCtx(conversationId, contactId, { storage: storageStub, triggerId: "trig-wa-presu" })
  const sent = await call(ctx, "reenviar_presupuesto", { patientId, budgetId })
  expect(sent).toContain("reenviado aquí mismo, con el documento")
  expect(await call(ctx, "reenviar_presupuesto", { patientId, budgetId })).toContain("reenviado")
  const out = await agentMessages(conversationId)
  expect(out).toHaveLength(1)
  expect(out[0]?.contentType).not.toBe("text")
  const audits = await inOrg((tx) =>
    tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "financial_document.sent"), sql`${auditEvent.metadata}->>'documentId' = ${budgetId}`)),
  )
  expect(audits).toHaveLength(1)
  expect(audits[0]?.metadata).toMatchObject({ origin: "agente", via: "respuesta", channel: "whatsapp" })
  expect(await tasksOf(contactId)).toEqual([])
})

it("la respuesta se anota solo con su sí: primero la lista con su suma y los botones Sí y No, después la anota a nombre de la persona", async () => {
  const first = await byTelegram("tg:anotar", "evt-anotar-1", "La 16 y la 26 ahora, la 36 después")
  const { conversationId } = first
  const contactId = await contactOf(conversationId)
  const patientId = await patientOf(contactId, "Lucía Anota")
  const { budgetId, tooth } = await budgetOf(patientId, { deliver: true })
  // Turno 1: mira el presupuesto, arma la lista y le pregunta.
  const turnOne = new ScriptedModel((messages, step) => {
    const last = String(messages[messages.length - 1]?.content ?? "")
    if (step === 1) return toolCall("ver_presupuesto", { patientId }, "a1-ver")
    if (step === 2) {
      const ids = Object.fromEntries([...last.matchAll(/pieza (\d+): [^[]*\[planItemId ([0-9a-f-]{36})\]/g)].map((m) => [m[1], m[2]]))
      return toolCall(
        "anotar_respuesta_presupuesto",
        {
          patientId,
          budgetId: /budgetId ([0-9a-f-]{36})/.exec(last)?.[1],
          decisions: [
            { planItemId: ids["16"], decision: "aceptado" },
            { planItemId: ids["26"], decision: "aceptado" },
            { planItemId: ids["36"], decision: "pospuesto" },
          ],
        },
        "a1-anotar",
      )
    }
    return toolCall("send_reply", { text: /«(Entonces anoto[^»]+)»/.exec(last)?.[1] ?? "¿?" }, "a1-envio")
  })
  expect(await runWith(turnOne, conversationId, first.messageId)).toBe("done")
  const question =
    `Entonces anoto que aceptas Resina compuesta de la pieza 16 y Resina compuesta de la pieza 26 (${S}360.00) y dejas para después Resina compuesta de la pieza 36. ¿Es correcto?`
  const asked = await agentMessages(conversationId)
  expect(asked.map((item) => item.body)).toEqual([question])
  expect(asked[0]?.replyButtons?.map((button) => button.title)).toEqual(["Sí", "No"])
  // El importe que repitió sale de lo que devolvió la herramienta.
  const [trace] = await inOrg((tx) => listAnswerTraces(tx, ORG, conversationId))
  // La comprobación anota el importe con un espacio común.
  expect(trace?.checks).toEqual([{ kind: "precio", value: "S/ 360.00", ok: true, source: "Respuesta al presupuesto por confirmar" }])
  // Todavía no se anotó nada.
  const pending = await inOrg((tx) => listProposals(tx, ORG, { conversationId, status: "propuesta" }))
  expect(pending.map((item) => [item.action, item.mode])).toEqual([["decidir_presupuesto", "confirmar_usuario"]])
  expect((await getBudgetDetailOf(patientId, budgetId)).status).toBe("presentado")

  // Turno 2: dice que sí y el agente lo confirma.
  const second = await byTelegram("tg:anotar", "evt-anotar-2", "Sí, es correcto")
  const turnTwo = new ScriptedModel((messages, step) => {
    if (step > 1) return toolCall("send_reply", { text: "Listo, quedó anotado." }, "a2-envio")
    const visible = messages.map((m) => String(m.content)).join("\n")
    const proposalId = /Propuesta pendiente[^\n]*\bid ([0-9a-f-]{36})/.exec(visible)?.[1]
    return proposalId ? toolCall("confirmar_propuesta", { proposalId }, "a2-confirma") : toolCall("send_reply", { text: "¿Me confirmas?" }, "a2-repregunta")
  })
  expect(await runWith(turnTwo, conversationId, second.messageId)).toBe("done")
  const decided = await getBudgetDetailOf(patientId, budgetId)
  expect(decided).toMatchObject({ status: "parcial", stateText: "Aceptó 2 de 3", decisionContactId: contactId, decidedBy: null })
  const items = await inOrg((tx) =>
    tx.select({ id: treatmentPlanItem.id, decision: treatmentPlanItem.decisionStatus }).from(treatmentPlanItem).where(inArray(treatmentPlanItem.id, Object.values(tooth))),
  )
  expect(Object.fromEntries(items.map((item) => [item.id, item.decision]))).toEqual({
    [tooth[16]!]: "aceptado",
    [tooth[26]!]: "aceptado",
    [tooth[36]!]: "pospuesto",
  })
  const [audit] = await inOrg((tx) =>
    tx.select({ actor: auditEvent.actorUserId, metadata: auditEvent.metadata }).from(auditEvent).where(and(eq(auditEvent.action, "budget.decision"), eq(auditEvent.entityId, budgetId))),
  )
  expect(audit).toMatchObject({ actor: `contact:${contactId}`, metadata: { via: "conversacion" } })
})

it("con dos opciones hay que elegir una; lo incompleto no se propone y corregir la lista reemplaza la anterior", async () => {
  const { conversationId } = await byTelegram("tg:opciones", "evt-opciones", "Prefiero la de la corona")
  const contactId = await contactOf(conversationId)
  const patientId = await patientOf(contactId, "Lucía Opciones")
  const { budgetId, tooth, crown, options } = await budgetOf(patientId, { deliver: true, crown: true })
  const ctx = toolCtx(conversationId, contactId)
  const answer = (decisions: Array<[string, string]>, optionId?: string) =>
    call(ctx, "anotar_respuesta_presupuesto", {
      patientId,
      budgetId,
      ...(optionId ? { optionId } : {}),
      decisions: decisions.map(([planItemId, decision]) => ({ planItemId, decision })),
    })
  expect(await answer([[tooth[16]!, "aceptado"], [tooth[26]!, "aceptado"], [crown!, "aceptado"]])).toContain("Tiene 2 opciones (Opción A, Opción B): pregunta cuál elige")
  expect(await answer([[tooth[16]!, "aceptado"]], options[1])).toContain("Falta saber qué hace con Resina compuesta de la pieza 26 y Corona de la pieza 36")
  const pendingNow = () => inOrg((tx) => listProposals(tx, ORG, { conversationId, status: "propuesta" }))
  expect(await pendingNow()).toEqual([])
  const firstTry = await answer([[tooth[16]!, "aceptado"], [tooth[26]!, "aceptado"], [crown!, "aceptado"]], options[1])
  expect(firstTry).toContain(`«Entonces anoto que eliges la Opción B y aceptas Resina compuesta de la pieza 16, Resina compuesta de la pieza 26 y Corona de la pieza 36 (${S}1,260.00). ¿Es correcto?»`)
  expect(ctx.confirmButtonsFor).toBe(/Propuesta ([0-9a-f-]{36})/.exec(firstTry)?.[1])
  // «No, la corona después»: la nueva lista reemplaza a la que no recibió su sí.
  ctx.triggerId = "trig-opciones-corrige"
  const corrected = await answer([[tooth[16]!, "aceptado"], [tooth[26]!, "aceptado"], [crown!, "pospuesto"]], options[1])
  expect(corrected).toContain("y dejas para después Corona de la pieza 36")
  const pending = await pendingNow()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.id).toBe(/Propuesta ([0-9a-f-]{36})/.exec(corrected)?.[1])
  const all = await inOrg((tx) => listProposals(tx, ORG, { conversationId }))
  expect(all.map((item) => item.status).sort()).toEqual(["expirada", "propuesta"])
  expect((await getBudgetDetailOf(patientId, budgetId)).status).toBe("presentado")
})

it("quien solo está autorizado a recibir información ve el presupuesto, pero la respuesta la da la persona o su representante", async () => {
  const { conversationId } = await byTelegram("tg:autorizado", "evt-autorizado", "Mi papá acepta todo")
  const contactId = await contactOf(conversationId)
  const [row] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Jorge Autorizado", patientNumber: await nextPatientNumber(ownerDb, ORG) })
  const patientId = row!.id
  await inOrg((tx) => setPatientContact(tx, ORG, clinic.actor, patientId, { contactId, relationship: "family", isPreferred: false }))
  await inOrg((tx) =>
    grantResponsibility(tx, ORG, clinic.actor, patientId, { contactId, kind: "autorizado_informacion", startsAt: new Date().toISOString().slice(0, 10) }),
  )
  const { budgetId, tooth } = await budgetOf(patientId, { deliver: true })
  const ctx = toolCtx(conversationId, contactId)
  expect(await call(ctx, "ver_presupuesto", { patientId })).toContain(`Total ${S}540.00`)
  const refused = await call(ctx, "anotar_respuesta_presupuesto", {
    patientId,
    budgetId,
    decisions: Object.values(tooth).map((planItemId) => ({ planItemId, decision: "aceptado" })),
  })
  expect(refused).toContain("su respuesta la da la persona o su representante legal")
  expect(await inOrg((tx) => listProposals(tx, ORG, { conversationId }))).toEqual([])
})

it("en una simulación o en «Probar» nada se envía, nada se propone de verdad y no queda ninguna tarea", async () => {
  const { conversationId } = await byTelegram("tg:simula-presu", "evt-simula-presu", "Mándame mi presupuesto")
  const contactId = await contactOf(conversationId)
  const patientId = await patientOf(contactId, "Lucía Simula")
  const { budgetId, tooth } = await budgetOf(patientId, { deliver: true })
  const count = async () => {
    const [counted] = await ownerDb.execute<{ tasks: number; proposals: number; messages: number; sent: number }>(sql`
      select (select count(*)::int from task) as tasks,
             (select count(*)::int from agent_proposal) as proposals,
             (select count(*)::int from message) as messages,
             (select count(*)::int from audit_event where action = 'financial_document.sent') as sent`)
    return counted
  }
  const before = await count()
  const decisions = Object.values(tooth).map((planItemId) => ({ planItemId, decision: "aceptado" }))
  const dry = toolCtx(conversationId, contactId, { dryRun: true, storage: storageStub })
  expect(await call(dry, "reenviar_presupuesto", { patientId, budgetId })).toContain("[SIMULACIÓN]")
  expect(await call(dry, "anotar_respuesta_presupuesto", { patientId, budgetId, decisions })).toContain("[SIMULACIÓN]")
  const sandbox: AgentSandbox = { transcript: [], state: { pending: [], recent: [], notes: [], lookups: [] } }
  const trial = toolCtx(randomUUID(), randomUUID(), { dryRun: true, sandbox })
  expect(await call(trial, "ver_presupuesto", { patientId: randomUUID() })).toContain("no tiene presupuestos entregados")
  expect(await call(trial, "reenviar_presupuesto", { patientId: randomUUID() })).toContain("[SIMULACIÓN]")
  await call(trial, "anotar_respuesta_presupuesto", { patientId: randomUUID(), budgetId: randomUUID(), decisions })
  expect(sandbox.state.pending).toMatchObject([{ action: "decidir_presupuesto", status: "propuesta" }])
  expect(await count()).toEqual(before)
  expect((await getBudgetDetailOf(patientId, budgetId)).status).toBe("presentado")
})
