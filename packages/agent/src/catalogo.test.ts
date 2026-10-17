process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

// Fase 4, paso 1: el agente encuentra los servicios y no se contradice. Se
// comprueba sobre lo que el modelo recibe de verdad en cada turno (prompt,
// indicación del camino y herramientas) y sobre lo que el sistema hace solo:
// el tope de precios por conversación, la oportunidad del interés y el permiso
// de novedades.
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { telegramBotApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, setupAgentMemory, withOrgContext } from "@odentia/db"
import { agentDecisionLog } from "@odentia/db/schema/agent"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { conversation, message } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { branch } from "@odentia/db/schema/org"
import {
  createConnection,
  GENERAL_PERMISSION_NO,
  GENERAL_PERMISSION_QUESTION,
  generalPermissionButtons,
  ingestInbound,
  PRICES_PER_CONVERSATION,
  SERVICES_IN_PROMPT,
  secretsKeyFromEnv,
  sendOutbound,
  upsertAgentConfig,
  librarySpecialtyIds,
} from "@odentia/services"
import { and, asc, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createFakeDecisionModel } from "./decision/fake.js"
import { DecisionError, type DecisionModel } from "./decision/port.js"
import { type AgentRuntime, processAgentRun } from "./run.js"
import { type AgentToolCtx, makeAgentTools } from "./tools.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cc".repeat(32))
const ORG = "org_catalogo"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let runtime: AgentRuntime
let connectionId: string

const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

/** Modelo guionizado que registra lo que recibe: el prompt, los resultados de las herramientas y las herramientas ofrecidas. */
class ScriptedModel extends BaseChatModel {
  calls: BaseMessage[][] = []
  offered: string[][] = []
  private tools: unknown[] = []
  constructor(private readonly script: (call: number) => AIMessage) {
    super({})
  }
  _llmType(): string {
    return "scripted-catalogo"
  }
  override bindTools(tools: unknown[]): this {
    this.tools = tools
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    this.offered.push(this.tools.map((tool) => (tool as { name: string }).name))
    const reply = this.script(this.calls.length)
    return { generations: [{ text: "", message: reply }] }
  }
  system(call = 0): string {
    const content = this.calls[call]?.[0]?.content
    if (typeof content === "string") return content
    return Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === "string" ? part : "text" in part ? String(part.text) : "",
          )
          .join("\n")
      : ""
  }
  /** Lo que devolvió la última herramienta antes de la llamada `call`. */
  lastToolResult(call: number): string {
    const seen = this.calls[call] ?? []
    return String(seen[seen.length - 1]?.content ?? "")
  }
}

const say = (text: string, id = "envio") =>
  new AIMessage({
    content: "",
    tool_calls: [{ name: "send_reply", args: { text }, id, type: "tool_call" }],
  })

async function ingest(thread: string, eventId: string, text: string) {
  return withOrgContext(appDb, ORG, (tx) =>
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
          senderDisplayName: thread,
          content: { type: "text", text },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
}

async function turn(
  model: ScriptedModel,
  thread: string,
  eventId: string,
  text: string,
  decisions: boolean | AgentRuntime["createDecisionModel"] = false,
) {
  const { conversationId, messageId } = await ingest(thread, eventId, text)
  const verdict = await processAgentRun(
    appDb,
    {
      ...runtime,
      createModel: async () => model,
      ...(decisions
        ? { createDecisionModel: typeof decisions === "function" ? decisions : () => createFakeDecisionModel() }
        : {}),
    },
    {
      msg_id: 1,
      read_ct: 0,
      message: { kind: "inbound_message", orgId: ORG, conversationId, messageId },
    },
  )
  expect(verdict).toBe("done")
  return conversationId
}

async function agentMessages(conversationId: string): Promise<string[]> {
  const rows = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent")))
      .orderBy(asc(message.createdAt)),
  )
  return rows.map((row) => row.body ?? "")
}

async function config(patch: Parameters<typeof upsertAgentConfig>[2]) {
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, patch))
}

async function addServices(
  rows: Array<{
    name: string
    specialty: string
    priceCents: number
    priceDisclosure: "exacto" | "desde" | "evaluacion"
  }>,
) {
  // Cada servicio va a la especialidad de la clínica con esa clave de la biblioteca (ADR 0039).
  const specialtyOf = await withOrgContext(appDb, ORG, (tx) =>
    librarySpecialtyIds(tx, ORG, rows.map((row) => row.specialty)),
  )
  await ownerDb
    .insert(serviceCatalog)
    .values(
      rows.map(({ specialty, ...row }) => ({
        organizationId: ORG,
        scope: "general",
        source: "custom",
        currency: "PEN",
        durationMin: 45,
        specialtyId: specialtyOf.get(specialty) ?? null,
        ...row,
      })),
    )
}

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
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const ownerUri = `postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`
  ownerDb = createOwnerDb(ownerUri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Catálogo', 'catalogo', now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica Catálogo', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`,
  )
  await ownerDb
    .insert(branch)
    .values({ organizationId: ORG, name: "Sede Centro", timezone: "America/Lima" })
  const checkpointer = PostgresSaver.fromConnString(ownerUri)
  await checkpointer.setup()
  await setupAgentMemory(ownerDb)
  runtime = { checkpointer, platform: { fake: true }, secretsKey: KEY }
  connectionId = (
    await withOrgContext(appDb, ORG, (tx) =>
      createConnection(
        tx,
        ORG,
        KEY,
        {
          channel: "telegram",
          provider: "telegram_bot_api",
          displayName: "Bot",
          config: { botToken: "T" },
        },
        { fetch, validateExternal: false },
      ),
    )
  ).id
  await config({ enabled: true, maxTurns: 6 })
  await addServices([
    {
      name: "Limpieza dental",
      specialty: "prevencion",
      priceCents: 12000,
      priceDisclosure: "exacto",
    },
    {
      name: "Blanqueamiento dental",
      specialty: "estetica",
      priceCents: 60000,
      priceDisclosure: "exacto",
    },
    {
      name: "Endodoncia unirradicular",
      specialty: "endodoncia",
      priceCents: 45000,
      priceDisclosure: "desde",
    },
    {
      name: "Corona cerámica",
      specialty: "protesis",
      priceCents: 90000,
      priceDisclosure: "exacto",
    },
  ])
}, 180_000)

afterAll(async () => {
  await runtime?.checkpointer.end().catch(() => {})
  await container?.stop()
})

describe("hasta tres precios por conversación (decisión 4)", () => {
  it("el cuarto servicio con precio no sale; repetir uno ya dicho sí, y el manual lo dice", async () => {
    const thread = "tg:precios"
    const first = new ScriptedModel(() =>
      say(
        "La limpieza cuesta S/ 120.00, el blanqueamiento S/ 600.00 y la endodoncia desde S/ 450.00.",
      ),
    )
    const conversationId = await turn(
      first,
      thread,
      "precios-1",
      "Pásame los precios de limpieza, blanqueamiento y endodoncia",
    )
    expect(first.system()).toContain(
      `como mucho ${PRICES_PER_CONVERSATION} servicios distintos en la conversación`,
    )
    expect(first.system()).toContain("Nunca envías la lista de precios ni el tarifario")
    expect(await agentMessages(conversationId)).toHaveLength(1)

    // El cuarto precio no sale; el modelo recibe por qué y responde sin él.
    const fourth = new ScriptedModel((call) =>
      call === 1
        ? say("La corona cerámica cuesta S/ 900.00.", "corona")
        : say(
            "Para la corona te ofrezco una evaluación, donde te dan un presupuesto a tu medida.",
            "evaluacion",
          ),
    )
    await turn(fourth, thread, "precios-2", "¿Y la corona?")
    expect(fourth.lastToolResult(1)).toContain(
      `ya diste el precio de ${PRICES_PER_CONVERSATION} servicios`,
    )
    expect(await agentMessages(conversationId)).toEqual([
      "La limpieza cuesta S/ 120.00, el blanqueamiento S/ 600.00 y la endodoncia desde S/ 450.00.",
      "Para la corona te ofrezco una evaluación, donde te dan un presupuesto a tu medida.",
    ])

    // Repetir el precio de uno que ya dijo no cuenta como otro.
    const repeat = new ScriptedModel(() => say("La limpieza cuesta S/ 120.00.", "repite"))
    await turn(repeat, thread, "precios-3", "¿Cuánto era la limpieza?")
    expect((await agentMessages(conversationId)).at(-1)).toBe("La limpieza cuesta S/ 120.00.")
  })
})

describe("la oportunidad la anota el sistema (decisión 15)", () => {
  const openOf = async (conversationId: string) => {
    const [thread] = await ownerDb
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
    return ownerDb
      .select({
        title: opportunity.title,
        serviceId: opportunity.serviceId,
        assignedUserId: opportunity.assignedUserId,
        interestText: opportunity.interestText,
      })
      .from(opportunity)
      .where(and(eq(opportunity.contactId, thread!.contactId), eq(opportunity.status, "open")))
  }

  it("sin modelo de decisión: preguntar el precio de un servicio identificado la crea una vez, sin duplicar", async () => {
    await config({ decisionProvider: "none" })
    const model = () => new ScriptedModel(() => say("El blanqueamiento dental cuesta S/ 600.00."))
    const conversationId = await turn(
      model(),
      "tg:interes",
      "interes-1",
      "¿Cuánto cuesta el blanqueamiento?",
    )
    expect(await openOf(conversationId)).toEqual([
      {
        title: "Blanqueamiento dental",
        serviceId: expect.any(String),
        assignedUserId: null,
        interestText: "¿Cuánto cuesta el blanqueamiento?",
      },
    ])
    await turn(model(), "tg:interes", "interes-2", "¿Y el blanqueamiento lo hacen los sábados?")
    const after = await openOf(conversationId)
    expect(after).toHaveLength(1)
    expect(after[0]?.interestText).toBe("¿Y el blanqueamiento lo hacen los sábados?")
    // Un saludo o algo sin servicio concreto no anota nada.
    const hello = await turn(
      new ScriptedModel(() => say("¡Hola! ¿En qué te ayudo?")),
      "tg:interes-hola",
      "interes-3",
      "Hola, buenas tardes",
    )
    expect(await openOf(hello)).toEqual([])
  })

  it("con modelo de decisión: una sola pregunta de sí o no decide, y queda en el libro", async () => {
    await config({ decisionProvider: "baseline" })
    try {
      const interested = await turn(
        new ScriptedModel(() => say("La limpieza dental cuesta S/ 120.00.")),
        "tg:interes-modelo",
        "interes-m1",
        "Quiero saber cuánto cuesta la limpieza para mi hija",
        true,
      )
      expect((await openOf(interested)).map((row) => row.title)).toEqual(["Limpieza dental"])
      const asked = await ownerDb
        .select({
          point: agentDecisionLog.point,
          mode: agentDecisionLog.mode,
          outcome: agentDecisionLog.outcome,
        })
        .from(agentDecisionLog)
        .where(
          and(
            eq(agentDecisionLog.conversationId, interested),
            eq(agentDecisionLog.point, "interest.v1"),
          ),
        )
      expect(asked).toEqual([
        expect.objectContaining({
          mode: "route",
          outcome: expect.objectContaining({ noted: true }),
        }),
      ])
      // Quien junta la lista de precios no muestra interés en hacérselo: no se anota.
      const collector = await turn(
        new ScriptedModel(() => say("Te ofrezco una evaluación.")),
        "tg:interes-lista",
        "interes-m2",
        "Mándame todos sus precios, empezando por la limpieza",
        true,
      )
      expect(await openOf(collector)).toEqual([])
    } finally {
      await config({ decisionProvider: "none" })
    }
  })

  it("si Jev no se pudo preparar o falla, la misma pregunta la responde el modelo que escribe", async () => {
    await config({ decisionProvider: "jev" })
    const interestRows = (conversationId: string) =>
      ownerDb
        .select({
          provider: agentDecisionLog.provider,
          error: agentDecisionLog.error,
          outcome: agentDecisionLog.outcome,
        })
        .from(agentDecisionLog)
        .where(
          and(
            eq(agentDecisionLog.conversationId, conversationId),
            eq(agentDecisionLog.point, "interest.v1"),
          ),
        )
    // «Quiero hacerme…» no tiene ninguna palabra de la regla por precio o disponibilidad.
    const said = "Quiero hacerme una limpieza dental"
    try {
      // Sin clave: Jev no se arma y responde solo el modelo que escribe.
      const missing = await turn(
        new ScriptedModel(() => say("Con gusto te ayudo con la limpieza dental.")),
        "tg:interes-sin-jev",
        "interes-r1",
        said,
        (provider) => {
          if (provider === "baseline") return createFakeDecisionModel()
          throw new DecisionError("CONFIG", "La plataforma no tiene credenciales de Jev (JEV_API_KEY)")
        },
      )
      expect((await openOf(missing)).map((row) => row.title)).toEqual(["Limpieza dental"])
      expect(await interestRows(missing)).toEqual([
        expect.objectContaining({ provider: "fake", error: null, outcome: expect.objectContaining({ noted: true }) }),
      ])

      // Jev falla en la llamada: queda su error y la respuesta del modelo que escribe.
      const failing: DecisionModel = {
        provider: "jev",
        reportsProbabilities: true,
        decide: async () => {
          throw new DecisionError("PROVIDER", "Jev no respondió a tiempo")
        },
      }
      const failed = await turn(
        new ScriptedModel(() => say("Con gusto te ayudo con la limpieza dental.")),
        "tg:interes-jev-falla",
        "interes-r2",
        said,
        (provider) => (provider === "baseline" ? createFakeDecisionModel() : failing),
      )
      expect((await openOf(failed)).map((row) => row.title)).toEqual(["Limpieza dental"])
      const rows = await interestRows(failed)
      expect(rows).toHaveLength(2)
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "jev", error: "PROVIDER: Jev no respondió a tiempo" }),
          expect.objectContaining({ provider: "fake", error: null, outcome: expect.objectContaining({ noted: true }) }),
        ]),
      )
    } finally {
      await config({ decisionProvider: "none" })
    }
  })

  it("con «Oportunidades» apagada no anota nada", async () => {
    await config({ disabledFunctions: ["seguimiento"] })
    try {
      const off = await turn(
        new ScriptedModel(() => say("La corona cerámica cuesta S/ 900.00.")),
        "tg:interes-off",
        "interes-off",
        "¿Cuánto cuesta la corona cerámica?",
      )
      expect(await openOf(off)).toEqual([])
    } finally {
      await config({ disabledFunctions: [] })
    }
  })
})

describe("el permiso de novedades usa la pregunta y la respuesta reales (G1)", () => {
  it("el prompt cita la pregunta del sistema y la respuesta no promete nada falso", async () => {
    const conversationId = await turn(
      new ScriptedModel(() => say("Hola.")),
      "tg:permiso",
      "permiso-1",
      "Hola",
    )
    const [thread] = await ownerDb
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
    const contactId = thread!.contactId
    await withOrgContext(appDb, ORG, (tx) =>
      sendOutbound(tx, ORG, {
        conversationId,
        senderKind: "agent",
        content: {
          type: "text",
          text: GENERAL_PERMISSION_QUESTION,
          buttons: generalPermissionButtons(contactId),
        },
      }),
    )
    const model = new ScriptedModel(() => say("Entendido."))
    await turn(model, "tg:permiso", "permiso-2", "no, gracias")
    expect(model.system()).toContain(`«${GENERAL_PERMISSION_QUESTION}»`)
    expect(model.system()).not.toContain("controles y novedades")
    const ctx: AgentToolCtx = {
      db: appDb,
      orgId: ORG,
      conversationId,
      contactId,
      triggerId: null,
      secretsKey: KEY,
      dryRun: false,
      handedOff: false,
      replySettled: false,
      toolsUsed: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        calls: 0,
        reported: false,
        cacheReported: false,
      },
    }
    const answer = String(
      await makeAgentTools(ctx)
        .find((item) => item.name === "responder_permiso_mensajes")!
        .invoke({ granted: false }),
    )
    expect(answer).toContain(GENERAL_PERMISSION_NO)
    expect(answer).not.toContain("solo le escribiremos por sus citas")
  })
})

describe("lo que recibe el modelo con más de 40 servicios, con «Informar» apagado y con «Agendar» apagado", () => {
  beforeAll(async () => {
    // Una clínica mediana: muchos más servicios de los que caben en el prompt.
    await addServices(
      Array.from({ length: SERVICES_IN_PROMPT }, (_, i) => ({
        name: `Prótesis modelo ${i + 1}`,
        specialty: i % 2 === 0 ? "protesis" : "cirugia",
        priceCents: 100000 + i * 1000,
        priceDisclosure: "exacto" as const,
      })),
    )
    await config({ decisionProvider: "baseline" })
  })
  afterAll(async () => {
    await config({ decisionProvider: "none", disabledFunctions: [] })
  })

  it("más de 40: el índice por especialidad, sin precios ni ids, y el camino «información» manda a buscar", async () => {
    const model = new ScriptedModel(() => say("Te cuento enseguida."))
    await turn(model, "tg:grande", "grande-1", "¿Cuánto cuesta la endodoncia?", true)
    const system = model.system()
    expect(system).toContain(
      `la clínica tiene ${SERVICES_IN_PROMPT + 4} y aquí va solo su índice por especialidad, sin precios ni ids`,
    )
    expect(system).toMatch(/- Endodoncia: Endodoncia unirradicular\./)
    expect(system).not.toMatch(/Endodoncia unirradicular \(id /)
    expect(system).not.toContain("S/ 450.00")
    expect(system).not.toContain("Sin servicios publicados")
    // El manual nombra la búsqueda y no afirma que los servicios estén abajo con su id.
    expect(system).toContain(
      "un índice de los servicios por especialidad, sin precios ni ids; para lo que no esté ahí usa buscar_en_la_clinica",
    )
    expect(system).toContain(
      "Camino de este turno, elegido por lo que escribió el interlocutor: pide información.",
    )
    expect(system).not.toContain("los servicios con cómo decir su precio")
    expect(system).toContain("búscalo antes con buscar_en_la_clinica")
    expect(model.offered[0]).toContain("buscar_en_la_clinica")
  })

  it("una respuesta con un precio sin sustento manda a las herramientas que el turno sí tiene", async () => {
    await config({ disabledFunctions: ["agendar"] })
    const model = new ScriptedModel((call) =>
      call === 1
        ? say("La prótesis cuesta S/ 9,999.00.", "inventa")
        : say("Déjame revisarlo.", "revisa"),
    )
    await turn(model, "tg:sin-sustento", "sin-sustento", "Quiero saber de las prótesis")
    const blocked = model.lastToolResult(1)
    expect(blocked).toContain("no figura en lo que consultaste")
    expect(blocked).toContain("buscar_en_la_clinica")
    expect(blocked).not.toContain("buscar_huecos")
  })

  it("«Agendar» apagado: ni buscar huecos ni proponer citas; el camino «cita» manda al enlace o a una persona", async () => {
    await config({ disabledFunctions: ["agendar"] })
    const model = new ScriptedModel(() => say("Te paso con el equipo."))
    await turn(model, "tg:sin-agenda", "sin-agenda", "Quiero una cita para limpieza", true)
    const system = model.system()
    expect(model.offered[0]).not.toContain("buscar_huecos")
    expect(system).not.toContain("proponer_cita con un hueco")
    expect(system).not.toContain("buscar_huecos")
    expect(system).toContain(
      "Camino de este turno, elegido por lo que escribió el interlocutor: reservar una cita. Por aquí no reservas",
    )
  })

  it("«Informar» apagado: nunca «Sin servicios publicados», sin medios de pago, y el camino «información» pasa el caso", async () => {
    await config({ disabledFunctions: ["informar"] })
    const model = new ScriptedModel(() => say("Te paso con el equipo."))
    await turn(model, "tg:sin-informar", "sin-informar", "¿Cuánto cuesta la endodoncia?", true)
    const system = model.system()
    expect(system).not.toContain("Sin servicios publicados")
    expect(system).not.toContain("Medios de pago")
    expect(system).not.toContain("medios de pago")
    expect(system).not.toContain("S/ 450.00")
    expect(system).toContain("«Informar» está apagada: no respondes precios")
    expect(model.offered[0]).not.toContain("buscar_en_la_clinica")
    expect(model.offered[0]).not.toContain("consultar_conocimiento")
  })
})
