import { accountCopy, type Db, store, storeCourier, storeEvent, storeMember } from "@gestoria/db"
import { and, asc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { e164, personName } from "./contacto.js"
import type { Person } from "./cuenta.js"
import { unassignCourierIn } from "./pedidos.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los repartidores en Equipo y repartidores (lienzo «gestorIA · Configuración, de nuevo», tablero
 * 9; ADR 0235): quién reparte para la tienda, su celular y lo que la tienda le paga por entrega.
 * Es de `equipo.gestionar` (el Dueño y el Administrador): Ventas y soporte no ven lo que se le paga.
 *
 * El repartidor es el mismo de Despachos (`store_courier`, ADR 0228): uno de fuera que la tienda
 * suma aquí o al escribir su nombre en Despachos, o una persona del equipo que ya llevó un pedido.
 * Lo que se le paga lo anota la tienda para saber cuánto le debe: gestorIA no le paga, no lo
 * descuenta de nada y no lo suma a ninguna cifra. Su cuenta y su app (gestorIA Reparto) llegan con
 * el tablero 23 del lienzo principal: hoy no hay enlace que aceptar.
 */

/** Lo que se le paga por entrega, en la unidad menor de la moneda de la tienda. Null: nada. */
const payCents = z
  .number()
  .int("Escribe el monto")
  .min(0, "El monto no puede ser negativo")
  .max(100_000_000, "Ese monto es demasiado alto")
  .nullable()

export const courierAddInput = z.object({
  name: personName,
  phone: e164.nullable(),
  payCents,
  failedTripPaid: z.boolean(),
})

/** Lo que se cambia: del de fuera, todo; del equipo, solo su pago (su nombre es el de su cuenta). */
export const courierPatchInput = courierAddInput.partial()

/** Un repartidor como lo ve quien gestiona el equipo. */
export interface CourierRow {
  id: string
  name: string
  /** La persona del equipo, si lo es. */
  userId: string | null
  team: boolean
  phone: string | null
  payCents: number | null
  failedTripPaid: boolean
}

/**
 * Los repartidores de la tienda: los de fuera que siguen activos y las personas del equipo que ya
 * tienen su repartidor (llevaron un pedido o se les fijó un pago). Primero los de fuera. Con
 * `courierId`, solo ese.
 */
export async function storeCouriersIn(
  tx: Db,
  storeId: string,
  courierId?: string,
): Promise<CourierRow[]> {
  const rows = await tx
    .select({
      id: storeCourier.id,
      name: storeCourier.name,
      account: accountCopy.name,
      userId: storeCourier.userId,
      phone: storeCourier.phone,
      payCents: storeCourier.payCents,
      failedTripPaid: storeCourier.failedTripPaid,
    })
    .from(storeCourier)
    .leftJoin(accountCopy, eq(accountCopy.userId, storeCourier.userId))
    .leftJoin(
      storeMember,
      and(
        eq(storeMember.storeId, storeCourier.storeId),
        eq(storeMember.userId, storeCourier.userId),
      ),
    )
    .where(
      and(
        eq(storeCourier.storeId, storeId),
        courierId ? eq(storeCourier.id, courierId) : undefined,
        // Quien dejó el equipo deja de repartir: lo que llevó sigue con su nombre en sus pedidos.
        sql`(${storeCourier.userId} is null and ${storeCourier.isActive}) or ${storeMember.userId} is not null`,
      ),
    )
    .orderBy(asc(storeCourier.name))
  return rows
    .map((row) => ({
      id: row.id,
      name: row.account ?? row.name,
      userId: row.userId,
      team: row.userId !== null,
      phone: row.phone,
      payCents: row.payCents,
      failedTripPaid: row.failedTripPaid,
    }))
    .sort((a, b) => Number(a.team) - Number(b.team))
}

/** La lista de Equipo y repartidores; la moneda del pago es la de la tienda. */
export async function storeCouriers(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx) => ({
    couriers: await storeCouriersIn(tx, storeId),
  }))
}

/** El que se acaba de guardar, como lo ve la pantalla. */
async function courierRowIn(tx: Db, storeId: string, courierId: string): Promise<CourierRow> {
  const [row] = await storeCouriersIn(tx, storeId, courierId)
  if (!row) throw new StoreError(404, "NOT_FOUND", "Ese repartidor ya no está")
  return row
}

/** Lo que se anota de un repartidor: su pago, en la moneda de la tienda (la unidad menor). */
async function payDetail(
  tx: Db,
  storeId: string,
  row: { payCents: number | null; failedTripPaid: boolean },
) {
  const [shop] = await tx
    .select({ currency: store.currency })
    .from(store)
    .where(eq(store.id, storeId))
  return {
    pagoPorEntrega: row.payCents === null ? null : { cents: row.payCents, moneda: shop?.currency },
    viajeFallidoSePaga: row.failedTripPaid,
  }
}

/** El nombre ya es de otro de fuera: uno de ahora o uno que la tienda sacó. */
const nameTaken = (field = "Ya tienes un repartidor con ese nombre") =>
  new StoreError(409, "NAME_TAKEN", "Ya tienes un repartidor con ese nombre", { name: field })

/** El de fuera con ese nombre (sin mayúsculas ni espacios de más), activo o sacado. */
async function outsiderNamed(tx: Db, storeId: string, name: string) {
  const [row] = await tx
    .select({ id: storeCourier.id, isActive: storeCourier.isActive })
    .from(storeCourier)
    .where(
      and(
        eq(storeCourier.storeId, storeId),
        sql`${storeCourier.userId} is null`,
        sql`lower(btrim(${storeCourier.name})) = lower(${name})`,
      ),
    )
    .for("update")
  return row ?? null
}

/**
 * «Invitar repartidor»: suma a alguien de fuera con su celular y su pago. Si la tienda ya lo tuvo
 * (el mismo nombre, sin mayúsculas ni espacios de más) y lo había sacado, vuelve el mismo, con lo
 * que llevó y cobró; si ya está, se dice.
 */
export async function addCourier(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof courierAddInput>,
) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx) => {
    const values = {
      phone: input.phone,
      payCents: input.payCents,
      failedTripPaid: input.failedTripPaid,
    }
    const found = await outsiderNamed(tx, storeId, input.name)
    if (found?.isActive) throw nameTaken()
    let id: string
    if (found) {
      await tx
        .update(storeCourier)
        .set({ ...values, name: input.name, isActive: true })
        .where(eq(storeCourier.id, found.id))
      id = found.id
    } else {
      const [created] = await tx
        .insert(storeCourier)
        .values({ storeId, name: input.name, createdBy: person.userId, ...values })
        .returning({ id: storeCourier.id })
      id = created!.id
    }
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "repartidor.agregado",
      subject: input.name,
      detail: await payDetail(tx, storeId, input),
    })
    return courierRowIn(tx, storeId, id)
  })
}

async function courierOf(tx: Db, storeId: string, courierId: string) {
  if (!z.uuid().safeParse(courierId).success)
    throw new StoreError(404, "NOT_FOUND", "Ese repartidor ya no está")
  const [found] = await tx
    .select({ courier: storeCourier, member: storeMember.userId })
    .from(storeCourier)
    .leftJoin(
      storeMember,
      and(
        eq(storeMember.storeId, storeCourier.storeId),
        eq(storeMember.userId, storeCourier.userId),
      ),
    )
    .where(and(eq(storeCourier.storeId, storeId), eq(storeCourier.id, courierId)))
    .for("update", { of: storeCourier })
  const row = found?.courier
  if (!row || (row.userId === null && !row.isActive))
    throw new StoreError(404, "NOT_FOUND", "Ese repartidor ya no está")
  if (row.userId !== null && found.member === null)
    throw new StoreError(404, "NOT_FOUND", "Esa persona ya no es del equipo")
  return row
}

/** Cambia su pago y, si es de fuera, su nombre y su celular. */
export async function updateCourier(
  appDb: Db,
  person: Person,
  storeId: string,
  courierId: string,
  input: z.infer<typeof courierPatchInput>,
) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx) => {
    const row = await courierOf(tx, storeId, courierId)
    if (row.userId !== null && (input.name !== undefined || input.phone !== undefined))
      throw new StoreError(
        400,
        "VALIDATION_ERROR",
        "Es del equipo: su nombre y su celular son los de su cuenta",
      )
    if (
      input.name !== undefined &&
      input.name.toLowerCase() !== row.name.trim().toLowerCase() &&
      (await outsiderNamed(tx, storeId, input.name))
    )
      throw nameTaken(
        "Ese nombre ya es de otro repartidor, de ahora o de antes. Usa otro, o suma al de antes con «Invitar repartidor».",
      )
    const next = {
      name: input.name ?? row.name,
      phone: input.phone === undefined ? row.phone : input.phone,
      payCents: input.payCents === undefined ? row.payCents : input.payCents,
      failedTripPaid: input.failedTripPaid ?? row.failedTripPaid,
    }
    await tx.update(storeCourier).set(next).where(eq(storeCourier.id, row.id))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "repartidor.cambiado",
      subject: row.userId ?? row.name,
      detail: {
        ...(next.name !== row.name ? { antes: row.name, ahora: next.name } : {}),
        ...(next.phone !== row.phone ? { celular: "cambiado" } : {}),
        ...(await payDetail(tx, storeId, next)),
      },
    })
    return courierRowIn(tx, storeId, row.id)
  })
}

/**
 * «Sacar»: deja de ofrecerse en Despachos y lo que todavía no salió con él queda «sin
 * repartidor». No se borra: lo que llevó y cobró sigue con su nombre. A alguien del equipo no se
 * le saca de aquí: se le quita del equipo.
 */
export async function removeCourier(appDb: Db, person: Person, storeId: string, courierId: string) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx) => {
    const row = await courierOf(tx, storeId, courierId)
    if (row.userId !== null)
      throw new StoreError(
        409,
        "TEAM_COURIER",
        "Es del equipo: puede repartir mientras sea del equipo. Para que no reparta, no le asignes entregas.",
      )
    await tx.update(storeCourier).set({ isActive: false }).where(eq(storeCourier.id, row.id))
    const unassigned = await unassignCourierIn(tx, storeId, row.id, person.userId)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "repartidor.quitado",
      subject: row.name,
      detail: { pedidosSinRepartidor: unassigned },
    })
    return { unassigned }
  })
}
