import {
  type Db,
  MAX_PHOTO_BYTES,
  MAX_PRODUCT_OPTIONS,
  MAX_PRODUCT_PHOTOS,
  PRODUCT_RELATIONS,
  type PhotoType,
  type ProductOption,
  product,
  productLink,
  productPhoto,
  productPromotion,
  productQuantityPrice,
  productVariant,
  stockMovement,
  storeEvent,
} from "@gestoria/db"
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { costWarning } from "./dinero.js"
import { lastEntryCost } from "./stock.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * El catálogo de una tienda (paso B3, tableros 7 y 14): productos que agrupan sus variantes
 * (Schema.org `ProductGroup` con `variesBy`, como el catálogo de Meta), con sus fotos, su precio
 * de lista, su precio mínimo de venta, el precio por cantidad, las promociones y lo que Sofi
 * puede recomendar junto a cada uno. Lo ve todo el equipo; lo cambian el Dueño y el
 * Administrador. En B3 solo se guarda: la negociación la hace Sofi en B5.
 */

/** Lo más que un producto puede tener de variantes y una tienda de productos. */
export const MAX_VARIANTS = 200
export const MAX_PRODUCTS = 2000

const money = z.number().int("Escribe un monto válido").min(1, "Debe ser mayor que 0").max(100_000_000)
const label = (what: string, max: number) =>
  z.string().trim().min(1, `Escribe ${what}`).max(max, `Máximo ${max} caracteres`)

const optionInput = z.object({
  name: label("el nombre de la opción (Talla, Color)", 30),
  values: z
    .array(label("cada valor", 30))
    .min(1, "Escribe al menos un valor")
    .max(40, "Hasta 40 valores por opción"),
})

const sameText = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" }) === 0

const options = z
  .array(optionInput)
  .max(MAX_PRODUCT_OPTIONS, `Hasta ${MAX_PRODUCT_OPTIONS} opciones (talla, color, material)`)
  .superRefine((list, ctx) => {
    list.forEach((option, i) => {
      if (list.findIndex((o) => sameText(o.name, option.name)) !== i)
        ctx.addIssue({ code: "custom", path: [i, "name"], message: "Esa opción ya está" })
      option.values.forEach((value, j) => {
        if (option.values.findIndex((v) => sameText(v, value)) !== j)
          ctx.addIssue({ code: "custom", path: [i, "values"], message: `«${value}» está dos veces` })
      })
    })
    const combinations = list.reduce((n, o) => n * o.values.length, 1)
    if (combinations > MAX_VARIANTS)
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `Son ${combinations} combinaciones: el máximo es ${MAX_VARIANTS}`,
      })
  })

/** Los datos de un producto, sin valores por omisión: un cambio solo toca lo que trae. */
const productFields = {
  name: label("el nombre del producto", 120),
  category: z
    .string()
    .trim()
    .max(60, "Máximo 60 caracteres")
    .nullable()
    .transform((c) => c || null),
  description: z.string().trim().max(2000, "Máximo 2000 caracteres"),
  listPriceCents: money,
  minPriceCents: money.nullable(),
  options,
}

const minBelowList = (p: { listPriceCents?: number; minPriceCents?: number | null }) =>
  p.minPriceCents == null || p.listPriceCents == null || p.minPriceCents <= p.listPriceCents

export const productInput = z
  .object({
    ...productFields,
    category: productFields.category.default(null),
    description: productFields.description.default(""),
    minPriceCents: productFields.minPriceCents.default(null),
    options: options.default([]),
  })
  .refine(minBelowList, {
    message: "El precio mínimo no puede ser mayor que el de lista",
    path: ["minPriceCents"],
  })

const dateOnly = z.iso.date("Elige el día")

export const productPatch = z
  .object({
    ...productFields,
    quantityPrices: z
      .array(
        z.object({
          minQuantity: z.number().int().min(2, "Desde 2 unidades").max(1000),
          unitPriceCents: money,
        }),
      )
      .max(5, "Hasta 5 precios por cantidad"),
    promotions: z
      .array(
        z.object({
          name: label("el nombre de la promoción", 60),
          percentOff: z.number().int().min(1, "Al menos 1 %").max(90, "Hasta 90 %"),
          startsOn: dateOnly,
          endsOn: dateOnly,
        }),
      )
      .max(10, "Hasta 10 promociones"),
    links: z
      .array(z.object({ productId: z.uuid(), kind: z.enum(PRODUCT_RELATIONS) }))
      .max(30, "Hasta 30 productos relacionados"),
  })
  .partial()
  .superRefine((p, ctx) => {
    const tiers = p.quantityPrices ?? []
    tiers.forEach((tier, i) => {
      if (tiers.findIndex((t) => t.minQuantity === tier.minQuantity) !== i)
        ctx.addIssue({ code: "custom", path: ["quantityPrices", i, "minQuantity"], message: "Esa cantidad ya está" })
    })
    const promos = p.promotions ?? []
    promos.forEach((promo, i) => {
      if (promo.endsOn < promo.startsOn)
        ctx.addIssue({ code: "custom", path: ["promotions", i, "endsOn"], message: "Termina antes de empezar" })
      promos.forEach((other, j) => {
        if (j < i && promo.startsOn <= other.endsOn && other.startsOn <= promo.endsOn)
          ctx.addIssue({
            code: "custom",
            path: ["promotions", i, "startsOn"],
            message: `Se pisa con «${other.name}»: las promociones no se suman`,
          })
      })
    })
  })

export const variantPatch = z.object({
  sku: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]{1,40}$/, "Hasta 40 letras, números, puntos o guiones, sin espacios")
    .optional(),
  priceCents: money.nullable().optional(),
  photoId: z.uuid().nullable().optional(),
})

/** Lo que identifica un texto para un código: sin tildes, en mayúsculas, solo letras y números. */
function codePart(text: string, max: number): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, max)
}

/** Arma un código único para la variante: «ZAPATILLAU-BLANCA-38». */
export function makeSku(productName: string, values: string[], taken: Set<string>): string {
  const base = [codePart(productName, 10) || "PROD", ...values.map((v) => codePart(v, 8)).filter(Boolean)]
    .join("-")
    .slice(0, 36)
  let sku = base
  for (let n = 2; taken.has(sku.toLowerCase()); n++) sku = `${base}-${n}`
  taken.add(sku.toLowerCase())
  return sku
}

/** Todas las combinaciones de las opciones; sin opciones, una sola variante sin valores. */
export function combinations(list: ProductOption[]): string[][] {
  return list.reduce<string[][]>(
    (acc, option) => acc.flatMap((combo) => option.values.map((value) => [...combo, value])),
    [[]],
  )
}

const sameCombo = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, i) => sameText(value, b[i]!))

function uuidOr404(id: string, message: string) {
  if (!z.uuid().safeParse(id).success) throw new StoreError(404, "NOT_FOUND", message)
}

async function takenSkus(tx: Db, storeId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ sku: productVariant.sku })
    .from(productVariant)
    .where(and(eq(productVariant.storeId, storeId), isNull(productVariant.removedAt)))
  return new Set(rows.map((row) => row.sku.toLowerCase()))
}

function nameTaken(error: unknown): boolean {
  const e = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } }
  return (
    (e.code ?? e.cause?.code) === "23505" &&
    (e.constraint_name ?? e.cause?.constraint_name) === "product_store_name_uidx"
  )
}

async function uniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (nameTaken(error))
      throw new StoreError(409, "NAME_TAKEN", "Ya hay un producto con ese nombre", {
        name: "Ya hay un producto con ese nombre",
      })
    throw error
  }
}

/** La lista del catálogo: cada producto con su rango de precio, sus variantes y lo que queda. */
export async function catalog(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx) => {
    const products = await tx
      .select({
        id: product.id,
        name: product.name,
        category: product.category,
        listPriceCents: product.listPriceCents,
        minPriceCents: product.minPriceCents,
        options: product.options,
      })
      .from(product)
      .where(eq(product.storeId, storeId))
      .orderBy(asc(product.name))
    const variants = await tx
      .select({
        productId: productVariant.productId,
        priceCents: productVariant.priceCents,
        stock: productVariant.stock,
      })
      .from(productVariant)
      .where(and(eq(productVariant.storeId, storeId), isNull(productVariant.removedAt)))
    const photos = await tx
      .select({ id: productPhoto.id, productId: productPhoto.productId, position: productPhoto.position })
      .from(productPhoto)
      .where(eq(productPhoto.storeId, storeId))
      .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
    return {
      products: products.map((p) => {
        const own = variants.filter((v) => v.productId === p.id)
        const prices = own.map((v) => v.priceCents ?? p.listPriceCents)
        return {
          ...p,
          variantCount: own.length,
          stock: own.reduce((sum, v) => sum + v.stock, 0),
          fromCents: prices.length ? Math.min(...prices) : p.listPriceCents,
          toCents: prices.length ? Math.max(...prices) : p.listPriceCents,
          photoId: photos.find((photo) => photo.productId === p.id)?.id ?? null,
        }
      }),
    }
  })
}

async function productRow(tx: Db, storeId: string, productId: string) {
  uuidOr404(productId, "Ese producto ya no está")
  const [row] = await tx
    .select()
    .from(product)
    .where(and(eq(product.id, productId), eq(product.storeId, storeId)))
  if (!row) throw new StoreError(404, "NOT_FOUND", "Ese producto ya no está")
  return row
}

async function detailIn(tx: Db, storeId: string, productId: string) {
  const row = await productRow(tx, storeId, productId)
  const variants = await tx
    .select({
      id: productVariant.id,
      optionValues: productVariant.optionValues,
      sku: productVariant.sku,
      priceCents: productVariant.priceCents,
      photoId: productVariant.photoId,
      stock: productVariant.stock,
    })
    .from(productVariant)
    .where(and(eq(productVariant.productId, productId), isNull(productVariant.removedAt)))
    .orderBy(asc(productVariant.createdAt), asc(productVariant.sku))
  const photos = await tx
    .select({ id: productPhoto.id, position: productPhoto.position })
    .from(productPhoto)
    .where(eq(productPhoto.productId, productId))
    .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
  const quantityPrices = await tx
    .select({ minQuantity: productQuantityPrice.minQuantity, unitPriceCents: productQuantityPrice.unitPriceCents })
    .from(productQuantityPrice)
    .where(eq(productQuantityPrice.productId, productId))
    .orderBy(asc(productQuantityPrice.minQuantity))
  const promotions = await tx
    .select({
      name: productPromotion.name,
      percentOff: productPromotion.percentOff,
      startsOn: productPromotion.startsOn,
      endsOn: productPromotion.endsOn,
    })
    .from(productPromotion)
    .where(eq(productPromotion.productId, productId))
    .orderBy(asc(productPromotion.startsOn))
  const linkRows = await tx
    .select({ a: productLink.productA, b: productLink.productB, kind: productLink.kind })
    .from(productLink)
    .where(or(eq(productLink.productA, productId), eq(productLink.productB, productId)))
  const otherIds = linkRows.map((l) => (l.a === productId ? l.b : l.a))
  const names = otherIds.length
    ? await tx
        .select({ id: product.id, name: product.name })
        .from(product)
        .where(inArray(product.id, otherIds))
    : []
  const allVariantIds = (
    await tx
      .select({ id: productVariant.id })
      .from(productVariant)
      .where(eq(productVariant.productId, productId))
  ).map((v) => v.id)
  const lastCostCents = await lastEntryCost(tx, allVariantIds)
  const prices = variants.map((v) => v.priceCents ?? row.listPriceCents)
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    listPriceCents: row.listPriceCents,
    minPriceCents: row.minPriceCents,
    options: row.options,
    variants,
    photos,
    quantityPrices,
    promotions,
    links: linkRows
      .map((l) => {
        const id = l.a === productId ? l.b : l.a
        return { productId: id, kind: l.kind, name: names.find((n) => n.id === id)?.name ?? "" }
      })
      .sort((x, y) => x.name.localeCompare(y.name, "es")),
    fromCents: prices.length ? Math.min(...prices) : row.listPriceCents,
    toCents: prices.length ? Math.max(...prices) : row.listPriceCents,
    lastCostCents,
    costWarning: costWarning(row.minPriceCents, lastCostCents),
  }
}

export async function productDetail(appDb: Db, person: Person, storeId: string, productId: string) {
  return inStore(appDb, person, storeId, "catalogo.ver", (tx) => detailIn(tx, storeId, productId))
}

/** Crea el producto con todas las combinaciones de sus opciones, cada una con stock 0. */
export async function createProductIn(
  tx: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof productInput>,
  taken?: Set<string>,
) {
  const [row] = await tx
    .insert(product)
    .values({
      storeId,
      name: input.name,
      category: input.category,
      description: input.description,
      listPriceCents: input.listPriceCents,
      minPriceCents: input.minPriceCents,
      options: input.options,
    })
    .returning({ id: product.id })
  const skus = taken ?? (await takenSkus(tx, storeId))
  const combos = combinations(input.options)
  const variants = await tx
    .insert(productVariant)
    .values(
      combos.map((values) => ({
        storeId,
        productId: row!.id,
        optionValues: values,
        sku: makeSku(input.name, values, skus),
      })),
    )
    .returning({ id: productVariant.id, optionValues: productVariant.optionValues, sku: productVariant.sku })
  return { id: row!.id, variants }
}

export async function createProduct(appDb: Db, person: Person, storeId: string, input: z.infer<typeof productInput>) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [{ value }] = (await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(product)
      .where(eq(product.storeId, storeId))) as [{ value: number }]
    if (value >= MAX_PRODUCTS)
      throw new StoreError(409, "TOO_MANY", `Hasta ${MAX_PRODUCTS} productos por tienda`)
    const created = await uniqueName(() => createProductIn(tx, person, storeId, input))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "catalogo.producto",
      subject: input.name,
      detail: { creado: created.id, listPriceCents: input.listPriceCents, minPriceCents: input.minPriceCents },
    })
    return { id: created.id }
  })
}

/**
 * Cambia las opciones de un producto: las combinaciones nuevas se crean con stock 0 y las que
 * ya no están se quitan (su kardex se conserva). Una variante con stock no se quita: antes se
 * ajusta a 0, con su motivo. Cambiar cuántas opciones tiene rehace todas las combinaciones.
 */
async function applyOptions(
  tx: Db,
  storeId: string,
  current: { id: string; name: string; options: ProductOption[] },
  next: ProductOption[],
) {
  const active = await tx
    .select({ id: productVariant.id, optionValues: productVariant.optionValues, stock: productVariant.stock })
    .from(productVariant)
    .where(and(eq(productVariant.productId, current.id), isNull(productVariant.removedAt)))
  const wanted = combinations(next)
  const reshaped = current.options.length !== next.length
  const gone = active.filter((v) => reshaped || !wanted.some((combo) => sameCombo(combo, v.optionValues)))
  const stocked = gone.filter((v) => v.stock > 0)
  if (stocked.length > 0) {
    const names = stocked
      .slice(0, 3)
      .map((v) => `${v.optionValues.join(" ") || current.name} (${v.stock})`)
      .join(", ")
    throw new StoreError(
      409,
      "VARIANT_HAS_STOCK",
      `Para quitar ${stocked.length === 1 ? "esa variante" : "esas variantes"}, primero ajusta su stock a 0: ${names}.`,
      { options: "Hay variantes con stock que se quitarían" },
    )
  }
  const now = new Date()
  if (gone.length > 0)
    await tx
      .update(productVariant)
      .set({ removedAt: now, updatedAt: now })
      .where(inArray(productVariant.id, gone.map((v) => v.id)))
  const kept = active.filter((v) => !gone.includes(v))
  const fresh = wanted.filter((combo) => !kept.some((v) => sameCombo(combo, v.optionValues)))
  if (fresh.length > 0) {
    const skus = await takenSkus(tx, storeId)
    await tx.insert(productVariant).values(
      fresh.map((values) => ({
        storeId,
        productId: current.id,
        optionValues: values,
        sku: makeSku(current.name, values, skus),
      })),
    )
  }
}

export async function updateProduct(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
  patch: z.infer<typeof productPatch>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const current = await productRow(tx, storeId, productId)
    const listPriceCents = patch.listPriceCents ?? current.listPriceCents
    const minPriceCents = patch.minPriceCents !== undefined ? patch.minPriceCents : current.minPriceCents
    if (minPriceCents !== null && minPriceCents > listPriceCents)
      throw new StoreError(400, "VALIDATION_ERROR", "El precio mínimo no puede ser mayor que el de lista", {
        minPriceCents: "El precio mínimo no puede ser mayor que el de lista",
      })
    if (patch.options) await applyOptions(tx, storeId, current, patch.options)
    const changes = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
      listPriceCents,
      minPriceCents,
      updatedAt: new Date(),
    }
    await uniqueName(() => tx.update(product).set(changes).where(eq(product.id, productId)))
    if (patch.quantityPrices) {
      for (const tier of patch.quantityPrices)
        if (tier.unitPriceCents >= listPriceCents)
          throw new StoreError(400, "VALIDATION_ERROR", "El precio por cantidad es menor que el de lista", {
            quantityPrices: "Cada precio por cantidad es menor que el de lista",
          })
      await tx.delete(productQuantityPrice).where(eq(productQuantityPrice.productId, productId))
      if (patch.quantityPrices.length > 0)
        await tx
          .insert(productQuantityPrice)
          .values(patch.quantityPrices.map((tier) => ({ storeId, productId, ...tier })))
    }
    if (patch.promotions) {
      await tx.delete(productPromotion).where(eq(productPromotion.productId, productId))
      if (patch.promotions.length > 0)
        await tx
          .insert(productPromotion)
          .values(patch.promotions.map((promo) => ({ storeId, productId, ...promo })))
    }
    if (patch.links) {
      const others = [...new Set(patch.links.map((l) => l.productId))].filter((id) => id !== productId)
      const found = others.length
        ? await tx
            .select({ id: product.id })
            .from(product)
            .where(and(eq(product.storeId, storeId), inArray(product.id, others)))
        : []
      if (found.length !== others.length)
        throw new StoreError(404, "NOT_FOUND", "Uno de los productos relacionados ya no está")
      await tx
        .delete(productLink)
        .where(or(eq(productLink.productA, productId), eq(productLink.productB, productId)))
      const rows = patch.links
        .filter((l) => l.productId !== productId)
        .map((l) => {
          const [a, b] = [productId, l.productId].sort()
          return { storeId, productA: a!, productB: b!, kind: l.kind }
        })
        .filter((r, i, all) => all.findIndex((o) => o.productA === r.productA && o.productB === r.productB && o.kind === r.kind) === i)
      if (rows.length > 0) await tx.insert(productLink).values(rows)
    }
    if (
      listPriceCents !== current.listPriceCents ||
      minPriceCents !== current.minPriceCents ||
      (patch.name && patch.name !== current.name)
    )
      await tx.insert(storeEvent).values({
        storeId,
        actorUserId: person.userId,
        action: "catalogo.producto",
        subject: patch.name ?? current.name,
        detail: {
          cambiado: productId,
          listPriceCents: { from: current.listPriceCents, to: listPriceCents },
          minPriceCents: { from: current.minPriceCents, to: minPriceCents },
        },
      })
    return detailIn(tx, storeId, productId)
  })
}

/** Borra un producto que nunca movió stock (un error al crearlo). Con kardex, no se borra. */
export async function deleteProduct(appDb: Db, person: Person, storeId: string, productId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const current = await productRow(tx, storeId, productId)
    const [moved] = await tx
      .select({ id: stockMovement.id })
      .from(stockMovement)
      .innerJoin(productVariant, eq(productVariant.id, stockMovement.variantId))
      .where(eq(productVariant.productId, productId))
      .limit(1)
    if (moved)
      throw new StoreError(
        409,
        "HAS_KARDEX",
        "Este producto ya tiene movimientos en su kardex: no se borra, para no perder su historia.",
      )
    await tx.delete(product).where(eq(product.id, productId))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "catalogo.producto",
      subject: current.name,
      detail: { borrado: productId },
    })
  })
}

async function variantRow(tx: Db, storeId: string, variantId: string) {
  uuidOr404(variantId, "Esa variante ya no está")
  const [row] = await tx
    .select()
    .from(productVariant)
    .where(
      and(eq(productVariant.id, variantId), eq(productVariant.storeId, storeId), isNull(productVariant.removedAt)),
    )
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa variante ya no está")
  return row
}

/** Cambia el código, el precio propio o la foto de una variante (nulo: usa el del producto). */
export async function updateVariant(
  appDb: Db,
  person: Person,
  storeId: string,
  variantId: string,
  patch: z.infer<typeof variantPatch>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const variant = await variantRow(tx, storeId, variantId)
    if (patch.photoId) {
      const [photo] = await tx
        .select({ id: productPhoto.id })
        .from(productPhoto)
        .where(and(eq(productPhoto.id, patch.photoId), eq(productPhoto.productId, variant.productId)))
      if (!photo) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está en el producto")
    }
    if (patch.sku && patch.sku.toLowerCase() !== variant.sku.toLowerCase()) {
      const taken = await takenSkus(tx, storeId)
      if (taken.has(patch.sku.toLowerCase()))
        throw new StoreError(409, "SKU_TAKEN", "Ese código ya es de otra variante", {
          sku: "Ese código ya es de otra variante",
        })
    }
    await tx
      .update(productVariant)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productVariant.id, variantId))
    return detailIn(tx, storeId, variant.productId)
  })
}

/** Quita una combinación que no se vende. Con stock, no: antes se ajusta a 0. */
export async function removeVariant(appDb: Db, person: Person, storeId: string, variantId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const variant = await variantRow(tx, storeId, variantId)
    if (variant.stock > 0)
      throw new StoreError(
        409,
        "VARIANT_HAS_STOCK",
        `Tiene ${variant.stock} en stock. Para quitarla, primero ajusta su stock a 0 con el motivo.`,
      )
    const others = await tx
      .select({ id: productVariant.id })
      .from(productVariant)
      .where(and(eq(productVariant.productId, variant.productId), isNull(productVariant.removedAt)))
    if (others.length <= 1)
      throw new StoreError(409, "LAST_VARIANT", "Un producto necesita al menos una variante")
    const now = new Date()
    await tx
      .update(productVariant)
      .set({ removedAt: now, updatedAt: now })
      .where(eq(productVariant.id, variantId))
    return detailIn(tx, storeId, variant.productId)
  })
}

/** El tipo de una imagen por sus primeros bytes, no por lo que dice quien la sube. */
export function imageType(bytes: Uint8Array): PhotoType | null {
  const at = (i: number) => bytes[i]
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg"
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return "image/png"
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  return null
}

export async function addPhoto(appDb: Db, person: Person, storeId: string, productId: string, bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES)
    throw new StoreError(400, "PHOTO_TOO_LARGE", "La foto pesa demasiado. Prueba con otra más chica.")
  const contentType = imageType(bytes)
  if (!contentType)
    throw new StoreError(400, "PHOTO_TYPE", "Sube una foto en JPG, PNG o WebP")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await productRow(tx, storeId, productId)
    const existing = await tx
      .select({ position: productPhoto.position })
      .from(productPhoto)
      .where(eq(productPhoto.productId, productId))
    if (existing.length >= MAX_PRODUCT_PHOTOS)
      throw new StoreError(409, "TOO_MANY_PHOTOS", `Hasta ${MAX_PRODUCT_PHOTOS} fotos por producto`)
    const [row] = await tx
      .insert(productPhoto)
      .values({
        storeId,
        productId,
        position: Math.max(-1, ...existing.map((p) => p.position)) + 1,
        contentType,
        content: Buffer.from(bytes),
        createdBy: person.userId,
      })
      .returning({ id: productPhoto.id, position: productPhoto.position })
    return row!
  })
}

export async function removePhoto(appDb: Db, person: Person, storeId: string, photoId: string) {
  uuidOr404(photoId, "Esa foto ya no está")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    // La variante que la usaba vuelve a la foto del producto.
    await tx
      .update(productVariant)
      .set({ photoId: null, updatedAt: new Date() })
      .where(and(eq(productVariant.storeId, storeId), eq(productVariant.photoId, photoId)))
    const [row] = await tx
      .delete(productPhoto)
      .where(and(eq(productPhoto.id, photoId), eq(productPhoto.storeId, storeId)))
      .returning({ id: productPhoto.id })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
  })
}

export async function photoContent(appDb: Db, person: Person, storeId: string, photoId: string) {
  uuidOr404(photoId, "Esa foto ya no está")
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx) => {
    const [row] = await tx
      .select({ contentType: productPhoto.contentType, content: productPhoto.content })
      .from(productPhoto)
      .where(and(eq(productPhoto.id, photoId), eq(productPhoto.storeId, storeId)))
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
    return row
  })
}
