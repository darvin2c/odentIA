import {
  agentGap,
  contractState,
  type Db,
  DELIVERY_COSTS,
  DELIVERY_TYPES,
  FREIGHTS,
  type PAYMENT_COLLECTIONS,
  product,
  READY_IN,
  store,
  storeAgent,
  storeDeliveryMethod,
  storeEvent,
  storeImage,
  storeInvitation,
  storeLink,
  storeMember,
  storePaymentMethod,
} from "@gestoria/db"
import { accountState } from "@odentia/contract"
import { and, asc, count, countDistinct, eq, gt, isNull } from "drizzle-orm"
import { z } from "zod"
import { BANKS, MAX_METHODS, patchOf, paymentMethodsIn } from "./cobros.js"
import type { Person } from "./cuenta.js"
import { checkZonesIn, type ZoneSent, zoneInput, zonesProblem } from "./entregas.js"
import { linkStateIn } from "./pasarela.js"
import { can } from "./permisos.js"
import { chargingPaymentsIn, setupFactsIn, setupSteps, skippedStepsIn } from "./primeros-pasos.js"
import { couriersIn, slotLabel, storeSlotsIn } from "./repartidores.js"
import { supportForTeam } from "./soporte.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los medios de pago y las formas de entrega de una tienda (paso B3, tablero 6): un nombre
 * libre y un tipo de una lista estándar, como «Medios de pago» de odentIA. Lo ven todos los del
 * equipo; lo cambian el Dueño y el Administrador. Lo que se apaga, Sofi deja de ofrecerlo.
 */

/** El orden en que cobra Sofi (tablero 14): link, después captura y al final al recibir. */
export const COLLECTION_RANK: Record<(typeof PAYMENT_COLLECTIONS)[number], number> = {
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

export const deliveryInput = z
  .object({
    name: z.string().trim().min(1, "Escribe cómo lo dirá Sofi").max(80, "Máximo 80 caracteres"),
    type: z.enum(DELIVERY_TYPES),
    details: z.string().trim().max(300, "Máximo 300 caracteres").default(""),
    cost: z.enum(DELIVERY_COSTS),
    priceCents: cents.nullable().default(null),
    zones: z.array(zoneInput).max(30, "Hasta 30 zonas").default([]),
    eta: z.string().trim().max(120, "Máximo 120 caracteres").default(""),
    acceptsPayOnDelivery: z.boolean().default(false),
    maxDiscountCents: positive.nullable().default(null),
    freeFromCents: positive.nullable().default(null),
    /** Recojo en tienda: su horario y en cuánto está listo. */
    openingHours: z
      .array(
        z
          .object({
            days: z.array(z.number().int().min(1).max(7)).min(1, "Elige los días").max(7),
            opens: z
              .number()
              .int()
              .min(0)
              .max(24 * 60),
            closes: z
              .number()
              .int()
              .min(0)
              .max(24 * 60),
          })
          .refine((h) => h.opens < h.closes, {
            message: "Cierra después de abrir",
            path: ["closes"],
          }),
      )
      .max(7, "Hasta 7 horarios")
      .default([]),
    readyIn: z.enum(READY_IN).nullable().default(null),
    /** Por agencia: con cuáles y quién paga el flete. */
    agencies: z.array(z.string().trim().min(1).max(40)).max(10, "Hasta 10 agencias").default([]),
    freight: z.enum(FREIGHTS).nullable().default(null),
    freightCents: positive.nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (d.freight === "antes" && d.freightCents === null)
      ctx.addIssue({
        code: "custom",
        path: ["freightCents"],
        message: "Escribe cuánto cobras de flete",
      })
    const zones = zonesProblem(d.zones)
    if (d.cost === "por_zona" && zones) ctx.addIssue({ code: "custom", ...zones })
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
  .transform((d) => {
    // El pago al recibir de cada zona; si no lo dice, el de la forma de entrega. Con zonas, la
    // forma acepta pago al recibir si alguna de sus zonas lo acepta.
    const zones = (d.cost === "por_zona" ? d.zones : []).map((zone) => ({
      ...zone,
      payOnDelivery: zone.payOnDelivery ?? d.acceptsPayOnDelivery,
    }))
    return {
      ...d,
      acceptsPayOnDelivery:
        zones.length > 0 ? zones.some((zone) => zone.payOnDelivery) : d.acceptsPayOnDelivery,
      freightCents: d.freight === "antes" ? d.freightCents : null,
      priceCents: d.cost === "fijo" ? d.priceCents : null,
      zones,
      maxDiscountCents: d.cost === "fijo" || d.cost === "por_zona" ? d.maxDiscountCents : null,
      freeFromCents: d.cost === "fijo" || d.cost === "por_zona" ? d.freeFromCents : null,
    }
  })

const deliveryChange = patchOf(deliveryInput)

/**
 * Un cambio a una forma de entrega, con la versión que se tenía a la vista (`version`, su
 * `updatedAt`). Guardar la forma entera sobre una versión vieja pisaría lo que cambió otra
 * pestaña u otra persona: el servidor lo rechaza (`staleProblem`). Encender o apagar no la pide.
 */
export const deliveryPatch = z.unknown().transform((raw, ctx) => {
  const { version, ...rest } =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const result = deliveryChange.safeParse(rest)
  if (!result.success) {
    for (const issue of result.error.issues)
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path })
    return z.NEVER
  }
  return { change: result.data, version: typeof version === "string" ? version : null }
})

/** Lo que se dice cuando lo que se tenía a la vista ya cambió. */
export const STALE_MESSAGE =
  "Esto cambió en otra pestaña o lo cambió otra persona. Recarga para ver lo último y vuelve a hacer tu cambio: el tuyo no se guardó."

function staleProblem(): StoreError {
  return new StoreError(409, "STALE", STALE_MESSAGE)
}

/** La forma de entrega, bloqueada hasta que termine la transacción: dos cambios van en fila. */
async function lockedDelivery(tx: Db, storeId: string, id: string) {
  const [row] = await tx
    .select()
    .from(storeDeliveryMethod)
    .where(and(eq(storeDeliveryMethod.id, id), eq(storeDeliveryMethod.storeId, storeId)))
    .for("update")
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa forma de entrega ya no está")
  return row
}

const uuid = z.uuid()
function idOf(id: string, what: string): string {
  if (!uuid.safeParse(id).success) throw new StoreError(404, "NOT_FOUND", `Ese ${what} ya no está`)
  return id
}

export async function paymentsAndDeliveries(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const payments = await paymentMethodsIn(tx, storeId)
    const deliveries = await tx
      .select()
      .from(storeDeliveryMethod)
      .where(eq(storeDeliveryMethod.storeId, storeId))
      .orderBy(asc(storeDeliveryMethod.createdAt))
    return {
      payments: payments.sort(
        (a, b) => COLLECTION_RANK[a.collection] - COLLECTION_RANK[b.collection],
      ),
      deliveries: deliveries.map(({ storeId: _, ...m }) => m),
      /** Las franjas de entrega (Despachos), opcionales: un pedido sin franja sale igual. */
      slots: (await storeSlotsIn(tx, storeId)).map((slot) => ({ ...slot, label: slotLabel(slot) })),
      /** Los bancos para la transferencia (Cobros), con su código de entidad del CCI. */
      banks: BANKS,
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

export async function createDelivery(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof deliveryInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await underLimit(tx, storeDeliveryMethod, storeId)
    const zones = await checkZonesIn(tx, storeId, null, input.zones)
    const [row] = await tx
      .insert(storeDeliveryMethod)
      .values({ storeId, ...input, zones })
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
  { change: patch, version }: z.infer<typeof deliveryPatch>,
) {
  idOf(id, "forma de entrega")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const before = await lockedDelivery(tx, storeId, id)
    // La forma entera (no solo encender o apagar) se guarda solo sobre la versión que se vio.
    if ("type" in patch && (version === null || Date.parse(version) !== before.updatedAt.getTime()))
      throw staleProblem()
    const set =
      "zones" in patch
        ? { ...patch, zones: await checkZonesIn(tx, storeId, id, patch.zones) }
        : patch
    const [row] = await tx
      .update(storeDeliveryMethod)
      .set({ ...set, updatedAt: new Date() })
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

/**
 * Un cambio a una sola zona del reparto, sobre lo que está guardado ahora (no sobre la copia de la
 * pantalla): mover un distrito, guardar una zona o quitarla. Lleva lo que se tenía a la vista de
 * esa zona (o en qué zona estaba el distrito); si ya cambió, se rechaza en lugar de pisarlo.
 */
export const zoneChange = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("distrito"),
    district: z.string().regex(/^[0-9]{6}$/, "Elige el distrito"),
    /** La zona en la que se veía el distrito; null: sin entrega. */
    from: z.string().nullable(),
    /** La zona a la que va; null: «No entrego ahí». */
    to: z.string().nullable(),
  }),
  z.object({
    op: z.literal("zona"),
    /** El nombre que tenía la zona; null: una nueva. */
    before: z.string().nullable(),
    /** La zona como se veía al abrirla (con `before`). */
    seen: z.unknown().optional(),
    zone: zoneInput,
  }),
  z.object({ op: z.literal("quitar"), name: z.string(), seen: z.unknown() }),
])

/** Lo que cuenta para saber si una zona cambió: todo, con los distritos en orden. */
function zoneKey(zone: unknown): string {
  if (typeof zone !== "object" || zone === null) return ""
  const z = zone as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).sort() : [])
  const slots = Array.isArray(z.slots)
    ? (z.slots as { start: number; end: number }[]).map((s) => `${s.start}-${s.end}`).sort()
    : []
  return JSON.stringify([
    z.name,
    z.priceCents,
    list(z.districts),
    z.lead ?? "manana",
    z.cutoff ?? null,
    list(z.weekdays),
    slots,
    z.payOnDelivery ?? null,
    z.freeShipping ?? true,
  ])
}

export async function changeZone(
  appDb: Db,
  person: Person,
  storeId: string,
  id: string,
  change: z.infer<typeof zoneChange>,
) {
  idOf(id, "forma de entrega")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const method = await lockedDelivery(tx, storeId, id)
    if (method.cost !== "por_zona") throw staleProblem()
    const current = method.zones
    const indexOf = (name: string | null) =>
      name === null ? -1 : current.findIndex((z) => z.name === name)
    let zones: ZoneSent[]
    let detail: Record<string, unknown>
    if (change.op === "distrito") {
      const now = current.find((z) => z.districts?.includes(change.district))?.name ?? null
      if (now !== change.from || (change.to !== null && indexOf(change.to) < 0))
        throw staleProblem()
      zones = current.map((z) => ({
        ...z,
        districts: [
          ...(z.districts ?? []).filter((d) => d !== change.district),
          ...(z.name === change.to ? [change.district] : []),
        ],
      }))
      detail = { distrito: change.district, de: change.from, a: change.to }
    } else if (change.op === "zona") {
      const at = indexOf(change.before)
      if (change.before !== null && (at < 0 || zoneKey(current[at]) !== zoneKey(change.seen)))
        throw staleProblem()
      const mine = new Set(change.zone.districts ?? current[at]?.districts ?? [])
      const next: ZoneSent = {
        ...change.zone,
        districts: [...mine],
        payOnDelivery: change.zone.payOnDelivery ?? current[at]?.payOnDelivery ?? true,
      }
      // Los distritos de esta zona salen de las demás: un distrito está en una sola zona.
      const rest = current.map((z) => ({
        ...z,
        districts: (z.districts ?? []).filter((d) => !mine.has(d)),
      }))
      zones = at < 0 ? [...rest, next] : rest.map((z, i) => (i === at ? next : z))
      detail = { zona: next.name, ...(change.before ? { antes: change.before } : {}) }
    } else {
      const at = indexOf(change.name)
      if (at < 0 || zoneKey(current[at]) !== zoneKey(change.seen)) throw staleProblem()
      if (current.length === 1)
        throw new StoreError(409, "LAST_ZONE", "Es la única zona: cámbiala en vez de quitarla")
      zones = current.filter((_, i) => i !== at)
      detail = { quitada: change.name }
    }
    const checked = await checkZonesIn(tx, storeId, id, zones)
    const [row] = await tx
      .update(storeDeliveryMethod)
      .set({
        zones: checked,
        acceptsPayOnDelivery: checked.some((z) => z.payOnDelivery),
        updatedAt: new Date(),
      })
      .where(and(eq(storeDeliveryMethod.id, id), eq(storeDeliveryMethod.storeId, storeId)))
      .returning()
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.entrega",
      subject: method.name,
      detail: { cambiado: id, ...detail },
    })
    return row!
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
    // Los medios con que se cobra (sin el link si no hay pasarela).
    const { payments } = await chargingPaymentsIn(tx, storeId)
    // Solo si está conectada, con qué, en qué modo y si sirve: la cuenta y sus llaves nunca
    // salen de aquí.
    const gateway = await linkStateIn(tx, storeId, now)
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
    // «Lo que aprendió»: cuántas preguntas distintas esperan respuesta de la tienda.
    const [gaps] = seesSofi
      ? await tx
          .select({ open: countDistinct(agentGap.questionKey) })
          .from(agentGap)
          .where(and(eq(agentGap.storeId, storeId), isNull(agentGap.outcome)))
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
      // Solo con qué se cobra: los datos de cobro no van al navegador.
      payments: payments.map(({ name, typeCode, collection }) => ({ name, typeCode, collection })),
      paymentLink: gateway
        ? { provider: gateway.row.provider, mode: gateway.mode, state: gateway.state }
        : null,
      deliveries: deliveries.map(({ zones, ...delivery }) => ({
        ...delivery,
        zones: zones.length,
        districts: zones.reduce((sum, zone) => sum + (zone.districts?.length ?? 0), 0),
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
      sofi: seesSofi
        ? { enabled: agent?.enabled ?? false, tried: facts.triedSofi, toAnswer: gaps?.open ?? 0 }
        : null,
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
