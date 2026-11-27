import {
  asAdminDecider,
  createDecisionModel,
  createFakeDecisionModel,
  createHelpWriter,
  type PlatformDecisions,
  type PlatformLlm,
  resolveLlmSpec,
  withAiMeter,
} from "@odentia/agent"
import type { AccountApp } from "@odentia/auth"
import {
  appEvent,
  CONTRACT_MAX_BODY_BYTES,
  CONTRACT_MAX_EVENT_BYTES,
  CONTRACT_MAX_HELP_BYTES,
  CONTRACT_PATHS,
  helpAskQuestion,
  stateQuestion,
} from "@odentia/contract"
import { verifySignedMessage } from "@odentia/contract/signing"
import type { Db } from "@odentia/db"
import {
  type AppContractPeer,
  answerAppHelp,
  answerAppState,
  type HelpDecider,
  receiveAppEvent,
  recordAppAiUsage,
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
  /** El modelo de la plataforma, que redacta en la Ayuda (`LLM_*`); sin él, el de demostración. */
  llm?: PlatformLlm
  /** Las credenciales de Jev de la plataforma (`JEV_*`), que decide en la Ayuda. */
  decisions?: PlatformDecisions
}

/** ¿Es una de las direcciones del acuerdo? */
export function isContractPath(path: string): boolean {
  return path === CONTRACT_PATHS.events || path === CONTRACT_PATHS.state || path === CONTRACT_PATHS.help
}

/**
 * Quién elige la respuesta de la Ayuda de una app: Jev, con la cuenta de odentIA, como en las
 * clínicas (`helpDecider` de `help.ts`), pero sin clínica: no hay modelo de decisión elegido que
 * mirar. Con el modelo de demostración, su doble determinista. Sin Jev, null: responden las
 * palabras.
 */
async function appHelpDecider(llm: PlatformLlm, decisions: PlatformDecisions | undefined): Promise<HelpDecider | null> {
  if (llm.fake) return asAdminDecider(createFakeDecisionModel())
  if (!decisions?.jev) return null
  // Jev no usa el modelo que escribe: no hace falta su clave.
  const model = await createDecisionModel("jev", decisions, resolveLlmSpec({ fake: true })).catch(() => null)
  return model ? asAdminDecider(model) : null
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
  // Un aviso puede traer el comprobante de un pago y una pregunta a la Ayuda, la guía de la app.
  const max =
    c.req.path === CONTRACT_PATHS.events
      ? CONTRACT_MAX_EVENT_BYTES
      : c.req.path === CONTRACT_PATHS.help
        ? CONTRACT_MAX_HELP_BYTES
        : CONTRACT_MAX_BODY_BYTES
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
  if (c.req.path === CONTRACT_PATHS.help) {
    const parsed = helpAskQuestion.safeParse(json)
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const llm = deps.llm ?? { fake: true }
    // A Jev viajan la pregunta, la anterior y el nombre de la pantalla; a quien redacta, la
    // pregunta y textos de la guía. Lo que cuesta lo paga odentIA, por app (origen «ayuda»).
    return runService(c, 200, () =>
      withAiMeter(
        async () => {
          const decider = await appHelpDecider(llm, deps.decisions)
          return answerAppHelp(deps.ownerDb, peer.app, parsed.data, decider, decider ? createHelpWriter(llm) : null)
        },
        (entries) => deps.ownerDb.transaction((tx) => recordAppAiUsage(tx as Db, peer.app, "ayuda", entries)),
      ),
    )
  }
  const parsed = stateQuestion.safeParse(json)
  if (!parsed.success) return validationError(c, parsed.error.issues)
  return runService(c, 200, () => answerAppState(deps.ownerDb, peer.app, parsed.data.account))
}
