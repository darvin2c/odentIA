/**
 * Las primitivas de existencias (ADR 0067), la única puerta que mueve saldos:
 * - Todo sale del lote que vence primero (sin vencimiento al final), o del
 *   lote elegido.
 * - Lo que se usa sin haber queda como faltante; lo que entra lo cubre
 *   primero con dos filas `cobertura` y el ingreso queda entero en su lote.
 * - Una devolución baja primero el faltante; un conteo ajusta hacia arriba y
 *   hacia abajo; un traslado va en parejas por lote y cubre el faltante del
 *   destino.
 * - El reintento con la misma clave devuelve lo hecho sin tocar saldos; otro
 *   contenido con la misma clave es un conflicto en palabras.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { product, productLot, warehouse } from "@odentia/db/schema/inventory"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  consumeFefo,
  defaultWarehouse,
  lotFor,
  type MovementBase,
  movementsWithPrefix,
  receiveIntoLot,
  restoreUnits,
  returnMovements,
  setLotQuantity,
  setSedeStock,
  shortageOf,
  stockBySede,
  transferUnits,
} from "./inventory-stock.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function stockClinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `existencias-${orgId.slice(0, 8)}`)
  const [sede] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Miraflores" }).returning()
  const [otra] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "San Isidro" }).returning()
  const [item] = await ownerDb.insert(product).values({ organizationId: orgId, sku: "GNT", name: "Guantes", unit: "guante" }).returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  // Cada sede nace con su almacén principal (disparador de la base).
  const main = await run((tx) => defaultWarehouse(tx, orgId, sede!.id))
  const other = await run((tx) => defaultWarehouse(tx, orgId, otra!.id))
  const base = (keyPrefix: string, kind: MovementBase["kind"] = "ingreso"): MovementBase => ({ kind, reason: "Prueba", actorUserId: null, keyPrefix })
  /** Un lote con su vencimiento y lo que trae. */
  const lot = (code: string, quantity: number, expiresAt: string | null, warehouseId = main.id) =>
    run(async (tx) => {
      const row = await lotFor(tx, orgId, { productId: item!.id, warehouseId, code, expiresAt, actorUserId: null })
      await receiveIntoLot(tx, orgId, { lot: row, quantity, base: base(`entra:${randomUUID()}`) })
      return row
    })
  const qty = async (lotId: string) =>
    (await ownerDb.select({ q: productLot.quantityOnHand }).from(productLot).where(eq(productLot.id, lotId)))[0]?.q
  const onHand = async (branchId = sede!.id) => (await run((tx) => stockBySede(tx, orgId, { branchId, productIds: [item!.id] }))).get(item!.id)?.onHand ?? 0
  const shortage = (warehouseId = main.id) => run((tx) => shortageOf(tx, orgId, item!.id, warehouseId))
  return { orgId, sede: sede!, otra: otra!, item: item!, run, main, other, base, lot, qty, onHand, shortage }
}

it("el almacén principal: cada sede nace con el suyo y se encuentra siempre el mismo", async () => {
  const c = await stockClinic()
  const rows = await ownerDb.select().from(warehouse).where(and(eq(warehouse.organizationId, c.orgId), eq(warehouse.branchId, c.sede.id)))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: c.main.id, isDefault: true, name: "Almacén principal" })
  expect((await c.run((tx) => defaultWarehouse(tx, c.orgId, c.sede.id))).id).toBe(c.main.id)
})

it("descuenta del lote que vence primero; sin vencimiento va al final; o solo del lote elegido", async () => {
  const c = await stockClinic()
  const late = await c.lot("TARDE", 5, "2031-01-01")
  const none = await c.lot("SIN-VENCE", 5, null)
  const early = await c.lot("PRONTO", 3, "2030-01-01")
  const used = await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, quantity: 6, allowShortage: false, base: c.base("uso:1", "consumo") }),
  )
  expect(used.parts).toEqual([
    { lotId: early.id, quantity: 3 },
    { lotId: late.id, quantity: 3 },
  ])
  expect(await c.qty(early.id)).toBe(0)
  expect(await c.qty(late.id)).toBe(2)
  expect(await c.qty(none.id)).toBe(5)
  // El lote elegido: solo de ese, aunque otro venza antes.
  await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, lotId: none.id, quantity: 2, allowShortage: false, base: c.base("uso:2", "consumo") }),
  )
  expect(await c.qty(none.id)).toBe(3)
  expect(await c.qty(late.id)).toBe(2)
  // Sin faltante permitido, si no alcanza lo dice con la unidad.
  await expect(
    c.run((tx) =>
      consumeFefo(tx, c.orgId, {
        productId: c.item.id,
        warehouseId: c.main.id,
        quantity: 9,
        allowShortage: false,
        unitWords: (n) => `${n} guantes`,
        base: c.base("uso:3", "consumo"),
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "No alcanza: hay 5 guantes." })
  expect(await c.onHand()).toBe(5)
})

it("lo usado sin haber queda como faltante y la mercadería que llega lo cubre primero, con dos filas de cobertura", async () => {
  const c = await stockClinic()
  await c.lot("L-1", 2, "2030-01-01")
  const used = await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, quantity: 5, allowShortage: true, base: c.base("atencion:1", "consumo") }),
  )
  expect(used.shortage).toBe(3)
  expect(used.movements.map((row) => [row.lotId === null, row.quantityDelta])).toEqual([
    [false, -2],
    [true, -3],
  ])
  expect(await c.shortage()).toBe(3)
  expect(await c.onHand()).toBe(-3)

  // Llegan 10: el ingreso queda entero en su lote y cubre los 3 que faltaban.
  const arrived = await c.run(async (tx) => {
    const row = await lotFor(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, code: "L-2", expiresAt: "2031-01-01", actorUserId: null })
    return { row, result: await receiveIntoLot(tx, c.orgId, { lot: row, quantity: 10, base: c.base("compra:1") }) }
  })
  expect(arrived.result.covered).toBe(3)
  expect(arrived.result.movements.map((row) => [row.kind, row.lotId === null, row.quantityDelta])).toEqual([
    ["ingreso", false, 10],
    ["cobertura", false, -3],
    ["cobertura", true, 3],
  ])
  expect(await c.qty(arrived.row.id)).toBe(7)
  expect(await c.shortage()).toBe(0)
  expect(await c.onHand()).toBe(7)
})

it("una devolución baja primero el faltante y lo demás vuelve a su lote", async () => {
  const c = await stockClinic()
  const lot = await c.lot("L-1", 4, "2030-01-01")
  const sale = await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, quantity: 6, allowShortage: true, base: c.base("venta:1", "venta") }),
  )
  expect(await c.shortage()).toBe(2)
  // Devolver 3 sueltos: 2 bajan el faltante y 1 entra al lote.
  const back = await c.run((tx) =>
    restoreUnits(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, quantity: 3, preferLotId: lot.id, base: c.base("devuelve:1", "devolucion") }),
  )
  expect(back.movements.map((row) => [row.lotId === null, row.quantityDelta])).toEqual([
    [true, 2],
    [false, 1],
  ])
  expect(await c.shortage()).toBe(0)
  expect(await c.qty(lot.id)).toBe(1)
  // Devolver exactamente lo que dejó la venta: cada parte vuelve a su origen.
  const again = await c.run((tx) => returnMovements(tx, c.orgId, { movements: sale.movements, base: c.base("anula:1", "devolucion") }))
  expect(again.reduce((sum, row) => sum + row.quantityDelta, 0)).toBe(6)
  expect(await c.onHand()).toBe(7)
})

it("contar: lo que falta sale del lote que vence primero y lo que sobra baja el faltante y entra al lote más nuevo", async () => {
  const c = await stockClinic()
  const early = await c.lot("PRONTO", 5, "2030-01-01")
  const late = await c.lot("TARDE", 5, "2031-01-01")
  const down = await c.run((tx) =>
    setSedeStock(tx, c.orgId, { productId: c.item.id, branchId: c.sede.id, counted: 7, base: c.base("conteo:1", "ajuste") }),
  )
  expect(down).toMatchObject({ before: 10, after: 7, delta: -3, replayed: false })
  expect(await c.qty(early.id)).toBe(2)
  expect(await c.qty(late.id)).toBe(5)
  // Igual: no deja fila.
  expect(await c.run((tx) => setSedeStock(tx, c.orgId, { productId: c.item.id, branchId: c.sede.id, counted: 7, base: c.base("conteo:2", "ajuste") }))).toMatchObject({ delta: 0 })
  expect(await c.run((tx) => movementsWithPrefix(tx, c.orgId, "conteo:2"))).toEqual([])

  // Con faltante: contar de más lo baja primero.
  await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, quantity: 9, allowShortage: true, base: c.base("atencion:1", "consumo") }),
  )
  expect(await c.onHand()).toBe(-2)
  const up = await c.run((tx) =>
    setSedeStock(tx, c.orgId, { productId: c.item.id, branchId: c.sede.id, counted: 4, base: c.base("conteo:3", "ajuste") }),
  )
  expect(up).toMatchObject({ before: -2, after: 4, delta: 6 })
  expect(await c.shortage()).toBe(0)
  expect(await c.onHand()).toBe(4)
  // El reintento con la misma clave devuelve lo hecho sin tocar nada.
  expect(await c.run((tx) => setSedeStock(tx, c.orgId, { productId: c.item.id, branchId: c.sede.id, counted: 4, base: c.base("conteo:3", "ajuste") }))).toMatchObject({
    delta: 6,
    replayed: true,
  })
  expect(await c.onHand()).toBe(4)
})

it("un lote en lo que se contó: el ajuste es la diferencia y el lote queda exacto", async () => {
  const c = await stockClinic()
  const lot = await c.lot("L-1", 7, "2030-01-01")
  const result = await c.run((tx) => setLotQuantity(tx, c.orgId, { lotId: lot.id, counted: 6, base: c.base("ajuste:1", "ajuste") }))
  expect(result).toMatchObject({ before: 7, after: 6, delta: -1, replayed: false })
  expect(await c.qty(lot.id)).toBe(6)
  const retry = await c.run((tx) => setLotQuantity(tx, c.orgId, { lotId: lot.id, counted: 6, base: c.base("ajuste:1", "ajuste") }))
  expect(retry).toMatchObject({ delta: -1, replayed: true })
  expect(await c.qty(lot.id)).toBe(6)
})

it("un traslado va en parejas por lote, con origen y destino en cada fila, y cubre el faltante del destino", async () => {
  const c = await stockClinic()
  const early = await c.lot("PRONTO", 3, "2030-01-01")
  const late = await c.lot("TARDE", 5, "2031-01-01")
  // En el destino se usaron 2 sin haber.
  await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.other.id, quantity: 2, allowShortage: true, base: c.base("otra:uso", "consumo") }),
  )
  const moved = await c.run((tx) =>
    transferUnits(tx, c.orgId, {
      productId: c.item.id,
      fromWarehouseId: c.main.id,
      toWarehouseId: c.other.id,
      quantity: 4,
      base: c.base("traslado:1", "traslado"),
    }),
  )
  expect(moved.covered).toBe(2)
  const pairs = moved.movements.filter((row) => row.kind === "traslado")
  expect(pairs).toHaveLength(4)
  for (const row of pairs) expect(row).toMatchObject({ warehouseId: c.main.id, destWarehouseId: c.other.id })
  expect(pairs.filter((row) => row.quantityDelta < 0).map((row) => [row.lotId, row.quantityDelta])).toEqual([
    [early.id, -3],
    [late.id, -1],
  ])
  expect(moved.movements.filter((row) => row.kind === "cobertura").map((row) => row.warehouseId)).toEqual([c.other.id, c.other.id])
  expect(await c.onHand(c.sede.id)).toBe(4)
  expect(await c.onHand(c.otra.id)).toBe(2)
  expect(await c.shortage(c.other.id)).toBe(0)
  // Los lotes del destino llevan el código y el vencimiento de los de origen.
  const arrived = await ownerDb.select().from(productLot).where(and(eq(productLot.organizationId, c.orgId), eq(productLot.warehouseId, c.other.id)))
  expect(arrived.map((row) => [row.code, row.expiresAt]).sort()).toEqual([
    ["PRONTO", "2030-01-01"],
    ["TARDE", "2031-01-01"],
  ])
  // El reintento no mueve nada más; con otra cantidad, conflicto en palabras.
  const retry = await c.run((tx) =>
    transferUnits(tx, c.orgId, { productId: c.item.id, fromWarehouseId: c.main.id, toWarehouseId: c.other.id, quantity: 4, base: c.base("traslado:1", "traslado") }),
  )
  expect(retry.replayed).toBe(true)
  expect(await c.onHand(c.sede.id)).toBe(4)
  await expect(
    c.run((tx) =>
      transferUnits(tx, c.orgId, { productId: c.item.id, fromWarehouseId: c.main.id, toWarehouseId: c.other.id, quantity: 1, base: c.base("traslado:1", "traslado") }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("ya se registró con otros datos") })
})

it("el reintento con la misma clave no duplica y otro contenido con ella es un conflicto", async () => {
  const c = await stockClinic()
  await c.lot("L-1", 5, "2030-01-01")
  const input = { productId: c.item.id, warehouseId: c.main.id, quantity: 2, allowShortage: false, base: c.base("uso:mismo", "consumo") }
  const first = await c.run((tx) => consumeFefo(tx, c.orgId, input))
  const again = await c.run((tx) => consumeFefo(tx, c.orgId, input))
  expect(again.replayed).toBe(true)
  expect(again.movements.map((row) => row.id)).toEqual(first.movements.map((row) => row.id))
  expect(await c.onHand()).toBe(3)
  await expect(c.run((tx) => consumeFefo(tx, c.orgId, { ...input, quantity: 3 }))).rejects.toMatchObject({
    code: "CONFLICT",
    message: "Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.",
  })
  expect(await c.onHand()).toBe(3)
})

it("lo vencido no se usa, no se vende ni se traslada: sale de lo vigente y, si no alcanza, queda faltante", async () => {
  const c = await stockClinic()
  const expired = await c.lot("VENCIDO", 4, "2020-01-01")
  const valid = await c.lot("VIGENTE", 2, "2031-01-01")
  const today = "2026-10-19"
  const used = await c.run((tx) =>
    consumeFefo(tx, c.orgId, {
      productId: c.item.id,
      warehouseId: c.main.id,
      quantity: 3,
      allowShortage: true,
      usableOn: today,
      base: c.base("atencion:vencido", "consumo"),
    }),
  )
  expect(used.parts).toEqual([
    { lotId: valid.id, quantity: 2 },
    { lotId: null, quantity: 1 },
  ])
  expect(await c.qty(expired.id)).toBe(4)
  expect(await c.shortage()).toBe(1)
  // El lote vencido elegido a mano se rechaza en palabras.
  await expect(
    c.run((tx) =>
      consumeFefo(tx, c.orgId, {
        productId: c.item.id,
        warehouseId: c.main.id,
        lotId: expired.id,
        quantity: 1,
        allowShortage: false,
        usableOn: today,
        base: c.base("uso:vencido", "consumo"),
      }),
    ),
  ).rejects.toThrow("ya venció")
  // Sin el día (conteo, baja), lo vencido sí cuenta.
  await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: c.item.id, warehouseId: c.main.id, quantity: 4, allowShortage: false, base: c.base("baja:vencido", "ajuste") }),
  )
  expect(await c.qty(expired.id)).toBe(0)
})
