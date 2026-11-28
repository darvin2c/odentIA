/**
 * El permiso de promociones y la baja (ADR 0240) contra una base real, con un modelo controlado
 * (nunca la red): Sofi anota solo lo que ella escribió tal cual en esta conversación, no repite
 * un estado, responde la baja con la frase fija y lee el estado en LA CLIENTA. La base vuelve a
 * mirar la cita (`0051_reglas_perfil_de_la_clienta.sql`).
 */
import { randomBytes, randomUUID } from "node:crypto"
import {
  conversation,
  conversationMessage,
  customer,
  customerConsent,
  saleOrder,
  store,
  storeAgent,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { asc, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SOFI_ACTOR, withAgent } from "../agente.js"
import type { LinkAdapter } from "../link-de-pago.js"
import { optOutReply } from "./herramientas.js"
import type { ChatModel, ChatRequest, ModelReply } from "./modelo.js"
import { toolCall } from "./modelo.js"
import { answer, consentWords } from "./sofi.js"

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
type Json = Record<string, any>
type Step = (request: ChatRequest) => Partial<ModelReply>

let db: TestDb
const storeId = randomUUID()
const steps: Step[] = []
const model: ChatModel = {
  name: "gpt-6-luna",
  async complete(request) {
    const step = steps.shift()
    if (!step) throw new Error("El modelo de prueba no tiene más respuestas")
    const reply = step(request)
    return {
      content: reply.content ?? null,
      toolCalls: reply.toolCalls ?? [],
      usage: { input: 3000, cached: 2000, output: 80 },
    }
  },
}
const say =
  (content: string): Step =>
  () => ({ content })
const use =
  (name: string, args: Json): Step =>
  () => ({ toolCalls: [toolCall(name, args)] })
const lastTool = (r: ChatRequest): Json => {
  const last = [...r.messages].reverse().find((m) => m.role === "tool")
  return JSON.parse((last as { content: string }).content)
}
/** Lo que Sofi lee de la tienda y de la clienta (el segundo mensaje de sistema). */
const facts = (r: ChatRequest) => String(r.messages[1]!.content)

/** Estas pruebas no cobran: el link de pago no se usa. */
const noLink: LinkAdapter = {
  async verify() {},
  async create() {
    throw new Error("Estas pruebas no crean links de pago")
  },
  read: () => ({ kind: "ignorar" }),
  async payment() {
    return null
  },
}

const deps = () => ({
  appDb: db.appDb,
  lockDb: db.ownerDb,
  model,
  link: {
    adapters: { mercadopago: noLink },
    secretsKey: randomBytes(32),
    apiURL: "https://servidor.prueba",
  },
})

async function newConversation(customerName: string | null = null) {
  const id = randomUUID()
  await db.ownerDb
    .insert(conversation)
    .values({ id, storeId, channel: "whatsapp", customerName, createdBy: "banco" })
  return id
}

/** Ella escribe y Sofi responde con lo que dice el guion. */
async function write(conversationId: string, text: string, ...script: Step[]) {
  steps.push(...script)
  await db.ownerDb
    .insert(conversationMessage)
    .values({ storeId, conversationId, author: "cliente", text, actorUserId: "banco" })
  const result = await answer(deps(), storeId, conversationId)
  expect(steps).toHaveLength(0)
  expect(result.status).toBe("respondio")
  const [reply] = await db.ownerDb
    .select()
    .from(conversationMessage)
    .where(eq(conversationMessage.conversationId, conversationId))
    .orderBy(sql`${conversationMessage.seq} desc`)
    .limit(1)
  return reply!
}

const consents = (conversationId: string) =>
  db.ownerDb
    .select()
    .from(customerConsent)
    .where(eq(customerConsent.conversationId, conversationId))
    .orderBy(asc(customerConsent.createdAt))

/** Un pedido entregado de su ficha en esa conversación: así la conversación tiene ficha. */
async function boughtWith(conversationId: string, customerId: string) {
  const [{ next }] = (await db.ownerDb.execute(
    sql`select coalesce(max(number), 0) + 1 as next from sale_order where store_id = ${storeId}`,
  )) as unknown as [{ next: number }]
  await db.ownerDb.insert(saleOrder).values({
    storeId,
    number: Number(next),
    state: "entregado",
    channel: "whatsapp",
    conversationId,
    customerId,
    customerName: "Ana Torres",
    deliveryName: "Recojo",
    deliveryType: "OnSitePickup",
    deliveryListCents: 0,
    deliveryCents: 0,
    paymentName: "Yape",
    paymentCollection: "comprobante",
    itemsAutoCents: 12900,
    subtotalCents: 12900,
    totalCents: 12900,
    createdBy: "banco",
  })
}

beforeAll(async () => {
  db = await startTestDb()
  await db.ownerDb.execute(
    sql`insert into account_copy (user_id, name, email) values ('banco', 'Banco', 'banco@gestoria.test') on conflict do nothing`,
  )
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "banco" })
  await db.ownerDb.insert(storeAgent).values({ storeId, enabled: true, updatedBy: "banco" })
}, 180_000)

afterAll(async () => {
  await db?.stop()
})

describe("lo que Sofi lee del permiso", () => {
  it("cada estado en una frase", () => {
    expect(consentWords(null)).toBe("Promociones: no le preguntaste todavía.")
    expect(consentWords({ state: "si" })).toContain("Promociones: aceptó")
    expect(consentWords({ state: "no" })).toContain("Promociones: dijo que no")
    expect(consentWords({ state: "baja" })).toContain("Promociones: pidió la baja")
  })

  it("la frase de la baja, con su primer nombre o sin él", () => {
    expect(optOutReply("Ana")).toBe(
      "Entendido, Ana. No te enviaremos más promociones. Los avisos de tus pedidos sí te seguirán llegando. Si algún día las quieres de nuevo, escríbeme «quiero promociones».",
    )
    expect(optOutReply(null)).toMatch(/^Entendido\. No te enviaremos/)
  })
})

describe("la baja", () => {
  it("la anota con su cita tal cual y responde la frase fija, sin volver al modelo", async () => {
    const id = await newConversation("Ana Torres")
    const reply = await write(id, "Hola, ya no me mandes estas cosas porfa", (r) => {
      expect(facts(r)).toContain("Promociones: no le preguntaste todavía.")
      return {
        toolCalls: [toolCall("anotar_baja", { cita: "ya no me mandes estas cosas porfa" })],
      }
    })
    expect(reply.text).toBe(optOutReply("Ana"))
    expect((reply.detail as Json).tools).toEqual([{ name: "anotar_baja", ok: true }])
    const rows = await consents(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "baja",
      quote: "ya no me mandes estas cosas porfa",
      channel: "whatsapp",
      customerId: null,
      actorUserId: SOFI_ACTOR,
    })
    const [said] = await db.ownerDb
      .select()
      .from(conversationMessage)
      .where(eq(conversationMessage.id, rows[0]!.messageId))
    expect(said?.author).toBe("cliente")

    // Ya en baja: lo lee, y si lo repite no suma otra fila.
    const again = await write(id, "Ya no me mandes nada de promociones", (r) => {
      expect(facts(r)).toContain("Promociones: pidió la baja.")
      return { toolCalls: [toolCall("anotar_baja", { cita: "no me mandes nada" })] }
    })
    expect(again.text).toBe(optOutReply("Ana"))
    expect(await consents(id)).toHaveLength(1)
  })

  it("una cita que ella no escribió no se anota", async () => {
    const id = await newConversation()
    const reply = await write(
      id,
      "Ahora no tengo plata",
      use("anotar_baja", { cita: "no quiero promociones" }),
      (r) => {
        const result = lastTool(r)
        expect(result.ok).toBe(false)
        expect(result.problema).toContain("no se anotó")
        return { content: "No te preocupes, aquí estoy cuando quieras." }
      },
    )
    expect(reply.text).toBe("No te preocupes, aquí estoy cuando quieras.")
    expect((reply.detail as Json).tools).toEqual([
      { name: "anotar_baja", ok: false, code: "SIN_CITA" },
    ])
    expect(await consents(id)).toHaveLength(0)
  })

  it("lo que escribió Sofi tampoco vale como cita: solo lo de ella", async () => {
    const id = await newConversation()
    await db.ownerDb.insert(conversationMessage).values({
      storeId,
      conversationId: id,
      author: "sofi",
      text: "¿Quieres que te avise cuando llegue algo nuevo?",
      delivery: "sin_enviar",
      actorUserId: SOFI_ACTOR,
    })
    await write(
      id,
      "Ok",
      use("anotar_permiso", { respuesta: "si", cita: "avise cuando llegue algo nuevo" }),
      say("Cuéntame, ¿qué buscas?"),
    )
    expect(await consents(id)).toHaveLength(0)
  })

  it("la base tampoco deja anotar una cita que no está en su mensaje", async () => {
    const id = await newConversation()
    const [said] = await db.ownerDb
      .insert(conversationMessage)
      .values({
        storeId,
        conversationId: id,
        author: "cliente",
        text: "Hola",
        actorUserId: "banco",
      })
      .returning({ id: conversationMessage.id })
    await expect(
      withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
        tx.insert(customerConsent).values({
          storeId,
          conversationId: id,
          channel: "whatsapp",
          state: "baja",
          messageId: said!.id,
          quote: "no me escribas",
          actorUserId: SOFI_ACTOR,
        }),
      ),
    ).rejects.toThrow()
  })
})

describe("el permiso", () => {
  it("anota el sí y el no con su cita, y no repite el mismo estado", async () => {
    const id = await newConversation()
    await write(
      id,
      "Sí, avísame porfa",
      use("anotar_permiso", { respuesta: "si", cita: "Sí, avísame" }),
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: true, anotado: true })
        return { content: "¡Listo! Te aviso por aquí." }
      },
    )
    await write(
      id,
      "Sí, avísame nomás",
      (r) => {
        expect(facts(r)).toContain("Promociones: aceptó.")
        return { toolCalls: [toolCall("anotar_permiso", { respuesta: "si", cita: "avísame" })] }
      },
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: true, anotado: false })
        return { content: "Ya lo tengo anotado." }
      },
    )
    await write(
      id,
      "Mejor no, gracias",
      use("anotar_permiso", { respuesta: "no", cita: "Mejor no" }),
      say("Está bien, no te escribo."),
    )
    expect((await consents(id)).map((c) => [c.state, c.quote])).toEqual([
      ["si", "Sí, avísame"],
      ["no", "Mejor no"],
    ])
  })

  it("después de la baja, vuelve a aceptar solo con un mensaje suyo nuevo", async () => {
    const id = await newConversation()
    await write(id, "No quiero promociones", use("anotar_baja", { cita: "No quiero promociones" }))
    // Con lo que dijo antes de la baja, no.
    await write(id, "Ok", use("anotar_permiso", { respuesta: "si", cita: "promociones" }), (r) => {
      // «promociones» está en «No quiero promociones», anterior a la baja.
      expect(lastTool(r).ok).toBe(false)
      return { content: "Entendido." }
    })
    await write(
      id,
      "Ahora sí, quiero promociones",
      use("anotar_permiso", { respuesta: "si", cita: "quiero promociones" }),
      say("¡Listo! Te aviso por aquí."),
    )
    expect((await consents(id)).map((c) => c.state)).toEqual(["baja", "si"])
  })

  it("con ficha, se anota a su ficha y vale en su otro chat", async () => {
    const [ana] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Ana Torres", createdBy: "banco" })
      .returning({ id: customer.id })
    const first = await newConversation()
    await boughtWith(first, ana!.id)
    await write(
      first,
      "Sí, avísame",
      use("anotar_permiso", { respuesta: "si", cita: "Sí, avísame" }),
      say("¡Listo!"),
    )
    expect((await consents(first))[0]?.customerId).toBe(ana!.id)
    const other = await newConversation()
    await boughtWith(other, ana!.id)
    await write(other, "Hola", (r) => {
      expect(facts(r)).toContain("Promociones: aceptó.")
      return { content: "¡Hola!" }
    })
  })
})

describe("la cita es lo que acaba de decir", () => {
  it("una frase de un mensaje anterior no se anota: solo la del último", async () => {
    const id = await newConversation()
    await write(id, "quiero promociones", say("¿Qué talla buscas?"))
    const reply = await write(
      id,
      "Ok gracias",
      use("anotar_permiso", { respuesta: "si", cita: "quiero promociones" }),
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: false })
        return { content: "De nada." }
      },
    )
    expect((reply.detail as Json).tools).toEqual([
      { name: "anotar_permiso", ok: false, code: "SIN_CITA" },
    ])
    expect(await consents(id)).toHaveLength(0)
  })

  it("una cita de menos de dos caracteres sin espacios no se anota", async () => {
    const id = await newConversation()
    await write(id, "Sí", use("anotar_permiso", { respuesta: "si", cita: "S" }), (r) => {
      expect(lastTool(r)).toMatchObject({ ok: false })
      return { content: "¿Me confirmas?" }
    })
    expect(await consents(id)).toHaveLength(0)
    await write(id, "Sí", use("anotar_permiso", { respuesta: "si", cita: "Sí" }), say("¡Listo!"))
    expect(await consents(id)).toHaveLength(1)
  })
})

describe("la ficha donde se anota", () => {
  it("en la ficha propia del pedido del chat, no en la que se ve: «Separar» se la lleva", async () => {
    const [older] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Paola Ruiz", createdBy: "banco" })
      .returning({ id: customer.id })
    const [newer] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Paola Ruiz", createdBy: "banco", mergedInto: older!.id })
      .returning({ id: customer.id })
    const id = await newConversation()
    await boughtWith(id, newer!.id)
    await write(
      id,
      "Sí, avísame",
      use("anotar_permiso", { respuesta: "si", cita: "Sí, avísame" }),
      say("¡Listo!"),
    )
    expect((await consents(id))[0]?.customerId).toBe(newer!.id)
  })

  it("si el chat tiene pedidos de dos familias, sin ficha: quien escribe puede no ser ella", async () => {
    const [ana] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Ana Paz", createdBy: "banco" })
      .returning({ id: customer.id })
    const [bea] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Bea Paz", createdBy: "banco" })
      .returning({ id: customer.id })
    const id = await newConversation()
    await boughtWith(id, ana!.id)
    await boughtWith(id, bea!.id)
    await write(
      id,
      "Sí, avísame",
      use("anotar_permiso", { respuesta: "si", cita: "Sí, avísame" }),
      say("¡Listo!"),
    )
    expect((await consents(id))[0]).toMatchObject({ state: "si", customerId: null })
  })
})
