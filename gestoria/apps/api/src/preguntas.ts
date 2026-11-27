import { type Db, product, productQuestion } from "@gestoria/db"
import { and, desc, eq, isNull, or } from "drizzle-orm"
import { z } from "zod"
import { detailIn, forRole, logProductEvent, namesOf, productRow, uuidOr404 } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { can } from "./permisos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Lo que Sofi no supo (lienzo «La ficha del producto», tablero 12; decisión 11): la pregunta de la
 * clienta queda en el producto y se responde una vez. Ventas responde (`ventas.atender`) y puede
 * proponer que la respuesta se guarde en la ficha; el Dueño o el Administrador (`configuracion`)
 * la guardan, y desde ahí Sofi la usa la próxima vez. Sofi solo anota la pregunta: la base no la
 * deja responder ni guardar (`0035_reglas_la_ficha_del_producto.sql`). La herramienta de Sofi que
 * la anota y la línea de «Te toca» llegan con su propio cambio.
 */

const questionText = z
  .string()
  .trim()
  .min(3, "Escribe la pregunta")
  .max(500, "Máximo 500 caracteres")
const answerText = z
  .string()
  .trim()
  .min(1, "Escribe la respuesta")
  .max(1000, "Máximo 1000 caracteres")

/**
 * Anota una pregunta de una conversación, sin respuesta. La usará la herramienta de Sofi, dentro
 * de su transacción (`withAgent`), y vale igual para una persona que atiende el chat.
 */
export async function addQuestionIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  input: { productId: string; conversationId: string; question: string },
) {
  await productRow(tx, storeId, input.productId)
  const [row] = await tx
    .insert(productQuestion)
    .values({
      storeId,
      productId: input.productId,
      conversationId: input.conversationId,
      question: questionText.parse(input.question),
      askedBy: actorUserId,
    })
    .returning({ id: productQuestion.id })
  return row!
}

async function questionRow(tx: Db, storeId: string, questionId: string) {
  uuidOr404(questionId, "Esa pregunta ya no está")
  const [row] = await tx
    .select()
    .from(productQuestion)
    .where(and(eq(productQuestion.id, questionId), eq(productQuestion.storeId, storeId)))
    .for("update")
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa pregunta ya no está")
  return row
}

/** Las preguntas que esperan: sin responder, o respondidas por Ventas para guardarlas en la ficha. */
export async function openQuestions(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const rows = await tx
      .select({
        id: productQuestion.id,
        productId: productQuestion.productId,
        productName: product.name,
        conversationId: productQuestion.conversationId,
        question: productQuestion.question,
        askedBy: productQuestion.askedBy,
        askedAt: productQuestion.askedAt,
        answer: productQuestion.answer,
        answeredBy: productQuestion.answeredBy,
        saveRequested: productQuestion.saveRequested,
      })
      .from(productQuestion)
      .innerJoin(product, eq(product.id, productQuestion.productId))
      .where(
        and(
          eq(productQuestion.storeId, storeId),
          or(isNull(productQuestion.answer), eq(productQuestion.saveRequested, true)),
        ),
      )
      .orderBy(desc(productQuestion.askedAt))
      .limit(200)
    const who = await namesOf(
      tx,
      rows.flatMap((r) => [r.askedBy, r.answeredBy]),
    )
    return {
      questions: rows.map((r) => ({
        ...r,
        askedBy: who.get(r.askedBy) ?? null,
        answeredBy: r.answeredBy ? (who.get(r.answeredBy) ?? null) : null,
      })),
    }
  })
}

export const answerInput = z.object({
  answer: answerText,
  /** Guardarla en la ficha: lo hace quien cambia el catálogo; Ventas solo lo propone. */
  save: z.boolean().default(false),
})

/**
 * Responde una pregunta. Con `save`, quien cambia el catálogo la deja en la ficha; Ventas la deja
 * propuesta, y el Dueño o el Administrador la aceptan con «Guardar». Una ya guardada solo la
 * cambia quien cambia el catálogo.
 */
export async function answerQuestion(
  appDb: Db,
  person: Person,
  storeId: string,
  questionId: string,
  input: z.infer<typeof answerInput>,
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx, role) => {
    const row = await questionRow(tx, storeId, questionId)
    const editor = can(role, "configuracion")
    if (row.savedAt && !editor)
      throw new StoreError(
        403,
        "FORBIDDEN",
        "Esa respuesta ya está en la ficha: la cambia quien cambia el catálogo",
      )
    const now = new Date()
    // Quien cambia el catálogo la deja en la ficha (o la mantiene, si ya estaba).
    const saved = editor && (input.save || row.savedAt !== null)
    await tx
      .update(productQuestion)
      .set({
        answer: input.answer,
        answeredBy: person.userId,
        answeredAt: now,
        saveRequested: input.save && !editor,
        savedBy: saved ? person.userId : null,
        savedAt: saved ? now : null,
      })
      .where(eq(productQuestion.id, questionId))
    if (saved)
      await logProductEvent(tx, storeId, row.productId, person.userId, "pregunta", [
        { field: "question", from: row.savedAt ? row.answer : null, to: input.answer },
        { field: "questionId", from: questionId, to: questionId },
      ])
    return forRole(await detailIn(tx, storeId, row.productId), role)
  })
}

export const saveInput = z.object({
  /** La respuesta como queda en la ficha: la de Ventas, o mejor escrita. */
  answer: answerText.optional(),
})

/** Guarda en la ficha la respuesta de una pregunta (la que propuso Ventas, o cambiada). */
export async function saveQuestion(
  appDb: Db,
  person: Person,
  storeId: string,
  questionId: string,
  input: z.infer<typeof saveInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const row = await questionRow(tx, storeId, questionId)
    const answer = input.answer ?? row.answer
    if (!answer)
      throw new StoreError(400, "VALIDATION_ERROR", "Escribe la respuesta", {
        answer: "Escribe la respuesta",
      })
    const now = new Date()
    const rewritten = answer !== row.answer
    await tx
      .update(productQuestion)
      .set({
        answer,
        ...(rewritten || !row.answeredBy ? { answeredBy: person.userId, answeredAt: now } : {}),
        saveRequested: false,
        savedBy: person.userId,
        savedAt: now,
      })
      .where(eq(productQuestion.id, questionId))
    await logProductEvent(tx, storeId, row.productId, person.userId, "pregunta", [
      { field: "question", from: row.savedAt ? row.answer : null, to: answer },
      { field: "questionId", from: questionId, to: questionId },
    ])
    return detailIn(tx, storeId, row.productId)
  })
}

/** Saca una respuesta de la ficha (Sofi deja de usarla). La pregunta y su respuesta quedan. */
export async function unsaveQuestion(
  appDb: Db,
  person: Person,
  storeId: string,
  questionId: string,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const row = await questionRow(tx, storeId, questionId)
    if (!row.savedAt && !row.saveRequested) return detailIn(tx, storeId, row.productId)
    await tx
      .update(productQuestion)
      .set({ saveRequested: false, savedBy: null, savedAt: null })
      .where(eq(productQuestion.id, questionId))
    if (row.savedAt)
      await logProductEvent(tx, storeId, row.productId, person.userId, "pregunta", [
        { field: "question", from: row.answer, to: null },
        { field: "questionId", from: questionId, to: questionId },
      ])
    return detailIn(tx, storeId, row.productId)
  })
}

export const savedQuestionInput = z.object({ question: questionText, answer: answerText })

/** Una pregunta que la tienda ya sabe que le hacen, respondida y guardada en la ficha. */
export async function addSavedQuestion(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
  input: z.infer<typeof savedQuestionInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await productRow(tx, storeId, productId)
    const now = new Date()
    const [row] = await tx
      .insert(productQuestion)
      .values({
        storeId,
        productId,
        question: input.question,
        askedBy: person.userId,
        answer: input.answer,
        answeredBy: person.userId,
        answeredAt: now,
        savedBy: person.userId,
        savedAt: now,
      })
      .returning({ id: productQuestion.id })
    await logProductEvent(tx, storeId, productId, person.userId, "pregunta", [
      { field: "question", from: null, to: input.answer },
      { field: "questionId", from: null, to: row!.id },
    ])
    return detailIn(tx, storeId, productId)
  })
}
