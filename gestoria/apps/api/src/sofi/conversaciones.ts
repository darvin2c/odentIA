import {
  conversation,
  conversationMessage,
  customerConsent,
  type Db,
  product,
  productVideo,
  saleOrder,
  saleOrderLine,
  storeAgent,
  storeEvent,
  storePaymentMethod,
} from "@gestoria/db"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { agentStopIn } from "../acuerdo.js"
import { agentName, SOFI_ACTOR } from "../agente.js"
import type { Storage } from "../archivos.js"
import { COLLECTION_RANK } from "../configuracion.js"
import type { Person } from "../cuenta.js"
import { formatMoney } from "../dinero.js"
import { momentWords, storeClockIn } from "../hora.js"
import { APP_LINK_SECONDS, sofiMediaIn } from "../medios.js"
import { createOrderIn, orderInput, pad, payTestOrderIn } from "../pedidos.js"
import { can, type StoreSeat } from "../permisos.js"
import { balancesIn, unpaidBalance } from "../saldo.js"
import { inStore, StoreError } from "../tiendas.js"
import type { SentMedia } from "./herramientas.js"
import { type AnswerResult, answer, type SofiDeps } from "./sofi.js"

/**
 * Lo que el equipo ve y pone de Sofi (paso B5, tablero 8): lo que el dueño deja escrito y la
 * conversación de prueba. Mientras no hay canal (B2), «Probar a Sofi» es la única forma de verla
 * vender: quien prueba escribe como cliente y Sofi responde con la tienda de verdad. Sus pedidos
 * son de prueba (no mueven stock, no crean un link real y no cuentan en Reportes).
 */

export const agentSettingsInput = z.object({
  enabled: z.boolean(),
  displayName: z
    .string()
    .trim()
    .max(60, "Máximo 60 caracteres")
    .default("")
    .transform((value) => value || null),
  knowledge: z.string().trim().max(2000, "Máximo 2000 caracteres").default(""),
  followPayment: z.boolean(),
  followThanks: z.boolean(),
  followRestock: z.boolean(),
  followReturn: z.boolean(),
})

/** Una línea del carrito de la vitrina: la variante y cuántas. */
const cartLine = z.object({ variantId: z.uuid(), quantity: z.int().min(1).max(20) })

export const customerMessageInput = z.object({
  text: z.string().trim().min(1, "Escribe el mensaje").max(1000, "Máximo 1000 caracteres"),
  /** El producto desde el que escribe («Probar como clienta» de la ficha, o su link). */
  desde: z.uuid().optional(),
  /** Lo que tiene en el carrito de la vitrina, que es el mismo del chat. */
  carrito: z.array(cartLine).max(10).optional(),
})

const DEFAULTS = {
  enabled: false,
  displayName: null,
  knowledge: "",
  followPayment: true,
  followThanks: true,
  followRestock: true,
  followReturn: true,
}

/**
 * Lo que Sofi tiene puesto, si hay modelo para que responda, si la administración la detuvo y
 * las pruebas. Es la parte «Sofi» de Configuración: la lee quien la cambia (`configuracion`), no
 * Ventas ni soporte (`gestoria/AGENTS.md`: soporte mira Configuración sin Sofi).
 */
export async function agentSettings(
  appDb: Db,
  person: Person,
  storeId: string,
  modelReady: boolean,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx.select().from(storeAgent).where(eq(storeAgent.storeId, storeId))
    const settings = row
      ? {
          enabled: row.enabled,
          displayName: row.displayName,
          knowledge: row.knowledge,
          followPayment: row.followPayment,
          followThanks: row.followThanks,
          followRestock: row.followRestock,
          followReturn: row.followReturn,
        }
      : DEFAULTS
    const tests = await tx
      .select({
        id: conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        customerName: conversation.customerName,
      })
      .from(conversation)
      .where(and(eq(conversation.storeId, storeId), eq(conversation.channel, "prueba")))
      .orderBy(desc(conversation.updatedAt))
      .limit(10)
    // Si la administración detuvo a Sofi (la cuenta no puede seguir o llegó a su tope).
    return { settings, modelReady, tests, agentStop: await agentStopIn(tx, storeId) }
  })
}

export async function saveAgentSettings(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof agentSettingsInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [before] = await tx.select().from(storeAgent).where(eq(storeAgent.storeId, storeId))
    const values = { ...input, updatedBy: person.userId, updatedAt: new Date() }
    await tx
      .insert(storeAgent)
      .values({ storeId, ...values })
      .onConflictDoUpdate({ target: storeAgent.storeId, set: values })
    if ((before?.enabled ?? false) !== input.enabled)
      await tx.insert(storeEvent).values({
        storeId,
        actorUserId: person.userId,
        action: "configuracion.sofi",
        subject: "Sofi",
        detail: { encendida: input.enabled },
      })
    return input
  })
}

/**
 * «Probar a Sofi» está en Configuración: sirve al ajustarla, no a diario. Por eso la abre y la
 * escribe quien cambia la configuración (lienzo «gestorIA como odentIA», tablero 10).
 */
export async function newTestConversation(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .insert(conversation)
      .values({ storeId, channel: "prueba", createdBy: person.userId })
      .returning({ id: conversation.id })
    return { id: row!.id }
  })
}

const TOOL_WORDS: Record<string, string> = {
  buscar_productos: "Buscó en el catálogo",
  cotizar: "Calculó el total",
  armar_pedido: "Anotó el pedido",
  link_de_pago: "Pidió el link de pago",
  anotar_pago: "Anotó la captura",
  ver_pedidos: "Miró los pedidos",
  avisar_cuando_vuelva: "Quedó en avisar cuando vuelva",
  pasar_a_persona: "La pasó a una persona",
  mandar_foto: "Mandó una foto o el video",
  anotar_pregunta: "Le preguntó a la tienda",
  anotar_permiso: "Anotó si quiere promociones",
  anotar_baja: "Anotó la baja de promociones",
}

/**
 * Lo que hizo Sofi para responder, en palabras del equipo (la marca «Agente» del tablero 8). Lo
 * que costó el modelo es una cifra de Reportes: va solo a quien los ve (`reportes.ver`).
 */
function basisOf(detail: Record<string, unknown>, seesCost: boolean) {
  const tools = Array.isArray(detail.tools)
    ? (detail.tools as { name: string; ok: boolean }[]).map(
        (t) => `${TOOL_WORDS[t.name] ?? t.name}${t.ok ? "" : " (no se pudo)"}`,
      )
    : []
  return {
    tools,
    stopped: Array.isArray(detail.frenado) ? (detail.frenado as string[][]).flat() : [],
    handoff: typeof detail.paso === "string" ? detail.paso : null,
    ...(seesCost ? { costMicros: typeof detail.costo === "number" ? detail.costo : null } : {}),
  }
}

/** Las fotos y videos de una respuesta de Sofi, con lo que la pantalla necesita para mostrarlos. */
async function mediaOf(
  tx: Db,
  storage: Storage | null | undefined,
  detail: Record<string, unknown>,
) {
  const sent = Array.isArray(detail.medios) ? (detail.medios as SentMedia[]) : []
  if (sent.length === 0) return []
  const videos = sent.some((m) => m.kind === "video")
    ? await tx
        .select({ id: productVideo.id, objectKey: productVideo.objectKey })
        .from(productVideo)
        .where(
          inArray(
            productVideo.id,
            sent.filter((m) => m.kind === "video").map((m) => m.id),
          ),
        )
    : []
  return Promise.all(
    sent.map(async (m) => {
      const video = videos.find((v) => v.id === m.id)
      return {
        kind: m.kind,
        id: m.id,
        product: m.product,
        color: m.color,
        label: m.label,
        // La foto se ve con `/fotos/:id`; el video, con su enlace firmado (vence como los de la app).
        urls:
          video && storage
            ? {
                video: await storage.signedUrl(`${video.objectKey}/video`, APP_LINK_SECONDS),
                poster: await storage.signedUrl(`${video.objectKey}/poster`, APP_LINK_SECONDS),
              }
            : null,
      }
    }),
  )
}

/** Lo que se ve del uso de Sofi en una respuesta: lo que usó de la ficha y lo que no supo. */
function usageOf(detail: Record<string, unknown>) {
  const used = Array.isArray(detail.usados)
    ? (detail.usados as { label: string; target: string }[])
    : []
  const missed = Array.isArray(detail.no_supo)
    ? (detail.no_supo as { productId: string; question: string }[])
    : []
  return { used, missed }
}

/**
 * Una conversación como la ve quien tiene `role`. La de «Probar a Sofi» es de Configuración: solo
 * la abre quien la cambia, aunque atender (`ventas.atender`) abra las de verdad. Lo que costó el
 * modelo, solo con `reportes.ver`.
 */
async function viewIn(
  tx: Db,
  storeId: string,
  conversationId: string,
  role: StoreSeat,
  storage?: Storage | null,
) {
  if (!z.uuid().safeParse(conversationId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.storeId, storeId)))
  if (!conv) throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
  if (conv.channel === "prueba" && !can(role, "configuracion"))
    throw new StoreError(403, "FORBIDDEN", "Tu rol en esta tienda no permite hacerlo")
  const seesCost = can(role, "reportes.ver")
  const messages = await tx
    .select()
    .from(conversationMessage)
    .where(eq(conversationMessage.conversationId, conversationId))
    .orderBy(asc(conversationMessage.seq))
  const orders = await tx
    .select({
      id: saleOrder.id,
      number: saleOrder.number,
      state: saleOrder.state,
      paymentCollection: saleOrder.paymentCollection,
      totalCents: saleOrder.totalCents,
      test: saleOrder.test,
    })
    .from(saleOrder)
    .where(and(eq(saleOrder.storeId, storeId), eq(saleOrder.conversationId, conversationId)))
    .orderBy(asc(saleOrder.number))
  const balances = await balancesIn(
    tx,
    orders.map((o) => o.id),
  )
  // Lo que anotó Sofi del permiso para escribirle, junto al mensaje de ella que lo causó.
  const consents = await tx
    .select({
      id: customerConsent.id,
      state: customerConsent.state,
      createdAt: customerConsent.createdAt,
      messageId: customerConsent.messageId,
    })
    .from(customerConsent)
    .where(
      and(eq(customerConsent.storeId, storeId), eq(customerConsent.conversationId, conversationId)),
    )
    .orderBy(asc(customerConsent.createdAt))
  const cost = messages.reduce(
    (sum, m) => sum + (typeof m.detail.costo === "number" ? m.detail.costo : 0),
    0,
  )
  return {
    id: conv.id,
    channel: conv.channel,
    customerName: conv.customerName,
    handler: conv.handler,
    waitingReason: conv.waitingReason,
    ...(seesCost ? { costMicros: cost } : {}),
    messages: await Promise.all(
      messages.map(async (m) => ({
        id: m.id,
        author: m.author,
        text: m.text,
        createdAt: m.createdAt,
        delivery: m.delivery,
        needsTemplate: m.needsTemplate,
        followUp: m.followUp,
        byArgos: agentName(m.actorUserId) === "Argos",
        ...(m.author === "sofi"
          ? {
              basis: basisOf(m.detail, seesCost),
              media: await mediaOf(tx, storage, m.detail),
              /** Los pedidos que anotó con esta respuesta: van como tarjeta («Ver y pagar»). */
              orders: Array.isArray(m.detail.pedidos) ? (m.detail.pedidos as string[]) : [],
              ...usageOf(m.detail),
              notice: m.detail.aviso === true,
            }
          : {}),
        ...(m.author === "cliente" && Array.isArray(m.detail.carrito) ? { fromCart: true } : {}),
      })),
    ),
    orders: orders.map((o) => ({
      ...o,
      number: pad(o.number),
      balance: balances.get(o.id) ?? unpaidBalance(o.totalCents),
    })),
    consentNotes: consents.map((c) => ({
      id: c.id,
      state: c.state,
      createdAt: c.createdAt.toISOString(),
      messageId: c.messageId,
    })),
  }
}

export async function conversationView(
  appDb: Db,
  person: Person,
  storeId: string,
  conversationId: string,
  storage?: Storage | null,
) {
  return inStore(appDb, person, storeId, "ventas.atender", (tx, role) =>
    viewIn(tx, storeId, conversationId, role, storage),
  )
}

/**
 * Quien prueba escribe como cliente y Sofi responde. Solo en una conversación de prueba: en una
 * de verdad, lo del cliente llega por su canal.
 */
export async function writeAsCustomer(
  sofi: SofiDeps,
  person: Person,
  storeId: string,
  conversationId: string,
  input: z.infer<typeof customerMessageInput>,
): Promise<{ conversation: Awaited<ReturnType<typeof viewIn>>; result: AnswerResult }> {
  await inStore(sofi.appDb, person, storeId, "configuracion", async (tx) => {
    if (!z.uuid().safeParse(conversationId).success)
      throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
    const [conv] = await tx
      .select({ channel: conversation.channel })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.storeId, storeId)))
      .for("update")
    if (!conv) throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
    if (conv.channel !== "prueba")
      throw new StoreError(409, "NOT_A_TEST", "Solo se escribe como cliente en una prueba")
    await tx.insert(conversationMessage).values({
      storeId,
      conversationId,
      author: "cliente",
      text: input.text,
      actorUserId: person.userId,
      // Desde qué producto escribe y su carrito de la vitrina: datos que Sofi lee, nunca órdenes.
      detail: {
        ...(input.desde ? { desde: input.desde } : {}),
        ...(input.carrito?.length ? { carrito: input.carrito } : {}),
      },
    })
    await tx
      .update(conversation)
      .set({ lastCustomerAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(conversation.id, conversationId))
  })
  const result = await answer(sofi, storeId, conversationId)
  return {
    conversation: await conversationView(sofi.appDb, person, storeId, conversationId, sofi.storage),
    result,
  }
}

/** «Devolver a Sofi»: la conversación que esperaba a una persona vuelve a ella. */
export async function returnToSofi(
  appDb: Db,
  person: Person,
  storeId: string,
  conversationId: string,
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx, role) => {
    const view = await viewIn(tx, storeId, conversationId, role)
    await tx
      .update(conversation)
      .set({ handler: "sofi", waitingReason: null, updatedAt: new Date() })
      .where(eq(conversation.id, conversationId))
    return { ...view, handler: "sofi" as const, waitingReason: null }
  })
}

/* ------------------------------------------------- «Probar como clienta»: el carrito y el pago */

/** La conversación de prueba de esta tienda, con el candado puesto; si no es de prueba, no sigue. */
async function testConversationIn(tx: Db, storeId: string, conversationId: string) {
  if (!z.uuid().safeParse(conversationId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
  const [conv] = await tx
    .select({ id: conversation.id, channel: conversation.channel })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.storeId, storeId)))
    .for("update")
  if (!conv) throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
  if (conv.channel !== "prueba")
    throw new StoreError(409, "NOT_A_TEST", "Esto es solo de una conversación de prueba")
  return conv
}

/**
 * El carrito de la prueba, el mismo para el chat y la vitrina: el último pedido de la
 * conversación (el que anotó Sofi con lo acordado, o el de la vitrina), con sus líneas, lo
 * acordado y su plazo. Sin pedido, null: la vitrina usa lo que la clienta eligió ahí.
 */
async function cartIn(tx: Db, storeId: string, conversationId: string) {
  const [order] = await tx
    .select()
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        eq(saleOrder.conversationId, conversationId),
        sql`${saleOrder.state} <> 'anulado'`,
      ),
    )
    .orderBy(desc(saleOrder.number))
    .limit(1)
  if (!order) return null
  const lines = await tx
    .select({
      productId: saleOrderLine.productId,
      variantId: saleOrderLine.variantId,
      productName: saleOrderLine.productName,
      variantName: saleOrderLine.variantName,
      quantity: saleOrderLine.quantity,
      unitCents: saleOrderLine.unitCents,
      autoUnitCents: saleOrderLine.autoUnitCents,
      gift: saleOrderLine.gift,
    })
    .from(saleOrderLine)
    .where(eq(saleOrderLine.orderId, order.id))
    .orderBy(asc(saleOrderLine.position))
  const colorOf = async (productId: string, variantName: string) => {
    const [row] = await tx
      .select({ options: product.options, colorOption: product.colorOption })
      .from(product)
      .where(eq(product.id, productId))
    if (!row || row.colorOption === null) return null
    const values = row.options[row.colorOption]?.values ?? []
    return variantName.split(" · ").find((v) => values.includes(v)) ?? null
  }
  const { timeZone } = await storeClockIn(tx, storeId)
  const balance =
    (await balancesIn(tx, [order.id])).get(order.id) ?? unpaidBalance(order.totalCents)
  const now = new Date()
  const expires = order.priceExpiresAt
  return {
    id: order.id,
    number: pad(order.number),
    state: order.state,
    bySofi: order.createdBy === SOFI_ACTOR,
    paid: balance.paid,
    lines: await Promise.all(
      lines.map(async (line) => ({
        ...line,
        // La foto del color de esa línea, con la misma regla de Sofi.
        photoId:
          (
            await sofiMediaIn(
              tx,
              null,
              storeId,
              line.productId,
              await colorOf(line.productId, line.variantName),
            )
          ).photo?.id ?? null,
      })),
    ),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    deliveryName: order.deliveryName,
    deliveryCents: order.deliveryCents,
    deliveryListCents: order.deliveryListCents,
    totalCents: order.totalCents,
    /** Lo acordado con Sofi (lo que cedió) y hasta cuándo vale; null si va a su precio. */
    deal:
      order.marginUsedCents > 0 && expires
        ? {
            expiresAt: expires,
            expired: expires.getTime() <= now.getTime(),
            until: momentWords(timeZone, expires, now),
            freeDelivery: order.deliveryCents === 0 && order.deliveryListCents > 0,
            discountCents: order.discountCents,
          }
        : null,
    paymentName: order.paymentName,
  }
}

export async function testCart(appDb: Db, person: Person, storeId: string, conversationId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await testConversationIn(tx, storeId, conversationId)
    return { cart: await cartIn(tx, storeId, conversationId) }
  })
}

export const testOrderInput = z.object({
  lines: z.array(cartLine).min(1, "El carrito está vacío").max(10),
  deliveryMethodId: z.uuid("Elige cómo te llega"),
  zone: z.string().trim().max(60).nullish(),
})

/**
 * «Pagar ahora» desde la vitrina de la prueba, con lo que la clienta eligió ahí: el pedido se anota
 * con la misma operación de siempre (`createOrderIn`), de prueba y en la misma conversación. Si
 * Sofi ya anotó uno sin pagar, se paga ese: lo acordado no se rehace.
 */
export async function placeTestOrder(
  appDb: Db,
  person: Person,
  storeId: string,
  conversationId: string,
  input: z.infer<typeof testOrderInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await testConversationIn(tx, storeId, conversationId)
    const open = await cartIn(tx, storeId, conversationId)
    if (open && open.state === "por_pagar")
      throw new StoreError(
        409,
        "ORDER_OPEN",
        "Ya hay un pedido por pagar en esta conversación: págalo, o pídele a Sofi que lo cambie.",
      )
    const methods = (
      await tx
        .select()
        .from(storePaymentMethod)
        .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.isActive, true)))
    )
      // «Pagar ahora» es pagar ya: no el pago al recibir.
      .filter((m) => m.collection !== "al_recibir")
      .sort((a, b) => COLLECTION_RANK[a.collection] - COLLECTION_RANK[b.collection])
    if (!methods[0])
      throw new StoreError(
        409,
        "NO_PAYMENT",
        "La tienda no tiene un medio para pagar ya (link o captura): solo se paga al recibir",
      )
    const parsed = orderInput.safeParse({
      customerName: "Clienta de prueba",
      customerPhone: "",
      channel: "otro",
      address: "",
      notes: "Desde la vitrina, en «Probar como clienta»",
      lines: input.lines.map((l) => ({
        variantId: l.variantId,
        quantity: l.quantity,
        unitCents: null,
        gift: false,
      })),
      deliveryMethodId: input.deliveryMethodId,
      zone: input.zone ?? null,
      deliveryListCents: null,
      deliveryCents: null,
      paymentMethodId: methods[0].id,
    })
    if (!parsed.success)
      throw new StoreError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "No vale")
    const { today } = await storeClockIn(tx, storeId)
    await createOrderIn(tx, storeId, person.userId, parsed.data, {
      conversationId,
      today,
      test: true,
    })
    return { cart: await cartIn(tx, storeId, conversationId) }
  })
}

export const testPayInput = z.object({
  orderId: z.uuid(),
  /** Con qué paga en la vitrina de la prueba: solo cambia lo que se anota. */
  method: z.enum(["Yape", "Tarjeta"]),
})

/**
 * «Pagar ahora» de la prueba: el pago se simula (no se cobra), el pedido queda pagado y Sofi le
 * escribe una vez a la clienta, por la misma tubería de siempre: confirma y, si algo combina con
 * lo que compró, se lo ofrece como un pedido aparte (el pagado no se cambia, ADR 0226).
 */
export async function payTestOrder(
  sofi: SofiDeps,
  person: Person,
  storeId: string,
  conversationId: string,
  input: z.infer<typeof testPayInput>,
) {
  const paid = await inStore(sofi.appDb, person, storeId, "configuracion", async (tx) => {
    await testConversationIn(tx, storeId, conversationId)
    const [order] = await tx
      .select({
        id: saleOrder.id,
        currency: sql<string>`(select currency from store where id = ${storeId})`,
      })
      .from(saleOrder)
      .where(
        and(
          eq(saleOrder.id, input.orderId),
          eq(saleOrder.storeId, storeId),
          eq(saleOrder.conversationId, conversationId),
        ),
      )
    if (!order) throw new StoreError(404, "NOT_FOUND", "Ese pedido no es de esta conversación")
    const done = await payTestOrderIn(tx, storeId, person.userId, order.id, input.method)
    const lines = await tx
      .select({
        name: saleOrderLine.productName,
        variant: saleOrderLine.variantName,
        quantity: saleOrderLine.quantity,
      })
      .from(saleOrderLine)
      .where(eq(saleOrderLine.orderId, order.id))
    return { ...done, currency: order.currency, lines }
  })
  const bought = paid.lines
    .map((l) => `${l.quantity} × ${l.name}${l.variant === "Única" ? "" : ` ${l.variant}`}`)
    .join(", ")
  const result = await answer(sofi, storeId, conversationId, {
    text: `La clienta acaba de pagar el pedido ${paid.number} (${formatMoney(paid.totalCents, paid.currency)}) con ${input.method}: ${bought}. Confírmale en una frase que el pago llegó y que le avisas cuando salga, sin prometer un día que no sabes. Si lo que compró tiene «combina» en buscar_productos, ofrécele una sola vez ese producto como un pedido aparte, a su precio o con tu oferta del margen y su plazo; no cambies el pedido pagado ni digas que va en el mismo envío.`,
  })
  return {
    conversation: await conversationView(sofi.appDb, person, storeId, conversationId, sofi.storage),
    result,
    cart: await testCart(sofi.appDb, person, storeId, conversationId).then((r) => r.cart),
  }
}

/**
 * Lo que Sofi no supo, ya respondido: con «Que Sofi se lo diga», Sofi le escribe a cada clienta
 * que preguntó, por la misma tubería (con su revisión antes de salir). Si una persona atiende ese
 * chat, Sofi no escribe: se lo dice la persona.
 */
export async function tellAnswer(
  sofi: SofiDeps,
  storeId: string,
  told: { conversationId: string; product: string }[],
  answerText: string,
): Promise<{ told: number }> {
  let count = 0
  // La pregunta la escribió la clienta: no va en el aviso (es de sistema). Va el producto, que es
  // de la tienda, y la respuesta, que es lo único cuyos importes se pueden repetir.
  for (const { conversationId, product: name } of told) {
    const result = await answer(sofi, storeId, conversationId, {
      text: `La tienda respondió lo que preguntó la clienta de «${name}»: «${answerText}». Díselo con tus palabras, sin agregar nada que no diga la respuesta, y sigue con la venta.`,
    })
    if (result.status === "respondio") count += 1
  }
  return { told: count }
}
