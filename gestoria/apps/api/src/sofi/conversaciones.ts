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
import { pad } from "../pedidos.js"
import { balancesIn, unpaidBalance } from "../saldo.js"
import { inStore, StoreError } from "../tiendas.js"
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

export const customerMessageInput = z.object({
  text: z.string().trim().min(1, "Escribe el mensaje").max(1000, "Máximo 1000 caracteres"),
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
  ver_envio: "Miró el envío al distrito",
  ver_pedidos: "Miró los pedidos",
  avisar_cuando_vuelva: "Quedó en avisar cuando vuelva",
  pasar_a_persona: "La pasó a una persona",
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
