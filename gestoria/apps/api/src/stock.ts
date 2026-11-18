import { accountCopy, type Db, productVariant, stockMovement } from "@gestoria/db"
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * El stock de cada variante y su kardex (decisión 3 del lienzo B). El saldo no se escribe: cada
 * movimiento lo cambia en la base (`stock_movement_apply`), que anota el saldo y rechaza que
 * quede bajo cero. Aquí están las entradas y los ajustes a mano (con motivo escrito), y las dos
 * operaciones que usarán los pedidos de B4: descontar una venta y devolverla al anular.
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

function isStockError(error: unknown): boolean {
  const e = error as {
    code?: string
    constraint_name?: string
    cause?: { code?: string; constraint_name?: string }
  }
  const code = e.code ?? e.cause?.code
  const constraint = e.constraint_name ?? e.cause?.constraint_name
  return code === "23514" && constraint === "product_variant_stock_check"
}

/** Corre `fn` y convierte «no alcanza el stock» en un error que se entiende. */
async function stockGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (isStockError(error))
      throw new StoreError(409, "NOT_ENOUGH_STOCK", "No alcanza el stock para ese movimiento")
    throw error
  }
}

async function variantIn(tx: Db, storeId: string, variantId: string) {
  if (!z.uuid().safeParse(variantId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa variante ya no está")
  const [row] = await tx
    .select({
      id: productVariant.id,
      stock: productVariant.stock,
      removedAt: productVariant.removedAt,
    })
    .from(productVariant)
    .where(and(eq(productVariant.id, variantId), eq(productVariant.storeId, storeId)))
    .for("update")
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
    const variant = await variantIn(tx, storeId, variantId)
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
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx) => {
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
    return { stock: variant.stock, movements }
  })
}

/**
 * Las variantes que ya tienen ese movimiento de ese pedido. Se mira antes de agregar, y no con
 * `on conflict do nothing`: el stock se mueve en un disparador previo, que corre aunque la fila
 * después se descarte. Dos pedidos iguales a la vez chocan en el índice único y uno se deshace.
 */
async function movedFor(
  tx: Db,
  storeId: string,
  reference: string,
  kind: "venta" | "anulacion",
): Promise<Set<string>> {
  const rows = await tx
    .select({ variantId: stockMovement.variantId })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.storeId, storeId),
        eq(stockMovement.reference, reference),
        eq(stockMovement.kind, kind),
      ),
    )
  return new Set(rows.map((row) => row.variantId))
}

export interface SaleLine {
  variantId: string
  quantity: number
}

/**
 * Descuenta lo de un pedido (decisión 3: al confirmar el pago, o al salir si se paga al
 * recibir). Para B4: corre dentro de la transacción del pedido, ya en su tienda. Si no alcanza
 * alguna variante, no descuenta ninguna. Repetirla con el mismo pedido no descuenta otra vez.
 */
export async function recordSale(
  tx: Db,
  storeId: string,
  actorUserId: string,
  reference: string,
  lines: SaleLine[],
) {
  return stockGuard(async () => {
    const done = await movedFor(tx, storeId, reference, "venta")
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1)
        throw new StoreError(400, "VALIDATION_ERROR", "La cantidad de cada línea es al menos 1")
      if (done.has(line.variantId)) continue
      await tx.insert(stockMovement).values({
        storeId,
        variantId: line.variantId,
        kind: "venta",
        quantity: -line.quantity,
        reference,
        actorUserId,
      })
    }
  })
}

/**
 * Devuelve al stock lo que descontó un pedido que se anula: lo mismo que salió, una sola vez.
 * Lo que el pedido no llegó a descontar no se toca.
 */
export async function cancelSale(tx: Db, storeId: string, actorUserId: string, reference: string) {
  const sold = await tx
    .select({ variantId: stockMovement.variantId, quantity: stockMovement.quantity })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.storeId, storeId),
        eq(stockMovement.reference, reference),
        eq(stockMovement.kind, "venta"),
      ),
    )
  const done = await movedFor(tx, storeId, reference, "anulacion")
  const back = sold.filter((line) => !done.has(line.variantId))
  for (const line of back)
    await tx.insert(stockMovement).values({
      storeId,
      variantId: line.variantId,
      kind: "anulacion",
      quantity: -line.quantity,
      reference,
      actorUserId,
    })
  return back.length
}

/**
 * Lo que costó un producto según su kardex: la última entrada con costo de cada variante y, de
 * esas, la más cara. Así el aviso del mínimo no se queda corto cuando una variante costó más
 * (la blanca a 68 y la negra a 55: avisa con 68).
 */
export async function lastEntryCost(tx: Db, variantIds: string[]): Promise<number | null> {
  if (variantIds.length === 0) return null
  const rows = await tx
    .selectDistinctOn([stockMovement.variantId], {
      variantId: stockMovement.variantId,
      cost: stockMovement.unitCostCents,
    })
    .from(stockMovement)
    .where(
      and(
        inArray(stockMovement.variantId, variantIds),
        eq(stockMovement.kind, "entrada"),
        isNotNull(stockMovement.unitCostCents),
      ),
    )
    .orderBy(stockMovement.variantId, desc(stockMovement.createdAt), desc(stockMovement.id))
  const costs = rows.map((row) => row.cost).filter((cost): cost is number => cost !== null)
  return costs.length > 0 ? Math.max(...costs) : null
}
