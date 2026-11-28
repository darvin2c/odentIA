import {
  conversation,
  conversationMessage,
  customerConsent,
  type Db,
  type PaymentKind,
  product,
  productVideo,
  saleOrder,
  saleOrderLine,
  storeAgent,
  storeDeliveryMethod,
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
import { createOrderIn, orderInput, pad, payTestOrderIn, quoteOrderIn } from "../pedidos.js"
import { can, type StoreSeat } from "../permisos.js"
import { balancesIn, unpaidBalance } from "../saldo.js"
import { inStore, StoreError } from "../tiendas.js"
import type { SentMedia, Withheld } from "./herramientas.js"
import {
  choicesInput,
  choicesOf,
  closingOf,
  DEFAULT_CHOICES,
  hoursWords,
  hourWords,
  OFFER_NAMES,
  type OfferKind,
  teamNow,
} from "./opciones.js"
import { type AnswerResult, answer, handoffLater, type SofiDeps } from "./sofi.js"

/**
 * Lo que el equipo ve y pone de Sofi (paso B5, tablero 8): lo que el dueño deja escrito y la
 * conversación de prueba. Mientras no hay canal (B2), «Probar a Sofi» es la única forma de verla
 * vender: quien prueba escribe como cliente y Sofi responde con la tienda de verdad. Sus pedidos
 * son de prueba (no mueven stock, no crean un link real y no cuentan en Reportes).
 */

/**
 * Lo que la tienda pone de Sofi: todo se elige (ADR 0234). Lo único escrito es cómo se presenta,
 * que va entre «» como su nombre; «Lo que sabe» va aparte (`saber.ts`).
 *
 * Cada cambio manda solo lo que cambió y la versión que vio (`version`, la hora del último
 * cambio): sobre una versión vieja se rechaza, para que una pestaña abierta hace rato no pise lo
 * que otra persona cambió. Encender o pausar no va aquí: es su propia operación (`agentStateInput`),
 * y guardar opciones nunca la toca.
 */
const optionsInput = choicesInput.extend({
  displayName: z
    .string()
    .trim()
    .max(60, "Máximo 60 caracteres")
    .transform((value) => value || null),
  followPayment: z.boolean(),
  followThanks: z.boolean(),
  followRestock: z.boolean(),
  followReturn: z.boolean(),
})

export const agentSettingsInput = optionsInput
  .partial()
  .extend({ version: z.iso.datetime({ offset: true }).nullable() })

export const agentStateInput = z.object({ enabled: z.boolean() })

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
  ...DEFAULT_CHOICES,
  enabled: false,
  displayName: null,
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
          ...choicesOf(row),
          enabled: row.enabled,
          displayName: row.displayName,
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
    // El horario y el aviso fuera de él, en las mismas palabras que usa Sofi.
    const hours = settings.teamHours
    const { timeZone, today } = await storeClockIn(tx, storeId)
    const words = hours
      ? {
          hours: hoursWords(hours),
          // Lo que diría al cerrar hoy: el próximo día que atiende, como lo calcula Sofi.
          afterHours: handoffLater(
            teamNow(hours, timeZone, closingOf(hours, timeZone, today)).back ??
              `desde las ${hourWords(hours.from)}`,
          ),
        }
      : null
    return {
      settings,
      version: versionOf(row),
      words,
      modelReady,
      tests,
      agentStop: await agentStopIn(tx, storeId),
    }
  })
}

/** La versión de lo elegido: la hora del último cambio de opciones; null si nunca se eligió. */
/**
 * La versión de lo elegido: la hora del último cambio de opciones; null si nunca se eligió. Una fila
 * que nació sin elegir nada (al encender, o para tomar el candado) lleva la hora cero.
 */
const NEVER = new Date(0)
const versionOf = (row: { updatedAt: Date } | undefined) =>
  row && row.updatedAt.getTime() !== NEVER.getTime() ? row.updatedAt.toISOString() : null

const STALE = () =>
  new StoreError(
    409,
    "STALE",
    "Alguien cambió a Sofi mientras tenías esto abierto. Ciérralo y vuelve a abrirlo para ver lo nuevo antes de guardar.",
  )

/**
 * La fila de Sofi de la tienda, con candado. Si no existe, nace con lo de siempre y sin versión:
 * así también el primer guardado (y el primer «Encender») espera al otro y no lo pisa.
 */
async function lockedAgent(tx: Db, storeId: string, person: Person) {
  await tx
    .insert(storeAgent)
    .values({ storeId, updatedBy: person.userId, updatedAt: NEVER })
    .onConflictDoNothing({ target: storeAgent.storeId })
  const [row] = await tx
    .select()
    .from(storeAgent)
    .where(eq(storeAgent.storeId, storeId))
    .for("update")
  return row!
}

/**
 * Guarda solo lo que cambió, si la versión que vio quien guarda es la de ahora. La fila se lee con
 * candado: dos guardados a la vez no se pisan, el segundo ve la versión nueva y se rechaza.
 */
export async function saveAgentSettings(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof agentSettingsInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const { version, ...change } = input
    const before = await lockedAgent(tx, storeId, person)
    if (versionOf(before) !== version) throw STALE()
    const [row] = await tx
      .update(storeAgent)
      .set({ ...change, updatedBy: person.userId, updatedAt: new Date() })
      .where(eq(storeAgent.storeId, storeId))
      .returning()
    return { version: versionOf(row) }
  })
}

/**
 * Encender o pausar a Sofi: su propia operación, que no toca lo elegido ni su versión (una
 * pestaña con las opciones abiertas puede guardar después). Queda en el registro de la tienda.
 */
export async function setAgentEnabled(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof agentStateInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const before = await lockedAgent(tx, storeId, person)
    if (before.enabled === input.enabled) return input
    await tx
      .update(storeAgent)
      .set({ enabled: input.enabled })
      .where(eq(storeAgent.storeId, storeId))
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
  ver_envio: "Miró el envío al distrito",
  ver_pedidos: "Miró los pedidos",
  avisar_cuando_vuelva: "Quedó en avisar cuando vuelva",
  pasar_a_persona: "La pasó a una persona",
  mandar_foto: "Mandó una foto o el video",
  anotar_pregunta: "Le preguntó a la tienda",
  leer_lo_que_sabe: "Leyó «Lo que sabe»",
  anotar_permiso: "Anotó si quiere promociones",
  anotar_baja: "Anotó la baja de promociones",
}

/** Por qué no ofreció nada aunque lo intentó (`bargainProblem`), en palabras de la tienda. */
const HELD_WORDS: Record<Withheld, string> = {
  sin_precio:
    "No ofreció nada: antes le tocaba decir el precio completo y lo que tiene el producto.",
  sin_duda: "No ofreció nada: la clienta no dudó ni pidió rebaja después de oír el precio.",
  mitad:
    "Quiso ceder más de la mitad de lo que hay sobre tu mínimo en su primera oferta, y no la dejó.",
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

/**
 * «Por qué respondió así», solo de lo que quedó anotado en su respuesta (lo que de verdad le
 * llegó): cómo habla, lo que leyó de «Lo que sabe», lo que ofreció de la lista de la tienda, lo que
 * la tienda no la dejó ofrecer, la pregunta que no supo y si el equipo no estaba. No adivina por
 * qué el modelo eligió algo.
 */
export function whyOf(detail: Record<string, unknown>): string[] {
  const why: string[] = []
  if (typeof detail.estilo === "string") why.push(`Habló ${detail.estilo}, como elegiste.`)
  const read = strings(detail.sabe)
  if (read.length) why.push(`Usó de «Lo que sabe»: ${read.map((q) => `«${q}»`).join(", ")}.`)
  const offered = strings(detail.ofrecio).filter((k): k is OfferKind => k in OFFER_NAMES)
  if (offered.length)
    why.push(
      `Ofreció de tu lista: ${offered.map((k) => OFFER_NAMES[k]).join(" y ")}, sin bajar de tu mínimo.`,
    )
  if (typeof detail.objecion === "string")
    why.push(`Ofreció porque la clienta dijo «${detail.objecion}», después de oír el precio.`)
  if (detail.primera === true)
    why.push("Era su primera oferta: cedió como mucho la mitad de lo que hay sobre tu mínimo.")
  if (typeof detail.sin_oferta === "string" && detail.sin_oferta in HELD_WORDS)
    why.push(HELD_WORDS[detail.sin_oferta as Withheld])
  const refused = strings(detail.no_dejo).filter((k): k is OfferKind => k in OFFER_NAMES)
  if (refused.length)
    why.push(
      `Intentó ofrecer ${refused.map((k) => OFFER_NAMES[k]).join(" y ")} y tu regla no lo dejó.`,
    )
  if (typeof detail.pregunta === "string")
    why.push(`No sabía «${detail.pregunta}»: no lo inventó y te lo pasó.`)
  if (typeof detail.fuera_de_horario === "string")
    why.push(`Tu equipo no estaba: dijo que le escriben ${detail.fuera_de_horario}.`)
  return why
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
    why: whyOf(detail),
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
    const { order } = await vitrinaOrderIn(tx, storeId, input)
    const { today } = await storeClockIn(tx, storeId)
    await createOrderIn(tx, storeId, person.userId, order, {
      conversationId,
      today,
      test: true,
    })
    return { cart: await cartIn(tx, storeId, conversationId) }
  })
}

/** Los medios para pagar ya (link o captura, nunca al recibir), en el orden en que cobra Sofi. */
export async function payNowMethodsIn(tx: Db, storeId: string) {
  return (
    await tx
      .select()
      .from(storePaymentMethod)
      .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.isActive, true)))
      .orderBy(asc(storePaymentMethod.createdAt))
  )
    .filter((m) => m.collection !== "al_recibir")
    .sort((a, b) => COLLECTION_RANK[a.collection] - COLLECTION_RANK[b.collection])
}

/**
 * El pedido que arma el carrito de la vitrina de la prueba, como lo arma «Pagar ahora»: lo que
 * eligió la clienta, su entrega y el primer medio para pagar ya. Para cotizar una entrega por zona
 * sin zona elegida (`anyZone`), se usa la primera solo para el precio de lo que lleva: el envío
 * queda por elegir.
 */
async function vitrinaOrderIn(
  tx: Db,
  storeId: string,
  input: z.infer<typeof testOrderInput>,
  options: { anyZone?: boolean } = {},
) {
  const methods = await payNowMethodsIn(tx, storeId)
  if (!methods[0])
    throw new StoreError(
      409,
      "NO_PAYMENT",
      "La tienda no tiene un medio para pagar ya (link o captura): solo se paga al recibir",
    )
  let zone = input.zone ?? null
  let zoneMissing = false
  if (!zone && options.anyZone) {
    const [delivery] = await tx
      .select({ cost: storeDeliveryMethod.cost, zones: storeDeliveryMethod.zones })
      .from(storeDeliveryMethod)
      .where(
        and(
          eq(storeDeliveryMethod.id, input.deliveryMethodId),
          eq(storeDeliveryMethod.storeId, storeId),
        ),
      )
    if (delivery?.cost === "por_zona" && delivery.zones[0]) {
      zone = delivery.zones[0].name
      zoneMissing = true
    }
  }
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
    zone,
    deliveryListCents: null,
    deliveryCents: null,
    paymentMethodId: methods[0].id,
  })
  if (!parsed.success)
    throw new StoreError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "No vale")
  return { order: parsed.data, zoneMissing }
}

/**
 * Lo que cuesta el carrito de la vitrina de la prueba antes de pagar: la misma cuenta del pedido
 * que arma «Pagar ahora» (`quoteOrderIn`: el precio por cantidad, las promociones, el de
 * revendedora y el envío gratis de su zona). La pantalla no calcula nada: muestra esto. Si falta
 * algo (la zona), lo dice y no da un total.
 */
export async function quoteTestCart(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof testOrderInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const { order, zoneMissing } = await vitrinaOrderIn(tx, storeId, input, { anyZone: true })
    const { today } = await storeClockIn(tx, storeId)
    const q = await quoteOrderIn(tx, storeId, order, today)
    if (!q.quote) return { quote: null, problem: Object.values(q.fields)[0] ?? "Revisa el carrito" }
    const { quote } = q
    return {
      quote: {
        lines: quote.lines.map((line, i) => ({
          variantId: input.lines[i]!.variantId,
          quantity: line.quantity,
          unitCents: line.unitCents,
          listUnitCents: line.listUnitCents,
        })),
        subtotalCents: quote.subtotalCents,
        /** Sin zona elegida, el envío y el total quedan por saber. */
        deliveryCents: zoneMissing ? null : quote.deliveryCents,
        totalCents: zoneMissing ? null : quote.totalCents,
        freeFromCents: zoneMissing ? null : q.freeFromCents,
      },
      problem: zoneMissing ? "Elige tu zona" : null,
    }
  })
}

export const testPayInput = z.object({
  orderId: z.uuid(),
  /** Con qué medio de la tienda paga en la vitrina de la prueba: solo cambia lo que se anota. */
  paymentMethodId: z.uuid("Elige con qué pagas"),
})

/**
 * Cómo se dice cada tipo de medio en el aviso a Sofi: palabras fijas, nunca el nombre que escribió
 * la tienda (lo que escribe la tienda no va como instrucción).
 */
const KIND_WORDS: Record<PaymentKind, string> = {
  yape: "Yape",
  plin: "Plin",
  transferencia: "una transferencia",
  efectivo: "efectivo",
  pos: "tarjeta",
  link: "el link de pago",
  otro: "uno de los medios de la tienda",
}

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
    // Solo un medio de la tienda para pagar ya, encendido: los mismos que ofrece la hoja de pago.
    const method = (await payNowMethodsIn(tx, storeId)).find((m) => m.id === input.paymentMethodId)
    if (!method)
      throw new StoreError(400, "VALIDATION_ERROR", "Ese medio de pago ya no está encendido", {
        paymentMethodId: "Ese medio de pago ya no está encendido",
      })
    const done = await payTestOrderIn(tx, storeId, person.userId, order.id, method)
    const lines = await tx
      .select({
        name: saleOrderLine.productName,
        variant: saleOrderLine.variantName,
        quantity: saleOrderLine.quantity,
      })
      .from(saleOrderLine)
      .where(eq(saleOrderLine.orderId, order.id))
    return { ...done, currency: order.currency, lines, kind: method.kind }
  })
  const bought = paid.lines
    .map((l) => `${l.quantity} × ${l.name}${l.variant === "Única" ? "" : ` ${l.variant}`}`)
    .join(", ")
  const result = await answer(sofi, storeId, conversationId, {
    text: `La clienta acaba de pagar el pedido ${paid.number} (${formatMoney(paid.totalCents, paid.currency)}) con ${KIND_WORDS[paid.kind]}: ${bought}. Confírmale en una frase que el pago llegó y que le avisas cuando salga, sin prometer un día que no sabes. Si lo que compró tiene «combina» en buscar_productos, ofrécele una sola vez ese producto como un pedido aparte, a su precio o con tu oferta del margen y su plazo; no cambies el pedido pagado ni digas que va en el mismo envío.`,
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
