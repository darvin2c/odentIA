import { accountCopy, type Db, productVariant, stockMovement } from "@gestoria/db"
import { and, desc, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { can } from "./permisos.js"
import { constraintError, inStore, StoreError } from "./tiendas.js"

/**
 * El stock de cada variante y su kardex (decisión 3 del lienzo B). El saldo no se escribe: cada
 * movimiento lo cambia en la base (`stock_movement_apply`), que anota el saldo y rechaza que
 * quede bajo cero. Aquí están las entradas y los ajustes a mano (con motivo escrito), y las dos
 * operaciones de los pedidos: dejar fuera lo de sus líneas (al venderse y en cada cambio) y
 * devolverlo al anular.
 */

const quantity = z.number().int("Escribe un número entero").max(100_000, "Es demasiado")

export const movementInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entrada"),
    quantity: quantity.min(1, "Escribe cuántas entran"),
    unitCostCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
    reason: z.string().trim().max(300).optional(),
  }),
  z.object({
    kind: z.literal("ajuste"),
    /** Cuántas hay de verdad, contadas: el ajuste es la diferencia con el saldo. */
    counted: quantity.min(0, "No puede ser menos de 0"),
    reason: z
      .string()
      .trim()
      .min(3, "Escribe el motivo del ajuste (por ejemplo, «par dañado»)")
      .max(300, "Máximo 300 caracteres"),
  }),
])

/** Corre `fn` y convierte lo que rechaza la base (no alcanza, variante quitada) en un error que se entiende. */
async function stockGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw constraintError(error) ?? error
  }
}

/** La variante de la tienda; con `lock`, tomada hasta terminar (para mover su stock). */
async function variantIn(tx: Db, storeId: string, variantId: string, lock = false) {
  if (!z.uuid().safeParse(variantId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa variante ya no está")
  const query = tx
    .select({
      id: productVariant.id,
      stock: productVariant.stock,
      removedAt: productVariant.removedAt,
    })
    .from(productVariant)
    .where(and(eq(productVariant.id, variantId), eq(productVariant.storeId, storeId)))
  const [row] = await (lock ? query.for("update") : query)
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa variante ya no está")
  return row
}

/** Una entrada o un ajuste a mano: el Dueño o el Administrador. */
export async function addMovement(
  appDb: Db,
  person: Person,
  storeId: string,
  variantId: string,
  input: z.infer<typeof movementInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const variant = await variantIn(tx, storeId, variantId, true)
    if (variant.removedAt)
      throw new StoreError(409, "VARIANT_REMOVED", "Esa variante ya no se vende")
    const values =
      input.kind === "entrada"
        ? {
            kind: "entrada" as const,
            quantity: input.quantity,
            unitCostCents: input.unitCostCents,
            reason: input.reason || null,
          }
        : { kind: "ajuste" as const, quantity: input.counted - variant.stock, reason: input.reason }
    if (values.quantity === 0)
      throw new StoreError(409, "NO_CHANGE", `Ya tiene ${variant.stock}: no hay nada que ajustar`, {
        counted: `Ya tiene ${variant.stock}`,
      })
    const [row] = await tx
      .insert(stockMovement)
      .values({ storeId, variantId, actorUserId: person.userId, ...values })
      .returning()
    return row!
  })
}

/** El kardex de una variante, del más nuevo al más viejo, con el nombre de quien lo hizo. */
export async function kardex(appDb: Db, person: Person, storeId: string, variantId: string) {
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx, role) => {
    const variant = await variantIn(tx, storeId, variantId)
    const movements = await tx
      .select({
        id: stockMovement.id,
        kind: stockMovement.kind,
        quantity: stockMovement.quantity,
        balance: stockMovement.balance,
        unitCostCents: stockMovement.unitCostCents,
        reason: stockMovement.reason,
        reference: stockMovement.reference,
        createdAt: stockMovement.createdAt,
        actorName: accountCopy.name,
      })
      .from(stockMovement)
      .leftJoin(accountCopy, eq(accountCopy.userId, stockMovement.actorUserId))
      .where(eq(stockMovement.variantId, variantId))
      .orderBy(desc(stockMovement.createdAt), desc(stockMovement.id))
      .limit(200)
    // El costo de cada entrada solo lo ve quien puede ver costos (Ventas no).
    const costs = can(role, "costos.ver")
    return {
      stock: variant.stock,
      movements: costs ? movements : movements.map((m) => ({ ...m, unitCostCents: null })),
    }
  })
}

/**
 * Lo que mueve un pedido en el kardex va con su referencia («Pedido 0147») y, desde la segunda vez,
 * con la de cada paso («Pedido 0147 · cambio 1», ADR 0224): así el índice único de cada referencia
 * sigue diciendo que un paso no se repite, y cambiar dos veces no se salta el segundo cambio.
 */
const ofOrder = (reference: string) =>
  or(eq(stockMovement.reference, reference), like(stockMovement.reference, `${reference} · %`))

/**
 * Lo que un pedido tiene fuera del stock ahora, por variante: lo vendido menos lo que volvió, en
 * todas sus referencias.
 */
export async function heldBy(
  tx: Db,
  storeId: string,
  reference: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      variantId: stockMovement.variantId,
      out: sql<number>`(-sum(${stockMovement.quantity}))::int`,
    })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.storeId, storeId),
        inArray(stockMovement.kind, ["venta", "anulacion"]),
        ofOrder(reference),
      ),
    )
    .groupBy(stockMovement.variantId)
  return new Map(
    rows.filter((row) => Number(row.out) !== 0).map((row) => [row.variantId, Number(row.out)]),
  )
}

/** Cuántas referencias usó ya el pedido: la suya y la de cada paso que movió stock. */
async function referencesUsed(tx: Db, storeId: string, reference: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${stockMovement.reference})::int` })
    .from(stockMovement)
    .where(and(eq(stockMovement.storeId, storeId), ofOrder(reference)))
  return Number(row?.n ?? 0)
}

/** La referencia del próximo paso: la del pedido la primera vez; después, «· cambio N». */
async function nextReference(tx: Db, storeId: string, reference: string): Promise<string> {
  const used = await referencesUsed(tx, storeId, reference)
  return used === 0 ? reference : `${reference} · cambio ${used}`
}

export interface SaleLine {
  variantId: string
  quantity: number
}

/**
 * Deja fuera del stock lo que dicen las líneas del pedido (decisión 3: al confirmar el pago, o al
 * salir si se paga al recibir). Para B4: corre dentro de la transacción del pedido, ya en su
 * tienda. Compara con lo que el pedido ya tiene fuera y mueve solo la diferencia, en un solo paso
 * con su referencia: lo que sobra vuelve y lo que falta sale. Repetirla con las mismas líneas no
 * mueve nada. Si no alcanza alguna variante, falla entera (quien la llama deshace el paso).
 *
 * Con `returnsOnly`, solo vuelve lo que ya no está en el pedido: lo que falta se descuenta después.
 */
export async function recordSale(
  tx: Db,
  storeId: string,
  actorUserId: string,
  reference: string,
  lines: SaleLine[],
  options: { returnsOnly?: boolean; stepReference?: string } = {},
) {
  return stockGuard(async () => {
    const want = new Map<string, number>()
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1)
        throw new StoreError(400, "VALIDATION_ERROR", "La cantidad de cada línea es al menos 1")
      want.set(line.variantId, (want.get(line.variantId) ?? 0) + line.quantity)
    }
    const held = await heldBy(tx, storeId, reference)
    const deltas = [...new Set([...held.keys(), ...want.keys()])]
      .map((variantId) => ({
        variantId,
        delta: (want.get(variantId) ?? 0) - (held.get(variantId) ?? 0),
      }))
      .filter((d) => d.delta !== 0)
    // Primero vuelve lo que sobra; después sale lo que falta.
    const back = deltas.filter((d) => d.delta < 0)
    const out = options.returnsOnly ? [] : deltas.filter((d) => d.delta > 0)
    const moves = [...back, ...out]
    if (moves.length === 0) return 0
    const step = options.stepReference ?? (await nextReference(tx, storeId, reference))
    for (const move of moves)
      await tx.insert(stockMovement).values({
        storeId,
        variantId: move.variantId,
        kind: move.delta > 0 ? "venta" : "anulacion",
        quantity: -move.delta,
        reference: step,
        actorUserId,
      })
    return moves.length
  })
}

/**
 * Devuelve al stock todo lo que un pedido tiene fuera, una sola vez: lo de un pedido que se anula,
 * o lo de un pago que se deshizo. Lo que el pedido no llegó a descontar no se toca. Un pedido que
 * solo se vendió devuelve con su propia referencia («Pedido 0142»); uno que cambió, con la del paso.
 */
export async function cancelSale(tx: Db, storeId: string, actorUserId: string, reference: string) {
  const used = await referencesUsed(tx, storeId, reference)
  return recordSale(tx, storeId, actorUserId, reference, [], {
    ...(used === 1 ? { stepReference: reference } : {}),
  })
}

/**
 * Lo que costó un producto según su kardex: la última entrada con costo de cada variante y, de
 * esas, la más cara. Así el aviso del mínimo no se queda corto cuando una variante costó más
 * (la blanca a 68 y la negra a 55: avisa con 68).
 */
export async function lastEntryCost(tx: Db, productId: string): Promise<number | null> {
  // También las variantes quitadas: su costo sigue siendo lo que costó el producto.
  const rows = await tx
    .selectDistinctOn([stockMovement.variantId], { cost: stockMovement.unitCostCents })
    .from(stockMovement)
    .innerJoin(productVariant, eq(productVariant.id, stockMovement.variantId))
    .where(
      and(
        eq(productVariant.productId, productId),
        eq(stockMovement.kind, "entrada"),
        isNotNull(stockMovement.unitCostCents),
      ),
    )
    .orderBy(stockMovement.variantId, desc(stockMovement.createdAt), desc(stockMovement.id))
  const costs = rows.map((row) => row.cost).filter((cost): cost is number => cost !== null)
  return costs.length > 0 ? Math.max(...costs) : null
}
