import {
  conversation,
  conversationMessage,
  type Db,
  saleOrder,
  storeAgent,
  storeEvent,
} from "@gestoria/db"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { agentStopIn } from "../acuerdo.js"
import { agentName } from "../agente.js"
import type { Person } from "../cuenta.js"
import { storeClockIn } from "../hora.js"
import { pad } from "../pedidos.js"
import { balancesIn, unpaidBalance } from "../saldo.js"
import { inStore, StoreError } from "../tiendas.js"
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

export const customerMessageInput = z.object({
  text: z.string().trim().min(1, "Escribe el mensaje").max(1000, "Máximo 1000 caracteres"),
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

/** Lo que Sofi tiene puesto, y si hay modelo para que responda. */
export async function agentSettings(
  appDb: Db,
  person: Person,
  storeId: string,
  modelReady: boolean,
) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
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
const versionOf = (row: { updatedAt: Date } | undefined) => row?.updatedAt.toISOString() ?? null

const STALE = () =>
  new StoreError(
    409,
    "STALE",
    "Alguien cambió a Sofi mientras tenías esto abierto. Ciérralo y vuelve a abrirlo para ver lo nuevo antes de guardar.",
  )

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
    const [before] = await tx
      .select()
      .from(storeAgent)
      .where(eq(storeAgent.storeId, storeId))
      .for("update")
    if (versionOf(before) !== version) throw STALE()
    const values = { ...change, updatedBy: person.userId, updatedAt: new Date() }
    const [row] = await tx
      .insert(storeAgent)
      .values({ storeId, ...values })
      .onConflictDoUpdate({ target: storeAgent.storeId, set: values })
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
    const [before] = await tx
      .select({ enabled: storeAgent.enabled })
      .from(storeAgent)
      .where(eq(storeAgent.storeId, storeId))
      .for("update")
    if ((before?.enabled ?? false) === input.enabled) return input
    await tx
      .insert(storeAgent)
      .values({ storeId, enabled: input.enabled, updatedBy: person.userId })
      .onConflictDoUpdate({ target: storeAgent.storeId, set: { enabled: input.enabled } })
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
  leer_lo_que_sabe: "Leyó «Lo que sabe»",
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

/** Lo que hizo Sofi para responder, en palabras del equipo (la marca «Agente» del tablero 8). */
function basisOf(detail: Record<string, unknown>) {
  const tools = Array.isArray(detail.tools)
    ? (detail.tools as { name: string; ok: boolean }[]).map(
        (t) => `${TOOL_WORDS[t.name] ?? t.name}${t.ok ? "" : " (no se pudo)"}`,
      )
    : []
  return {
    tools,
    stopped: Array.isArray(detail.frenado) ? (detail.frenado as string[][]).flat() : [],
    handoff: typeof detail.paso === "string" ? detail.paso : null,
    costMicros: typeof detail.costo === "number" ? detail.costo : null,
    why: whyOf(detail),
  }
}

async function viewIn(tx: Db, storeId: string, conversationId: string) {
  if (!z.uuid().safeParse(conversationId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.storeId, storeId)))
  if (!conv) throw new StoreError(404, "NOT_FOUND", "Esa conversación ya no está")
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
    costMicros: cost,
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author,
      text: m.text,
      createdAt: m.createdAt,
      delivery: m.delivery,
      needsTemplate: m.needsTemplate,
      followUp: m.followUp,
      byArgos: agentName(m.actorUserId) === "Argos",
      ...(m.author === "sofi" ? { basis: basisOf(m.detail) } : {}),
    })),
    orders: orders.map((o) => ({
      ...o,
      number: pad(o.number),
      balance: balances.get(o.id) ?? unpaidBalance(o.totalCents),
    })),
  }
}

export async function conversationView(
  appDb: Db,
  person: Person,
  storeId: string,
  conversationId: string,
) {
  return inStore(appDb, person, storeId, "ventas.atender", (tx) =>
    viewIn(tx, storeId, conversationId),
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
    })
    await tx
      .update(conversation)
      .set({ lastCustomerAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(conversation.id, conversationId))
  })
  const result = await answer(sofi, storeId, conversationId)
  return {
    conversation: await conversationView(sofi.appDb, person, storeId, conversationId),
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
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const view = await viewIn(tx, storeId, conversationId)
    await tx
      .update(conversation)
      .set({ handler: "sofi", waitingReason: null, updatedAt: new Date() })
      .where(eq(conversation.id, conversationId))
    return { ...view, handler: "sofi" as const, waitingReason: null }
  })
}
