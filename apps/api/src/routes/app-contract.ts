import type { AccountApp } from "@odentia/auth"
import {
  appEvent,
  CONTRACT_MAX_BODY_BYTES,
  CONTRACT_MAX_EVENT_BYTES,
  CONTRACT_PATHS,
  stateQuestion,
} from "@odentia/contract"
import { verifySignedMessage } from "@odentia/contract/signing"
import type { Db } from "@odentia/db"
import {
  type AppContractPeer,
  answerAppState,
  receiveAppEvent,
  type Storage,
} from "@odentia/services"
import type { Context } from "hono"
import { errorBody } from "../lib/error.js"
import { readLimited } from "./account-review.js"
import { runService, validationError } from "./helpers.js"

export { CONTRACT_PATHS }

export interface AppContractDeps {
  ownerDb: Db
  /** Con qué secreto firma cada app (`<APP>_CONTRACT_SECRET`). Sin el suyo, el acuerdo no existe. */
  appContractPeers?: AppContractPeer[]
  /** Donde se guarda el comprobante que sube la app (el mismo de los de las clínicas). */
  storage?: Pick<Storage, "putAttachment">
}

/** ¿Es una de las direcciones del acuerdo? */
export function isContractPath(path: string): boolean {
  return path === CONTRACT_PATHS.events || path === CONTRACT_PATHS.state
}

/**
 * El acuerdo con una app que es otro sistema (ADR 0211), en su propio dominio y de servidor a
 * servidor: lo que la app avisa y lo que pregunta, firmado con su secreto (Standard Webhooks).
 * La app sale del dominio por donde llegó, nunca del cuerpo; sin su secreto configurado, estas
 * direcciones no existen (404) y nada se acepta.
 */
export async function answerAppContract(
  c: Context,
  app: AccountApp,
  deps: AppContractDeps,
): Promise<Response> {
  const peer = deps.appContractPeers?.find((one) => one.app === app)
  if (!peer || c.req.method !== "POST")
    return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
  // Un aviso puede traer el comprobante de un pago; una pregunta, nunca.
  const max = c.req.path === CONTRACT_PATHS.events ? CONTRACT_MAX_EVENT_BYTES : CONTRACT_MAX_BODY_BYTES
  const declared = Number(c.req.header("content-length") ?? "0")
  if (declared > max)
    return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Mensaje demasiado grande"), 413)
  const body = await readLimited(c.req.raw, max)
  if (body === null)
    return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Mensaje demasiado grande"), 413)
  const messageId = verifySignedMessage({ secret: peer.secret, headers: c.req.raw.headers, body })
  if (!messageId) return c.json(errorBody(c, "UNAUTHORIZED", "Firma inválida"), 401)
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return c.json(errorBody(c, "VALIDATION", "El cuerpo es JSON"), 400)
  }
  if (c.req.path === CONTRACT_PATHS.events) {
    const parsed = appEvent.safeParse(json)
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => ({
      received: true as const,
      ...(await receiveAppEvent(deps.ownerDb, peer.app, messageId, parsed.data, new Date(), {
        storage: deps.storage,
      })),
    }))
  }
  const parsed = stateQuestion.safeParse(json)
  if (!parsed.success) return validationError(c, parsed.error.issues)
  return runService(c, 200, () => answerAppState(deps.ownerDb, peer.app, parsed.data.account))
}
