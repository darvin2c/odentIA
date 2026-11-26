import {
  accountCopy,
  type Db,
  enterStore,
  store,
  storeEvent,
  storeSupportAccess,
} from "@gestoria/db"
import type { AdminRequest } from "@odentia/contract"
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm"
import { z } from "zod"
import type { StoreSeat } from "./permisos.js"
import { StoreError } from "./tiendas.js"

/**
 * La entrada de soporte a una tienda (ADR 0214, como la de las clínicas): la administración la
 * pide por el acuerdo, a nombre de una persona de su equipo, por un rato y para algo. Entra solo
 * si el Dueño o un Administrador la acepta; entra con su propia cuenta, solo a mirar (`support`
 * en `permisos.ts`), y hasta que vence o se la quitan. Todo queda en `store_event`.
 *
 * Mira solo desde la administración (ADR 0219): el token de la cuenta dice si la sesión pasó el
 * código del personal (`staffVerified`) y, sin eso, la tienda no sale en su lista ni se abre. A
 * quien tuvo una entrada, el servidor le dice cómo está la suya; a cualquier otra persona, la
 * tienda no existe.
 */

/** Cuánto espera un pedido a que la tienda lo acepte. */
export const SUPPORT_REQUEST_HOURS = 24

export type SupportAccessRow = typeof storeSupportAccess.$inferSelect

/** Cómo lo ve la tienda: por aceptar, adentro, terminado (venció o se quitó) o rechazado. */
export type SupportAccessStatus = "por_aceptar" | "vigente" | "terminado" | "rechazado"

export function supportStatusOf(row: SupportAccessRow, now = new Date()): SupportAccessStatus {
  if (row.state === "pedido") return row.requestExpiresAt > now ? "por_aceptar" : "terminado"
  if (row.state === "aceptado" && row.expiresAt && row.expiresAt > now) return "vigente"
  if (row.state === "rechazado") return "rechazado"
  return "terminado"
}

/**
 * El pedido de la administración (con el dueño de la base): queda por aceptar. Un pedido por vez:
 * si la misma persona ya lo tiene pedido y sin responder, este falla con su motivo (la tienda solo
 * vería el primero).
 */
export async function receiveSupportRequest(
  tx: Db,
  data: Extract<AdminRequest, { type: "soporte.entrar" }>["data"],
  now = new Date(),
): Promise<{ status: "hecho" | "fallo"; message: string }> {
  const storeId = data.account
  if (!z.uuid().safeParse(storeId).success)
    return { status: "fallo", message: "Esa tienda no existe en gestorIA." }
  const [shop] = await tx.select({ id: store.id }).from(store).where(eq(store.id, storeId))
  if (!shop) return { status: "fallo", message: "Esa tienda no existe en gestorIA." }
  const [pending] = await tx
    .select({ id: storeSupportAccess.id })
    .from(storeSupportAccess)
    .where(
      and(
        eq(storeSupportAccess.storeId, storeId),
        eq(storeSupportAccess.staffUserId, data.staff.userId),
        eq(storeSupportAccess.state, "pedido"),
        gt(storeSupportAccess.requestExpiresAt, now),
      ),
    )
  if (pending)
    return {
      status: "fallo",
      message:
        "Ya lo pediste y la tienda todavía no responde. Espera su respuesta o a que venza el pedido (24 horas).",
    }
  await tx.insert(storeSupportAccess).values({
    storeId,
    staffUserId: data.staff.userId,
    staffName: data.staff.name,
    minutes: data.minutes,
    reason: data.reason,
    requestExpiresAt: new Date(now.getTime() + SUPPORT_REQUEST_HOURS * 3_600_000),
    createdAt: now,
  })
  await tx.insert(storeEvent).values({
    storeId,
    actorUserId: null,
    action: "soporte.pedido",
    subject: data.staff.userId,
    detail: { nombre: data.staff.name, minutos: data.minutes, motivo: data.reason },
  })
  return {
    status: "hecho",
    message: "Pedido a la tienda: su Dueño o un Administrador decide si entras.",
  }
}

/**
 * La entrada vigente de soporte de esta persona en la tienda, o null. Dentro de la transacción de
 * la persona: la regla de la base solo le deja ver las suyas.
 */
export async function activeSupportOf(
  tx: Db,
  storeId: string,
  userId: string,
  now = new Date(),
): Promise<SupportAccessRow | null> {
  const [row] = await tx
    .select()
    .from(storeSupportAccess)
    .where(
      and(
        eq(storeSupportAccess.storeId, storeId),
        eq(storeSupportAccess.staffUserId, userId),
        eq(storeSupportAccess.state, "aceptado"),
        gt(storeSupportAccess.expiresAt, now),
      ),
    )
    .orderBy(desc(storeSupportAccess.expiresAt))
    .limit(1)
  return row ?? null
}

/** La primera vez que soporte entra con esa entrada queda anotada (ya dentro de la tienda). */
export async function noteSupportEntry(
  tx: Db,
  storeId: string,
  access: SupportAccessRow,
  now = new Date(),
): Promise<void> {
  if (access.usedAt) return
  const [first] = await tx
    .update(storeSupportAccess)
    .set({ usedAt: now })
    .where(and(eq(storeSupportAccess.id, access.id), isNull(storeSupportAccess.usedAt)))
    .returning({ id: storeSupportAccess.id })
  if (first)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: access.staffUserId,
      action: "soporte.entro",
      subject: access.staffUserId,
      detail: { nombre: access.staffName },
    })
}

/**
 * Las tiendas que esta persona de soporte puede mirar ahora, para elegir al entrar. Sin el código
 * del personal en esta sesión, ninguna: se abren desde la administración.
 */
export async function supportStoresOf(
  tx: Db,
  userId: string,
  staffVerified: boolean,
  now = new Date(),
) {
  if (!staffVerified) return []
  return tx
    .select({
      id: store.id,
      name: store.name,
      currency: store.currency,
      until: storeSupportAccess.expiresAt,
    })
    .from(storeSupportAccess)
    .innerJoin(store, eq(store.id, storeSupportAccess.storeId))
    .where(
      and(
        eq(storeSupportAccess.staffUserId, userId),
        eq(storeSupportAccess.state, "aceptado"),
        gt(storeSupportAccess.expiresAt, now),
      ),
    )
}

/**
 * Cómo terminó una entrada: se terminó el tiempo, la sacó alguien de la tienda, salió soporte, la
 * tienda dijo que no o nadie respondió a tiempo.
 */
export type SupportEnding = "tiempo" | "quitado" | "salio" | "rechazado" | "sin_respuesta"

/** Cómo terminó una entrada que ya no está por aceptar ni vigente, cuándo y quién (si fue alguien). */
export function endingOf(
  row: SupportAccessRow,
  now = new Date(),
): { reason: SupportEnding; at: Date; by: string | null } | null {
  const status = supportStatusOf(row, now)
  if (status === "por_aceptar" || status === "vigente") return null
  if (row.state === "rechazado")
    return { reason: "rechazado", at: row.answeredAt ?? row.createdAt, by: row.answeredBy }
  if (row.state === "quitado" && row.endedAt)
    return row.endedBy === row.staffUserId
      ? { reason: "salio", at: row.endedAt, by: null }
      : { reason: "quitado", at: row.endedAt, by: row.endedBy }
  if (row.state === "aceptado" && row.expiresAt)
    return { reason: "tiempo", at: row.expiresAt, by: null }
  return { reason: "sin_respuesta", at: row.requestExpiresAt, by: null }
}

/** Los nombres de quienes respondieron o sacaron a soporte (dentro de la tienda: su equipo). */
async function namesOf(tx: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return new Map()
  const rows = await tx
    .select({ userId: accountCopy.userId, name: accountCopy.name })
    .from(accountCopy)
    .where(inArray(accountCopy.userId, wanted))
  return new Map(rows.map((row) => [row.userId, row.name]))
}

/**
 * Lo que la tienda ve de soporte en su equipo (ya dentro de ella). El Dueño y un Administrador:
 * lo pedido, lo vigente y lo último que pasó, con quién lo dejó entrar, si entró y cómo terminó.
 * Ventas: solo quién mira ahora y hasta cuándo, sin el «Para qué». Soporte no lo ve: ya tiene su
 * franja.
 */
export async function supportForTeam(tx: Db, storeId: string, seat: StoreSeat, now = new Date()) {
  if (seat === "support") return []
  const rows = await tx
    .select()
    .from(storeSupportAccess)
    .where(eq(storeSupportAccess.storeId, storeId))
    .orderBy(desc(storeSupportAccess.createdAt))
    .limit(10)
  if (seat === "sales")
    return rows
      .filter((row) => supportStatusOf(row, now) === "vigente")
      .map((row) => ({
        id: row.id,
        staffName: row.staffName,
        status: "vigente" as const,
        expiresAt: row.expiresAt,
        usedAt: row.usedAt,
      }))
  const names = await namesOf(
    tx,
    rows.flatMap((row) => [row.answeredBy, row.endedBy]),
  )
  return rows.map((row) => {
    const ending = endingOf(row, now)
    return {
      id: row.id,
      staffName: row.staffName,
      minutes: row.minutes,
      reason: row.reason,
      status: supportStatusOf(row, now),
      requestedAt: row.createdAt,
      answeredAt: row.answeredAt,
      answeredBy: row.answeredBy,
      answeredByName: row.answeredBy ? (names.get(row.answeredBy) ?? null) : null,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      ending: ending
        ? {
            reason: ending.reason,
            at: ending.at,
            by: ending.by,
            byName: ending.by ? (names.get(ending.by) ?? null) : null,
          }
        : null,
    }
  })
}

/** Cómo está la entrada de esta persona de soporte en una tienda, dicho por el servidor. */
export type MySupportState =
  | { state: "pendiente"; requestedAt: Date }
  | { state: "falta_codigo"; until: Date }
  | { state: "puede_mirar"; until: Date }
  | { state: "terminado"; reason: SupportEnding; at: Date; byName: string | null }

/**
 * La entrada de esta persona en la tienda (la regla de la base solo le deja ver las suyas): la
 * vigente si hay; si no, la última. Null si nunca tuvo una: para ella, la tienda no existe. Para
 * decir quién la sacó se entra un momento a la tienda a leer solo ese nombre, y se sale.
 */
export async function supportStateOf(
  tx: Db,
  storeId: string,
  person: { userId: string; staffVerified?: boolean },
  now = new Date(),
): Promise<MySupportState | null> {
  const active = await activeSupportOf(tx, storeId, person.userId, now)
  if (active?.expiresAt)
    return person.staffVerified
      ? { state: "puede_mirar", until: active.expiresAt }
      : { state: "falta_codigo", until: active.expiresAt }
  const [last] = await tx
    .select()
    .from(storeSupportAccess)
    .where(
      and(
        eq(storeSupportAccess.storeId, storeId),
        eq(storeSupportAccess.staffUserId, person.userId),
      ),
    )
    .orderBy(desc(storeSupportAccess.createdAt))
    .limit(1)
  if (!last) return null
  if (supportStatusOf(last, now) === "por_aceptar")
    return { state: "pendiente", requestedAt: last.createdAt }
  const ending = endingOf(last, now)
  if (!ending) return null
  let byName: string | null = null
  if (ending.by) {
    await enterStore(tx, storeId)
    byName = (await namesOf(tx, [ending.by])).get(ending.by) ?? null
    await enterStore(tx, "")
  }
  return { state: "terminado", reason: ending.reason, at: ending.at, byName }
}

/** El estado de la entrada como error de la tienda: así cada pedido de soporte lo dice. */
export function supportStateError(state: MySupportState): StoreError {
  if (state.state === "pendiente")
    return new StoreError(403, "SUPPORT_PENDING", "La tienda todavía no responde.")
  if (state.state === "falta_codigo")
    return new StoreError(
      403,
      "SUPPORT_NEEDS_ADMIN",
      "Para mirar esta tienda, ábrela desde la administración.",
    )
  return new StoreError(403, "SUPPORT_ENDED", "El acceso terminó.")
}

/** La entrada de la tienda en la que se está, bloqueada para responderla (dos clics no la cruzan). */
async function accessIn(tx: Db, storeId: string, accessId: string) {
  if (!z.uuid().safeParse(accessId).success) return null
  const [row] = await tx
    .select()
    .from(storeSupportAccess)
    .where(and(eq(storeSupportAccess.id, accessId), eq(storeSupportAccess.storeId, storeId)))
    .for("update")
  return row ?? null
}

/**
 * El Dueño o un Administrador acepta o rechaza el pedido (`equipo.gestionar`, ya comprobado por
 * quien llama, dentro de la tienda). Aceptado, soporte entra desde ahora por los minutos pedidos.
 */
export async function answerSupportIn(
  tx: Db,
  storeId: string,
  userId: string,
  accessId: string,
  accept: boolean,
  now = new Date(),
) {
  const row = await accessIn(tx, storeId, accessId)
  if (!row) throw new StoreError(404, "NOT_FOUND", "Ese pedido de soporte ya no está.")
  if (supportStatusOf(row, now) !== "por_aceptar")
    throw new StoreError(409, "ANSWERED", "Ese pedido ya se respondió o venció.")
  const expiresAt = accept ? new Date(now.getTime() + row.minutes * 60_000) : null
  await tx
    .update(storeSupportAccess)
    .set({
      state: accept ? "aceptado" : "rechazado",
      answeredAt: now,
      answeredBy: userId,
      expiresAt,
    })
    .where(eq(storeSupportAccess.id, row.id))
  await tx.insert(storeEvent).values({
    storeId,
    actorUserId: userId,
    action: accept ? "soporte.aceptado" : "soporte.rechazado",
    subject: row.staffUserId,
    detail: { nombre: row.staffName, ...(expiresAt ? { hasta: expiresAt.toISOString() } : {}) },
  })
}

/** Quita una entrada vigente antes de que venza. */
export async function endSupportIn(
  tx: Db,
  storeId: string,
  userId: string,
  accessId: string,
  now = new Date(),
) {
  const row = await accessIn(tx, storeId, accessId)
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa entrada de soporte ya no está.")
  if (supportStatusOf(row, now) !== "vigente")
    throw new StoreError(409, "ENDED", "Esa entrada ya terminó.")
  await tx
    .update(storeSupportAccess)
    .set({ state: "quitado", endedAt: now, endedBy: userId })
    .where(eq(storeSupportAccess.id, row.id))
  await tx.insert(storeEvent).values({
    storeId,
    actorUserId: userId,
    action: "soporte.quitado",
    subject: row.staffUserId,
    detail: { nombre: row.staffName },
  })
}

/**
 * Soporte termina su mirada antes de que venza («Salir» de la franja): solo la suya y solo la
 * entrada, nunca su sesión de la cuenta, que es la misma de la administración.
 */
export async function leaveSupportIn(tx: Db, storeId: string, userId: string, now = new Date()) {
  const active = await activeSupportOf(tx, storeId, userId, now)
  if (!active) throw new StoreError(409, "ENDED", "Esa entrada ya terminó.")
  // La regla de la base deja anotar el cambio solo dentro de la tienda.
  await enterStore(tx, storeId)
  const row = await accessIn(tx, storeId, active.id)
  if (!row || row.staffUserId !== userId || supportStatusOf(row, now) !== "vigente")
    throw new StoreError(409, "ENDED", "Esa entrada ya terminó.")
  await tx
    .update(storeSupportAccess)
    .set({ state: "quitado", endedAt: now, endedBy: userId })
    .where(eq(storeSupportAccess.id, row.id))
  await tx.insert(storeEvent).values({
    storeId,
    actorUserId: userId,
    action: "soporte.salio",
    subject: userId,
    detail: { nombre: row.staffName },
  })
}
