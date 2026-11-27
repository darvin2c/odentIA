import { agentGap, conversation, type Db, product, storeAgentAnswer } from "@gestoria/db"
import { and, asc, count, desc, eq, isNull, max, sql } from "drizzle-orm"
import { z } from "zod"
import { SOFI_ACTOR } from "../agente.js"
import type { Person } from "../cuenta.js"
import { inStore, StoreError } from "../tiendas.js"

/**
 * «Lo que sabe» y «Lo que aprendió» Sofi (tablero 8 de «gestorIA · Configuración, de nuevo»;
 * decisiones 7 y 8; ADR 0234).
 *
 * - «Lo que sabe» son preguntas y respuestas que escribe la tienda (`store_agent_answer`). Sofi ve
 *   la lista de preguntas y lee la respuesta que necesita con `leer_lo_que_sabe`: llegan como datos
 *   de una herramienta, nunca como instrucciones, y «Por qué» dice cuál leyó.
 * - «Lo que aprendió» son las preguntas que Sofi no supo responder en una conversación de verdad
 *   (`agent_gap`), anotadas al pasar el chat a una persona. Solo propone: la tienda la responde
 *   (va a «Lo que sabe») o la quita. Nada se agrega solo.
 */

/** Lo más que Sofi lista de «Lo que sabe» en lo que lee: las más nuevas. */
export const MAX_ANSWERS = 60

export const answerInput = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Escribe la pregunta como la haría una clienta")
    .max(200, "Máximo 200 caracteres"),
  answer: z.string().trim().min(1, "Escribe la respuesta").max(1000, "Máximo 1000 caracteres"),
})

/** La clave de una pregunta, para juntar las iguales: sin tildes, signos ni mayúsculas. */
export function questionKey(question: string): string {
  return question
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim()
    .slice(0, 200)
}

const idInput = z.uuid()
const notFound = () => new StoreError(404, "NOT_FOUND", "Esa pregunta ya no está")

/** Lo que sabe Sofi, lo que aprendió y los productos sin descripción (de su ficha en Catálogo). */
export async function knowledgeView(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const answers = await tx
      .select({
        id: storeAgentAnswer.id,
        question: storeAgentAnswer.question,
        answer: storeAgentAnswer.answer,
        updatedAt: storeAgentAnswer.updatedAt,
      })
      .from(storeAgentAnswer)
      .where(eq(storeAgentAnswer.storeId, storeId))
      .orderBy(asc(storeAgentAnswer.createdAt))
    // Lo que aprendió: cada pregunta abierta una vez, con cuántas conversaciones la hicieron.
    const gaps = await tx
      .select({
        key: agentGap.questionKey,
        question: sql<string>`(array_agg(${agentGap.question} order by ${agentGap.createdAt} desc))[1]`,
        conversations: count(sql`distinct ${agentGap.conversationId}`),
        lastAt: max(agentGap.createdAt),
      })
      .from(agentGap)
      .where(and(eq(agentGap.storeId, storeId), isNull(agentGap.outcome)))
      .groupBy(agentGap.questionKey)
      .orderBy(desc(count(sql`distinct ${agentGap.conversationId}`)), desc(max(agentGap.createdAt)))
      .limit(50)
    const bare = await tx
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(
        and(eq(product.storeId, storeId), sql`char_length(btrim(${product.description})) = 0`),
      )
      .orderBy(asc(product.name))
      .limit(20)
    return {
      answers,
      gaps: gaps.map((g) => ({ ...g, lastAt: g.lastAt ?? null })),
      productsWithoutDescription: bare,
    }
  })
}

export async function addAnswer(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof answerInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .insert(storeAgentAnswer)
      .values({ storeId, ...input, createdBy: person.userId, updatedBy: person.userId })
      .returning({ id: storeAgentAnswer.id })
    return { id: row!.id }
  })
}

export async function changeAnswer(
  appDb: Db,
  person: Person,
  storeId: string,
  answerId: string,
  input: z.infer<typeof answerInput>,
) {
  if (!idInput.safeParse(answerId).success) throw notFound()
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .update(storeAgentAnswer)
      .set({ ...input, updatedBy: person.userId, updatedAt: new Date() })
      .where(and(eq(storeAgentAnswer.id, answerId), eq(storeAgentAnswer.storeId, storeId)))
      .returning({ id: storeAgentAnswer.id })
    if (!row) throw notFound()
    return { id: row.id }
  })
}

export async function removeAnswer(appDb: Db, person: Person, storeId: string, answerId: string) {
  if (!idInput.safeParse(answerId).success) throw notFound()
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(storeAgentAnswer)
      .where(and(eq(storeAgentAnswer.id, answerId), eq(storeAgentAnswer.storeId, storeId)))
      .returning({ id: storeAgentAnswer.id })
    if (!row) throw notFound()
  })
}

export const gapAnswerInput = answerInput.extend({ key: z.string().min(1).max(200) })
export const gapDismissInput = z.object({ key: z.string().min(1).max(200) })

/** Cierra todas las conversaciones abiertas de esa pregunta; null si ya no había ninguna. */
async function closeGaps(
  tx: Db,
  person: Person,
  storeId: string,
  key: string,
  outcome: "respondida" | "quitada",
  answerId: string | null,
) {
  const closed = await tx
    .update(agentGap)
    .set({ outcome, answerId, closedBy: person.userId, closedAt: new Date() })
    .where(
      and(eq(agentGap.storeId, storeId), eq(agentGap.questionKey, key), isNull(agentGap.outcome)),
    )
    .returning({ id: agentGap.id })
  return closed.length
}

/**
 * «Responder» en «Lo que aprendió»: la respuesta va a «Lo que sabe» (con la pregunta como la
 * dejó la tienda) y la pregunta se cierra. Nada de esto lo hace Sofi.
 */
export async function answerGap(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof gapAnswerInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .insert(storeAgentAnswer)
      .values({
        storeId,
        question: input.question,
        answer: input.answer,
        createdBy: person.userId,
        updatedBy: person.userId,
      })
      .returning({ id: storeAgentAnswer.id })
    const closed = await closeGaps(tx, person, storeId, input.key, "respondida", row!.id)
    if (closed === 0)
      throw new StoreError(409, "GAP_CLOSED", "Esa pregunta ya se respondió o se quitó")
    return { id: row!.id }
  })
}

/** «Quitar»: la pregunta deja de proponerse, sin agregar nada a «Lo que sabe». */
export async function dismissGap(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof gapDismissInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const closed = await closeGaps(tx, person, storeId, input.key, "quitada", null)
    if (closed === 0)
      throw new StoreError(409, "GAP_CLOSED", "Esa pregunta ya se respondió o se quitó")
  })
}

/* ----------------------------------------------------------- lo que usa Sofi */

/** Las preguntas de «Lo que sabe» que Sofi ve (sin las respuestas), con un número corto cada una. */
export async function answersForAgent(tx: Db, storeId: string) {
  const rows = await tx
    .select({
      id: storeAgentAnswer.id,
      question: storeAgentAnswer.question,
      answer: storeAgentAnswer.answer,
    })
    .from(storeAgentAnswer)
    .where(eq(storeAgentAnswer.storeId, storeId))
    .orderBy(desc(storeAgentAnswer.createdAt))
    .limit(MAX_ANSWERS)
  return rows.reverse().map((row, i) => ({ ref: `p${i + 1}`, ...row }))
}

/**
 * Anota una pregunta que Sofi no supo responder, en una conversación de verdad. Si ya está
 * abierta en esa conversación, no la repite.
 */
export async function noteGapIn(
  tx: Db,
  storeId: string,
  conversationId: string,
  question: string,
): Promise<boolean> {
  const key = questionKey(question)
  if (!key) return false
  const [open] = await tx
    .select({ id: agentGap.id })
    .from(agentGap)
    .where(
      and(
        eq(agentGap.conversationId, conversationId),
        eq(agentGap.questionKey, key),
        isNull(agentGap.outcome),
      ),
    )
  if (open) return false
  const [conv] = await tx
    .select({ channel: conversation.channel })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.storeId, storeId)))
  // La de «Probar a Sofi» no enseña nada: es la tienda probando.
  if (!conv || conv.channel === "prueba") return false
  await tx.insert(agentGap).values({
    storeId,
    conversationId,
    question: question.trim().slice(0, 200),
    questionKey: key,
    createdBy: SOFI_ACTOR,
  })
  return true
}
