import {
  type AccountEventPayload,
  type AccountEventType,
  isAccountEventSecret,
  signAccountEvent,
} from "@odentia/auth/account-events"
import { type AccountApp, EXTERNAL_ACCOUNT_APPS } from "@odentia/auth/apps"
import type { Db } from "@odentia/db"
import { userGlobalBlock } from "@odentia/db/schema/admin-organizations"
import { accountEvent, user } from "@odentia/db/schema/auth"
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"

/**
 * Los avisos de la cuenta a las apps que son otro sistema (ADR 0201): que una cuenta se
 * cerró, se bloqueó o se reabrió. Se escriben en la misma transacción que el cambio, para
 * todas esas apps, estén configuradas o no: la que se configure después recibe lo que pasó
 * antes. Los de una misma persona llegan en orden: uno no sale mientras otro anterior suyo
 * a esa app no se haya recibido.
 *
 * Se mandan en el momento (la API, al terminar el cierre) y, si fallan, el trabajador los
 * reintenta: cada vuelta toma los que tocan, sin pisarse con otra (`skip locked`). Repetir
 * un aviso es seguro por el acuerdo: la app reconoce un repetido por su `webhook-id`, que
 * es el id de la fila y no cambia.
 */

/** Dónde y con qué secreto se avisa a una app. Sin esto, sus avisos esperan. */
export interface AccountEventSender {
  app: AccountApp
  url: string
  secret: string
}

/** Lo que dice el entorno de cada app (`<APP>_ACCOUNT_EVENTS_URL` y `_SECRET`); solo lo completo. */
export function accountEventSendersFromEnv(env: {
  GESTORIA_ACCOUNT_EVENTS_URL?: string | undefined
  GESTORIA_ACCOUNT_EVENTS_SECRET?: string | undefined
}): { senders: AccountEventSender[]; problems: string[] } {
  const configured: Partial<
    Record<AccountApp, { url?: string | undefined; secret?: string | undefined }>
  > = {
    gestoria: { url: env.GESTORIA_ACCOUNT_EVENTS_URL, secret: env.GESTORIA_ACCOUNT_EVENTS_SECRET },
  }
  const senders: AccountEventSender[] = []
  const problems: string[] = []
  for (const app of EXTERNAL_ACCOUNT_APPS) {
    const url = configured[app]?.url?.trim() ?? ""
    const secret = configured[app]?.secret?.trim() ?? ""
    if (!url && !secret) continue
    if (!url || !secret) {
      problems.push(
        `Los avisos de la cuenta a ${app} necesitan su dirección y su secreto: quedan esperando.`,
      )
      continue
    }
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
      problems.push(`La dirección de los avisos a ${app} va por https: quedan esperando.`)
      continue
    }
    if (!isAccountEventSecret(secret)) {
      problems.push(
        `El secreto de los avisos a ${app} es whsec_ y al menos 24 bytes en base64: quedan esperando.`,
      )
      continue
    }
    senders.push({ app, url, secret })
  }
  return { senders, problems }
}

/**
 * Anota, en la transacción del cambio, el aviso a cada app que es otro sistema. Toma una
 * llave de esa cuenta hasta terminar la transacción: dos cambios de la misma cuenta se
 * anotan uno tras otro, y su `created_at` (la hora de la base al anotarlo, no la del inicio
 * de la transacción) sigue el orden en que quedaron hechos.
 */
async function recordAccountEvent(
  tx: Db,
  userId: string,
  type: AccountEventType,
  expiresAt: Date | null = null,
): Promise<void> {
  if (EXTERNAL_ACCOUNT_APPS.length === 0) return
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account_event:${userId}`}, 0))`)
  await tx
    .insert(accountEvent)
    .values(EXTERNAL_ACCOUNT_APPS.map((app) => ({ userId, type, app, expiresAt })))
}

/** Se cerró la cuenta: cada app saca a esa persona de sus equipos y marca cerrada su copia. */
export function recordAccountClosed(tx: Db, userId: string): Promise<void> {
  return recordAccountEvent(tx, userId, "cuenta.cerrada")
}

/** Se bloqueó la cuenta, sin fecha o hasta `expiresAt`: cada app deja de dejarla entrar. */
export function recordAccountBlocked(
  tx: Db,
  userId: string,
  expiresAt: Date | null,
): Promise<void> {
  return recordAccountEvent(tx, userId, "cuenta.bloqueada", expiresAt)
}

/** Se quitó el bloqueo (también el de un cierre): cada app vuelve a dejarla entrar. */
export function recordAccountReopened(tx: Db, userId: string): Promise<void> {
  return recordAccountEvent(tx, userId, "cuenta.reabierta")
}

/** Lo más que espera la respuesta de una app. */
const ACCOUNT_EVENT_TIMEOUT_MS = 10_000

/**
 * Espera antes del intento siguiente: 30 s, 1 min, 2 min… hasta una hora. La primera es
 * mayor que lo que puede tardar la app en responder: mientras un envío espera, nadie más
 * toma ese aviso (la API y el trabajador no se pisan).
 */
export function accountEventBackoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600)
}

export interface DeliverAccountEventsResult {
  delivered: number
  failed: number
}

/**
 * Manda los avisos que tocan a cada app configurada. Antes de llamar, deja anotado el
 * intento y cuándo toca el siguiente (en su propia transacción): si el proceso se cae a
 * mitad, el aviso vuelve a salir después, y la app lo reconoce por su id.
 */
export async function deliverAccountEvents(
  ownerDb: Db,
  senders: readonly AccountEventSender[],
  opts: { fetch?: typeof fetch; now?: Date; limit?: number; timeoutMs?: number } = {},
): Promise<DeliverAccountEventsResult> {
  const send = opts.fetch ?? fetch
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const result: DeliverAccountEventsResult = { delivered: 0, failed: 0 }
  for (const sender of senders) {
    const now = opts.now ?? new Date()
    // eslint-disable-next-line no-await-in-loop
    const due = await ownerDb.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(accountEvent)
        .where(
          and(
            eq(accountEvent.app, sender.app),
            isNull(accountEvent.deliveredAt),
            lte(accountEvent.nextAttemptAt, now),
            // En orden: un bloqueo y su reapertura nunca llegan al revés.
            sql`not exists (
              select 1 from auth.account_event earlier
              where earlier.app = ${accountEvent.app}
                and earlier.user_id = ${accountEvent.userId}
                and earlier.delivered_at is null
                and (earlier.created_at, earlier.id) < (${accountEvent.createdAt}, ${accountEvent.id})
            )`,
          ),
        )
        .orderBy(asc(accountEvent.createdAt), asc(accountEvent.id))
        .limit(limit)
        .for("update", { skipLocked: true })
      for (const row of rows) {
        const wait = accountEventBackoffSeconds(row.attempts + 1)
        await tx
          .update(accountEvent)
          .set({
            attempts: sql`${accountEvent.attempts} + 1`,
            nextAttemptAt: new Date(now.getTime() + wait * 1000),
          })
          .where(eq(accountEvent.id, row.id))
      }
      return rows
    })
    for (const row of due) {
      const payload: AccountEventPayload = {
        type: row.type as AccountEventType,
        timestamp: row.createdAt.toISOString(),
        data:
          row.type === "cuenta.bloqueada"
            ? { userId: row.userId, expiresAt: row.expiresAt?.toISOString() ?? null }
            : { userId: row.userId },
      }
      const body = JSON.stringify(payload)
      let error: string | null = null
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await send(sender.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...signAccountEvent({ secret: sender.secret, id: row.id, body }),
          },
          body,
          signal: AbortSignal.timeout(
            Math.min(opts.timeoutMs ?? ACCOUNT_EVENT_TIMEOUT_MS, ACCOUNT_EVENT_TIMEOUT_MS),
          ),
          redirect: "manual",
        })
        if (response.status < 200 || response.status >= 300)
          error = `La app respondió ${response.status}`
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "No se pudo llamar a la app"
      }
      // eslint-disable-next-line no-await-in-loop
      await ownerDb
        .update(accountEvent)
        .set(
          error ? { lastError: error.slice(0, 500) } : { deliveredAt: new Date(), lastError: null },
        )
        // Uno ya recibido no vuelve a marcarse con error.
        .where(and(eq(accountEvent.id, row.id), isNull(accountEvent.deliveredAt)))
      if (error) result.failed += 1
      else result.delivered += 1
    }
  }
  return result
}

/** Lo más que una app puede preguntar de una vez en la revisión de su copia. */
export const ACCOUNT_REVIEW_LIMIT = 500

/** Lo que la cuenta le dice a una app de una persona que ya conoce. */
export interface ReviewedAccount {
  userId: string
  /** No existe: la app no la conoce de esta cuenta. */
  found: boolean
  /** Cerrada o bloqueada: no puede entrar. Cerrar avisa aparte (`cuenta.cerrada`). */
  blocked: boolean
  name: string | null
  email: string | null
  emailVerified: boolean
  image: string | null
}

/**
 * La revisión de la copia de las cuentas en una app que es otro sistema (decisión 11 del
 * lienzo A, ADR 0201): la app pregunta por las personas que ya conoce (por id, nunca por
 * correo: no sirve para buscar a nadie) y la cuenta responde lo vigente. Es la última red de
 * los avisos: lo que no llegó por aviso, llega aquí una vez al día. Solo lectura.
 */
export async function reviewAccounts(ownerDb: Db, userIds: readonly string[]): Promise<ReviewedAccount[]> {
  const ids = [...new Set(userIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))]
  if (ids.length === 0) return []
  if (ids.length > ACCOUNT_REVIEW_LIMIT)
    throw new Error(`La revisión pregunta por ${ACCOUNT_REVIEW_LIMIT} cuentas como mucho`)
  const now = new Date()
  const rows = await ownerDb
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      blockedBy: userGlobalBlock.userId,
    })
    .from(user)
    .leftJoin(
      userGlobalBlock,
      and(
        eq(userGlobalBlock.userId, user.id),
        eq(userGlobalBlock.active, true),
        or(isNull(userGlobalBlock.expiresAt), gt(userGlobalBlock.expiresAt, now)),
      ),
    )
    .where(inArray(user.id, ids))
  const byId = new Map(rows.map((row) => [row.userId, row]))
  return ids.map((userId) => {
    const row = byId.get(userId)
    if (!row)
      return { userId, found: false, blocked: false, name: null, email: null, emailVerified: false, image: null }
    return {
      userId,
      found: true,
      blocked: row.blockedBy !== null,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified,
      image: row.image,
    }
  })
}
