/**
 * Lo que hay y cómo se mueve (ADR 0067): las primitivas de existencias que
 * comparten Inventario, el cierre de la atención y «Cobrar». Ningún otro
 * módulo escribe saldos de lotes ni faltantes por su cuenta.
 *
 * Reglas que se mantienen aquí:
 * - El saldo de un lote es la suma de sus movimientos y nunca baja de cero
 *   (también lo exige la base).
 * - Lo que se usó o se vendió sin haber es el faltante del producto en ese
 *   almacén: menos la suma de sus movimientos sin lote. Lo que hay en una sede
 *   es la suma de sus lotes menos su faltante.
 * - Lo que entra cubre primero el faltante. Al recibir mercadería la
 *   cobertura son dos filas `cobertura` (el lote entrega y el faltante recibe),
 *   así el ingreso queda entero en su lote con su compra y su costo.
 * - Todo se descuenta del lote que vence primero (sin vencimiento al final;
 *   entre iguales, el más antiguo).
 * - Cada movimiento lleva su clave: un reintento con la misma clave devuelve
 *   lo hecho sin tocar saldos.
 */
import type { Db } from "@odentia/db"
import { productLot, stockMovement, stockShortage, type StockMovementKind, warehouse } from "@odentia/db/schema/inventory"
import { and, asc, desc, eq, like, sql } from "drizzle-orm"
import { branchNotFound, notFound, ServiceError } from "./errors.js"
import { findOrgLocale } from "./locale.js"

/** El código de un lote que nadie nombró (inventario inicial, devoluciones): en pantalla, «Sin código». */
export const NO_LOT_CODE = ""

function conflict(message: string): ServiceError {
  return new ServiceError("CONFLICT", 409, message)
}

/* ---------------- almacenes de una sede ---------------- */

/**
 * El almacén principal de una sede. La base lo crea al crear la sede; si una
 * sede vieja no lo tuviera, se crea aquí (nunca se inventa otro).
 */
export async function defaultWarehouse(tx: Db, orgId: string, branchId: string) {
  const [row] = await tx
    .select()
    .from(warehouse)
    .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.branchId, branchId), eq(warehouse.isDefault, true)))
    .limit(1)
  if (row) return row
  const [branchRow] = await tx.execute<{ id: string }>(
    sql`select id from branch where organization_id = ${orgId} and id = ${branchId} limit 1`,
  )
  if (!branchRow) throw branchNotFound()
  const [created] = await tx
    .insert(warehouse)
    .values({ organizationId: orgId, branchId, name: "Almacén principal", isDefault: true })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  const [again] = await tx
    .select()
    .from(warehouse)
    .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.branchId, branchId), eq(warehouse.isDefault, true)))
    .limit(1)
  if (!again) throw notFound("Almacén")
  return again
}

/** Los almacenes de una sede (activos o no: lo que tienen sigue contando). */
export async function sedeWarehouseIds(tx: Db, orgId: string, branchId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: warehouse.id })
    .from(warehouse)
    .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.branchId, branchId)))
  return rows.map((row) => row.id)
}

/* ---------------- lo que hay ---------------- */

export interface SedeStock {
  /** Suma de los lotes de la sede. */
  lots: number
  /** Lo usado o vendido sin haber en la sede. */
  shortage: number
  /** Lo que hay: lotes − faltante (puede ser negativo). */
  onHand: number
}

/**
 * Lo que hay de cada producto en una sede (o en toda la clínica sin
 * `branchId`). Los productos sin lotes ni faltante no vienen: valen cero.
 */
export async function stockBySede(
  tx: Db,
  orgId: string,
  options: { branchId?: string | null; productIds?: string[] } = {},
): Promise<Map<string, SedeStock>> {
  if (options.productIds && options.productIds.length === 0) return new Map()
  const productFilter = options.productIds
    ? sql`and x.product_id in (${sql.join(options.productIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const branchFilter = options.branchId ? sql`and w.branch_id = ${options.branchId}` : sql``
  const rows = await tx.execute<{ productId: string; lots: string; shortage: string }>(sql`
    select x.product_id as "productId", sum(x.lots)::text as lots, sum(x.shortage)::text as shortage
    from (
      select l.product_id, l.warehouse_id, l.quantity_on_hand as lots, 0 as shortage
        from product_lot l where l.organization_id = ${orgId}
      union all
      select s.product_id, s.warehouse_id, 0, s.quantity
        from stock_shortage s where s.organization_id = ${orgId}
    ) x
    join warehouse w on w.organization_id = ${orgId} and w.id = x.warehouse_id
    where true ${branchFilter} ${productFilter}
    group by x.product_id`)
  return new Map(
    rows.map((row) => {
      const lots = Number(row.lots ?? 0)
      const shortage = Number(row.shortage ?? 0)
      return [row.productId, { lots, shortage, onHand: lots - shortage }]
    }),
  )
}

/* ---------------- lotes y faltante ---------------- */

type LotRow = typeof productLot.$inferSelect

/** «Hoy» en la zona de la clínica (`AAAA-MM-DD`): un lote vence a medianoche de su clínica, no de UTC. */
export async function clinicToday(tx: Db, orgId: string, now = new Date()): Promise<string> {
  const { timezone } = await findOrgLocale(tx, orgId)
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

/**
 * Los lotes de un producto en un almacén, bloqueados, en el orden en que se
 * gastan. Con `usableOn` (el día de la clínica) quedan fuera los vencidos:
 * lo vencido no se usa en una atención, no se vende ni se traslada; se da de
 * baja. Sin él (conteo, baja) entran todos.
 */
export async function fefoLots(
  tx: Db,
  orgId: string,
  productId: string,
  warehouseId: string,
  usableOn?: string | null,
): Promise<LotRow[]> {
  return tx
    .select()
    .from(productLot)
    .where(
      and(
        eq(productLot.organizationId, orgId),
        eq(productLot.productId, productId),
        eq(productLot.warehouseId, warehouseId),
        sql`${productLot.quantityOnHand} > 0`,
        usableOn ? sql`(${productLot.expiresAt} is null or ${productLot.expiresAt} >= ${usableOn})` : undefined,
      ),
    )
    .orderBy(sql`${productLot.expiresAt} asc nulls last`, asc(productLot.createdAt), asc(productLot.id))
    .for("update")
}

/** Bloquea el faltante de un producto en un almacén y devuelve cuánto es (0 si no hay fila). */
async function lockShortage(tx: Db, orgId: string, productId: string, warehouseId: string): Promise<number> {
  const [row] = await tx
    .select({ quantity: stockShortage.quantity })
    .from(stockShortage)
    .where(
      and(
        eq(stockShortage.organizationId, orgId),
        eq(stockShortage.productId, productId),
        eq(stockShortage.warehouseId, warehouseId),
      ),
    )
    .for("update")
    .limit(1)
  return row?.quantity ?? 0
}

async function changeShortage(tx: Db, orgId: string, productId: string, warehouseId: string, delta: number) {
  await tx
    .insert(stockShortage)
    .values({ organizationId: orgId, productId, warehouseId, quantity: Math.max(0, delta) })
    .onConflictDoUpdate({
      target: [stockShortage.organizationId, stockShortage.productId, stockShortage.warehouseId],
      set: { quantity: sql`${stockShortage.quantity} + ${delta}`, updatedAt: new Date() },
    })
}

async function changeLot(tx: Db, orgId: string, lotId: string, delta: number) {
  await tx
    .update(productLot)
    .set({ quantityOnHand: sql`${productLot.quantityOnHand} + ${delta}`, updatedAt: new Date() })
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, lotId)))
}

/** El lote con ese código en el almacén, o uno nuevo (sin saldo) con lo que se sabe de él. */
export async function lotFor(
  tx: Db,
  orgId: string,
  input: {
    productId: string
    warehouseId: string
    code: string
    expiresAt?: string | null
    supplierId?: string | null
    purchaseOrderId?: string | null
    actorUserId: string | null
  },
): Promise<LotRow> {
  const where = and(
    eq(productLot.organizationId, orgId),
    eq(productLot.productId, input.productId),
    eq(productLot.warehouseId, input.warehouseId),
    eq(productLot.code, input.code),
  )
  const [found] = await tx.select().from(productLot).where(where).limit(1)
  if (found) return found
  const [created] = await tx
    .insert(productLot)
    .values({
      organizationId: orgId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      supplierId: input.supplierId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      code: input.code,
      expiresAt: input.expiresAt ?? null,
      quantityOnHand: 0,
      createdBy: input.actorUserId,
    })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  const [raced] = await tx.select().from(productLot).where(where).limit(1)
  if (!raced) throw notFound("Lote")
  return raced
}

/* ---------------- movimientos ---------------- */

/** Lo que acompaña a cada fila que escribe una operación. */
export interface MovementBase {
  kind: StockMovementKind
  reason: string
  actorUserId: string | null
  /** Prefijo de las claves: cada fila lleva `${keyPrefix}:${n}`. */
  keyPrefix: string
  patientId?: string | null
  encounterId?: string | null
  chargeId?: string | null
  purchaseOrderId?: string | null
}

export type MovementRow = typeof stockMovement.$inferSelect

/** Las filas que ya dejó una operación con este prefijo (un reintento las devuelve). */
export async function movementsWithPrefix(tx: Db, orgId: string, keyPrefix: string): Promise<MovementRow[]> {
  const escaped = keyPrefix.replace(/[\\%_]/g, (char) => `\\${char}`)
  return tx
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.organizationId, orgId), like(stockMovement.idempotencyKey, `${escaped}:%`)))
    .orderBy(asc(stockMovement.createdAt), asc(stockMovement.idempotencyKey))
}

async function writeMovement(
  tx: Db,
  orgId: string,
  base: MovementBase,
  n: number,
  row: {
    productId: string
    warehouseId: string
    lotId: string | null
    delta: number
    kind?: StockMovementKind
    /** Solo traslado: el almacén de destino (el origen va en `warehouseId`). */
    destWarehouseId?: string | null
  },
): Promise<MovementRow> {
  const [inserted] = await tx
    .insert(stockMovement)
    .values({
      organizationId: orgId,
      productId: row.productId,
      lotId: row.lotId,
      warehouseId: row.warehouseId,
      destWarehouseId: row.destWarehouseId ?? null,
      kind: row.kind ?? base.kind,
      quantityDelta: row.delta,
      reason: base.reason,
      actorUserId: base.actorUserId,
      purchaseOrderId: base.purchaseOrderId ?? null,
      patientId: base.patientId ?? null,
      encounterId: base.encounterId ?? null,
      chargeId: base.chargeId ?? null,
      idempotencyKey: `${base.keyPrefix}:${n}`,
    })
    .returning()
  return inserted
}

export interface StockPart {
  /** El lote que entregó o recibió; null = el faltante. */
  lotId: string | null
  quantity: number
}

export interface StockResult {
  movements: MovementRow[]
  parts: StockPart[]
  /** Lo que quedó como faltante (solo al descontar). */
  shortage: number
  /** Un reintento: no se tocó nada. */
  replayed: boolean
}

function partsOf(movements: MovementRow[]): StockPart[] {
  return movements.map((row) => ({ lotId: row.lotId, quantity: Math.abs(row.quantityDelta) }))
}

/** El lote elegido, bloqueado, si es de ese producto y ese almacén y le queda algo. */
async function chosenLot(
  tx: Db,
  orgId: string,
  lotId: string,
  productId: string,
  warehouseId: string,
  usableOn?: string | null,
): Promise<LotRow[]> {
  const [lot] = await tx
    .select()
    .from(productLot)
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, lotId)))
    .for("update")
    .limit(1)
  if (!lot || lot.productId !== productId || lot.warehouseId !== warehouseId) throw notFound("Lote")
  if (usableOn && lot.expiresAt !== null && lot.expiresAt < usableOn)
    throw conflict(`El lote ${lot.code || "sin código"} ya venció: dalo de baja o elige otro.`)
  return lot.quantityOnHand > 0 ? [lot] : []
}

/**
 * Descuenta unidades de uso de un producto en un almacén, del lote que vence
 * primero (o solo del lote elegido, `lotId`). Si no alcanza: con
 * `allowShortage` lo que falta queda como faltante (la atención y la venta
 * nunca se bloquean); sin él, un conflicto que dice cuánto hay.
 */
export async function consumeFefo(
  tx: Db,
  orgId: string,
  input: {
    productId: string
    warehouseId: string
    quantity: number
    allowShortage: boolean
    /** Sale solo de este lote (Registrar uso con el lote elegido). */
    lotId?: string | null
    /** El día de la clínica: los lotes vencidos antes no se usan (atención, uso, venta). */
    usableOn?: string | null
    /** Para el mensaje si no alcanza: «guantes». */
    unitWords?: (quantity: number) => string
    base: MovementBase
  },
): Promise<StockResult> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
    throw new ServiceError("VALIDATION", 400, "La cantidad debe ser un entero positivo")
  const prior = await movementsWithPrefix(tx, orgId, input.base.keyPrefix)
  if (prior.length > 0) {
    const total = prior.reduce((sum, row) => sum - row.quantityDelta, 0)
    if (total !== input.quantity || prior.some((row) => row.productId !== input.productId))
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    return { movements: prior, parts: partsOf(prior), shortage: prior.filter((row) => row.lotId === null).reduce((sum, row) => sum - row.quantityDelta, 0), replayed: true }
  }
  const lots = input.lotId
    ? await chosenLot(tx, orgId, input.lotId, input.productId, input.warehouseId, input.usableOn)
    : await fefoLots(tx, orgId, input.productId, input.warehouseId, input.usableOn)
  const available = lots.reduce((sum, lot) => sum + lot.quantityOnHand, 0)
  if (available < input.quantity && !input.allowShortage) {
    const words = input.unitWords ?? ((quantity: number) => String(quantity))
    throw conflict(`No alcanza: hay ${words(available)}.`)
  }
  const movements: MovementRow[] = []
  let left = input.quantity
  let n = 0
  for (const lot of lots) {
    if (left === 0) break
    const take = Math.min(left, lot.quantityOnHand)
    await changeLot(tx, orgId, lot.id, -take)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, { productId: input.productId, warehouseId: input.warehouseId, lotId: lot.id, delta: -take }),
    )
    left -= take
  }
  if (left > 0) {
    await lockShortage(tx, orgId, input.productId, input.warehouseId)
    await changeShortage(tx, orgId, input.productId, input.warehouseId, left)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, { productId: input.productId, warehouseId: input.warehouseId, lotId: null, delta: -left }),
    )
  }
  return { movements, parts: partsOf(movements), shortage: left, replayed: false }
}

/**
 * Pone unidades de vuelta (una devolución, un conteo que sobra, una
 * corrección): primero baja el faltante del almacén y lo que sobra va al lote
 * indicado, al que vence último o a uno «sin código».
 */
export async function restoreUnits(
  tx: Db,
  orgId: string,
  input: {
    productId: string
    warehouseId: string
    quantity: number
    /** El lote de donde salió, si se sabe: vuelve ahí. */
    preferLotId?: string | null
    base: MovementBase
  },
): Promise<StockResult> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
    throw new ServiceError("VALIDATION", 400, "La cantidad debe ser un entero positivo")
  const prior = await movementsWithPrefix(tx, orgId, input.base.keyPrefix)
  if (prior.length > 0) {
    const total = prior.reduce((sum, row) => sum + row.quantityDelta, 0)
    if (total !== input.quantity || prior.some((row) => row.productId !== input.productId))
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    return { movements: prior, parts: partsOf(prior), shortage: 0, replayed: true }
  }
  const movements: MovementRow[] = []
  let left = input.quantity
  let n = 0
  const shortage = await lockShortage(tx, orgId, input.productId, input.warehouseId)
  if (shortage > 0) {
    const cover = Math.min(shortage, left)
    await changeShortage(tx, orgId, input.productId, input.warehouseId, -cover)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, { productId: input.productId, warehouseId: input.warehouseId, lotId: null, delta: cover }),
    )
    left -= cover
  }
  if (left > 0) {
    let lotId = input.preferLotId ?? null
    if (lotId) {
      const [lot] = await tx
        .select({ id: productLot.id, productId: productLot.productId, warehouseId: productLot.warehouseId })
        .from(productLot)
        .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, lotId)))
        .for("update")
        .limit(1)
      if (!lot || lot.productId !== input.productId || lot.warehouseId !== input.warehouseId) lotId = null
    }
    if (!lotId) {
      const [last] = await tx
        .select({ id: productLot.id })
        .from(productLot)
        .where(
          and(
            eq(productLot.organizationId, orgId),
            eq(productLot.productId, input.productId),
            eq(productLot.warehouseId, input.warehouseId),
          ),
        )
        .orderBy(sql`${productLot.expiresAt} desc nulls first`, desc(productLot.createdAt))
        .for("update")
        .limit(1)
      lotId =
        last?.id ??
        (await lotFor(tx, orgId, {
          productId: input.productId,
          warehouseId: input.warehouseId,
          code: NO_LOT_CODE,
          actorUserId: input.base.actorUserId,
        })).id
    }
    await changeLot(tx, orgId, lotId, left)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, { productId: input.productId, warehouseId: input.warehouseId, lotId, delta: left }),
    )
  }
  return { movements, parts: partsOf(movements), shortage: 0, replayed: false }
}

/**
 * Entra mercadería a un lote (una compra, «Agregar sin compra», la lista
 * inicial). El ingreso queda entero en el lote; si el almacén tenía
 * faltante, el lote lo cubre con dos filas `cobertura` y toma su costo.
 */
export async function receiveIntoLot(
  tx: Db,
  orgId: string,
  input: {
    lot: LotRow
    quantity: number
    base: MovementBase
  },
): Promise<StockResult & { covered: number }> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
    throw new ServiceError("VALIDATION", 400, "La cantidad debe ser un entero positivo")
  const prior = await movementsWithPrefix(tx, orgId, input.base.keyPrefix)
  if (prior.length > 0) {
    const entry = prior.find((row) => row.kind === input.base.kind)
    if (!entry || entry.quantityDelta !== input.quantity || entry.lotId !== input.lot.id)
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    const covered = prior.filter((row) => row.kind === "cobertura" && row.lotId === null).reduce((sum, row) => sum + row.quantityDelta, 0)
    return { movements: prior, parts: partsOf(prior), shortage: 0, replayed: true, covered }
  }
  const { productId, warehouseId } = input.lot
  await tx
    .select({ id: productLot.id })
    .from(productLot)
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, input.lot.id)))
    .for("update")
  await changeLot(tx, orgId, input.lot.id, input.quantity)
  const movements = [
    await writeMovement(tx, orgId, input.base, 0, { productId, warehouseId, lotId: input.lot.id, delta: input.quantity }),
  ]
  const shortage = await lockShortage(tx, orgId, productId, warehouseId)
  const covered = Math.min(shortage, input.quantity)
  if (covered > 0) {
    await changeLot(tx, orgId, input.lot.id, -covered)
    await changeShortage(tx, orgId, productId, warehouseId, -covered)
    movements.push(
      await writeMovement(tx, orgId, input.base, 1, { productId, warehouseId, lotId: input.lot.id, delta: -covered, kind: "cobertura" }),
      await writeMovement(tx, orgId, input.base, 2, { productId, warehouseId, lotId: null, delta: covered, kind: "cobertura" }),
    )
  }
  return { movements, parts: partsOf(movements), shortage: 0, replayed: false, covered }
}

/**
 * Pone lo que hay de un producto en una sede en `counted` (un conteo o la
 * lista inicial con un producto que ya existía): lo que falta sale del lote
 * que vence primero; lo que sobra baja el faltante y después entra al lote
 * que vence último. Devuelve cuánto cambió (0 = ya estaba bien).
 */
export async function setSedeStock(
  tx: Db,
  orgId: string,
  input: {
    productId: string
    branchId: string
    counted: number
    base: MovementBase
  },
): Promise<{ before: number; after: number; delta: number; replayed: boolean }> {
  if (!Number.isSafeInteger(input.counted) || input.counted < 0)
    throw new ServiceError("VALIDATION", 400, "Lo que hay debe ser un número entero desde 0")
  const prior = await movementsWithPrefix(tx, orgId, input.base.keyPrefix)
  if (prior.length > 0) {
    const delta = prior.reduce((sum, row) => sum + row.quantityDelta, 0)
    return { before: input.counted - delta, after: input.counted, delta, replayed: true }
  }
  const warehouses = await sedeWarehouseIds(tx, orgId, input.branchId)
  if (warehouses.length === 0) throw branchNotFound()
  const main = await defaultWarehouse(tx, orgId, input.branchId)
  const stock = (await stockBySede(tx, orgId, { branchId: input.branchId, productIds: [input.productId] })).get(input.productId)
  const before = stock?.onHand ?? 0
  const delta = input.counted - before
  if (delta === 0) return { before, after: before, delta: 0, replayed: false }
  if (delta < 0) {
    // Falta: sale de los lotes de la sede, empezando por el almacén principal.
    let left = -delta
    let step = 0
    const ordered = [main.id, ...warehouses.filter((id) => id !== main.id)]
    for (const warehouseId of ordered) {
      if (left === 0) break
      const lots = await fefoLots(tx, orgId, input.productId, warehouseId)
      const here = lots.reduce((sum, lot) => sum + lot.quantityOnHand, 0)
      if (here === 0) continue
      const take = Math.min(here, left)
      await consumeFefo(tx, orgId, {
        productId: input.productId,
        warehouseId,
        quantity: take,
        allowShortage: false,
        base: { ...input.base, keyPrefix: `${input.base.keyPrefix}:${step++}` },
      })
      left -= take
    }
    if (left > 0) throw conflict("No se pudo ajustar: cambió lo que hay mientras se contaba. Vuelve a abrir el conteo.")
  } else {
    // Sobra: primero baja el faltante de cada almacén, después entra al principal.
    let left = delta
    let step = 0
    for (const warehouseId of warehouses) {
      if (left === 0) break
      const shortage = await lockShortage(tx, orgId, input.productId, warehouseId)
      if (shortage === 0) continue
      const cover = Math.min(shortage, left)
      await restoreUnits(tx, orgId, {
        productId: input.productId,
        warehouseId,
        quantity: cover,
        base: { ...input.base, keyPrefix: `${input.base.keyPrefix}:${step++}` },
      })
      left -= cover
    }
    if (left > 0)
      await restoreUnits(tx, orgId, {
        productId: input.productId,
        warehouseId: main.id,
        quantity: left,
        base: { ...input.base, keyPrefix: `${input.base.keyPrefix}:${step++}` },
      })
  }
  return { before, after: input.counted, delta, replayed: false }
}

/**
 * Deja un lote en lo que se contó («Ajustar» un lote en particular): el lote
 * queda exactamente en `counted` con un ajuste por la diferencia. No toca el
 * faltante: corregir lo que hay de todo el producto es «Contar»
 * (`setSedeStock`). Devuelve cuánto cambió (0 = ya estaba bien, sin fila).
 */
export async function setLotQuantity(
  tx: Db,
  orgId: string,
  input: { lotId: string; counted: number; base: MovementBase },
): Promise<{ lot: LotRow; before: number; after: number; delta: number; movements: MovementRow[]; replayed: boolean }> {
  if (!Number.isSafeInteger(input.counted) || input.counted < 0 || input.counted > 1_000_000_000)
    throw new ServiceError("VALIDATION", 400, "Lo que hay debe ser un número entero desde 0")
  const [lot] = await tx
    .select()
    .from(productLot)
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, input.lotId)))
    .for("update")
    .limit(1)
  if (!lot) throw notFound("Lote")
  const prior = await movementsWithPrefix(tx, orgId, input.base.keyPrefix)
  if (prior.length > 0) {
    if (prior.some((row) => row.lotId !== lot.id))
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    const delta = prior.reduce((sum, row) => sum + row.quantityDelta, 0)
    return { lot, before: input.counted - delta, after: input.counted, delta, movements: prior, replayed: true }
  }
  const delta = input.counted - lot.quantityOnHand
  if (delta === 0) return { lot, before: lot.quantityOnHand, after: lot.quantityOnHand, delta: 0, movements: [], replayed: false }
  await changeLot(tx, orgId, lot.id, delta)
  const movement = await writeMovement(tx, orgId, input.base, 0, {
    productId: lot.productId,
    warehouseId: lot.warehouseId,
    lotId: lot.id,
    delta,
  })
  return { lot, before: lot.quantityOnHand, after: input.counted, delta, movements: [movement], replayed: false }
}

/**
 * Pasa unidades de un almacén a otro (un traslado entre sedes): del lote
 * elegido o de los que vencen primero, en parejas por lote (salida del lote
 * de origen y llegada a un lote con el mismo código y vencimiento en el
 * destino). Las dos filas guardan el origen en `warehouse_id` y el destino en
 * `dest_warehouse_id`. Lo que llega cubre primero el faltante del destino, con
 * sus dos filas `cobertura`. Sin faltante permitido: si no alcanza, un
 * conflicto que dice cuánto hay.
 */
export async function transferUnits(
  tx: Db,
  orgId: string,
  input: {
    productId: string
    fromWarehouseId: string
    toWarehouseId: string
    quantity: number
    lotId?: string | null
    /** El día de la clínica: lo vencido no se traslada. */
    usableOn?: string | null
    unitWords?: (quantity: number) => string
    base: MovementBase
  },
): Promise<StockResult & { covered: number }> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
    throw new ServiceError("VALIDATION", 400, "La cantidad debe ser un entero positivo")
  if (input.fromWarehouseId === input.toWarehouseId)
    throw new ServiceError("VALIDATION", 400, "El destino debe ser otro almacén")
  const prior = await movementsWithPrefix(tx, orgId, input.base.keyPrefix)
  if (prior.length > 0) {
    const out = prior.filter((row) => row.kind === input.base.kind && row.quantityDelta < 0)
    const total = out.reduce((sum, row) => sum - row.quantityDelta, 0)
    if (total !== input.quantity || prior.some((row) => row.productId !== input.productId))
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    const covered = prior.filter((row) => row.kind === "cobertura" && row.lotId === null).reduce((sum, row) => sum + row.quantityDelta, 0)
    return { movements: prior, parts: partsOf(out), shortage: 0, replayed: true, covered }
  }
  const lots = input.lotId
    ? await chosenLot(tx, orgId, input.lotId, input.productId, input.fromWarehouseId, input.usableOn)
    : await fefoLots(tx, orgId, input.productId, input.fromWarehouseId, input.usableOn)
  const available = lots.reduce((sum, lot) => sum + lot.quantityOnHand, 0)
  if (available < input.quantity) {
    const words = input.unitWords ?? ((quantity: number) => String(quantity))
    throw conflict(`No alcanza: hay ${words(available)}.`)
  }
  const movements: MovementRow[] = []
  const arrived: Array<{ lotId: string; quantity: number }> = []
  let left = input.quantity
  let n = 0
  for (const lot of lots) {
    if (left === 0) break
    const take = Math.min(left, lot.quantityOnHand)
    await changeLot(tx, orgId, lot.id, -take)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, {
        productId: input.productId,
        warehouseId: input.fromWarehouseId,
        destWarehouseId: input.toWarehouseId,
        lotId: lot.id,
        delta: -take,
      }),
    )
    const dest = await lotFor(tx, orgId, {
      productId: input.productId,
      warehouseId: input.toWarehouseId,
      code: lot.code,
      expiresAt: lot.expiresAt,
      supplierId: lot.supplierId,
      purchaseOrderId: lot.purchaseOrderId,
      actorUserId: input.base.actorUserId,
    })
    await tx
      .select({ id: productLot.id })
      .from(productLot)
      .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, dest.id)))
      .for("update")
    await changeLot(tx, orgId, dest.id, take)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, {
        productId: input.productId,
        warehouseId: input.fromWarehouseId,
        destWarehouseId: input.toWarehouseId,
        lotId: dest.id,
        delta: take,
      }),
    )
    arrived.push({ lotId: dest.id, quantity: take })
    left -= take
  }
  // Lo que llega cubre primero lo que se usó sin haber en el destino.
  const shortage = await lockShortage(tx, orgId, input.productId, input.toWarehouseId)
  const covered = Math.min(shortage, input.quantity)
  if (covered > 0) {
    let pending = covered
    for (const part of arrived) {
      if (pending === 0) break
      const take = Math.min(pending, part.quantity)
      await changeLot(tx, orgId, part.lotId, -take)
      movements.push(
        await writeMovement(tx, orgId, input.base, n++, {
          productId: input.productId,
          warehouseId: input.toWarehouseId,
          lotId: part.lotId,
          delta: -take,
          kind: "cobertura",
        }),
      )
      pending -= take
    }
    await changeShortage(tx, orgId, input.productId, input.toWarehouseId, -covered)
    movements.push(
      await writeMovement(tx, orgId, input.base, n++, {
        productId: input.productId,
        warehouseId: input.toWarehouseId,
        lotId: null,
        delta: covered,
        kind: "cobertura",
      }),
    )
  }
  return {
    movements,
    parts: partsOf(movements.filter((row) => row.kind === input.base.kind && row.quantityDelta < 0)),
    shortage: 0,
    replayed: false,
    covered,
  }
}

/**
 * Devuelve exactamente lo que dejaron unos movimientos de salida (una venta
 * anulada, una corrección): cada lote recibe lo suyo y lo que fue faltante
 * baja el faltante; si ya no hay faltante que bajar, entra al lote que vence
 * último. Devuelve las filas nuevas.
 */
export async function returnMovements(
  tx: Db,
  orgId: string,
  input: { movements: MovementRow[]; base: MovementBase },
): Promise<MovementRow[]> {
  const out = input.movements.filter((row) => row.quantityDelta < 0)
  const written: MovementRow[] = []
  let step = 0
  for (const row of out) {
    const result = await restoreUnits(tx, orgId, {
      productId: row.productId,
      warehouseId: row.warehouseId,
      quantity: -row.quantityDelta,
      preferLotId: row.lotId,
      base: { ...input.base, keyPrefix: `${input.base.keyPrefix}:${step++}` },
    })
    written.push(...result.movements)
  }
  return written
}

/** Las salidas que dejó una atención o un concepto de «Cobrar», sin contar lo ya devuelto. */
export async function movementsOf(
  tx: Db,
  orgId: string,
  ref: { encounterId?: string; chargeId?: string; productId?: string },
): Promise<MovementRow[]> {
  const conditions = [eq(stockMovement.organizationId, orgId)]
  if (ref.encounterId) conditions.push(eq(stockMovement.encounterId, ref.encounterId))
  if (ref.chargeId) conditions.push(eq(stockMovement.chargeId, ref.chargeId))
  if (ref.productId) conditions.push(eq(stockMovement.productId, ref.productId))
  if (!ref.encounterId && !ref.chargeId) return []
  return tx.select().from(stockMovement).where(and(...conditions)).orderBy(asc(stockMovement.createdAt))
}

/**
 * Devuelve a la sede lo que salió con un concepto de «Cobrar» y sigue afuera
 * (ADR 0068): `chargeId` es el concepto original, el que guarda las salidas.
 * Cuenta lo que ya volvió en devoluciones anteriores; sin `quantity`, vuelve
 * todo lo que queda afuera. Cada almacén recibe lo suyo, en el último lote del
 * que salió.
 */
export async function returnSold(
  tx: Db,
  orgId: string,
  input: { chargeId: string; quantity?: number; base: MovementBase },
): Promise<MovementRow[]> {
  const rows = await movementsOf(tx, orgId, { chargeId: input.chargeId })
  const out = new Map<string, { productId: string; warehouseId: string; lotId: string | null; quantity: number }>()
  for (const row of rows) {
    const entry = out.get(row.warehouseId) ?? { productId: row.productId, warehouseId: row.warehouseId, lotId: null, quantity: 0 }
    entry.quantity -= row.quantityDelta
    if (row.quantityDelta < 0 && row.lotId) entry.lotId = row.lotId
    out.set(row.warehouseId, entry)
  }
  const outside = [...out.values()].reduce((total, entry) => total + Math.max(entry.quantity, 0), 0)
  if (input.quantity !== undefined && input.quantity > outside)
    throw conflict("De ese producto ya volvió todo lo que salió con esta venta.")
  let left = input.quantity ?? outside
  const written: MovementRow[] = []
  let step = 0
  for (const entry of [...out.values()].reverse()) {
    if (left <= 0) break
    if (entry.quantity <= 0) continue
    const take = Math.min(entry.quantity, left)
    const result = await restoreUnits(tx, orgId, {
      productId: entry.productId,
      warehouseId: entry.warehouseId,
      quantity: take,
      preferLotId: entry.lotId,
      base: { ...input.base, keyPrefix: `${input.base.keyPrefix}:${step++}` },
    })
    written.push(...result.movements)
    left -= take
  }
  return written
}

/** Para pruebas y lecturas: el faltante de un producto en un almacén. */
export async function shortageOf(tx: Db, orgId: string, productId: string, warehouseId: string): Promise<number> {
  const [row] = await tx
    .select({ quantity: stockShortage.quantity })
    .from(stockShortage)
    .where(and(eq(stockShortage.organizationId, orgId), eq(stockShortage.productId, productId), eq(stockShortage.warehouseId, warehouseId)))
    .limit(1)
  return row?.quantity ?? 0
}

