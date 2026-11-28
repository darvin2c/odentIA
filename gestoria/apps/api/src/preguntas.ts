import { conversation, type Db, product, productQuestion } from "@gestoria/db"
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm"
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
 * deja responder ni guardar (`0056_reglas_la_ficha_del_producto.sql`); la anota con su herramienta
 * `anotar_pregunta`. Las que esperan van a «Te toca» de Inicio (`questionLinesIn`): varias iguales
 * del mismo producto son una línea, y se responden de una vez (`answerQuestions`). Las de «Probar a
 * Sofi» quedan en la ficha, pero no van a «Te toca» ni avisan.
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
  /** «Que Sofi se lo diga»: Sofi le escribe la respuesta a cada clienta que preguntó. */
  tell: z.boolean().default(false),
})

export const groupAnswerInput = answerInput.extend({
  /** Las preguntas iguales del mismo producto: la línea de «Te toca» («3 clientas»). */
  ids: z.array(z.uuid()).min(1).max(50),
})

/**
 * Responde una pregunta, o varias iguales del mismo producto de una vez (la línea de «Te toca»).
 * Con `save`, quien cambia el catálogo la deja en la ficha (una sola vez, en la primera); Ventas
 * la deja propuesta, y el Dueño o el Administrador la aceptan con «Guardar». Una ya guardada solo
 * la cambia quien cambia el catálogo. Devuelve a quién decírselo (las conversaciones que
 * preguntaron), para «Que Sofi se lo diga».
 */
export async function answerQuestions(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof groupAnswerInput>,
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx, role) => {
    const ids = [...new Set(input.ids)]
    const rows = await tx
      .select()
      .from(productQuestion)
      .where(and(eq(productQuestion.storeId, storeId), inArray(productQuestion.id, ids)))
      .orderBy(asc(productQuestion.askedAt))
      .for("update")
    if (rows.length !== ids.length)
      throw new StoreError(404, "NOT_FOUND", "Esa pregunta ya no está")
    const productId = rows[0]!.productId
    if (rows.some((row) => row.productId !== productId))
      throw new StoreError(400, "VALIDATION_ERROR", "Son preguntas de productos distintos")
    const editor = can(role, "configuracion")
    // La línea de «Te toca» responde lo que espera: si otra persona ya la respondió, no se pisa.
    if (input.ids.length > 1 && rows.some((row) => row.answer !== null))
      throw new StoreError(409, "ALREADY_ANSWERED", "Esa pregunta ya la respondieron")
    if (rows.some((row) => row.savedAt) && !editor)
      throw new StoreError(
        403,
        "FORBIDDEN",
        "Esa respuesta ya está en la ficha: la cambia quien cambia el catálogo",
      )
    const now = new Date()
    // En la ficha queda una sola: la que ya estaba guardada, o la primera.
    const keeper = rows.find((row) => row.savedAt) ?? rows[0]!
    for (const row of rows) {
      const mine = row.id === keeper.id
      // Quien cambia el catálogo la deja en la ficha (o la mantiene, si ya estaba).
      const saved = mine && editor && (input.save || row.savedAt !== null)
      await tx
        .update(productQuestion)
        .set({
          answer: input.answer,
          answeredBy: person.userId,
          answeredAt: now,
          saveRequested: mine && input.save && !editor,
          savedBy: saved ? person.userId : null,
          savedAt: saved ? now : null,
        })
        .where(eq(productQuestion.id, row.id))
      if (saved)
        await logProductEvent(tx, storeId, productId, person.userId, "pregunta", [
          { field: "question", from: row.savedAt ? row.answer : null, to: input.answer },
          { field: "questionId", from: row.id, to: row.id },
        ])
    }
    // Se le dice solo a quien esperaba: lo ya respondido no se vuelve a escribir.
    const told = new Set<string>()
    for (const row of rows)
      if (row.conversationId && row.answer === null) told.add(row.conversationId)
    const [named] = await tx
      .select({ name: product.name })
      .from(product)
      .where(eq(product.id, productId))
    return {
      product: forRole(await detailIn(tx, storeId, productId), role),
      tell: input.tell
        ? [...told].map((conversationId) => ({ conversationId, product: named?.name ?? "" }))
        : [],
    }
  })
}

/** Responde una pregunta de la ficha (la misma regla que la línea de «Te toca»). */
export async function answerQuestion(
  appDb: Db,
  person: Person,
  storeId: string,
  questionId: string,
  input: z.infer<typeof answerInput>,
) {
  uuidOr404(questionId, "Esa pregunta ya no está")
  return answerQuestions(appDb, person, storeId, { ...input, ids: [questionId] })
}

/** Una pregunta en palabras sueltas, sin tildes ni signos: así dos iguales son una sola línea. */
export function questionKey(question: string): string {
  return question
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim()
}

/** Una línea de «Te toca» de lo que Sofi no supo: la pregunta, de qué producto y quién espera. */
export interface QuestionLine {
  productId: string
  product: string
  question: string
  /** Las preguntas iguales de esa línea: se responden juntas. */
  ids: string[]
  /** Cuántas clientas la hicieron (sus conversaciones). */
  people: number
  /** El nombre de la primera que preguntó, si lo dio. */
  customer: string | null
  askedAt: Date
  /** Ventas ya la respondió y propone guardarla: la guarda quien cambia la ficha. */
  proposed: { id: string; answer: string } | null
}

/**
 * Lo que Sofi no supo y espera respuesta, para «Te toca»: de conversaciones de verdad (las de
 * «Probar a Sofi» quedan solo en la ficha), juntas las iguales del mismo producto. Con
 * `proposals`, también lo que Ventas propuso guardar, para quien cambia la ficha.
 */
export async function questionLinesIn(
  tx: Db,
  storeId: string,
  proposals: boolean,
): Promise<QuestionLine[]> {
  const rows = await tx
    .select({
      id: productQuestion.id,
      productId: productQuestion.productId,
      product: product.name,
      question: productQuestion.question,
      answer: productQuestion.answer,
      saveRequested: productQuestion.saveRequested,
      conversationId: productQuestion.conversationId,
      customer: conversation.customerName,
      askedAt: productQuestion.askedAt,
    })
    .from(productQuestion)
    .innerJoin(product, eq(product.id, productQuestion.productId))
    .innerJoin(
      conversation,
      and(
        eq(conversation.id, productQuestion.conversationId),
        eq(conversation.storeId, productQuestion.storeId),
      ),
    )
    .where(
      and(
        eq(productQuestion.storeId, storeId),
        ne(conversation.channel, "prueba"),
        proposals
          ? or(isNull(productQuestion.answer), eq(productQuestion.saveRequested, true))
          : isNull(productQuestion.answer),
      ),
    )
    .orderBy(asc(productQuestion.askedAt))
    .limit(300)
  const lines = new Map<string, QuestionLine & { conversations: Set<string> }>()
  for (const row of rows) {
    const proposed = row.answer !== null && row.saveRequested
    const key = `${row.productId}|${proposed ? `p:${row.id}` : questionKey(row.question)}`
    const line = lines.get(key) ?? {
      productId: row.productId,
      product: row.product,
      question: row.question,
      ids: [],
      people: 0,
      customer: row.customer,
      askedAt: row.askedAt,
      proposed: proposed ? { id: row.id, answer: row.answer! } : null,
      conversations: new Set<string>(),
    }
    line.ids.push(row.id)
    if (row.conversationId) line.conversations.add(row.conversationId)
    line.people = line.conversations.size
    lines.set(key, line)
  }
  return [...lines.values()].map(({ conversations: _, ...line }) => line)
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
