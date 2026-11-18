import {
  type AccountEventPayload,
  isAccountEventSecret,
  signAccountEvent,
} from "@odentia/auth/account-events"
import { type AccountApp, EXTERNAL_ACCOUNT_APPS } from "@odentia/auth/apps"
import type { Db } from "@odentia/db"
import { accountEvent } from "@odentia/db/schema/auth"
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm"

/**
 * Los avisos de la cuenta a las apps que son otro sistema (ADR 0201): hoy, que se cerró
 * una cuenta, para que cada app saque a esa persona de sus equipos y marque cerrada su
 * copia. Se escriben en la misma transacción que el cierre, para todas esas apps, estén
 * configuradas o no: la que se configure después recibe lo que pasó antes.
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

/** Anota, en la transacción del cierre, el aviso a cada app que es otro sistema. */
export async function recordAccountClosed(tx: Db, userId: string): Promise<void> {
  if (EXTERNAL_ACCOUNT_APPS.length === 0) return
  await tx
    .insert(accountEvent)
    .values(EXTERNAL_ACCOUNT_APPS.map((app) => ({ userId, type: "cuenta.cerrada" as const, app })))
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
          ),
        )
        .orderBy(asc(accountEvent.createdAt))
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
        type: row.type as AccountEventPayload["type"],
        timestamp: row.createdAt.toISOString(),
        data: { userId: row.userId },
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
