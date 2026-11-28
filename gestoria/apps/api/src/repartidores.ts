import {
  accountCopy,
  type Db,
  type DeliverySlot,
  MAX_DELIVERY_SLOTS,
  store,
  storeCourier,
  storeDeliveryMethod,
  storeEvent,
  storeMember,
} from "@gestoria/db"
import { and, asc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Las franjas de entrega y los repartidores de una tienda (entrega 3 del lienzo «gestorIA como
 * odentIA», tableros 6 y 23; ADR 0228). Las dos son opcionales: un pedido sin franja ni repartidor
 * sale igual («Sin franja», «Sin repartidor»). Las usan Despachos y las operaciones del pedido.
 */

/* --------------------------------------------------------------------------- las franjas */

/** «9–13 h», «9:30–13 h»: como la lee la tienda. */
export function slotLabel(slot: DeliverySlot): string {
  const hour = (minutes: number) => {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `${h}:${String(m).padStart(2, "0")}` : String(h)
  }
  return `${hour(slot.start)}–${hour(slot.end)} h`
}

const minute = z
  .number()
  .int("Elige una hora")
  .min(0, "Elige una hora")
  .max(24 * 60, "Elige una hora")

export const slotInput = z
  .object({ start: minute, end: minute })
  .refine((slot) => slot.start < slot.end, {
    message: "La franja termina después de empezar",
    path: ["end"],
  })

/** Las franjas de la tienda, en orden, sin repetirse. */
export const slotsInput = z.object({
  slots: z
    .array(slotInput)
    .max(MAX_DELIVERY_SLOTS, `Hasta ${MAX_DELIVERY_SLOTS} franjas`)
    .transform((slots) => sortSlots(slots))
    .refine(
      (slots) =>
        slots.every(
          (slot, i) => i === 0 || slotKey(slots[i - 1] as DeliverySlot) !== slotKey(slot),
        ),
      { message: "Esa franja ya está" },
    ),
})

const slotKey = (slot: DeliverySlot) => `${slot.start}-${slot.end}`

export function sortSlots(slots: DeliverySlot[]): DeliverySlot[] {
  return [...slots].sort((a, b) => a.start - b.start || a.end - b.end)
}

export const sameSlot = (a: DeliverySlot | null, b: DeliverySlot | null) =>
  a === null || b === null ? a === b : a.start === b.start && a.end === b.end

/** Las franjas de la tienda. */
export async function storeSlotsIn(tx: Db, storeId: string): Promise<DeliverySlot[]> {
  const [row] = await tx
    .select({ slots: store.deliverySlots })
    .from(store)
    .where(eq(store.id, storeId))
  return sortSlots(row?.slots ?? [])
}

/**
 * La franja de un pedido es una de las de la tienda, o la que ya tenía aunque la tienda la haya
 * quitado después (el pedido guarda su copia). Null: sin franja.
 */
export async function checkSlotIn(
  tx: Db,
  storeId: string,
  slot: DeliverySlot | null,
  current: DeliverySlot | null,
) {
  if (slot === null || sameSlot(slot, current)) return
  const slots = await storeSlotsIn(tx, storeId)
  if (!slots.some((one) => sameSlot(one, slot)))
    throw new StoreError(400, "VALIDATION_ERROR", "Elige una de las franjas de la tienda", {
      slot: "Elige una de las franjas de la tienda",
    })
}

/** «Franjas de entrega», en Configuración › Formas de entrega y zonas: quien cambia la configuración. */
export async function setDeliverySlots(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof slotsInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await tx.update(store).set({ deliverySlots: input.slots }).where(eq(store.id, storeId))
    // Una franja que se quita sale también de las zonas que la tenían (Entregas).
    const kept = new Set(input.slots.map(slotKey))
    const methods = await tx
      .select({ id: storeDeliveryMethod.id, zones: storeDeliveryMethod.zones })
      .from(storeDeliveryMethod)
      .where(eq(storeDeliveryMethod.storeId, storeId))
    for (const method of methods)
      if (method.zones.some((zone) => (zone.slots ?? []).some((s) => !kept.has(slotKey(s)))))
        await tx
          .update(storeDeliveryMethod)
          .set({
            zones: method.zones.map((zone) => ({
              ...zone,
              slots: (zone.slots ?? []).filter((s) => kept.has(slotKey(s))),
            })),
            updatedAt: new Date(),
          })
          .where(eq(storeDeliveryMethod.id, method.id))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: "Franjas de entrega",
      detail: { franjas: input.slots.map(slotLabel) },
    })
    return { slots: input.slots }
  })
}

/* ------------------------------------------------------------------------ los repartidores */

/**
 * A quién se le asigna: un repartidor que la tienda ya tiene, una persona del equipo o un nombre
 * externo sencillo, escrito ahí mismo. Null: sin repartidor.
 */
export const courierChoice = z
  .union([
    z.object({ courierId: z.uuid("Elige el repartidor") }).strict(),
    z.object({ userId: z.string().min(1).max(200) }).strict(),
    z
      .object({
        name: z
          .string()
          .trim()
          .min(1, "Escribe el nombre de quien lo lleva")
          .max(80, "Máximo 80 caracteres"),
      })
      .strict(),
  ])
  .nullable()
export type CourierChoice = z.infer<typeof courierChoice>

/**
 * El repartidor que corresponde a lo elegido, dentro de la transacción de la tienda: el que ya
 * está, la persona del equipo (con su repartidor, que se abre la primera vez) o el nombre externo
 * (el mismo si ya se escribió antes, sin mayúsculas ni espacios de más). Null: sin repartidor.
 */
export async function courierFor(
  tx: Db,
  storeId: string,
  actorUserId: string,
  choice: CourierChoice,
): Promise<{ id: string; name: string } | null> {
  if (choice === null) return null
  if ("courierId" in choice) {
    const [row] = await tx
      .select({ id: storeCourier.id, name: storeCourier.name, account: accountCopy.name })
      .from(storeCourier)
      .leftJoin(accountCopy, eq(accountCopy.userId, storeCourier.userId))
      .where(and(eq(storeCourier.storeId, storeId), eq(storeCourier.id, choice.courierId)))
    if (!row)
      throw new StoreError(400, "VALIDATION_ERROR", "Ese repartidor ya no está", {
        courier: "Ese repartidor ya no está",
      })
    return { id: row.id, name: row.account ?? row.name }
  }
  if ("userId" in choice) {
    const [member] = await tx
      .select({ userId: storeMember.userId, name: accountCopy.name })
      .from(storeMember)
      .innerJoin(accountCopy, eq(accountCopy.userId, storeMember.userId))
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, choice.userId)))
    if (!member)
      throw new StoreError(400, "VALIDATION_ERROR", "Esa persona ya no es del equipo", {
        courier: "Esa persona ya no es del equipo",
      })
    const [found] = await tx
      .select({ id: storeCourier.id })
      .from(storeCourier)
      .where(and(eq(storeCourier.storeId, storeId), eq(storeCourier.userId, member.userId)))
    if (found) return { id: found.id, name: member.name }
    const [created] = await tx
      .insert(storeCourier)
      .values({ storeId, name: member.name, userId: member.userId, createdBy: actorUserId })
      .returning({ id: storeCourier.id })
    return { id: created!.id, name: member.name }
  }
  const name = choice.name.replace(/\s+/g, " ")
  const [found] = await tx
    .select({ id: storeCourier.id, name: storeCourier.name, isActive: storeCourier.isActive })
    .from(storeCourier)
    .where(
      and(
        eq(storeCourier.storeId, storeId),
        sql`${storeCourier.userId} is null`,
        sql`lower(btrim(${storeCourier.name})) = lower(${name})`,
      ),
    )
  if (found) {
    if (!found.isActive)
      await tx.update(storeCourier).set({ isActive: true }).where(eq(storeCourier.id, found.id))
    return { id: found.id, name: found.name }
  }
  const [created] = await tx
    .insert(storeCourier)
    .values({ storeId, name, createdBy: actorUserId })
    .returning({ id: storeCourier.id })
  return { id: created!.id, name }
}

/** Un repartidor como lo ve la pantalla: el nombre de su cuenta, si es del equipo. */
export interface CourierView {
  /** Su repartidor en la tienda; null si es del equipo y todavía no llevó nada. */
  id: string | null
  /** La persona del equipo, si lo es. */
  userId: string | null
  name: string
  /** Del equipo de la tienda (no un nombre externo). */
  team: boolean
}

/**
 * A quién se le puede asignar: las personas del equipo y los nombres externos que la tienda ya
 * usó (los que dejó de usar no se ofrecen). Primero el equipo.
 */
export async function couriersIn(tx: Db, storeId: string): Promise<CourierView[]> {
  const members = await tx
    .select({ userId: storeMember.userId, name: accountCopy.name })
    .from(storeMember)
    .innerJoin(accountCopy, eq(accountCopy.userId, storeMember.userId))
    .where(eq(storeMember.storeId, storeId))
    .orderBy(asc(accountCopy.name))
  const couriers = await tx
    .select({
      id: storeCourier.id,
      name: storeCourier.name,
      userId: storeCourier.userId,
      isActive: storeCourier.isActive,
    })
    .from(storeCourier)
    .where(eq(storeCourier.storeId, storeId))
    .orderBy(asc(storeCourier.name))
  const byUser = new Map(couriers.filter((c) => c.userId).map((c) => [c.userId, c.id]))
  return [
    ...members.map((m) => ({
      id: byUser.get(m.userId) ?? null,
      userId: m.userId,
      name: m.name,
      team: true,
    })),
    ...couriers
      .filter((c) => c.userId === null && c.isActive)
      .map((c) => ({ id: c.id, userId: null, name: c.name, team: false })),
  ]
}

/** El nombre de cada repartidor de la tienda, por su id: el de su cuenta si es del equipo. */
export async function courierNamesIn(tx: Db, storeId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: storeCourier.id, name: storeCourier.name, account: accountCopy.name })
    .from(storeCourier)
    .leftJoin(accountCopy, eq(accountCopy.userId, storeCourier.userId))
    .where(eq(storeCourier.storeId, storeId))
  return new Map(rows.map((row) => [row.id, row.account ?? row.name]))
}
