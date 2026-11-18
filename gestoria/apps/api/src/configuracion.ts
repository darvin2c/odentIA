import {
  type Db,
  DELIVERY_COSTS,
  DELIVERY_TYPES,
  PAYMENT_COLLECTIONS,
  PAYMENT_TYPE_CODES,
  storeDeliveryMethod,
  storeEvent,
  storePaymentMethod,
} from "@gestoria/db"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los medios de pago y las formas de entrega de una tienda (paso B3, tablero 6): un nombre
 * libre y un tipo de una lista estándar, como «Medios de pago» de odentIA. Lo ven todos los del
 * equipo; lo cambian el Dueño y el Administrador. Lo que se apaga, Sofi deja de ofrecerlo.
 */

/** Lo más que una tienda puede tener de cada lista. */
export const MAX_METHODS = 30

/** El orden en que cobra Sofi (tablero 14): link, después captura y al final al recibir. */
const COLLECTION_RANK: Record<(typeof PAYMENT_COLLECTIONS)[number], number> = {
  link: 0,
  comprobante: 1,
  al_recibir: 2,
}

const cents = z.number().int("Escribe un monto válido").min(0).max(100_000_000)
const positive = z
  .number()
  .int("Escribe un monto válido")
  .min(1, "Debe ser mayor que 0")
  .max(100_000_000)

export const paymentInput = z
  .object({
    name: z.string().trim().min(1, "Escribe cómo lo dirá Sofi").max(80, "Máximo 80 caracteres"),
    typeCode: z.enum(PAYMENT_TYPE_CODES),
    collection: z.enum(PAYMENT_COLLECTIONS),
    details: z.string().trim().max(500, "Máximo 500 caracteres").default(""),
    isActive: z.boolean().default(true),
  })
  .refine((m) => m.typeCode !== "10" || m.collection === "al_recibir", {
    message: "El efectivo se cobra al recibir",
    path: ["collection"],
  })

export const paymentPatch = paymentInput.or(z.object({ isActive: z.boolean() }))

const zone = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de la zona").max(60),
  priceCents: cents,
})

export const deliveryInput = z
  .object({
    name: z.string().trim().min(1, "Escribe cómo lo dirá Sofi").max(80, "Máximo 80 caracteres"),
    type: z.enum(DELIVERY_TYPES),
    details: z.string().trim().max(300, "Máximo 300 caracteres").default(""),
    cost: z.enum(DELIVERY_COSTS),
    priceCents: cents.nullable().default(null),
    zones: z.array(zone).max(30, "Hasta 30 zonas").default([]),
    eta: z.string().trim().max(120, "Máximo 120 caracteres").default(""),
    acceptsPayOnDelivery: z.boolean().default(false),
    maxDiscountCents: positive.nullable().default(null),
    freeFromCents: positive.nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (d.cost === "fijo" && d.priceCents === null)
      ctx.addIssue({ code: "custom", path: ["priceCents"], message: "Escribe el precio del envío" })
    if (d.cost === "por_zona" && d.zones.length === 0)
      ctx.addIssue({ code: "custom", path: ["zones"], message: "Agrega al menos una zona" })
    if (d.cost !== "fijo" && d.cost !== "por_zona" && (d.maxDiscountCents ?? d.freeFromCents))
      ctx.addIssue({
        code: "custom",
        path: ["maxDiscountCents"],
        message: "Solo se negocia un envío que cuesta",
      })
  })
  // Lo que no aplica al costo elegido no se guarda.
  .transform((d) => ({
    ...d,
    priceCents: d.cost === "fijo" ? d.priceCents : null,
    zones: d.cost === "por_zona" ? d.zones : [],
    maxDiscountCents: d.cost === "fijo" || d.cost === "por_zona" ? d.maxDiscountCents : null,
    freeFromCents: d.cost === "fijo" || d.cost === "por_zona" ? d.freeFromCents : null,
  }))

export const deliveryPatch = deliveryInput.or(z.object({ isActive: z.boolean() }))

const uuid = z.uuid()
function idOf(id: string, what: string): string {
  if (!uuid.safeParse(id).success) throw new StoreError(404, "NOT_FOUND", `Ese ${what} ya no está`)
  return id
}

export async function paymentsAndDeliveries(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const payments = await tx
      .select()
      .from(storePaymentMethod)
      .where(eq(storePaymentMethod.storeId, storeId))
      .orderBy(asc(storePaymentMethod.createdAt))
    const deliveries = await tx
      .select()
      .from(storeDeliveryMethod)
      .where(eq(storeDeliveryMethod.storeId, storeId))
      .orderBy(asc(storeDeliveryMethod.createdAt))
    return {
      payments: payments
        .map(({ storeId: _, ...m }) => m)
        .sort((a, b) => COLLECTION_RANK[a.collection] - COLLECTION_RANK[b.collection]),
      deliveries: deliveries.map(({ storeId: _, ...m }) => m),
    }
  })
}

async function underLimit(
  tx: Db,
  table: typeof storePaymentMethod | typeof storeDeliveryMethod,
  storeId: string,
) {
  const rows = await tx.select({ id: table.id }).from(table).where(eq(table.storeId, storeId))
  if (rows.length >= MAX_METHODS)
    throw new StoreError(
      409,
      "TOO_MANY",
      `Hasta ${MAX_METHODS} por tienda. Borra los que ya no usas.`,
    )
}

export async function createPayment(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof paymentInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await underLimit(tx, storePaymentMethod, storeId)
    const [row] = await tx
      .insert(storePaymentMethod)
      .values({ storeId, ...input })
      .returning()
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: input.name,
      detail: { creado: row!.id },
    })
    return row!
  })
}

export async function updatePayment(
  appDb: Db,
  person: Person,
  storeId: string,
  id: string,
  patch: z.infer<typeof paymentPatch>,
) {
  idOf(id, "medio de pago")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .update(storePaymentMethod)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(storePaymentMethod.id, id), eq(storePaymentMethod.storeId, storeId)))
      .returning()
    if (!row) throw new StoreError(404, "NOT_FOUND", "Ese medio de pago ya no está")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: row.name,
      detail: { cambiado: id, ...patch },
    })
    return row
  })
}

export async function deletePayment(appDb: Db, person: Person, storeId: string, id: string) {
  idOf(id, "medio de pago")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(storePaymentMethod)
      .where(and(eq(storePaymentMethod.id, id), eq(storePaymentMethod.storeId, storeId)))
      .returning({ name: storePaymentMethod.name })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Ese medio de pago ya no está")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: row.name,
      detail: { borrado: id },
    })
  })
}

export async function createDelivery(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof deliveryInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await underLimit(tx, storeDeliveryMethod, storeId)
    const [row] = await tx
      .insert(storeDeliveryMethod)
      .values({ storeId, ...input })
      .returning()
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: input.name,
      detail: { creado: row!.id },
    })
    return row!
  })
}

export async function updateDelivery(
  appDb: Db,
  person: Person,
  storeId: string,
  id: string,
  patch: z.infer<typeof deliveryPatch>,
) {
  idOf(id, "forma de entrega")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .update(storeDeliveryMethod)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(storeDeliveryMethod.id, id), eq(storeDeliveryMethod.storeId, storeId)))
      .returning()
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa forma de entrega ya no está")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: row.name,
      detail: { cambiado: id, ...patch },
    })
    return row
  })
}

export async function deleteDelivery(appDb: Db, person: Person, storeId: string, id: string) {
  idOf(id, "forma de entrega")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(storeDeliveryMethod)
      .where(and(eq(storeDeliveryMethod.id, id), eq(storeDeliveryMethod.storeId, storeId)))
      .returning({ name: storeDeliveryMethod.name })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa forma de entrega ya no está")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: row.name,
      detail: { borrado: id },
    })
  })
}
