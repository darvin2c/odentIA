import { type Db, store, storeEvent, storeSupportAccess } from "@gestoria/db"
import type { AdminRequest } from "@odentia/contract"
import { and, desc, eq, gt, isNull } from "drizzle-orm"
import { z } from "zod"
import { StoreError } from "./tiendas.js"

/**
 * La entrada de soporte a una tienda (ADR 0213, como la de las clínicas): la administración la
 * pide por el acuerdo, a nombre de una persona de su equipo, por un rato y para algo. Entra solo
 * si el Dueño o un Administrador la acepta; entra con su propia cuenta, solo a mirar (`support`
 * en `permisos.ts`), y hasta que vence o se la quitan. Todo queda en `store_event`.
 */

/** Cuánto espera un pedido a que la tienda lo acepte. */
export const SUPPORT_REQUEST_HOURS = 24

export type SupportAccessRow = typeof storeSupportAccess.$inferSelect

/** Cómo lo ve la tienda: por aceptar, adentro, terminado (venció o se quitó) o rechazado. */
export type SupportAccessStatus = "por_aceptar" | "vigente" | "terminado" | "rechazado"

export function supportStatusOf(row: SupportAccessRow, now = new Date()): SupportAccessStatus {
  if (row.state === "pedido")
    return row.requestExpiresAt > now ? "por_aceptar" : "terminado"
  if (row.state === "aceptado" && row.expiresAt && row.expiresAt > now) return "vigente"
  if (row.state === "rechazado") return "rechazado"
  return "terminado"
}

/**
 * El pedido de la administración (con el dueño de la base): queda por aceptar. Si la misma
 * persona ya lo tiene pedido y sin responder, no se repite.
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
    return { status: "hecho", message: "Ya estaba pedido: la tienda todavía no responde." }
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

/** Las tiendas que esta persona de soporte puede mirar ahora, para elegir al entrar. */
export async function supportStoresOf(tx: Db, userId: string, now = new Date()) {
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

/** Lo que la tienda ve de soporte en su equipo: lo pedido, lo vigente y lo último que pasó. */
export async function supportForTeam(tx: Db, storeId: string, now = new Date()) {
  const rows = await tx
    .select()
    .from(storeSupportAccess)
    .where(eq(storeSupportAccess.storeId, storeId))
    .orderBy(desc(storeSupportAccess.createdAt))
    .limit(10)
  return rows.map((row) => ({
    id: row.id,
    staffName: row.staffName,
    minutes: row.minutes,
    reason: row.reason,
    status: supportStatusOf(row, now),
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
  }))
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
    .set({ state: accept ? "aceptado" : "rechazado", answeredAt: now, answeredBy: userId, expiresAt })
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
