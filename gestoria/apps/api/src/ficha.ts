import {
  type Db,
  type ProductChange,
  type ProductOption,
  product,
  productColor,
  productPhoto,
  productPromotion,
  productVariant,
  type RubroValue,
  saleOrder,
  saleOrderLine,
  stockMovement,
  storeDeliveryMethod,
} from "@gestoria/db"
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm"
import { z } from "zod"
import {
  barcodeInput,
  checkVersion,
  codeInput,
  combinations,
  detailIn,
  dropGoneColors,
  logProductEvent,
  MAX_VARIANTS,
  makeSku,
  money,
  productRow,
  sameText,
  takenSkus,
  versionInput,
} from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { deliveryListOf, pad, storeRow, todayIn, variantPrices } from "./pedidos.js"
import { can } from "./permisos.js"
import { autoUnit, floorOf, lowestQuote } from "./precio.js"
import { templateIn } from "./rubros.js"
import { lastEntryCost } from "./stock.js"
import { constraintError, inStore, StoreError } from "./tiendas.js"

/**
 * «Tallas y stock» de una vez (lienzo «La ficha del producto», tablero 8; decisión 6): cada color
 * es una fila con su hex y su foto, cada talla una columna, y cada celda una variante con su stock,
 * su precio y su código de barras. Guardar es una sola operación: crea y quita variantes, cambia
 * los nombres de colores y tallas sin rehacer sus variantes (su kardex sigue siendo el mismo) y
 * registra el stock en el kardex: subir es una entrada y bajar pide motivo (ADR 0206). El stock
 * nunca se escribe directo.
 */

const axisName = z.string().trim().min(1, "Escribe el nombre (Color, Talla)").max(30)
const axisValue = z
  .string()
  .trim()
  .min(1, "Escribe cada valor")
  .max(30, "Máximo 30 caracteres")
  .regex(/^[^,]*$/, "Un valor no lleva comas")

/** `#RRGGBB`, en mayúsculas o minúsculas; se guarda en minúsculas. */
export const hexInput = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Escribe el color como #RRGGBB")
  .transform((v) => v.toLowerCase())

export const gridInput = z
  .object({
    /** Las filas: los colores (o tonos, o acabados), en su orden. Nulo: el producto no tiene. */
    rows: z
      .object({
        name: axisName,
        values: z
          .array(
            z.object({
              /** El nombre que tenía, si se cambió: así sus variantes siguen siendo las mismas. */
              was: axisValue.optional(),
              value: axisValue,
              hex: hexInput.nullable().default(null),
              hex2: hexInput.nullable().default(null),
              /** La foto que manda Sofi cuando piden este color. */
              photoId: z.uuid().nullable().default(null),
            }),
          )
          .min(1, "Agrega al menos un color")
          .max(40, "Hasta 40 colores"),
      })
      .nullable(),
    /** Las columnas: las tallas (o modelos, o tamaños), en su orden. Nulo: no tiene. */
    columns: z
      .object({
        name: axisName,
        values: z
          .array(z.object({ was: axisValue.optional(), value: axisValue }))
          .min(1, "Agrega al menos una talla")
          .max(60, "Hasta 60 tallas"),
      })
      .nullable(),
    /** Una celda por combinación, con los nombres nuevos. */
    cells: z
      .array(
        z.object({
          row: axisValue.nullable(),
          column: axisValue.nullable(),
          /** Cuántas hay: la diferencia con el stock de ahora entra al kardex. */
          stock: z
            .number()
            .int("Escribe un número entero")
            .min(0, "No puede ser menos de 0")
            .max(100_000),
          /**
           * El stock que vio la pantalla al cambiarla. Con él, lo que se guarda es la diferencia
           * (`stock - seenStock`) sobre el stock de ahora: una venta de mientras tanto no se pisa.
           * Sin él, `stock` es el total (la hoja de antes).
           */
          seenStock: z.number().int().min(0).max(100_000).optional(),
          /** Su precio propio; nulo: el del producto. */
          priceCents: money.nullable(),
          barcode: barcodeInput.default(null),
          sku: codeInput.optional(),
        }),
      )
      .max(MAX_VARIANTS, `Hasta ${MAX_VARIANTS} variantes`),
    /** Lo que costó cada unidad que entra (opcional): con él se avisa si el mínimo queda cerca. */
    unitCostCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
    /** Por qué baja el stock o se quita una variante con stock (ADR 0206). */
    reason: z.string().trim().max(300).optional(),
    /** La versión de la ficha que vio la pantalla: si cambió después, 409 (`checkVersion`). */
    version: versionInput.optional(),
  })
  .superRefine((grid, ctx) => {
    for (const [axis, list] of [
      ["rows", grid.rows?.values ?? []],
      ["columns", grid.columns?.values ?? []],
    ] as const) {
      list.forEach((item, i) => {
        if (list.findIndex((other) => sameText(other.value, item.value)) !== i)
          ctx.addIssue({
            code: "custom",
            path: [axis, "values", i, "value"],
            message: `«${item.value}» está dos veces`,
          })
        if (
          item.was &&
          list.findIndex((other) => other.was && sameText(other.was, item.was!)) !== i
        )
          ctx.addIssue({
            code: "custom",
            path: [axis, "values", i, "was"],
            message: "Ese nombre se cambió dos veces",
          })
      })
    }
    if (grid.rows && grid.columns && sameText(grid.rows.name, grid.columns.name))
      ctx.addIssue({
        code: "custom",
        path: ["columns", "name"],
        message: "Las filas y las columnas se llaman igual",
      })
  })

export type GridInput = z.infer<typeof gridInput>

const comboKey = (values: string[]) => values.map((v) => v.toLocaleLowerCase("es")).join("\u0000")

/** El valor nuevo de uno de antes: el mismo nombre, o el que lo reemplazó con `was`. */
function renamed(list: { was?: string; value: string }[], old: string): string | null {
  const byWas = list.find((item) => item.was && sameText(item.was, old))
  if (byWas) return byWas.value
  const same = list.find((item) => !item.was && sameText(item.value, old))
  return same ? same.value : null
}

/** Cambia las claves de los datos por talla del rubro cuando una talla cambia de nombre. */
function renameSizeKeys(
  data: Record<string, RubroValue>,
  keys: string[],
  rename: (old: string) => string | null,
) {
  const out = { ...data }
  for (const key of keys) {
    const value = out[key]
    if (!value || typeof value !== "object" || "noAplica" in value) continue
    out[key] = Object.fromEntries(
      Object.entries(value).map(([size, v]) => [rename(size) ?? size, v]),
    ) as RubroValue
  }
  return out
}

export async function saveGrid(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
  grid: GridInput,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    try {
      return await saveGridIn(tx, person, storeId, productId, grid)
    } catch (error) {
      throw constraintError(error) ?? error
    }
  })
}

async function saveGridIn(
  tx: Db,
  person: Person,
  storeId: string,
  productId: string,
  grid: GridInput,
) {
  await checkVersion(tx, storeId, productId, grid.version)
  const current = await productRow(tx, storeId, productId)
  if (current.options.length > 2)
    throw new StoreError(
      409,
      "TOO_MANY_OPTIONS",
      "Este producto tiene tres opciones: la cuadrícula tiene solo colores y tallas.",
    )
  const fields: Record<string, string> = {}

  const next: ProductOption[] = []
  if (grid.rows) next.push({ name: grid.rows.name, values: grid.rows.values.map((v) => v.value) })
  if (grid.columns)
    next.push({ name: grid.columns.name, values: grid.columns.values.map((v) => v.value) })
  const wanted = combinations(next)
  if (wanted.length > MAX_VARIANTS)
    throw new StoreError(
      400,
      "VALIDATION_ERROR",
      `Son ${wanted.length} combinaciones: el máximo es ${MAX_VARIANTS}`,
    )

  // Cada celda, por su combinación nueva.
  const cellOf = new Map<string, GridInput["cells"][number]>()
  grid.cells.forEach((cell, i) => {
    const values = [
      ...(grid.rows ? [cell.row ?? ""] : []),
      ...(grid.columns ? [cell.column ?? ""] : []),
    ]
    const key = comboKey(values)
    if (!wanted.some((combo) => comboKey(combo) === key))
      fields[`cells.${i}`] = "Esa celda no es de un color y una talla de la cuadrícula"
    else if (cellOf.has(key)) fields[`cells.${i}`] = "Esa celda está dos veces"
    else cellOf.set(key, cell)
  })
  wanted.forEach((combo) => {
    if (!cellOf.has(comboKey(combo)))
      fields.cells = `Falta la celda de ${combo.join(" ") || "la variante"}`
  })
  if (Object.keys(fields).length > 0)
    throw new StoreError(400, "VALIDATION_ERROR", Object.values(fields)[0]!, fields)

  // Las variantes de hoy, tomadas: nadie mueve su stock mientras se guarda.
  const active = await tx
    .select()
    .from(productVariant)
    .where(and(eq(productVariant.productId, productId), isNull(productVariant.removedAt)))
    .for("update")
  // Qué eje era cada opción de antes: por su nombre o, si cambió, la del color son las filas y la
  // otra, las columnas. Si cambia cuántas opciones hay, las variantes se rehacen.
  const axes = current.options.map((option, i): "rows" | "columns" | null => {
    if (grid.rows && sameText(option.name, grid.rows.name)) return "rows"
    if (grid.columns && sameText(option.name, grid.columns.name)) return "columns"
    if (i === current.colorOption) return grid.rows ? "rows" : null
    return grid.columns ? "columns" : null
  })
  const reshaped =
    current.options.length !== next.length ||
    axes.some((axis) => axis === null) ||
    new Set(axes).size !== axes.length
  // Lo que pasa a ser cada una: su combinación nueva, o nada si su color o su talla se quitó.
  const mapped = active.map((variant) => {
    if (reshaped) return { variant, combo: null as string[] | null }
    const by = { rows: null as string | null, columns: null as string | null }
    variant.optionValues.forEach((value, i) => {
      const axis = axes[i]!
      by[axis] = renamed((axis === "rows" ? grid.rows : grid.columns)!.values, value)
    })
    const combo = [...(grid.rows ? [by.rows] : []), ...(grid.columns ? [by.columns] : [])]
    const match = combo.every(Boolean)
      ? wanted.find((w) => comboKey(w) === comboKey(combo as string[]))
      : undefined
    return { variant, combo: match ?? null }
  })
  const kept = mapped.filter((m) => m.combo !== null) as {
    variant: (typeof active)[number]
    combo: string[]
  }[]
  const gone = mapped.filter((m) => m.combo === null).map((m) => m.variant)

  const reason = grid.reason?.trim() || null
  // Lo que queda de cada variante: con el stock que vio la pantalla, lo de ahora más lo que ella
  // cambió; si cambió desde entonces (una venta), se dice en `meanwhile`.
  const meanwhile: { variant: string; seen: number; now: number }[] = []
  const targetOf = new Map<string, number>()
  for (const { variant, combo } of kept) {
    const cell = cellOf.get(comboKey(combo))!
    if (cell.seenStock === undefined) {
      targetOf.set(variant.id, cell.stock)
      continue
    }
    if (cell.seenStock !== variant.stock)
      meanwhile.push({ variant: combo.join(" · "), seen: cell.seenStock, now: variant.stock })
    targetOf.set(variant.id, Math.max(0, variant.stock + cell.stock - cell.seenStock))
  }
  const lowers = kept.some((k) => targetOf.get(k.variant.id)! < k.variant.stock)
  if ((lowers || gone.some((v) => v.stock > 0)) && (!reason || reason.length < 3))
    throw new StoreError(
      400,
      "VALIDATION_ERROR",
      "Escribe por qué baja el stock (por ejemplo, «par dañado»)",
      { reason: "Escribe el motivo" },
    )
  // Una variante que se quita no puede estar en un pedido que todavía la tiene que descontar.
  if (gone.length > 0) {
    const [open] = await tx
      .select({ number: saleOrder.number })
      .from(saleOrderLine)
      .innerJoin(saleOrder, eq(saleOrder.id, saleOrderLine.orderId))
      .where(
        and(
          inArray(
            saleOrderLine.variantId,
            gone.map((v) => v.id),
          ),
          notInArray(saleOrder.state, ["entregado", "anulado"]),
        ),
      )
      .limit(1)
    if (open)
      throw new StoreError(
        409,
        "VARIANT_IN_ORDER",
        `Una variante que se quita está en el pedido ${pad(open.number)}, todavía abierto. Entrégalo o anúlalo antes.`,
      )
  }

  const now = new Date()
  let entered = 0
  let lowered = 0
  // Lo que se quita: su stock baja a 0 con el motivo, en el kardex, y después se quita.
  for (const variant of gone) {
    if (variant.stock > 0) {
      await tx.insert(stockMovement).values({
        storeId,
        variantId: variant.id,
        kind: "ajuste",
        quantity: -variant.stock,
        reason,
        actorUserId: person.userId,
      })
      lowered += variant.stock
    }
  }
  if (gone.length > 0)
    await tx
      .update(productVariant)
      .set({ removedAt: now, updatedAt: now })
      .where(
        inArray(
          productVariant.id,
          gone.map((v) => v.id),
        ),
      )
  // Primero un valor de paso: así cambiar «blanca» por «negra» y al revés no choca con el índice
  // de las combinaciones de cada producto.
  // Lo mismo con el código de barras y el SKU: pasar uno de una celda a otra no choca.
  for (const { variant, combo } of kept) {
    const cell = cellOf.get(comboKey(combo))!
    await tx
      .update(productVariant)
      .set({
        optionValues: [`~${variant.id}`],
        barcode: null,
        ...(cell.sku && !sameText(cell.sku, variant.sku)
          ? { sku: `T${variant.id.replace(/-/g, "")}` }
          : {}),
      })
      .where(eq(productVariant.id, variant.id))
  }
  const skus = await takenSkus(tx, storeId)
  const priceChanges: ProductChange[] = []
  for (const { variant, combo } of kept) {
    const cell = cellOf.get(comboKey(combo))!
    if (cell.sku && !sameText(cell.sku, variant.sku)) skus.add(cell.sku.toLowerCase())
    await tx
      .update(productVariant)
      .set({
        optionValues: combo,
        priceCents: cell.priceCents,
        barcode: cell.barcode,
        ...(cell.sku ? { sku: cell.sku } : {}),
        updatedAt: now,
      })
      .where(eq(productVariant.id, variant.id))
    if (cell.priceCents !== variant.priceCents)
      priceChanges.push({
        field: `price:${combo.join(" · ")}`,
        from: variant.priceCents,
        to: cell.priceCents,
      })
  }
  const keptKeys = new Set(kept.map((k) => comboKey(k.combo)))
  const fresh = wanted.filter((combo) => !keptKeys.has(comboKey(combo)))
  const created = fresh.length
    ? await tx
        .insert(productVariant)
        .values(
          fresh.map((combo) => {
            const cell = cellOf.get(comboKey(combo))!
            return {
              storeId,
              productId,
              optionValues: combo,
              sku: cell.sku ?? makeSku(current.name, combo, skus),
              priceCents: cell.priceCents,
              barcode: cell.barcode,
            }
          }),
        )
        .returning({ id: productVariant.id, optionValues: productVariant.optionValues })
    : []
  // El stock: la diferencia de cada celda entra al kardex, que lo pone al día en la base.
  const stockMoves = [
    ...kept.map(({ variant, combo }) => ({
      id: variant.id,
      delta: targetOf.get(variant.id)! - variant.stock,
    })),
    ...created.map((row) => ({ id: row.id, delta: cellOf.get(comboKey(row.optionValues))!.stock })),
  ].filter((m) => m.delta !== 0)
  for (const move of stockMoves) {
    await tx.insert(stockMovement).values(
      move.delta > 0
        ? {
            storeId,
            variantId: move.id,
            kind: "entrada" as const,
            quantity: move.delta,
            unitCostCents: grid.unitCostCents,
            reason: "Tallas y stock",
            actorUserId: person.userId,
          }
        : {
            storeId,
            variantId: move.id,
            kind: "ajuste" as const,
            quantity: move.delta,
            reason,
            actorUserId: person.userId,
          },
    )
    if (move.delta > 0) entered += move.delta
    else lowered -= move.delta
  }

  // El producto: sus opciones, cuál es el color y las tallas de sus datos del rubro con su nombre nuevo.
  const sizeKeys = current.rubro
    ? (await templateIn(tx, storeId, current.rubro))
        .filter((f) => f.type === "por_talla" || f.type === "tabla")
        .map((f) => f.key)
    : []
  const rubroData = grid.columns
    ? renameSizeKeys(current.rubroData, sizeKeys, (old) => renamed(grid.columns!.values, old))
    : current.rubroData
  await tx
    .update(product)
    .set({
      options: next,
      colorOption: grid.rows ? 0 : null,
      rubroData,
      updatedAt: now,
    })
    .where(eq(product.id, productId))

  // Las promociones de un color o una talla siguen a su valor con el nombre nuevo; las de uno que
  // se quitó ya no tienen a quién bajarle el precio y se borran.
  const scoped = await tx
    .select()
    .from(productPromotion)
    .where(and(eq(productPromotion.productId, productId), isNotNull(productPromotion.optionIndex)))
  const promoChanges: ProductChange[] = []
  for (const promo of scoped) {
    const axis = reshaped ? null : (axes[promo.optionIndex!] ?? null)
    const list = axis ? (axis === "rows" ? grid.rows : grid.columns)?.values : undefined
    const value = list ? renamed(list, promo.optionValue!) : null
    const index = axis === "rows" ? 0 : axis === "columns" ? (grid.rows ? 1 : 0) : null
    if (value === null || index === null) {
      await tx.delete(productPromotion).where(eq(productPromotion.id, promo.id))
      promoChanges.push({ field: "promotionRemoved", from: promo.name, to: null })
    } else if (value !== promo.optionValue || index !== promo.optionIndex)
      await tx
        .update(productPromotion)
        .set({ optionIndex: index, optionValue: value })
        .where(eq(productPromotion.id, promo.id))
  }

  // Los colores: cómo se ve cada uno y su foto. Uno que cambió de nombre sigue siendo el mismo.
  // Lo que cambió de cada color queda en el historial con su nombre.
  const colorChanges: ProductChange[] = []
  if (grid.rows) {
    const looks = await tx.select().from(productColor).where(eq(productColor.productId, productId))
    const photoIds = grid.rows.values.map((v) => v.photoId).filter((id): id is string => !!id)
    const photos = photoIds.length
      ? await tx
          .select({ id: productPhoto.id })
          .from(productPhoto)
          .where(and(eq(productPhoto.productId, productId), inArray(productPhoto.id, photoIds)))
      : []
    // Cada fila de antes es de un solo color: primero las que cambiaron de nombre, después por su
    // nombre. Y un nombre de paso, para que cambiar dos nombres entre sí no choque con el índice.
    const used = new Set<string>()
    const lookOf = grid.rows.values.map((item) => {
      const look = item.was
        ? looks.find((l) => !used.has(l.id) && sameText(l.value, item.was!))
        : undefined
      if (look) used.add(look.id)
      return look
    })
    grid.rows.values.forEach((item, i) => {
      if (lookOf[i]) return
      const look = looks.find((l) => !used.has(l.id) && sameText(l.value, item.value))
      if (look) used.add(look.id)
      lookOf[i] = look
    })
    for (const look of looks)
      if (!used.has(look.id))
        colorChanges.push({ field: "colorRemoved", from: look.value, to: null })
    for (const look of looks)
      await tx
        .update(productColor)
        .set({ value: `~${look.id.slice(0, 28)}` })
        .where(eq(productColor.id, look.id))
    for (const [i, item] of grid.rows.values.entries()) {
      if (item.photoId && !photos.some((p) => p.id === item.photoId))
        throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está en el producto", {
          [`rows.values.${i}.photoId`]: "Esa foto ya no está",
        })
      const look = lookOf[i]
      const values = {
        value: item.value,
        hex: item.hex,
        hex2: item.hex ? item.hex2 : null,
        photoId: item.photoId,
        updatedAt: now,
      }
      if (!look) colorChanges.push({ field: "colorAdded", from: null, to: item.value })
      else if (look.value !== item.value)
        colorChanges.push({ field: "colorRenamed", from: look.value, to: item.value })
      else if (
        look.hex !== values.hex ||
        look.hex2 !== values.hex2 ||
        look.photoId !== values.photoId
      )
        colorChanges.push({ field: "colorLook", from: null, to: item.value })
      let colorId = look?.id
      if (look) await tx.update(productColor).set(values).where(eq(productColor.id, look.id))
      else {
        const [row] = await tx
          .insert(productColor)
          .values({ storeId, productId, ...values })
          .returning({ id: productColor.id })
        colorId = row!.id
      }
      // La foto del color es de ese color.
      if (item.photoId)
        await tx.update(productPhoto).set({ colorId }).where(eq(productPhoto.id, item.photoId))
    }
  }
  await dropGoneColors(tx, productId)

  const changes: ProductChange[] = [...colorChanges]
  if (JSON.stringify(current.options) !== JSON.stringify(next))
    changes.push({ field: "options", from: current.options, to: next })
  changes.push(...priceChanges, ...promoChanges)
  if (entered) changes.push({ field: "stockIn", from: null, to: entered })
  if (lowered) changes.push({ field: "stockOut", from: null, to: lowered })
  if (created.length) changes.push({ field: "variantsAdded", from: null, to: created.length })
  if (gone.length) changes.push({ field: "variantsRemoved", from: null, to: gone.length })
  if (grid.unitCostCents !== null && entered)
    changes.push({ field: "unitCostCents", from: null, to: grid.unitCostCents })
  await logProductEvent(
    tx,
    storeId,
    productId,
    person.userId,
    "cuadricula",
    changes,
    lowered ? reason : null,
  )
  const detail = await detailIn(tx, storeId, productId)
  return {
    product: detail,
    entered,
    lowered,
    created: created.length,
    removed: gone.length,
    meanwhile,
  }
}

/* ------------------------------------------------ «Probar cuánto cobraría Sofi» */

export const simulateInput = z.object({
  /** La variante; sin ella, la del medio del producto. */
  variantId: z.uuid().optional(),
  quantity: z.number().int().min(1, "Al menos 1").max(1000),
  /** La forma de entrega; sin ella, sin envío. */
  deliveryMethodId: z.uuid().optional(),
  zone: z.string().trim().max(60).nullable().default(null),
  /** Lo que cuesta el envío si «se acuerda». */
  deliveryListCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
})

/**
 * Lo menos que cobraría Sofi por tantas unidades de una variante con una forma de entrega: el
 * precio sin negociar y de dónde sale, el mínimo y la cotización más baja que Sofi podría dar
 * (`lowestQuote` de `precio.ts`, la misma regla de los pedidos). Lo que se gana sale del costo del
 * kardex y solo lo ve quien puede ver costos.
 */
export async function simulatePrice(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
  input: z.infer<typeof simulateInput>,
) {
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx, role) => {
    await productRow(tx, storeId, productId)
    const { currency } = await storeRow(tx, storeId)
    const today = await todayIn(tx, storeId)
    const variants = await variantPrices(tx, storeId, today, undefined, productId)
    const row = input.variantId
      ? variants.find((v) => v.id === input.variantId)
      : variants[Math.floor(variants.length / 2)]
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa variante ya no está")
    const fields: Record<string, string> = {}
    let delivery = {
      listCents: 0,
      maxDiscountCents: null as number | null,
      freeFromCents: null as number | null,
    }
    let deliveryName: string | null = null
    if (input.deliveryMethodId) {
      const [method] = await tx
        .select()
        .from(storeDeliveryMethod)
        .where(
          and(
            eq(storeDeliveryMethod.id, input.deliveryMethodId),
            eq(storeDeliveryMethod.storeId, storeId),
          ),
        )
      const listCents = deliveryListOf(method, input, fields)
      if (method) {
        deliveryName = method.name
        delivery = {
          listCents,
          maxDiscountCents: method.cost === "se_acuerda" ? null : method.maxDiscountCents,
          freeFromCents: method.freeFromCents,
        }
      }
    }
    if (Object.keys(fields).length > 0)
      throw new StoreError(400, "VALIDATION_ERROR", Object.values(fields)[0]!, fields)
    const auto = autoUnit(row.pricing, input.quantity)
    const floor = floorOf(row.pricing, auto.cents)
    const result = lowestQuote(
      {
        quantity: input.quantity,
        listUnitCents: row.pricing.listUnitCents,
        autoUnitCents: auto.cents,
        floorUnitCents: floor,
        offers: row.offers,
      },
      delivery,
      currency,
    )
    const costCents = can(role, "costos.ver") ? await lastEntryCost(tx, productId) : null
    const lowest = result.ok ? result.quote : null
    return {
      variantId: row.id,
      variantName: row.variantName,
      quantity: input.quantity,
      listUnitCents: row.pricing.listUnitCents,
      autoUnitCents: auto.cents,
      /** De dónde sale el precio sin negociar: lista, promoción, cantidad o por mayor. */
      reason: auto.reason,
      promotion: auto.reason === "promocion" ? row.promotion : null,
      floorUnitCents: floor,
      /** Se negocia: hay margen entre el precio sin negociar y el mínimo. */
      negotiable: floor < auto.cents,
      /**
       * Lo que Sofi puede ceder de su precio de hoy hasta el mínimo, por todas las unidades: la
       * barra del margen de la ficha. Lo ve también Ventas, que ya ve el mínimo para negociar.
       */
      canCedeCents: (auto.cents - floor) * input.quantity,
      /** Lo que se gana vendiendo en el mínimo, sin el envío; solo con `costos.ver`. */
      floorGainCents: costCents !== null ? (floor - costCents) * input.quantity : null,
      deliveryName,
      deliveryListCents: delivery.listCents,
      lowest,
      problems: result.ok ? null : result.fields,
      // Lo que costó y lo que se gana en el peor caso, solo con `costos.ver`.
      costCents,
      gainCents:
        costCents !== null && lowest
          ? lowest.subtotalCents -
            costCents * input.quantity -
            // El envío que no paga la clienta lo paga la tienda: el que cede Sofi del margen y
            // también el gratis desde un monto.
            (lowest.deliveryListCents - lowest.deliveryCents)
          : null,
    }
  })
}
