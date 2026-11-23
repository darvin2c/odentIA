import type { AccountApp } from "@odentia/auth"
import { verifySignedMessage } from "@odentia/auth/account-events"
import type { Db } from "@odentia/db"
import {
  ACCOUNT_REVIEW_LIMIT,
  type AccountEventSender,
  type ReviewedAccount,
  reviewAccounts,
} from "@odentia/services"
import type { Context } from "hono"
import { z } from "zod"
import { errorBody } from "../lib/error.js"

/** Dónde pregunta una app que es otro sistema, en su propio dominio (ADR 0201). */
export const ACCOUNT_REVIEW_PATH = "/api/account-apps/review"

/** Lo más que puede pesar la pregunta: 500 ids de cuenta caben de sobra. */
const MAX_BODY_BYTES = 64 * 1024

const question = z.object({
  userIds: z.array(z.string().min(1).max(200)).max(ACCOUNT_REVIEW_LIMIT),
})

export interface AccountReviewDeps {
  ownerDb: Db
  accountEventSenders?: AccountEventSender[]
  /** Para las pruebas sin base; por omisión, la cuenta de esta base. */
  reviewAccounts?: (userIds: string[]) => Promise<ReviewedAccount[]>
}

/**
 * La revisión diaria de la copia de las cuentas de una app (decisión 11 del lienzo A): la app
 * pregunta por las personas que ya conoce, firmando con el mismo secreto de sus avisos
 * (Standard Webhooks), y la cuenta responde lo vigente. Sin ese secreto configurado, no existe.
 * La app sale del dominio por donde llegó la pregunta, nunca de lo que dice el cuerpo.
 */
export async function answerAccountReview(
  c: Context,
  app: AccountApp,
  deps: AccountReviewDeps,
): Promise<Response> {
  const sender = deps.accountEventSenders?.find((one) => one.app === app)
  if (!sender || c.req.method !== "POST")
    return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
  const declared = Number(c.req.header("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES)
    return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Pregunta demasiado grande"), 413)
  const body = await readLimited(c.req.raw, MAX_BODY_BYTES)
  if (body === null)
    return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Pregunta demasiado grande"), 413)
  if (!verifySignedMessage({ secret: sender.secret, headers: c.req.raw.headers, body }))
    return c.json(errorBody(c, "UNAUTHORIZED", "Firma inválida"), 401)
  let parsed: z.infer<typeof question>
  try {
    parsed = question.parse(JSON.parse(body))
  } catch {
    return c.json(
      errorBody(c, "VALIDATION_ERROR", "Se pregunta por una lista de ids de cuenta"),
      400,
    )
  }
  const review = deps.reviewAccounts ?? ((ids: string[]) => reviewAccounts(deps.ownerDb, ids))
  return c.json({ accounts: await review(parsed.userIds) })
}

/** El cuerpo como texto, leído mientras llega y cortado al pasar el tope (también sin `content-length`). */
export async function readLimited(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
