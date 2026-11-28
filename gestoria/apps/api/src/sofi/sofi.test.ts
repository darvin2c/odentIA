/**
 * Sofi y Argos (paso B5) contra una base real, con un modelo controlado (nunca la red): las
 * herramientas usan las mismas operaciones que el equipo, la comprobación frena lo inventado,
 * nunca da un pago por confirmado, arma el pedido solo con un resumen que el cliente vio, y
 * Argos escribe cada seguimiento una sola vez. También lo que ve cada rol en Reportes.
 *
 * Esto prueba nuestro código, no cómo responde el modelo real: eso lo mide `eval-sofi.ts`.
 */
import { randomUUID } from "node:crypto"
import {
  conversation,
  conversationMessage,
  orderEvent,
  productColor,
  productPhoto,
  productQuestion,
  saleOrder,
  store,
  storeAgent,
  storeLink,
  storeMember,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { and, eq, sql } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withAgent } from "../agente.js"
import { createApp } from "../app.js"
import { runArgos } from "./argos.js"
import { tellAnswer } from "./conversaciones.js"
import type { ChatModel, ChatRequest, ModelReply } from "./modelo.js"
import { toolCall } from "./modelo.js"
import { amountsIn, claimsPaid } from "./revisar.js"
import { answer, SOFI_FALLBACK } from "./sofi.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>
let keys: ReturnType<typeof createLocalJWKSet>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  ajena: { id: "u-ajena", email: "ajena@otra.test", name: "Ajena" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const otherStore = randomUUID()
const base = `/api/tiendas/${storeId}`

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
type Json = Record<string, any>
type Step = (request: ChatRequest) => Partial<ModelReply> | Promise<Partial<ModelReply>>

/** El modelo controlado: cada prueba le da lo que responde en cada llamada. */
const steps: Step[] = []
const model: ChatModel = {
  name: "gpt-6-luna",
  async complete(request) {
    const step = steps.shift()
    if (!step) throw new Error("El modelo de prueba no tiene más respuestas")
    const reply = await step(request)
    return {
      content: reply.content ?? null,
      toolCalls: reply.toolCalls ?? [],
      usage: reply.usage ?? { input: 3000, cached: 2000, output: 80 },
    }
  },
}
const say =
  (content: string): Step =>
  () => ({ content })
const use =
  (name: string, args: (r: ChatRequest) => Json): Step =>
  (r) => ({
    toolCalls: [toolCall(name, args(r))],
  })
/** Lo que devolvió la última herramienta. */
const lastTool = (r: ChatRequest): Json => {
  const last = [...r.messages].reverse().find((m) => m.role === "tool")
  return JSON.parse((last as { content: string }).content)
}

async function tokenFor(who: Who) {
  const p = people[who]
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: p.email, emailVerified: true, name: p.name, image: null })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(p.id)
    .setIssuer(ACCOUNT)
    .setAudience("gestoria")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(privateKey)
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const response = await app.request(`${SERVER}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${await tokenFor(who)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json }
}

const ids = { yape: "", reparto: "", t38: "", t39: "", medias: "", ajena: "" }

async function newTest() {
  const created = await call("rosa", "POST", `${base}/sofi/pruebas`)
  expect(created.status).toBe(201)
  return created.json.id as string
}

async function write(conversationId: string, text: string, ...script: Step[]) {
  steps.push(...script)
  const sent = await call("rosa", "POST", `${base}/conversaciones/${conversationId}/cliente`, {
    text,
  })
  expect(sent.status).toBe(200)
  expect(steps).toHaveLength(0)
  return sent.json as { conversation: Json; result: Json }
}

const lastSofi = (view: Json) =>
  [...(view.conversation.messages as Json[])].reverse().find((m) => m.author === "sofi")!

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  keys = createLocalJWKSet({ keys: [jwk] })
  app = createApp({
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys },
    webURL: WEB,
    model,
  })
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb.insert(store).values([
    { id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" },
    { id: otherStore, name: "Otra tienda", currency: "PEN", createdBy: "u-ajena" },
  ])
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
    { storeId: otherStore, userId: "u-ajena", role: "owner" },
  ])
  const pay = async (body: Json) =>
    (await call("rosa", "POST", `${base}/medios-de-pago`, body)).json.method.id as string
  ids.yape = await pay({
    name: "Yape",
    typeCode: "68",
    collection: "comprobante",
    details: "Yape al 987 654 321, a nombre de Rosa Quispe",
  })
  const deliver = async (body: Json) =>
    (await call("rosa", "POST", `${base}/formas-de-entrega`, body)).json.method.id as string
  ids.reparto = await deliver({
    name: "Reparto en Lima",
    type: "DeliveryModeOwnFleet",
    cost: "fijo",
    priceCents: 1000,
    maxDiscountCents: 1000,
  })
  const zapatilla = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla urbana blanca",
    category: "Zapatillas",
    listPriceCents: 12900,
    minPriceCents: 10000,
    options: [{ name: "Talla", values: ["38", "39"] }],
  })
  const variants = (await call("rosa", "GET", `${base}/productos/${zapatilla.json.product.id}`))
    .json.product.variants as Json[]
  ids.t38 = variants.find((v) => v.optionValues[0] === "38")!.id
  ids.t39 = variants.find((v) => v.optionValues[0] === "39")!.id
  const medias = await call("rosa", "POST", `${base}/productos`, {
    name: "Medias",
    listPriceCents: 1500,
  })
  ids.medias = (
    await call("rosa", "GET", `${base}/productos/${medias.json.product.id}`)
  ).json.product.variants[0].id
  for (const [variantId, quantity] of [
    [ids.t38, 5],
    [ids.medias, 10],
  ] as const)
    await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
      kind: "entrada",
      quantity,
    })
  // Un producto de otra tienda: Sofi no lo puede vender aquí.
  const other = await call("ajena", "POST", `/api/tiendas/${otherStore}/productos`, {
    name: "Zapatilla ajena",
    listPriceCents: 5000,
  })
  ids.ajena = (
    await call("ajena", "GET", `/api/tiendas/${otherStore}/productos/${other.json.product.id}`)
  ).json.product.variants[0].id
}, 180_000)

afterAll(async () => {
  await db?.stop()
})

describe("la comprobación antes de enviar", () => {
  it("lee los importes como los escribe Sofi", () => {
    expect(amountsIn("Cuesta S/ 129, o desde S/89.90; total S/ 1,290.50", "PEN")).toEqual([
      12900, 8990, 129050,
    ])
    expect(amountsIn("Te queda en 120 soles", "PEN")).toEqual([12000])
    expect(amountsIn("Talla 38, quedan 2", "PEN")).toEqual([])
  })

  it("distingue un pago dado por confirmado de uno que espera", () => {
    expect(claimsPaid("¡Listo! Tu pago está confirmado.")).toBe(true)
    expect(claimsPaid("Recibimos tu pago, gracias")).toBe(true)
    expect(claimsPaid("Tu pago queda por confirmar: una persona lo revisa")).toBe(false)
    expect(claimsPaid("Apenas esté confirmado tu pago te aviso")).toBe(false)
    expect(claimsPaid("Todavía no está confirmado")).toBe(false)
    // La negación o la condición tienen que ir pegadas a lo que dice.
    expect(claimsPaid("No te preocupes, ya está pagado")).toBe(true)
    expect(claimsPaid("Si, recibimos tu pago")).toBe(true)
    expect(claimsPaid("Cuando tu pago esté confirmado te aviso")).toBe(false)
  })
})

describe("Sofi vende con las reglas de la tienda", () => {
  it("sin modelo no responde, y la prueba lo dice", async () => {
    const withModel = app
    app = createApp({
      appDb: db.appDb,
      ownerDb: db.ownerDb,
      account: { url: ACCOUNT, eventsSecret: "", keys },
      webURL: WEB,
    })
    try {
      expect((await call("rosa", "GET", `${base}/sofi`)).json.modelReady).toBe(false)
      const id = await newTest()
      const sent = await write(id, "Hola")
      expect(sent.result.status).toBe("sin_modelo")
      expect(sent.conversation.messages).toHaveLength(1)
    } finally {
      app = withModel
    }
    expect((await call("rosa", "GET", `${base}/sofi`)).json.modelReady).toBe(true)
  })

  it("da el precio con lo que devuelve el catálogo, y la respuesta lleva lo que hizo", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "Hola, ¿tienen la zapatilla blanca en 38?",
      use("buscar_productos", () => ({ texto: "zapatilla blanca 38" })),
      (r) => {
        const found = lastTool(r)
        const zap = found.productos[0]
        expect(zap.nombre).toBe("Zapatilla urbana blanca")
        expect(zap.se_negocia).toBe(true)
        // Lo agotado viene marcado y nunca muestra el mínimo.
        expect(zap.variantes.find((v: Json) => v.opciones === "39").agotada).toBe(true)
        expect(JSON.stringify(found)).not.toContain("S/ 100")
        return { content: `¡Hola! Soy Sofi. Sí, la tenemos en 38: cuesta ${zap.precio}.` }
      },
    )
    expect(sent.result.status).toBe("respondio")
    const reply = lastSofi(sent)
    expect(reply.text).toContain("S/ 129")
    expect(reply.delivery).toBe("prueba")
    expect(reply.basis.tools).toEqual(["Buscó en el catálogo"])
    expect(reply.basis.costMicros).toBeGreaterThan(0)
  })

  it("no baja del mínimo: cotizar se lo dice y ofrece lo que sí se puede", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "Te la compro a 90 soles",
      use("cotizar", () => ({
        lineas: [{ variante_id: ids.t38, cantidad: 1, precio_unitario: 90 }],
        entrega_id: ids.reparto,
      })),
      (r) => {
        const result = lastTool(r)
        expect(result.ok).toBe(false)
        expect(result.problemas[0]).toContain("No puede bajar")
        return { content: "A 90 no llego, pero te puedo regalar el envío." }
      },
    )
    const reply = lastSofi(sent)
    expect(reply.basis.tools).toEqual(["Calculó el total (no se pudo)"])
    expect(sent.conversation.handler).toBe("sofi")
  })

  it("un importe inventado no sale: lo corrige una vez y si insiste pasa a una persona", async () => {
    const id = await newTest()
    const fixed = await write(id, "¿Me la dejas en 50?", say("Te la dejo en S/ 50."), (r) => {
      // La corrección le llega como de la tienda, no del cliente.
      expect(String(r.messages.at(-1)!.content)).toContain("[Comprobación de la tienda")
      return { content: "Ese precio no lo puedo dar, pero veamos qué opciones hay." }
    })
    expect(lastSofi(fixed).text).toBe("Ese precio no lo puedo dar, pero veamos qué opciones hay.")
    expect(lastSofi(fixed).basis.stopped[0]).toContain("50")
    const stuck = await write(id, "¿Y en 40?", say("En S/ 40 te la dejo."), say("Ok, S/ 40."))
    expect(lastSofi(stuck).text).toBe(SOFI_FALLBACK)
    // Que el cliente lo haya escrito con moneda no lo vuelve un precio que Sofi pueda prometer.
    expect(lastSofi(stuck).basis.stopped.length).toBeGreaterThan(0)
    expect(stuck.conversation.handler).toBe("persona")
    expect(stuck.result.handoff).toBe(true)
    // Con una persona atendiendo, Sofi no escribe.
    const quiet = await write(id, "¿Hola?")
    expect(quiet.result.status).toBe("persona")
    // «Devolver a Sofi» y sigue.
    const back = await call("lucia", "POST", `${base}/conversaciones/${id}/devolver`)
    expect(back.json.conversation.handler).toBe("sofi")
  })

  it("arma el pedido solo con el resumen que el cliente vio; anota la captura y nunca la da por pagada", async () => {
    const id = await newTest()
    const args = {
      lineas: [{ variante_id: ids.t38, cantidad: 1 }],
      entrega_id: ids.reparto,
      envio_cobrado: 0,
    }
    // Sin resumen previo, no lo arma.
    const early = await write(
      id,
      "La quiero, soy Carla, Av. Primavera 123, Surco",
      use("armar_pedido", () => ({ ...args, nombre: "Carla", direccion: "Av. Primavera 123" })),
      (r) => {
        expect(lastTool(r).problema).toContain("resumen")
        return { toolCalls: [toolCall("cotizar", args)] }
      },
      (r) => ({ content: `Te queda en ${lastTool(r).total} con envío gratis. ¿Lo confirmo?` }),
    )
    expect(lastSofi(early).text).toContain("S/ 129")
    const confirmed = await write(
      id,
      "Sí, confirmo",
      use("armar_pedido", () => ({ ...args, nombre: "Carla", direccion: "Av. Primavera 123" })),
      (r) => {
        const result = lastTool(r)
        expect(result).toMatchObject({ ok: true, pedido: "0001", total: "S/ 129" })
        return { toolCalls: [toolCall("link_de_pago", { pedido: "0001" })] }
      },
      (r) => {
        // En una prueba no se crea un link real.
        expect(lastTool(r).problema).toContain("prueba")
        return {
          content: "Listo, tu pedido 0001 por S/ 129. Puedes pagar por Yape al 987 654 321.",
        }
      },
    )
    expect(confirmed.conversation.orders).toEqual([
      expect.objectContaining({ number: "0001", state: "por_pagar", test: true }),
    ])
    const [order] = await db.ownerDb
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.id, confirmed.conversation.orders[0].id))
    expect(order).toMatchObject({
      createdBy: "agente:sofi",
      conversationId: id,
      test: true,
      totalCents: 12900,
      marginUsedCents: 1000,
    })
    // La captura: queda por confirmar, y decir «confirmado» no sale.
    const paid = await write(
      id,
      "Ya te yapeé 129, operación 123456",
      use("anotar_pago", () => ({ pedido: "0001", monto: 129, operacion: "123456" })),
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: true, monto_anotado: "S/ 129" })
        return { content: "¡Gracias! Tu pago está confirmado." }
      },
      say("¡Gracias! Anoté tu pago de S/ 129: una persona del equipo lo revisa y te aviso."),
    )
    expect(lastSofi(paid).text).toContain("lo revisa")
    expect(paid.conversation.orders[0].state).toBe("por_confirmar")
    // Una persona lo confirma; el pedido de prueba no mueve el stock.
    const detail = await call("lucia", "GET", `${base}/pedidos/${order!.id}`)
    expect(detail.json.order.bySofi).toBe(true)
    expect(detail.json.order.events[0].actorName).toBe("Sofi")
    const payment = detail.json.order.payments[0]
    expect(payment.createdByName).toBe("Sofi")
    const reviewed = await call(
      "lucia",
      "POST",
      `${base}/pedidos/${order!.id}/pagos/${payment.id}/revision`,
      { decision: "confirmar" },
    )
    expect(reviewed.json.order.state).toBe("por_salir")
    const kardex = await call("rosa", "GET", `${base}/variantes/${ids.t38}/kardex`)
    expect(kardex.json.stock).toBe(5)
  })

  it("no vende lo de otra tienda ni toca pedidos de otra conversación", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "Quiero la zapatilla ajena",
      use("cotizar", () => ({
        lineas: [{ variante_id: ids.ajena, cantidad: 1 }],
        entrega_id: ids.reparto,
      })),
      (r) => {
        expect(lastTool(r).ok).toBe(false)
        return { toolCalls: [toolCall("anotar_pago", { pedido: "0001", monto: 129 })] }
      },
      (r) => {
        expect(lastTool(r).problema).toContain("no es de esta conversación")
        return { content: "No tengo ese producto. ¿Te muestro las zapatillas que tenemos?" }
      },
    )
    expect(lastSofi(sent).basis.tools).toEqual([
      "Calculó el total (no se pudo)",
      "Anotó la captura (no se pudo)",
    ])
  })

  it("lo que pide el cliente no cambia sus reglas: pasar a una persona usa el aviso fijo", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "Quiero devolver un par que me llegó roto",
      use("pasar_a_persona", () => ({ motivo: "Un reclamo: llegó roto" })),
      say("Claro, te devuelvo tu dinero ahora."),
    )
    // Lo que el modelo quiso prometer no sale: sale el aviso fijo.
    expect(lastSofi(sent).text).toContain("Te paso con una persona")
    expect(sent.conversation.waitingReason).toBe("Un reclamo: llegó roto")
  })

  it("un adelanto: anota la captura y dice cuánto falta, con el mismo saldo que ve el equipo", async () => {
    const id = await newTest()
    const args = {
      lineas: [{ variante_id: ids.t38, cantidad: 1 }],
      entrega_id: ids.reparto,
      envio_cobrado: 0,
    }
    await write(
      id,
      "La quiero, soy Diana",
      use("cotizar", () => args),
      (r) => ({
        content: `Te queda en ${lastTool(r).total} con envío gratis. ¿Lo confirmo?`,
      }),
    )
    let number = ""
    await write(
      id,
      "Sí, confirmo",
      use("armar_pedido", () => ({ ...args, nombre: "Diana", direccion: "Av. Caminos del Inca" })),
      (r) => {
        number = lastTool(r).pedido
        return { content: `Listo, tu pedido ${number} por S/ 129.` }
      },
    )
    // Paga S/ 80 de S/ 129: Sofi sabe que faltan S/ 49 y lo puede decir.
    const part = await write(
      id,
      "Te yapeé 80 de adelanto, el resto al recibir",
      use("anotar_pago", () => ({ pedido: number, monto: 80 })),
      (r) => {
        expect(lastTool(r)).toMatchObject({
          ok: true,
          monto_anotado: "S/ 80",
          falta_pagar: "S/ 49",
        })
        return { toolCalls: [toolCall("ver_pedidos", {})] }
      },
      (r) => {
        const [order] = lastTool(r).pedidos as Json[]
        // Lo que espera a una persona no se dice cobrado: «pagado_confirmado» no aparece.
        expect(order).toMatchObject({ por_confirmar: "S/ 80", falta_pagar: "S/ 49" })
        expect(order).not.toHaveProperty("pagado_confirmado")
        return {
          content:
            "Anoté tu adelanto de S/ 80: una persona del equipo lo revisa. Falta pagar S/ 49 al recibir.",
        }
      },
    )
    expect(lastSofi(part).text).toContain("Falta pagar S/ 49")
    expect(part.conversation.orders[0].balance).toMatchObject({
      pendingCents: 8000,
      dueCents: 4900,
    })
  })

  // Al final: arma un pedido, y los de arriba cuentan los números desde el 0001.
  it("la oferta llega una vez, con la hora exacta, no se mejora y el pedido vence a esa hora", async () => {
    const id = await newTest()
    const args = {
      lineas: [{ variante_id: ids.t38, cantidad: 1 }],
      entrega_id: ids.reparto,
      envio_cobrado: 0,
    }
    let deadline = ""
    const offered = await write(
      id,
      "Mmm, lo voy a pensar",
      use("cotizar", () => args),
      (r) => {
        const result = lastTool(r)
        expect(result.ok).toBe(true)
        // La hora exacta, en la de la tienda: la misma que vencerá el pedido.
        expect(result.plazo).toMatch(/hasta (hoy|mañana) a las \d{1,2}:\d{2} [ap]\. m\./)
        deadline = result.plazo.match(/hasta [^.]+\. m\./)[0]
        return {
          content: `Te consigo el envío gratis: te queda en ${result.total} si lo pagas ${deadline}.`,
        }
      },
    )
    expect(lastSofi(offered).text).toContain(deadline)
    const [said] = await db.ownerDb
      .select({ detail: conversationMessage.detail })
      .from(conversationMessage)
      .where(
        and(eq(conversationMessage.conversationId, id), eq(conversationMessage.author, "sofi")),
      )
    const offer = (said!.detail as Json).oferta
    expect(offer.cedido).toBe(1000)

    // Insiste: no la mejora.
    await write(
      id,
      "¿Y si además me bajas 10 soles?",
      use("cotizar", () => ({ ...args, lineas: [{ ...args.lineas[0]!, precio_unitario: 119 }] })),
      (r) => {
        const result = lastTool(r)
        expect(result.ok).toBe(false)
        expect(result.problemas[0]).toContain("no se mejora")
        return { content: `Lo que te consigo es el envío gratis, si lo pagas ${deadline}.` }
      },
    )

    // Acepta: el pedido vence a la hora que le dijo, no 24 horas desde que se anota.
    const confirmed = await write(
      id,
      "Ya, lo confirmo. Soy Ana, Av. Primavera 123",
      use("armar_pedido", () => ({ ...args, nombre: "Ana", direccion: "Av. Primavera 123" })),
      (r) => {
        const result = lastTool(r)
        expect(result.ok).toBe(true)
        expect(result.plazo).toContain(deadline)
        return { content: `Listo, tu pedido ${result.pedido} por ${result.total}.` }
      },
    )
    const [order] = await db.ownerDb
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.id, confirmed.conversation.orders[0].id))
    expect(order).toMatchObject({ marginUsedCents: 1000, state: "por_pagar" })
    expect(order!.priceExpiresAt?.toISOString()).toBe(offer.vence)
  })
})

describe("lo que escribe el cliente mientras Sofi responde", () => {
  it("lo responde después, con lo nuevo al final", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "Hola, ¿tienen zapatillas?",
      async (r) => {
        // Mientras Sofi responde, el cliente escribe otra vez (como llegará por el canal).
        await db.ownerDb.insert(conversationMessage).values({
          storeId,
          conversationId: id,
          author: "cliente",
          text: "¿Y me la dejas S/ 50 menos?",
          actorUserId: "canal",
        })
        expect(r.messages.at(-1)).toMatchObject({
          role: "user",
          content: "Hola, ¿tienen zapatillas?",
        })
        return { content: "¡Hola! Sí, tenemos zapatillas." }
      },
      (r) => {
        // La segunda vuelta ve lo nuevo al final, y lo que el cliente escribió no es un precio permitido.
        expect(r.messages.at(-1)).toMatchObject({
          role: "user",
          content: "¿Y me la dejas S/ 50 menos?",
        })
        return { content: "Te cuento los precios: déjame buscarlos." }
      },
    )
    const sofi = (sent.conversation.messages as Json[]).filter((m) => m.author === "sofi")
    expect(sofi.map((m) => m.text)).toEqual([
      "¡Hola! Sí, tenemos zapatillas.",
      "Te cuento los precios: déjame buscarlos.",
    ])
  })
})

describe("lo que pone el dueño y lo que ve cada rol", () => {
  it("Ventas no prueba a Sofi, no la configura ni ve Reportes", async () => {
    // «Probar a Sofi» vive en Configuración: es de quien la ajusta.
    expect((await call("lucia", "POST", `${base}/sofi/pruebas`)).status).toBe(403)
    const test = await call("rosa", "POST", `${base}/sofi/pruebas`)
    const written = await call(
      "lucia",
      "POST",
      `${base}/conversaciones/${test.json.id as string}/cliente`,
      { text: "Hola" },
    )
    expect(written.status).toBe(403)
    const save = await call("lucia", "PATCH", `${base}/sofi`, {
      enabled: true,
      followPayment: true,
      followThanks: true,
      followRestock: true,
      followReturn: true,
    })
    expect(save.status).toBe(403)
    expect((await call("lucia", "GET", `${base}/reportes`)).status).toBe(403)
    expect((await call("lucia", "GET", `${base}/argos`)).status).toBe(403)
    expect((await call("ajena", "GET", `${base}/sofi`)).status).toBe(404)
  })

  it("el dueño la enciende y queda escrito quién", async () => {
    const save = await call("rosa", "PATCH", `${base}/sofi`, {
      enabled: true,
      displayName: "Sofi, de Calzados Rosa",
      knowledge: "Atendemos de lunes a sábado.",
      followPayment: true,
      followThanks: true,
      followRestock: true,
      followReturn: true,
    })
    expect(save.status).toBe(200)
    const [row] = await db.ownerDb.select().from(storeAgent).where(eq(storeAgent.storeId, storeId))
    expect(row).toMatchObject({ enabled: true, updatedBy: "u-rosa" })
  })

  it("Reportes no cuenta los pedidos de prueba", async () => {
    const report = await call("rosa", "GET", `${base}/reportes?periodo=mes`)
    expect(report.status).toBe(200)
    expect(report.json.sold).toEqual({ cents: 0, orders: 0, ticketCents: 0, refundedCents: 0 })
    expect(report.json.agent.conversations).toBe(0)
  })
})

describe("Argos le encarga a Sofi lo de rutina", () => {
  it("agradece al día siguiente de entregar, recuerda un pago y avisa que volvió una talla, una sola vez", async () => {
    // Una conversación de verdad (la traerá B2): aquí la escribe el dueño de la base.
    const conversationId = randomUUID()
    await db.ownerDb.execute(sql`insert into conversation (id, store_id, channel, customer_name, created_by, last_customer_at)
      values (${conversationId}, ${storeId}, 'whatsapp', 'Carla Mendoza', 'canal', now() - interval '2 days')`)
    const make = async (extra: Json = {}) => {
      const created = await call("lucia", "POST", `${base}/pedidos`, {
        customerName: "Carla Mendoza",
        channel: "whatsapp",
        lines: [{ variantId: ids.medias, quantity: 1 }],
        deliveryMethodId: ids.reparto,
        paymentMethodId: ids.yape,
        ...extra,
      })
      expect(created.status).toBe(201)
      await db.ownerDb.execute(
        sql`update sale_order set conversation_id = ${conversationId}, created_at = now() - interval '4 hours' where id = ${created.json.order.id}`,
      )
      return created.json.order.id as string
    }
    const unpaid = await make()
    const delivered = await make()
    await db.ownerDb
      .update(saleOrder)
      .set({ state: "entregado" })
      .where(eq(saleOrder.id, delivered))
    await db.ownerDb.insert(orderEvent).values({
      storeId,
      orderId: delivered,
      actorUserId: "u-lucia",
      action: "entregado",
      createdAt: new Date(Date.now() - 21 * 3_600_000),
    })
    // Pidió la 39 agotada; entra stock.
    await db.ownerDb.execute(
      sql`insert into stock_request (store_id, variant_id, conversation_id) values (${storeId}, ${ids.t39}, ${conversationId})`,
    )
    await call("rosa", "POST", `${base}/variantes/${ids.t39}/movimientos`, {
      kind: "entrada",
      quantity: 2,
    })

    const first = await runArgos(db.ownerDb, db.appDb)
    expect(first.written).toBe(3)
    const again = await runArgos(db.ownerDb, db.appDb)
    expect(again.written).toBe(0)
    const written = await db.ownerDb
      .select()
      .from(conversationMessage)
      .where(eq(conversationMessage.conversationId, conversationId))
    const byKind = Object.fromEntries(written.map((m) => [m.followUp, m]))
    expect(byKind.gracias?.text).toBe("Gracias por tu compra, Carla. ¿Te llegó bien?")
    expect(byKind.pago?.text).toContain("listo para pagar")
    expect(byKind.pago?.followUpRef).toBe(unpaid)
    expect(byKind.volvio?.text).toContain("Volvió Zapatilla urbana blanca en 39")
    // Pasaron más de 24 horas desde que escribió: sale con plantilla aprobada.
    for (const m of written) {
      expect(m).toMatchObject({ author: "sofi", delivery: "sin_enviar", needsTemplate: true })
      expect(m.actorUserId).toBe("agente:argos")
    }

    const board = await call("rosa", "GET", `${base}/argos`)
    expect(board.status).toBe(200)
    expect(board.json.done.map((d: Json) => d.kind).sort()).toEqual(["gracias", "pago", "volvio"])
    // Lo que le toca al equipo está en Inicio: el pago por confirmar de la prueba no cuenta.
    const home = await call("rosa", "GET", `${base}/inicio`)
    expect(home.status).toBe(200)
    expect(home.json.toDo.filter((t: Json) => t.kind === "pago")).toEqual([])
  })

  it("con Sofi apagada, Argos no le encarga nada", async () => {
    await db.ownerDb
      .update(storeAgent)
      .set({ enabled: false })
      .where(and(eq(storeAgent.storeId, storeId)))
    expect((await runArgos(db.ownerDb, db.appDb)).stores).toBe(0)
  })
})

/* ------------------------------------------------------------------ la ficha del producto */

describe("Sofi con la ficha del producto (lienzo «La ficha del producto», PR 6)", () => {
  const lona = { id: "", blanca: "", negra: "", negra38: "", fotoBlanca: "", fotoNegra: "" }

  beforeAll(async () => {
    const created = await call("rosa", "POST", `${base}/productos`, {
      name: "Zapatilla de lona",
      category: "Zapatillas",
      description: "Zapatilla de lona para el día a día. Suela gruesa.",
      listPriceCents: 11900,
      minPriceCents: 9900,
      options: [
        { name: "Color", values: ["blanca", "negra"] },
        { name: "Talla", values: ["38", "39"] },
      ],
    })
    expect(created.status).toBe(201)
    lona.id = created.json.product.id
    const patched = await call("rosa", "PATCH", `${base}/productos/${lona.id}`, {
      rubro: "calzado",
      rubroData: { horma: "Normal", material: "Lona" },
      web: { visible: true, slug: "zapatilla-de-lona" },
      offers: { delivery: true, discount: false, secondUnit: false, gift: "Medias tobilleras" },
    })
    expect(patched.status).toBe(200)
    const variants = patched.json.product.variants as Json[]
    lona.negra38 = variants.find((v) => v.optionValues.join() === "negra,38")!.id
    await call("rosa", "POST", `${base}/variantes/${lona.negra38}/movimientos`, {
      kind: "entrada",
      quantity: 2,
    })
    // Los colores con su hex y una foto de cada uno: la de la negra es la que manda Sofi.
    const [blanca, negra] = await db.ownerDb
      .insert(productColor)
      .values([
        { storeId, productId: lona.id, value: "blanca", hex: "#ffffff" },
        { storeId, productId: lona.id, value: "negra", hex: "#1f1f1f" },
      ])
      .returning({ id: productColor.id })
    lona.blanca = blanca!.id
    lona.negra = negra!.id
    const photo = (colorId: string, position: number) => ({
      storeId,
      productId: lona.id,
      position,
      contentType: "image/jpeg" as const,
      objectKey: `tiendas/${storeId}/productos/${lona.id}/fotos/${randomUUID()}`,
      colorId,
      createdBy: "u-rosa",
    })
    const [fotoBlanca, fotoNegra] = await db.ownerDb
      .insert(productPhoto)
      .values([photo(lona.blanca, 0), photo(lona.negra, 1)])
      .returning({ id: productPhoto.id })
    lona.fotoBlanca = fotoBlanca!.id
    lona.fotoNegra = fotoNegra!.id
    await db.ownerDb
      .update(productColor)
      .set({ photoId: lona.fotoNegra })
      .where(eq(productColor.id, lona.negra))
    await call("rosa", "POST", `${base}/productos/${lona.id}/preguntas`, {
      question: "¿Se puede lavar en lavadora?",
      answer: "Sí, en ciclo suave y con agua fría.",
    })
    await db.ownerDb
      .insert(storeLink)
      .values({ name: "calzadosrosa", storeId, createdBy: "u-rosa" })
      .onConflictDoNothing()
    await db.ownerDb
      .update(storeAgent)
      .set({ enabled: true })
      .where(eq(storeAgent.storeId, storeId))
  })

  /** Lo que devolvió buscar_productos de la zapatilla de lona. */
  const lonaIn = (r: ChatRequest) =>
    (lastTool(r).productos as Json[]).find((p) => p.nombre === "Zapatilla de lona")!

  it("lee los datos del rubro, lo que la tienda respondió, los colores y lo que puede ofrecer", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "¿Cómo calza la de lona?",
      use("buscar_productos", () => ({ texto: "zapatilla de lona" })),
      (r) => {
        const found = lonaIn(r)
        expect(found.datos).toEqual([
          { dato: "Cómo calza", valor: "Normal" },
          { dato: "Material", valor: "Lona" },
        ])
        expect(found.la_ficha_no_dice).toContain("Cómo se limpia")
        expect(found.preguntas_respondidas).toEqual([
          {
            pregunta: "¿Se puede lavar en lavadora?",
            respuesta: "Sí, en ciclo suave y con agua fría.",
          },
        ])
        expect(found.colores).toEqual([
          { color: "blanca", foto: true },
          { color: "negra", foto: true },
        ])
        // Solo lo que la tienda deja ofrecer de este producto: ni soles ni la 2.ª unidad.
        expect(found.puede_ofrecer).toEqual([
          "envío gratis o más barato",
          "un regalo: Medias tobilleras",
        ])
        expect(found.estado).toBeUndefined()
        return { content: "Calza normal: pide tu talla de siempre." }
      },
    )
    // «Qué usó Sofi»: lo que leyó y está en lo que escribió.
    expect(lastSofi(sent).used).toContainEqual({ label: "Cómo calza: normal", target: "datos" })
  })

  it("cada estado dice lo suyo, y lo que ya no se vende no sale", async () => {
    await call("rosa", "PATCH", `${base}/productos/${lona.id}`, {
      status: { kind: "encargo", days: 5 },
    })
    const id = await newTest()
    await write(
      id,
      "¿Tienes la de lona?",
      use("buscar_productos", () => ({ texto: "zapatilla de lona" })),
      (r) => {
        expect(lonaIn(r).estado).toContain("te la consigo en 5 días")
        return { content: "No la tengo ahora: te la consigo en 5 días." }
      },
    )
    await call("rosa", "PATCH", `${base}/productos/${lona.id}`, {
      status: { kind: "no_se_vende" },
    })
    await write(
      id,
      "¿Y la de lona?",
      use("buscar_productos", () => ({ texto: "zapatilla de lona" })),
      (r) => {
        expect(
          (lastTool(r).productos as Json[]).some((p) => p.nombre === "Zapatilla de lona"),
        ).toBe(false)
        return { toolCalls: [toolCall("mandar_foto", { producto_id: lona.id })] }
      },
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: false })
        return { content: "Esa ya no la tenemos. ¿Te muestro la urbana?" }
      },
    )
    await call("rosa", "PATCH", `${base}/productos/${lona.id}`, { status: null })
  })

  it("manda la foto del color que pide (no la primera), y sin video lo dice", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "¿Tienes la negra en 38?",
      use("buscar_productos", () => ({ texto: "zapatilla de lona negra" })),
      () => ({ toolCalls: [toolCall("mandar_foto", { producto_id: lona.id, color: "Negra" })] }),
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: true, manda: "la foto", color: "negra" })
        return { toolCalls: [toolCall("mandar_foto", { producto_id: lona.id, video: true })] }
      },
      (r) => {
        expect(lastTool(r)).toMatchObject({ ok: false })
        return { content: "Sí: la negra 38 está a S/ 119 y me quedan 2. Te mando su foto." }
      },
    )
    const message = lastSofi(sent)
    expect(message.media).toEqual([
      expect.objectContaining({ kind: "foto", id: lona.fotoNegra, color: "negra" }),
    ])
    expect(message.used).toContainEqual({ label: "Stock negra 38: 2", target: "stock" })
    expect(message.used).toContainEqual({ label: "Foto de «negra»", target: "fotos" })
  })

  it("lo que no supo: lo deja a la tienda y sigue; lo de la prueba no va a «Te toca»", async () => {
    const id = await newTest()
    const sent = await write(
      id,
      "¿Destiñe al lavarla?",
      use("buscar_productos", () => ({ texto: "zapatilla de lona" })),
      () => ({
        toolCalls: [
          toolCall("anotar_pregunta", { producto_id: lona.id, pregunta: "¿Destiñe al lavarla?" }),
        ],
      }),
      (r) => {
        expect(lastTool(r).ok).toBe(true)
        return {
          content:
            "No lo tengo confirmado. Le pregunto a la tienda y te escribo. ¿En qué talla la buscas?",
        }
      },
    )
    expect(lastSofi(sent).missed).toEqual([
      { productId: lona.id, question: "¿Destiñe al lavarla?" },
    ])
    const [asked] = await db.ownerDb
      .select()
      .from(productQuestion)
      .where(eq(productQuestion.conversationId, id))
    expect(asked).toMatchObject({ askedBy: "agente:sofi", answer: null, productId: lona.id })
    const home = await call("rosa", "GET", `${base}/inicio`)
    expect(home.json.toDo.filter((t: Json) => t.kind === "pregunta")).toEqual([])
    // En la ficha sí queda, marcada como de una prueba.
    const sheet = await call("rosa", "GET", `${base}/productos/${lona.id}`)
    expect(sheet.json.product.questions).toContainEqual(
      expect.objectContaining({ question: "¿Destiñe al lavarla?", test: true }),
    )
  })

  it("en chats de verdad: dos iguales son una línea de «Te toca»; se responde una vez, Sofi se lo dice y queda en la ficha", async () => {
    const deps = {
      appDb: db.appDb,
      lockDb: db.ownerDb,
      model,
      link: { adapters: {}, secretsKey: null, apiURL: SERVER } as never,
    }
    const chats: string[] = []
    for (const name of ["Carla", "Valeria"]) {
      const [conv] = await db.ownerDb
        .insert(conversation)
        .values({ storeId, channel: "whatsapp", createdBy: "u-rosa", customerName: name })
        .returning({ id: conversation.id })
      await db.ownerDb.insert(conversationMessage).values({
        storeId,
        conversationId: conv!.id,
        author: "cliente",
        text: "¿destiñe al lavarla?",
        actorUserId: "u-rosa",
      })
      steps.push(
        use("anotar_pregunta", () => ({ producto_id: lona.id, pregunta: "¿Destiñe al lavarla?" })),
        say("No lo tengo confirmado. Le pregunto a la tienda y te escribo."),
      )
      expect((await answer(deps, storeId, conv!.id)).status).toBe("respondio")
      chats.push(conv!.id)
    }
    const home = await call("lucia", "GET", `${base}/inicio`)
    const lines = home.json.toDo.filter((t: Json) => t.kind === "pregunta")
    expect(lines).toEqual([
      expect.objectContaining({
        question: "¿Destiñe al lavarla?",
        product: "Zapatilla de lona",
        people: 2,
        customer: "Carla",
        proposed: null,
      }),
    ])
    // Sofi no responde por la tienda: la base no se lo deja.
    const changed = await withAgent(db.appDb, "agente:sofi", storeId, (tx) =>
      tx
        .update(productQuestion)
        .set({ answer: "No destiñe", answeredBy: "agente:sofi", answeredAt: new Date() })
        .where(eq(productQuestion.productId, lona.id))
        .returning({ id: productQuestion.id }),
    ).catch(() => [])
    expect(changed).toEqual([])
    // Ventas responde las dos de una vez y propone guardarla; el Dueño la guarda.
    const answered = await call("lucia", "POST", `${base}/preguntas/respuesta`, {
      ids: lines[0].ids,
      answer: "No destiñe. Lávala a mano con agua fría.",
      save: true,
      tell: false,
    })
    expect(answered.status).toBe(200)
    const proposed = (await call("rosa", "GET", `${base}/inicio`)).json.toDo.filter(
      (t: Json) => t.kind === "pregunta",
    )
    expect(proposed).toEqual([
      expect.objectContaining({
        proposed: expect.objectContaining({ answer: "No destiñe. Lávala a mano con agua fría." }),
      }),
    ])
    expect(
      (await call("lucia", "GET", `${base}/inicio`)).json.toDo.filter(
        (t: Json) => t.kind === "pregunta",
      ),
    ).toEqual([])
    const saved = await call(
      "rosa",
      "POST",
      `${base}/preguntas/${proposed[0].proposed.id}/guardar`,
      {},
    )
    expect(saved.status).toBe(200)
    expect(
      saved.json.product.questions.filter((q: Json) => q.savedAt).map((q: Json) => q.answer),
    ).toContain("No destiñe. Lávala a mano con agua fría.")
    // «Que Sofi se lo diga»: le escribe a cada una por la misma tubería, con la revisión de siempre.
    steps.push((r) => {
      const last = r.messages.at(-1)!
      expect(last.role).toBe("system")
      expect((last as { content: string }).content).toContain("AVISO DE LA TIENDA")
      return { content: "Te cuento: no destiñe. Lávala a mano con agua fría." }
    }, say("Te cuento: no destiñe. Lávala a mano con agua fría."))
    const told = await tellAnswer(
      deps,
      storeId,
      chats.map((conversationId) => ({ conversationId, question: "¿Destiñe al lavarla?" })),
      "No destiñe. Lávala a mano con agua fría.",
    )
    expect(told.told).toBe(2)
    expect(steps).toHaveLength(0)
    // La próxima vez, Sofi la lee de la ficha.
    const id = await newTest()
    await write(
      id,
      "¿Destiñe?",
      use("buscar_productos", () => ({ texto: "zapatilla de lona" })),
      (r) => {
        expect(lonaIn(r).preguntas_respondidas).toContainEqual({
          pregunta: "¿Destiñe al lavarla?",
          respuesta: "No destiñe. Lávala a mano con agua fría.",
        })
        return { content: "No destiñe. Lávala a mano con agua fría." }
      },
    )
  })

  it("«Probar como clienta»: el mismo carrito, el pago de prueba (no cobra) y Sofi escribe una vez después", async () => {
    const id = await newTest()
    const args = { lineas: [{ variante_id: lona.negra38, cantidad: 1 }], entrega_id: ids.reparto }
    // Llega desde el producto, con su carrito de la vitrina: Sofi lo lee como dato.
    steps.push(
      (r) => {
        const facts = (r.messages[1] as { content: string }).content
        expect(facts).toContain("LLEGÓ DESDE EL LINK DE: «Zapatilla de lona»")
        expect(facts).toContain("1 × Zapatilla de lona negra 38")
        return { toolCalls: [toolCall("cotizar", args)] }
      },
      (r) => ({ content: `Te queda en ${lastTool(r).total}. ¿Lo confirmo?` }),
    )
    const first = await call("rosa", "POST", `${base}/conversaciones/${id}/cliente`, {
      text: "Quiero pagar lo de mi carrito",
      desde: lona.id,
      carrito: [{ variantId: lona.negra38, quantity: 1 }],
    })
    expect(first.status).toBe(200)
    await write(
      id,
      "Sí, confirmo",
      use("armar_pedido", () => ({ ...args, nombre: "Carla" })),
      (r) => {
        expect(lastTool(r).ok).toBe(true)
        return { content: `¡Listo! Tu pedido quedó anotado: ${lastTool(r).total}.` }
      },
    )
    const cart = await call("rosa", "GET", `${base}/conversaciones/${id}/carrito`)
    expect(cart.json.cart).toMatchObject({ state: "por_pagar", bySofi: true, paid: false })
    // Con un pedido por pagar, la vitrina no arma otro: se paga ese.
    const again = await call("rosa", "POST", `${base}/conversaciones/${id}/carrito`, {
      lines: [{ variantId: lona.negra38, quantity: 1 }],
      deliveryMethodId: ids.reparto,
    })
    expect(again.status).toBe(409)
    // Ventas no prueba; el pago simulado es de quien prueba.
    expect(
      (
        await call("lucia", "POST", `${base}/conversaciones/${id}/pagar`, {
          orderId: cart.json.cart.id,
          method: "Yape",
        })
      ).status,
    ).toBe(403)
    const before = (await call("rosa", "GET", `${base}/variantes/${lona.negra38}/kardex`)).json
      .stock
    steps.push((r) => {
      const last = r.messages.at(-1) as { role: string; content: string }
      expect(last.role).toBe("system")
      expect(last.content).toContain("acaba de pagar")
      return { content: "¡Pago recibido! Te aviso por aquí cuando salga." }
    })
    const paid = await call("rosa", "POST", `${base}/conversaciones/${id}/pagar`, {
      orderId: cart.json.cart.id,
      method: "Yape",
    })
    expect(paid.status).toBe(200)
    expect(steps).toHaveLength(0)
    expect(paid.json.cart).toMatchObject({ paid: true, state: "por_salir" })
    expect(lastSofi(paid.json).notice).toBe(true)
    expect(lastSofi(paid.json).text).toContain("Pago recibido")
    // No mueve el stock ni cuenta en Reportes.
    expect((await call("rosa", "GET", `${base}/variantes/${lona.negra38}/kardex`)).json.stock).toBe(
      before,
    )
    const [order] = await db.ownerDb
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.id, cart.json.cart.id))
    expect(order).toMatchObject({ test: true, state: "por_salir" })
    // Después del pago, la vitrina arma otro pedido de prueba con lo que eligió ahí.
    const placed = await call("rosa", "POST", `${base}/conversaciones/${id}/carrito`, {
      lines: [{ variantId: lona.negra38, quantity: 1 }],
      deliveryMethodId: ids.reparto,
    })
    expect(placed.status).toBe(201)
    expect(placed.json.cart).toMatchObject({ state: "por_pagar", bySofi: false })
  })

  it("en una conversación de verdad no se paga de prueba", async () => {
    const [conv] = await db.ownerDb
      .insert(conversation)
      .values({ storeId, channel: "whatsapp", createdBy: "u-rosa" })
      .returning({ id: conversation.id })
    const response = await call("rosa", "GET", `${base}/conversaciones/${conv!.id}/carrito`)
    expect(response.status).toBe(409)
  })

  it("la vitrina pública da solo lo vendible, y solo si se ve en la web", async () => {
    // Una pregunta que la tienda todavía no respondió no se muestra.
    await db.ownerDb.insert(productQuestion).values({
      storeId,
      productId: lona.id,
      question: "¿Viene en caja de regalo?",
      askedBy: "u-rosa",
    })
    const response = await app.request(`${SERVER}/vitrina/calzadosrosa/zapatilla-de-lona`)
    expect(response.status).toBe(200)
    const text = await response.text()
    const page = JSON.parse(text) as Json
    expect(page.product).toMatchObject({ name: "Zapatilla de lona", visible: true })
    expect(page.product.colors).toEqual([
      { value: "blanca", hex: "#ffffff", hex2: null },
      { value: "negra", hex: "#1f1f1f", hex2: null },
    ])
    const negra38 = (page.product.variants as Json[]).find((v) => v.id === lona.negra38)
    // Quedan pocas: se dice cuántas; nunca el stock de las demás ni el mínimo.
    expect(negra38).toMatchObject({ color: "negra", size: "38", available: true })
    expect(page.product.answers).toContainEqual(
      expect.objectContaining({ question: "¿Se puede lavar en lavadora?" }),
    )
    for (const secret of [
      "minPriceCents",
      "offerGift",
      "Medias tobilleras",
      "lastCostCents",
      'stock"',
      "¿Viene en caja de regalo?",
      "barcode",
      "u-rosa",
    ])
      expect(text, secret).not.toContain(secret)
    await call("rosa", "PATCH", `${base}/productos/${lona.id}`, {
      web: { visible: false, slug: "zapatilla-de-lona" },
    })
    expect((await app.request(`${SERVER}/vitrina/calzadosrosa/zapatilla-de-lona`)).status).toBe(404)
    // La vista previa de la ficha la ve el equipo, también Ventas, aunque no esté en la web.
    const preview = await call("lucia", "GET", `${base}/productos/${lona.id}/vitrina`)
    expect(preview.status).toBe(200)
    expect(preview.json.product.visible).toBe(false)
    expect(JSON.stringify(preview.json)).not.toContain("minPriceCents")
  })
})
