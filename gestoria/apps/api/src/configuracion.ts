import {
  contractState,
  type Db,
  DELIVERY_COSTS,
  DELIVERY_TYPES,
  PAYMENT_COLLECTIONS,
  PAYMENT_TYPE_CODES,
  product,
  store,
  storeAgent,
  storeDeliveryMethod,
  storeEvent,
  storeImage,
  storeInvitation,
  storeLink,
  storeMember,
  storePaymentLink,
  storePaymentMethod,
} from "@gestoria/db"
import { accountState } from "@odentia/contract"
import { and, asc, count, eq, gt, isNull } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { can } from "./permisos.js"
import { setupFactsIn, setupSteps, skippedStepsIn } from "./primeros-pasos.js"
import { couriersIn, slotLabel, storeSlotsIn } from "./repartidores.js"
import { supportForTeam } from "./soporte.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los medios de pago y las formas de entrega de una tienda (paso B3, tablero 6): un nombre
 * libre y un tipo de una lista estándar, como «Medios de pago» de odentIA. Lo ven todos los del
 * equipo; lo cambian el Dueño y el Administrador. Lo que se apaga, Sofi deja de ofrecerlo.
 */

/** Lo más que una tienda puede tener de cada lista. */
export const MAX_METHODS = 30

/** El orden en que cobra Sofi (tablero 14): link, después captura y al final al recibir. */
export const COLLECTION_RANK: Record<(typeof PAYMENT_COLLECTIONS)[number], number> = {
  link: 0,
  comprobante: 1,
  al_recibir: 2,
}

/**
 * Un cambio es encender o apagar (solo `isActive`) o el medio entero. Se elige por lo que trae,
 * no probando uno y otro: así un dato inválido vuelve con su campo y nunca se guarda a medias.
 */
function patchOf<T>(full: z.ZodType<T>) {
  const toggle = z.object({ isActive: z.boolean() }).strict()
  return z.unknown().transform((raw, ctx): T | { isActive: boolean } => {
    const onlyToggle =
      typeof raw === "object" && raw !== null && Object.keys(raw).join() === "isActive"
    const result = (onlyToggle ? toggle : full).safeParse(raw)
    if (result.success) return result.data
    for (const issue of result.error.issues)
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path })
    return z.NEVER
  })
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

export const paymentPatch = patchOf(paymentInput)

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

export const deliveryPatch = patchOf(deliveryInput)

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
      /** Las franjas de entrega (Despachos), opcionales: un pedido sin franja sale igual. */
      slots: (await storeSlotsIn(tx, storeId)).map((slot) => ({ ...slot, label: slotLabel(slot) })),
      /** A quién se le puede asignar una entrega: el equipo y los nombres externos que ya se usaron. */
      couriers: await couriersIn(tx, storeId),
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

/**
 * «Lo que falta para vender», donde abre Configuración (lienzo «gestorIA · Configuración, de
 * nuevo», tablero 3): lo guardado en cada apartado, para que la pantalla diga en una línea cómo
 * está cada parte y qué falta. Nada se marca a mano: son los mismos datos que los primeros pasos
 * de Inicio (`setupFactsIn`), más lo de cada apartado. Lo que todavía no existe (los chats, la
 * pasarela conectada entrando a la cuenta) no viene: no se dibuja.
 *
 * Lo ve quien configura la tienda (`configuracion`) y soporte, que solo mira: a soporte no le
 * llegan Sofi ni el plan (no los mira) y a nadie le llegan costos, llaves ni los datos de cobro
 * (números de cuenta, celulares): solo nombres y estados. El plan, solo a quien tiene `plan`, con
 * lo último que se supo de la administración (sin preguntarle: abrir Configuración no la espera).
 */
export async function configOverview(appDb: Db, person: Person, storeId: string, now = new Date()) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx, seat) => {
    if (!can(seat, "configuracion") && seat !== "support")
      throw new StoreError(403, "FORBIDDEN", "Tu rol en esta tienda no permite hacerlo")
    const facts = await setupFactsIn(tx, storeId, now)
    const steps = setupSteps(facts, await skippedStepsIn(tx, storeId))
    const [shop] = await tx
      .select({ publicName: store.publicName, brandColor: store.brandColor })
      .from(store)
      .where(eq(store.id, storeId))
    const images = await tx
      .select({ kind: storeImage.kind })
      .from(storeImage)
      .where(eq(storeImage.storeId, storeId))
    const [link] = await tx
      .select({ name: storeLink.name })
      .from(storeLink)
      .where(and(eq(storeLink.storeId, storeId), eq(storeLink.current, true)))
    const [products] = await tx
      .select({ n: count() })
      .from(product)
      .where(eq(product.storeId, storeId))
    const payments = await tx
      .select({
        name: storePaymentMethod.name,
        typeCode: storePaymentMethod.typeCode,
        collection: storePaymentMethod.collection,
      })
      .from(storePaymentMethod)
      .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.isActive, true)))
      .orderBy(asc(storePaymentMethod.createdAt))
    // Solo si está conectada y con qué: la cuenta y sus llaves nunca salen de aquí.
    const [paymentLink] = await tx
      .select({ provider: storePaymentLink.provider })
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    const deliveries = await tx
      .select({
        name: storeDeliveryMethod.name,
        type: storeDeliveryMethod.type,
        cost: storeDeliveryMethod.cost,
        zones: storeDeliveryMethod.zones,
        acceptsPayOnDelivery: storeDeliveryMethod.acceptsPayOnDelivery,
      })
      .from(storeDeliveryMethod)
      .where(and(eq(storeDeliveryMethod.storeId, storeId), eq(storeDeliveryMethod.isActive, true)))
      .orderBy(asc(storeDeliveryMethod.createdAt))
    const slots = await storeSlotsIn(tx, storeId)
    const [members] = await tx
      .select({ n: count() })
      .from(storeMember)
      .where(eq(storeMember.storeId, storeId))
    const [invited] = await tx
      .select({ n: count() })
      .from(storeInvitation)
      .where(
        and(
          eq(storeInvitation.storeId, storeId),
          isNull(storeInvitation.acceptedAt),
          isNull(storeInvitation.revokedAt),
          gt(storeInvitation.expiresAt, now),
        ),
      )
    const couriers = await couriersIn(tx, storeId)
    // El pedido de soporte para mirar se responde en Equipo: ahí queda su punto.
    const supportAsks = (await supportForTeam(tx, storeId, seat, now)).filter(
      (row) => row.status === "por_aceptar",
    ).length
    const seesSofi = can(seat, "configuracion")
    const [agent] = seesSofi
      ? await tx
          .select({ enabled: storeAgent.enabled })
          .from(storeAgent)
          .where(eq(storeAgent.storeId, storeId))
      : []
    return {
      steps,
      brand: {
        publicName: shop?.publicName ?? null,
        brandColor: shop?.brandColor ?? null,
        logo: images.some((image) => image.kind === "logo"),
        link: link?.name ?? null,
      },
      catalog: {
        products: Number(products?.n ?? 0),
        withStock: facts.productsWithStock,
      },
      payments,
      paymentLink: paymentLink ? { provider: paymentLink.provider } : null,
      deliveries: deliveries.map(({ zones, ...delivery }) => ({
        ...delivery,
        zones: zones.length,
      })),
      slots: slots.length,
      team: {
        members: Number(members?.n ?? 0),
        invitations: Number(invited?.n ?? 0),
        // Los repartidores externos (los del equipo ya están en «members»).
        couriers: couriers.filter((courier) => !courier.team).map((courier) => courier.name),
        names: couriers.filter((courier) => courier.team).map((courier) => courier.name),
        supportAsks,
      },
      sofi: seesSofi ? { enabled: agent?.enabled ?? false, tried: facts.triedSofi } : null,
      plan: can(seat, "plan") ? await planLineIn(tx, storeId) : null,
    }
  })
}

/**
 * La línea del plan con lo último que dijo la administración (`contract_state`), sin preguntarle:
 * su nombre, cómo está la cuenta, lo que queda del crédito del tramo y si hay un cobro por pagar
 * (su estado, tal como lo dice la administración: aquí no se suma nada). Sin nada guardado, null.
 */
async function planLineIn(tx: Db, storeId: string) {
  const [row] = await tx
    .select({ state: contractState.state })
    .from(contractState)
    .where(eq(contractState.storeId, storeId))
  const parsed = accountState.safeParse(row?.state)
  if (!parsed.success || !parsed.data.found) return null
  const { plan, access, budget, charges } = parsed.data
  return {
    name: plan?.name ?? null,
    status: access?.status ?? null,
    creditLeftCents:
      budget?.currency && budget.creditCents > 0
        ? Math.max(0, budget.creditCents - budget.creditUsedCents)
        : null,
    currency: budget?.currency ?? null,
    toPay: charges.some((charge) => charge.status === "pendiente" || charge.status === "parcial"),
  }
}
