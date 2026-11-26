import { randomUUID } from "node:crypto"
import {
  type AdminRequest,
  type AdminRequestResult,
  APP_CONTRACT_PATHS,
  adminRequest,
  adminRequestResult,
} from "@odentia/contract"
import { isSigningSecret, signMessage } from "@odentia/contract/signing"
import type { Db } from "@odentia/db"
import {
  type AppContractRequestStatus,
  type AppContractRequestType,
  appContractRequest,
  SAAS_ACCOUNT_EXTERNAL_APPS,
  type SaasAccountExternalApp,
  saasAccount,
} from "@odentia/db/schema/admin-accounts"
import { user } from "@odentia/db/schema/auth"
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm"
import { accountEventBackoffSeconds } from "./account-events.js"
import type { AdminActor } from "./admin-core.js"
import { assignAppAccountPlan, requireAppAccount } from "./app-contract.js"
import { invalidField, ServiceError } from "./errors.js"

/**
 * Lo que la administración le pide a una app que es otro sistema (ADR 0214, tablero 3 del
 * lienzo A): abrir la cuenta de un cliente con su plan, dejar entrar a soporte y quitar a una
 * persona. Lo de cada app se queda en la app; la administración conserva el botón que lo pide.
 *
 * Es la misma maquinaria de los avisos de la cuenta (ADR 0201): el pedido se anota en la
 * transacción de quien lo pide (`app_contract_request`), sale en el momento y el trabajador lo
 * reintenta con la misma clave (`webhook-id` = su id), firmado con el secreto del acuerdo
 * (ADR 0211). Los de una misma cuenta salen en orden: abrirla va antes que dejar entrar a
 * soporte. La app responde «hecho» o «falló» con su motivo; lo demás (sin respuesta, sin firma,
 * caída) se reintenta. Sin dirección o sin secreto, no se puede pedir nada.
 */

/** Adónde y con qué secreto se le pide a cada app. */
export interface AppContractSender {
  app: SaasAccountExternalApp
  /** La dirección del servidor de la app (`https://servidor.gestoria24.com`). */
  url: string
  secret: string
}

/** Lo que dice el entorno (`<APP>_CONTRACT_URL` y el mismo `<APP>_CONTRACT_SECRET`); solo lo completo. */
export function appContractSendersFromEnv(env: {
  GESTORIA_CONTRACT_URL?: string | undefined
  GESTORIA_CONTRACT_SECRET?: string | undefined
}): { senders: AppContractSender[]; problems: string[] } {
  const configured: Record<SaasAccountExternalApp, { url?: string; secret?: string }> = {
    gestoria: { url: env.GESTORIA_CONTRACT_URL, secret: env.GESTORIA_CONTRACT_SECRET },
  }
  const senders: AppContractSender[] = []
  const problems: string[] = []
  for (const app of SAAS_ACCOUNT_EXTERNAL_APPS) {
    const url = configured[app].url?.trim() ?? ""
    const secret = configured[app].secret?.trim() ?? ""
    if (!url) continue
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
      problems.push(`La dirección de los pedidos a ${app} va por https: no se le pide nada.`)
      continue
    }
    if (!isSigningSecret(secret)) {
      problems.push(`Los pedidos a ${app} necesitan el secreto del acuerdo: no se le pide nada.`)
      continue
    }
    senders.push({ app, url, secret })
  }
  return { senders, problems }
}

/** Anota un pedido, comprobado contra el acuerdo: lo que sale es lo que la app lee. */
async function enqueue(
  tx: Db,
  app: SaasAccountExternalApp,
  accountId: string,
  actor: AdminActor,
  request: AdminRequest,
): Promise<string> {
  const payload = adminRequest.parse(request)
  const id = randomUUID()
  await tx.insert(appContractRequest).values({
    id,
    app,
    accountId,
    type: payload.type,
    payload,
    requestedBy: actor.userId,
  })
  return id
}

/** La persona de la cuenta única por su correo: la administración la conoce, la app quizá no. */
async function personByEmail(tx: Db, email: string, field: string) {
  const [row] = await tx
    .select({ userId: user.id, name: user.name, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1)
  if (!row) throw invalidField(field, "Nadie tiene cuenta con ese correo.")
  return row
}

/** Sin quién lo lleve, no se pide nada: el botón lo dice. */
function requireSender(senders: readonly AppContractSender[], app: SaasAccountExternalApp) {
  if (!senders.some((sender) => sender.app === app))
    throw new ServiceError(
      "NOT_CONNECTED",
      409,
      "La conexión con esa app no está encendida: todavía no se le puede pedir nada.",
    )
}

/**
 * Pide a la app que deje entrar a soporte un rato, a nombre de quien lo pide: la app decide
 * cómo (gestorIA se lo pregunta a su Dueño o Administrador) y lo deja anotado.
 */
export async function requestAppSupportAccess(
  tx: Db,
  senders: readonly AppContractSender[],
  actor: AdminActor,
  accountId: string,
  input: { minutes: number; reason: string },
  now = new Date(),
): Promise<string> {
  const account = await requireAppAccount(tx, accountId)
  requireSender(senders, account.app)
  const [staff] = await tx
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, actor.userId))
    .limit(1)
  if (!staff) throw new ServiceError("FORBIDDEN", 403, "Tu cuenta no está completa")
  return enqueue(tx, account.app, account.id, actor, {
    type: "soporte.entrar",
    timestamp: now.toISOString(),
    data: {
      account: account.externalRef,
      staff: { userId: actor.userId, name: staff.name || staff.email, email: staff.email },
      minutes: input.minutes,
      reason: input.reason,
    },
  })
}

/** Pide a la app que quite a una persona (por su correo en la cuenta única), con el motivo. */
export async function requestAppPersonRemoval(
  tx: Db,
  senders: readonly AppContractSender[],
  actor: AdminActor,
  accountId: string,
  input: { email: string; reason: string },
  now = new Date(),
): Promise<string> {
  const account = await requireAppAccount(tx, accountId)
  requireSender(senders, account.app)
  const person = await personByEmail(tx, input.email, "email")
  return enqueue(tx, account.app, account.id, actor, {
    type: "equipo.quitar",
    timestamp: now.toISOString(),
    data: { account: account.externalRef, userId: person.userId, reason: input.reason },
  })
}

/**
 * Abre la cuenta de un cliente en una app con su plan: de este lado, la cuenta con su plan
 * (su prueba empieza hoy); y le pide a la app que la abra con el mismo id, a nombre de su dueño.
 * Cuando la app la abre, avisa `cuenta.abierta` y esta cuenta solo se pone al día.
 */
export async function openAppAccountForClient(
  tx: Db,
  senders: readonly AppContractSender[],
  actor: AdminActor,
  input: {
    app: SaasAccountExternalApp
    name: string
    ownerEmail: string
    currency: string
    country: string | null
    planCode: string
  },
  now = new Date(),
): Promise<{ accountId: string; requestId: string }> {
  requireSender(senders, input.app)
  // Lo que la app rechazaría lo dice aquí, antes de abrir nada: una moneda que no existe.
  if (!Intl.supportedValuesOf("currency").includes(input.currency))
    throw invalidField("currency", "Esa moneda no existe: elige una de la lista.")
  const owner = await personByEmail(tx, input.ownerEmail, "ownerEmail")
  const ref = randomUUID()
  // Su id nunca es el de una clínica (ADR 0210): uno nuevo, distinto del de la tienda.
  const accountId = randomUUID()
  await tx.insert(saasAccount).values({
    id: accountId,
    app: input.app,
    externalRef: ref,
    name: input.name,
    country: input.country,
    ownerUserId: owner.userId,
  })
  await assignAppAccountPlan(tx, accountId, actor.userId, input.planCode, now)
  const requestId = await enqueue(tx, input.app, accountId, actor, {
    type: "cuenta.abrir",
    timestamp: now.toISOString(),
    data: {
      account: ref,
      name: input.name,
      currency: input.currency,
      country: input.country,
      owner: { userId: owner.userId, name: owner.name || owner.email, email: owner.email },
    },
  })
  return { accountId, requestId }
}

/** Un pedido como lo ve la administración: qué, quién, cuándo y cómo quedó. */
export interface AppContractRequestRow {
  id: string
  type: AppContractRequestType
  status: AppContractRequestStatus
  /** Lo que dijo la app, o por qué todavía no llega. */
  message: string | null
  requestedBy: string | null
  /** Lo pidió quien mira la lista: «Mirar la tienda» es solo para quien pidió entrar (ADR 0219). */
  mine: boolean
  createdAt: string
  doneAt: string | null
  /** A quién se refiere (la persona por quitar, o soporte y por cuánto). */
  detail: string | null
}

function detailOf(
  type: AppContractRequestType,
  payload: Record<string, unknown>,
  emails: Map<string, string>,
): string | null {
  const data = (payload.data ?? {}) as Record<string, unknown>
  if (type === "soporte.entrar") {
    const staff = (data.staff ?? {}) as { name?: string }
    return `${staff.name ?? "Soporte"} · ${String(data.minutes ?? "")} min · ${String(data.reason ?? "")}`
  }
  if (type === "equipo.quitar")
    return `${emails.get(String(data.userId)) ?? String(data.userId ?? "")} · ${String(data.reason ?? "")}`
  if (type === "cuenta.abrir") return String(data.name ?? "")
  return null
}

/** Los pedidos de una cuenta, del más nuevo al más viejo; `viewerId` dice cuáles pidió quien mira. */
export async function listAppContractRequests(
  tx: Db,
  accountId: string,
  viewerId: string | null = null,
  limit = 30,
): Promise<AppContractRequestRow[]> {
  const rows = await tx
    .select({ request: appContractRequest, requesterName: user.name, requesterEmail: user.email })
    .from(appContractRequest)
    .leftJoin(user, eq(user.id, appContractRequest.requestedBy))
    .where(eq(appContractRequest.accountId, accountId))
    .orderBy(desc(appContractRequest.createdAt), desc(appContractRequest.id))
    .limit(Math.min(Math.max(limit, 1), 100))
  // A quién se pidió quitar, por su correo de la cuenta única.
  const removed = rows
    .filter(({ request }) => request.type === "equipo.quitar")
    .map(({ request }) => String((request.payload.data as { userId?: unknown })?.userId ?? ""))
  const emails = new Map(
    removed.length
      ? (
          await tx
            .select({ id: user.id, email: user.email })
            .from(user)
            .where(inArray(user.id, removed))
        ).map((one) => [one.id, one.email] as const)
      : [],
  )
  return rows.map(({ request, requesterName, requesterEmail }) => ({
    id: request.id,
    type: request.type,
    status: request.status,
    message: request.status === "pendiente" ? request.lastError : request.resultMessage,
    requestedBy: requesterName || requesterEmail || null,
    mine: viewerId !== null && request.requestedBy === viewerId,
    createdAt: request.createdAt.toISOString(),
    doneAt: request.doneAt?.toISOString() ?? null,
    detail: detailOf(request.type, request.payload, emails),
  }))
}

/** Lo más que se espera la respuesta de una app. */
const REQUEST_TIMEOUT_MS = 10_000
/**
 * Tras tantos intentos sin respuesta (unos dos días, con la espera de una hora), el pedido se da
 * por fallido: no frena para siempre lo que sigue de esa cuenta, y el equipo lo pide otra vez.
 */
export const APP_REQUEST_MAX_ATTEMPTS = 50

export interface DeliverAppContractRequestsResult {
  delivered: number
  failed: number
}

/**
 * Envía los pedidos que tocan a cada app configurada, en orden por cuenta. Antes de llamar deja
 * anotado el intento y cuándo toca el siguiente (en su propia transacción): si el proceso se
 * cae a mitad, el pedido vuelve a salir con la misma clave y la app lo reconoce. La respuesta
 * «hecho» o «falló» de la app es final, y también un 400 (el pedido no es del acuerdo: repetirlo
 * no lo arregla); cualquier otra cosa (sin firma, caída, sin respuesta) se reintenta.
 */
export async function deliverAppContractRequests(
  ownerDb: Db,
  senders: readonly AppContractSender[],
  opts: { fetch?: typeof fetch; now?: Date; limit?: number } = {},
): Promise<DeliverAppContractRequestsResult> {
  const send = opts.fetch ?? fetch
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const result: DeliverAppContractRequestsResult = { delivered: 0, failed: 0 }
  for (const sender of senders) {
    const now = opts.now ?? new Date()
    // eslint-disable-next-line no-await-in-loop
    const due = await ownerDb.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(appContractRequest)
        .where(
          and(
            eq(appContractRequest.app, sender.app),
            eq(appContractRequest.status, "pendiente"),
            lte(appContractRequest.nextAttemptAt, now),
            // En orden por cuenta: abrirla llega antes que lo demás de esa cuenta.
            sql`not exists (
              select 1 from admin.app_contract_request earlier
              where earlier.account_id = ${appContractRequest.accountId}
                and earlier.status = 'pendiente'
                and (earlier.created_at, earlier.id) < (${appContractRequest.createdAt}, ${appContractRequest.id})
            )`,
          ),
        )
        .orderBy(asc(appContractRequest.createdAt), asc(appContractRequest.id))
        .limit(limit)
        .for("update", { skipLocked: true })
      for (const row of rows) {
        const wait = accountEventBackoffSeconds(row.attempts + 1)
        await tx
          .update(appContractRequest)
          .set({
            attempts: sql`${appContractRequest.attempts} + 1`,
            nextAttemptAt: new Date(now.getTime() + wait * 1000),
          })
          .where(eq(appContractRequest.id, row.id))
      }
      return rows
    })
    for (const row of due) {
      const body = JSON.stringify(row.payload)
      let answer: AdminRequestResult | null = null
      let error: string | null = null
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await send(new URL(APP_CONTRACT_PATHS.requests, sender.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...signMessage({ secret: sender.secret, id: row.id, body }),
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "manual",
        })
        if (response.status === 200) {
          // eslint-disable-next-line no-await-in-loop
          const parsed = adminRequestResult.safeParse(await response.json().catch(() => null))
          if (parsed.success) answer = parsed.data
          else error = "La app respondió algo que no es del acuerdo"
        } else if (response.status === 400) {
          answer = { status: "fallo", message: "La app no lo aceptó: no es un pedido del acuerdo." }
        } else error = `La app respondió ${response.status}`
      } catch (cause) {
        error =
          cause instanceof Error && cause.name === "TimeoutError"
            ? "La app no respondió a tiempo"
            : "No se pudo llamar a la app"
      }
      // eslint-disable-next-line no-await-in-loop
      await ownerDb
        .update(appContractRequest)
        .set(
          answer
            ? {
                status: answer.status,
                resultMessage: answer.message?.slice(0, 500) ?? null,
                doneAt: new Date(),
                lastError: null,
              }
            : row.attempts + 1 >= APP_REQUEST_MAX_ATTEMPTS
              ? {
                  status: "fallo" as const,
                  resultMessage:
                    `La app no respondió tras ${APP_REQUEST_MAX_ATTEMPTS} intentos: ${error ?? ""}`.slice(
                      0,
                      500,
                    ),
                  doneAt: new Date(),
                }
              : { lastError: error?.slice(0, 500) ?? null },
        )
        // Uno ya respondido no vuelve a cambiar.
        .where(and(eq(appContractRequest.id, row.id), eq(appContractRequest.status, "pendiente")))
      if (answer) result.delivered += 1
      else result.failed += 1
    }
  }
  return result
}
