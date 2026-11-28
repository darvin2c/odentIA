import {
  accountCopy,
  type Db,
  MAX_PHOTO_BYTES,
  MAX_PRODUCT_KEYWORDS,
  MAX_PRODUCT_OPTIONS,
  MAX_PRODUCT_PHOTOS,
  type PhotoType,
  PRODUCT_RELATIONS,
  PRODUCT_RUBROS,
  type ProductChange,
  type ProductEventAction,
  type ProductOption,
  type ProductStatus,
  product,
  productColor,
  productEvent,
  productLink,
  productPhoto,
  productPromotion,
  productQuantityPrice,
  productQuestion,
  productVariant,
  productVideo,
  saleOrder,
  saleOrderLine,
  stockMovement,
  storeEvent,
  storeTemplateField,
} from "@gestoria/db"
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm"
import { z } from "zod"
import { isAgent } from "./agente.js"
import type { Person } from "./cuenta.js"
import { costWarning } from "./dinero.js"
import { can, type StoreSeat } from "./permisos.js"
import { autoUnitCents } from "./precio.js"
import { applyRubroData, mergeTemplate, RUBROS, readinessOf, templateIn } from "./rubros.js"
import { lastEntryCost } from "./stock.js"
import { sameText } from "./texto.js"
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

export const money = z
  .number()
  .int("Escribe un monto válido")
  .min(1, "Debe ser mayor que 0")
  .max(100_000_000)
const label = (what: string, max: number) =>
  z.string().trim().min(1, `Escribe ${what}`).max(max, `Máximo ${max} caracteres`)

const optionInput = z.object({
  name: label("el nombre de la opción (Talla, Color)", 30),
  values: z
    .array(label("cada valor", 30).regex(/^[^,]*$/, "Un valor no lleva comas"))
    .min(1, "Escribe al menos un valor")
    .max(40, "Hasta 40 valores por opción"),
})

export { sameText }

const options = z
  .array(optionInput)
  .max(MAX_PRODUCT_OPTIONS, `Hasta ${MAX_PRODUCT_OPTIONS} opciones (talla, color, material)`)
  .superRefine((list, ctx) => {
    list.forEach((option, i) => {
      if (list.findIndex((o) => sameText(o.name, option.name)) !== i)
        ctx.addIssue({ code: "custom", path: [i, "name"], message: "Esa opción ya está" })
      option.values.forEach((value, j) => {
        if (option.values.findIndex((v) => sameText(v, value)) !== j)
          ctx.addIssue({
            code: "custom",
            path: [i, "values"],
            message: `«${value}» está dos veces`,
          })
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

/**
 * Un GTIN de GS1 (EAN-13, UPC-A, EAN-8 o GTIN-14) con su dígito verificador (módulo 10): el
 * estándar del código de barras que leen las cajas y piden los catálogos de Meta y Google.
 */
export function isGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false
  const digits = [...code].map(Number)
  const check = digits.pop()!
  const sum = digits.reverse().reduce((total, digit, i) => total + digit * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}

export const barcodeInput = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine(isGtin, "Ese código de barras no es válido: revisa sus números (EAN-13 de 13 cifras)")
  .nullable()

export const codeInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]{1,40}$/, "Hasta 40 letras, números, puntos o guiones, sin espacios")

/** Lo que dice la tienda del producto; nulo: «disponible» o «agotado», según su stock. */
const statusInput = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("encargo"),
      days: z.number().int().min(1, "Al menos 1 día").max(365),
    }),
    z.object({ kind: z.literal("cupo"), perDay: z.number().int().min(1, "Al menos 1").max(1000) }),
    z.object({ kind: z.literal("preventa"), date: z.iso.date("Elige el día que llega") }),
    z.object({ kind: z.literal("liquidacion") }),
    z.object({ kind: z.literal("no_se_vende") }),
  ])
  .nullable()

const packageInput = z
  .object({
    /** En gramos y milímetros (la pantalla los muestra en kg y cm). */
    weightG: z.number().int().min(1).max(1_000_000).nullable(),
    lengthMm: z.number().int().min(1).max(10_000).nullable(),
    widthMm: z.number().int().min(1).max(10_000).nullable(),
    heightMm: z.number().int().min(1).max(10_000).nullable(),
  })
  .refine(
    (p) =>
      [p.lengthMm, p.widthMm, p.heightMm].every((v) => v === null) ||
      [p.lengthMm, p.widthMm, p.heightMm].every((v) => v !== null),
    { message: "Escribe el largo, el ancho y el alto", path: ["lengthMm"] },
  )

const keywordsInput = z
  .array(z.string().trim().min(1).max(40, "Máximo 40 caracteres"))
  .max(MAX_PRODUCT_KEYWORDS, `Hasta ${MAX_PRODUCT_KEYWORDS} palabras`)
  .transform((list) =>
    list.filter((word, i) => list.findIndex((other) => sameText(other, word)) === i),
  )

const webInput = z.object({
  visible: z.boolean(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Solo letras sin tilde, números y guiones")
    .max(80, "Máximo 80 caracteres")
    .nullable(),
})

/** El nombre del producto en el link: sin tildes, en minúsculas y con guiones («zapatilla-de-lona»). */
export function slugOf(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "")
}

/**
 * El nombre en el link para un producto nuevo: el de su nombre y, si ya lo tiene otro de la
 * tienda, con un número («zapatilla-de-lona-2»). Nulo si el nombre no deja nada (solo signos).
 */
export async function freeSlug(tx: Db, storeId: string, name: string): Promise<string | null> {
  const base = slugOf(name).slice(0, 76).replace(/-+$/, "")
  if (!base) return null
  const taken = new Set(
    (
      await tx
        .select({ slug: product.webSlug })
        .from(product)
        .where(and(eq(product.storeId, storeId), sql`${product.webSlug} like ${`${base}%`}`))
    ).map((r) => r.slug),
  )
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return null
}

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

/** La versión de la ficha que vio la pantalla: su `updatedAt` en ISO 8601. */
export const versionInput = z.iso.datetime({ offset: true })

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
          /**
           * Solo para un color o una talla: la opción (su índice en `options`) y su valor. Nulo:
           * todo el producto.
           */
          scope: z
            .object({
              optionIndex: z
                .number()
                .int()
                .min(0)
                .max(MAX_PRODUCT_OPTIONS - 1),
              optionValue: z.string().trim().min(1).max(30),
            })
            .nullable()
            .default(null),
        }),
      )
      .max(10, "Hasta 10 promociones"),
    /** El precio para revendedoras: desde tantas unidades, cada una a tanto. Nulo: no hay. */
    wholesale: z
      .object({
        minQuantity: z.number().int().min(2, "Desde 2 unidades").max(10_000),
        unitPriceCents: money,
      })
      .nullable(),
    /** Cuánto menos cuesta lo que combina con este si va junto (el combo). Nulo: sin combo. */
    comboPercentOff: z.number().int().min(1, "Al menos 1 %").max(90, "Hasta 90 %").nullable(),
    /** Lo que Sofi puede ofrecer de este producto (siempre del mismo margen, una sola vez). */
    offers: z
      .object({
        delivery: z.boolean(),
        discount: z.boolean(),
        secondUnit: z.boolean(),
        /** Lo que regala, en palabras («Medias tobilleras»); nulo: no regala. */
        gift: z
          .string()
          .trim()
          .max(80, "Máximo 80 caracteres")
          .nullable()
          .transform((g) => g || null),
      })
      .partial(),
    links: z
      .array(z.object({ productId: z.uuid(), kind: z.enum(PRODUCT_RELATIONS) }))
      .max(30, "Hasta 30 productos relacionados"),
    rubro: z.enum(PRODUCT_RUBROS).nullable(),
    /** Solo los datos que cambian: `null` borra uno; «No aplica» es `{ "noAplica": true }`. */
    rubroData: z.record(z.string(), z.unknown()),
    code: codeInput.nullable(),
    status: statusInput,
    package: packageInput,
    keywords: keywordsInput,
    web: webInput.partial(),
    /**
     * La versión de la ficha que vio la pantalla (su `updatedAt`). Si otra pestaña o persona la
     * cambió después, no se pisa: 409 (`checkVersion`). Sin ella, como antes.
     */
    version: versionInput,
  })
  .partial()
  .superRefine((p, ctx) => {
    const tiers = p.quantityPrices ?? []
    tiers.forEach((tier, i) => {
      if (tiers.findIndex((t) => t.minQuantity === tier.minQuantity) !== i)
        ctx.addIssue({
          code: "custom",
          path: ["quantityPrices", i, "minQuantity"],
          message: "Esa cantidad ya está",
        })
    })
    const promos = p.promotions ?? []
    promos.forEach((promo, i) => {
      if (promo.endsOn < promo.startsOn)
        ctx.addIssue({
          code: "custom",
          path: ["promotions", i, "endsOn"],
          message: "Termina antes de empezar",
        })
      // Dos del mismo alcance no se pisan; de alcances distintos, va la mejor para cada variante.
      const sameScope = (other: typeof promo) =>
        (promo.scope === null && other.scope === null) ||
        (promo.scope !== null &&
          other.scope !== null &&
          promo.scope.optionIndex === other.scope.optionIndex &&
          sameText(promo.scope.optionValue, other.scope.optionValue))
      promos.forEach((other, j) => {
        if (
          j < i &&
          sameScope(other) &&
          promo.startsOn <= other.endsOn &&
          other.startsOn <= promo.endsOn
        )
          ctx.addIssue({
            code: "custom",
            path: ["promotions", i, "startsOn"],
            message: `Se pisa con «${other.name}»: las promociones no se suman`,
          })
      })
    })
  })

export const variantPatch = z.object({
  sku: codeInput.optional(),
  priceCents: money.nullable().optional(),
  photoId: z.uuid().nullable().optional(),
  barcode: barcodeInput.optional(),
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
  const base = [
    codePart(productName, 10) || "PROD",
    ...values.map((v) => codePart(v, 8)).filter(Boolean),
  ]
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

export function uuidOr404(id: string, message: string) {
  if (!z.uuid().safeParse(id).success) throw new StoreError(404, "NOT_FOUND", message)
}

export async function takenSkus(tx: Db, storeId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ sku: productVariant.sku })
    .from(productVariant)
    .where(and(eq(productVariant.storeId, storeId), isNull(productVariant.removedAt)))
  return new Set(rows.map((row) => row.sku.toLowerCase()))
}

/** La lista del catálogo: cada producto con su rango de precio, sus variantes y lo que queda. */
/**
 * El catálogo, una fila por producto: su precio, sus variantes y su stock, y para la tabla de la
 * pantalla (lienzo «La ficha del producto», e7) sus colores con su muestra, su estado y qué tan
 * lista está para Sofi (`readinessOf`, la misma cuenta de la ficha).
 */
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
        colorOption: product.colorOption,
        status: product.status,
        rubro: product.rubro,
        rubroData: product.rubroData,
        keywords: product.keywords,
        offerDelivery: product.offerDelivery,
        offerDiscount: product.offerDiscount,
        offerSecondUnit: product.offerSecondUnit,
        offerGift: product.offerGift,
        packageWeightG: product.packageWeightG,
        packageLengthMm: product.packageLengthMm,
      })
      .from(product)
      .where(eq(product.storeId, storeId))
      .orderBy(asc(product.name))
    const looks = await tx
      .select({
        productId: productColor.productId,
        id: productColor.id,
        value: productColor.value,
        hex: productColor.hex,
        hex2: productColor.hex2,
        photoId: productColor.photoId,
      })
      .from(productColor)
      .where(eq(productColor.storeId, storeId))
    const ownTemplates = await tx
      .select()
      .from(storeTemplateField)
      .where(eq(storeTemplateField.storeId, storeId))
    // El precio de venta de hoy de cada producto (con su promoción, `precio.ts`), el mismo que da
    // Sofi: con él se compara «algo más barato». De lo que hay (o se vende sin stock), si no, de todo.
    // `pedidos.ts` importa este archivo: se trae al usarlo, para no armar un ciclo al cargar.
    const { todayIn, variantPrices } = await import("./pedidos.js")
    const priced = Map.groupBy(
      await variantPrices(tx, storeId, await todayIn(tx, storeId)),
      (v) => v.productId,
    )
    const saleFromOf = (productId: string) => {
      const own = priced.get(productId) ?? []
      const selling = own.filter((v) => v.stock > 0 || v.sellsWithoutStock)
      const prices = (selling.length ? selling : own).map((v) => autoUnitCents(v.pricing, 1))
      return prices.length ? Math.min(...prices) : null
    }
    const variants = await tx
      .select({
        productId: productVariant.productId,
        priceCents: productVariant.priceCents,
        stock: productVariant.stock,
      })
      .from(productVariant)
      .where(and(eq(productVariant.storeId, storeId), isNull(productVariant.removedAt)))
    const photos = await tx
      .select({
        id: productPhoto.id,
        productId: productPhoto.productId,
        position: productPhoto.position,
        colorId: productPhoto.colorId,
      })
      .from(productPhoto)
      .where(eq(productPhoto.storeId, storeId))
      .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
    const byProduct = Map.groupBy(variants, (v) => v.productId)
    const photosOf = Map.groupBy(photos, (p) => p.productId)
    const looksOf = Map.groupBy(looks, (l) => l.productId)
    const templates = new Map(
      PRODUCT_RUBROS.map((rubro) => [
        rubro,
        mergeTemplate(
          rubro,
          ownTemplates.filter((row) => row.rubro === rubro),
        ),
      ]),
    )
    return {
      products: products.map((p) => {
        const own = byProduct.get(p.id) ?? []
        const prices = own.map((v) => v.priceCents ?? p.listPriceCents)
        const stock = own.reduce((sum, v) => sum + v.stock, 0)
        const ownPhotos = photosOf.get(p.id) ?? []
        const colors = (p.colorOption === null ? [] : (p.options[p.colorOption]?.values ?? [])).map(
          (value) => {
            const look = (looksOf.get(p.id) ?? []).find((l) => sameText(l.value, value))
            return {
              value,
              hex: look?.hex ?? null,
              hex2: look?.hex2 ?? null,
              hasPhoto:
                !!look?.photoId || (!!look && ownPhotos.some((ph) => ph.colorId === look.id)),
            }
          },
        )
        const readiness = readinessOf({
          listPriceCents: p.listPriceCents,
          minPriceCents: p.minPriceCents,
          stock,
          sellsWithoutStock: sellsWithoutStock(p.status),
          colors,
          photoCount: ownPhotos.length,
          rowLabel: p.rubro ? RUBROS[p.rubro].rowLabel : "Color",
          template: p.rubro ? (templates.get(p.rubro) ?? []) : [],
          rubroData: p.rubroData,
          offersSomething: p.offerDelivery || p.offerDiscount || p.offerSecondUnit || !!p.offerGift,
          keywordCount: p.keywords.length,
          hasPackage: p.packageWeightG !== null && p.packageLengthMm !== null,
        })
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          listPriceCents: p.listPriceCents,
          minPriceCents: p.minPriceCents,
          options: p.options,
          colorOption: p.colorOption,
          rubro: p.rubro,
          colors: colors.map(({ hasPhoto: _photo, ...color }) => color),
          state: saleStateOf(p.status, stock),
          readiness: {
            level: readiness.level,
            sellsAlone: readiness.sellsAlone,
            complete: readiness.complete,
            done: readiness.done,
            total: readiness.total,
            neededMissing: readiness.items.filter((i) => i.needed && !i.ok).length,
          },
          variantCount: own.length,
          stock,
          soldOut: own.filter((v) => v.stock === 0).length,
          fromCents: prices.length ? Math.min(...prices) : p.listPriceCents,
          toCents: prices.length ? Math.max(...prices) : p.listPriceCents,
          /** El precio de venta de hoy, desde (con su promoción); nulo si ya no se vende. */
          saleFromCents: saleFromOf(p.id),
          photoId: ownPhotos[0]?.id ?? null,
        }
      }),
    }
  })
}

/**
 * Si la ficha cambió desde la versión que vio la pantalla (otra pestaña, otra persona), no se
 * guarda encima: 409. Toma la fila mientras se guarda, así dos guardados a la vez no pasan los dos.
 */
export async function checkVersion(
  tx: Db,
  storeId: string,
  productId: string,
  version: string | undefined,
) {
  if (version === undefined) return
  uuidOr404(productId, "Ese producto ya no está")
  const [row] = await tx
    .select({ updatedAt: product.updatedAt })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.storeId, storeId)))
    .for("update")
  if (row && Date.parse(version) !== row.updatedAt.getTime())
    throw new StoreError(
      409,
      "STALE",
      "Alguien cambió esta ficha mientras la tenías abierta. Lo tuyo sigue aquí, sin guardar.",
    )
}

export async function productRow(tx: Db, storeId: string, productId: string) {
  uuidOr404(productId, "Ese producto ya no está")
  const [row] = await tx
    .select()
    .from(product)
    .where(and(eq(product.id, productId), eq(product.storeId, storeId)))
  if (!row) throw new StoreError(404, "NOT_FOUND", "Ese producto ya no está")
  return row
}

/** Lo que el producto muestra: «disponible» y «agotado» salen del stock; lo demás lo pone la tienda. */
export type SaleState = "disponible" | "agotado" | ProductStatus

export function saleStateOf(status: ProductStatus | null, stock: number): SaleState {
  return status ?? (stock > 0 ? "disponible" : "agotado")
}

/** Por encargo, con cupo o en preventa se vende sin stock: el pedido espera a que entre. */
export const SELLS_WITHOUT_STOCK: readonly ProductStatus[] = ["encargo", "cupo", "preventa"]

export const sellsWithoutStock = (status: ProductStatus | null) =>
  status !== null && SELLS_WITHOUT_STOCK.includes(status)

/** El precio para revendedoras de un producto: desde cuántas y a cuánto, o nada. */
export function wholesaleOf(row: {
  wholesaleMinQuantity: number | null
  wholesalePriceCents: number | null
}) {
  return row.wholesaleMinQuantity !== null && row.wholesalePriceCents !== null
    ? { minQuantity: row.wholesaleMinQuantity, unitPriceCents: row.wholesalePriceCents }
    : null
}

/** El nombre de quien anotó algo: el de su cuenta, o «Sofi» si fue ella. */
export async function namesOf(tx: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const people = [...new Set(ids.filter((id): id is string => !!id && !isAgent(id)))]
  const rows = people.length
    ? await tx
        .select({ id: accountCopy.userId, name: accountCopy.name })
        .from(accountCopy)
        .where(inArray(accountCopy.userId, people))
    : []
  const names = new Map(rows.map((row) => [row.id, row.name]))
  for (const id of ids) if (id && isAgent(id)) names.set(id, "Sofi")
  return names
}

/** Los colores del producto, en el orden de su opción, con cómo se ven y su foto. */
async function colorsIn(tx: Db, row: typeof product.$inferSelect) {
  if (row.colorOption === null) return []
  const values = row.options[row.colorOption]?.values ?? []
  const looks = await tx.select().from(productColor).where(eq(productColor.productId, row.id))
  return values.map((value) => {
    const look = looks.find((l) => sameText(l.value, value))
    return {
      id: look?.id ?? null,
      value,
      hex: look?.hex ?? null,
      hex2: look?.hex2 ?? null,
      photoId: look?.photoId ?? null,
    }
  })
}

export async function detailIn(tx: Db, storeId: string, productId: string) {
  const row = await productRow(tx, storeId, productId)
  const variants = await tx
    .select({
      id: productVariant.id,
      optionValues: productVariant.optionValues,
      sku: productVariant.sku,
      barcode: productVariant.barcode,
      priceCents: productVariant.priceCents,
      photoId: productVariant.photoId,
      stock: productVariant.stock,
    })
    .from(productVariant)
    .where(and(eq(productVariant.productId, productId), isNull(productVariant.removedAt)))
    .orderBy(asc(productVariant.createdAt), asc(productVariant.sku))
  const photos = await tx
    .select({ id: productPhoto.id, position: productPhoto.position, colorId: productPhoto.colorId })
    .from(productPhoto)
    .where(eq(productPhoto.productId, productId))
    .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
  const quantityPrices = await tx
    .select({
      minQuantity: productQuantityPrice.minQuantity,
      unitPriceCents: productQuantityPrice.unitPriceCents,
    })
    .from(productQuantityPrice)
    .where(eq(productQuantityPrice.productId, productId))
    .orderBy(asc(productQuantityPrice.minQuantity))
  const promotionRows = await tx
    .select({
      name: productPromotion.name,
      percentOff: productPromotion.percentOff,
      startsOn: productPromotion.startsOn,
      endsOn: productPromotion.endsOn,
      optionIndex: productPromotion.optionIndex,
      optionValue: productPromotion.optionValue,
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
  const questionRows = await tx
    .select()
    .from(productQuestion)
    .where(eq(productQuestion.productId, productId))
    .orderBy(desc(productQuestion.askedAt))
    .limit(100)
  const who = await namesOf(
    tx,
    questionRows.flatMap((q) => [q.askedBy, q.answeredBy, q.savedBy]),
  )
  const colors = await colorsIn(tx, row)
  const template = row.rubro ? await templateIn(tx, storeId, row.rubro) : []
  const lastCostCents = await lastEntryCost(tx, productId)
  const prices = variants.map((v) => v.priceCents ?? row.listPriceCents)
  const stock = variants.reduce((sum, v) => sum + v.stock, 0)
  const pkg = {
    weightG: row.packageWeightG,
    lengthMm: row.packageLengthMm,
    widthMm: row.packageWidthMm,
    heightMm: row.packageHeightMm,
  }
  const promotions = promotionRows.map(({ optionIndex, optionValue, ...promo }) => ({
    ...promo,
    scope: optionIndex !== null && optionValue !== null ? { optionIndex, optionValue } : null,
  }))
  const offers = {
    delivery: row.offerDelivery,
    discount: row.offerDiscount,
    secondUnit: row.offerSecondUnit,
    gift: row.offerGift,
  }
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    code: row.code,
    listPriceCents: row.listPriceCents,
    minPriceCents: row.minPriceCents,
    options: row.options,
    colorOption: row.colorOption,
    colors,
    variants,
    photos,
    quantityPrices,
    promotions,
    wholesale: wholesaleOf(row),
    comboPercentOff: row.comboPercentOff,
    offers,
    links: linkRows
      .map((l) => {
        const id = l.a === productId ? l.b : l.a
        return { productId: id, kind: l.kind, name: names.find((n) => n.id === id)?.name ?? "" }
      })
      .sort((x, y) => x.name.localeCompare(y.name, "es")),
    state: saleStateOf(row.status, stock),
    status: row.status,
    statusDays: row.statusDays,
    statusPerDay: row.statusPerDay,
    statusDate: row.statusDate,
    rubro: row.rubro,
    rubroData: row.rubroData,
    template,
    package: pkg,
    keywords: row.keywords,
    web: { visible: row.webVisible, slug: row.webSlug },
    questions: questionRows.map((q) => ({
      id: q.id,
      question: q.question,
      conversationId: q.conversationId,
      askedBy: who.get(q.askedBy) ?? null,
      askedAt: q.askedAt,
      answer: q.answer,
      answeredBy: q.answeredBy ? (who.get(q.answeredBy) ?? null) : null,
      answeredAt: q.answeredAt,
      saveRequested: q.saveRequested,
      savedBy: q.savedBy ? (who.get(q.savedBy) ?? null) : null,
      savedAt: q.savedAt,
    })),
    readiness: readinessOf({
      listPriceCents: row.listPriceCents,
      minPriceCents: row.minPriceCents,
      stock,
      sellsWithoutStock: sellsWithoutStock(row.status),
      colors: colors.map((c) => ({
        value: c.value,
        hasPhoto: !!c.photoId || (!!c.id && photos.some((p) => p.colorId === c.id)),
      })),
      photoCount: photos.length,
      rowLabel: row.rubro ? RUBROS[row.rubro].rowLabel : "Color",
      template,
      rubroData: row.rubroData,
      offersSomething: offers.delivery || offers.discount || offers.secondUnit || !!offers.gift,
      keywordCount: row.keywords.length,
      hasPackage: pkg.weightG !== null && pkg.lengthMm !== null,
    }),
    fromCents: prices.length ? Math.min(...prices) : row.listPriceCents,
    toCents: prices.length ? Math.max(...prices) : row.listPriceCents,
    lastCostCents,
    costWarning: costWarning(row.minPriceCents, lastCostCents),
    updatedAt: row.updatedAt,
  }
}

export type ProductDetail = Awaited<ReturnType<typeof detailIn>>

/** Lo que costó es del dueño: quien no puede ver costos no lo recibe, ni el aviso que lo nombra. */
export function forRole<T extends { lastCostCents: number | null; costWarning: unknown }>(
  detail: T,
  role: StoreSeat,
): T {
  return can(role, "costos.ver") ? detail : { ...detail, lastCostCents: null, costWarning: null }
}

export async function productDetail(appDb: Db, person: Person, storeId: string, productId: string) {
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx, role) =>
    forRole(await detailIn(tx, storeId, productId), role),
  )
}

/** Anota un cambio de la ficha en su historial, con quién y cuándo (lo pone la base). */
export async function logProductEvent(
  tx: Db,
  storeId: string,
  productId: string,
  actorUserId: string,
  action: ProductEventAction,
  changes: ProductChange[],
  reason: string | null = null,
) {
  await tx.insert(productEvent).values({ storeId, productId, actorUserId, action, changes, reason })
}

/** Lo que cambió entre dos versiones, campo por campo (solo los que trae `after`). */
export function changesOf(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: ProductChange[] = []
  for (const [field, to] of Object.entries(after)) {
    const from = before[field]
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null))
      out.push({ field, from: from ?? null, to: to ?? null })
  }
  return out
}

/** El historial de la ficha, del más nuevo al más viejo, con el nombre de quien lo hizo. */
export async function productHistory(
  appDb: Db,
  person: Person,
  storeId: string,
  productId: string,
) {
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx, role) => {
    const current = await productRow(tx, storeId, productId)
    const rows = await tx
      .select()
      .from(productEvent)
      .where(eq(productEvent.productId, productId))
      .orderBy(desc(productEvent.createdAt), desc(productEvent.id))
      .limit(200)
    const who = await namesOf(
      tx,
      rows.map((r) => r.actorUserId),
    )
    // Lo que costó solo lo ve quien puede ver costos.
    const costs = can(role, "costos.ver")
    const events = rows.map((r) => ({
      id: r.id,
      action: r.action as string,
      actorName: who.get(r.actorUserId) ?? null,
      changes: costs ? r.changes : r.changes.filter((c) => c.field !== "unitCostCents"),
      reason: r.reason,
      createdAt: r.createdAt,
    }))
    // «Creó el producto» va siempre al final: uno que se creó sin anotarlo (antes, o desde otra
    // pantalla) lo dice con su fecha, sin el nombre que no se sabe.
    if (rows.length < 200 && !rows.some((r) => r.action === "creado"))
      events.push({
        id: `creado-${productId}`,
        action: "creado",
        actorName: null,
        changes: [],
        reason: null,
        createdAt: current.createdAt,
      })
    return { events }
  })
}

/** La opción del color: la que se llama así (como en la migración `0034`); null si no hay. */
export function colorOptionOf(options: ProductOption[]): number | null {
  const i = options.findIndex((o) =>
    ["color", "colores", "tono", "tonos"].includes(o.name.trim().toLocaleLowerCase("es")),
  )
  return i >= 0 ? i : null
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
      colorOption: colorOptionOf(input.options),
      // Nace con su link: el catálogo web y «Copiar el link» lo tienen desde el principio.
      webSlug: await freeSlug(tx, storeId, input.name),
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
    .returning({
      id: productVariant.id,
      optionValues: productVariant.optionValues,
      sku: productVariant.sku,
    })
  return { id: row!.id, variants }
}

export async function createProduct(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof productInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [{ value }] = (await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(product)
      .where(eq(product.storeId, storeId))) as [{ value: number }]
    if (value >= MAX_PRODUCTS)
      throw new StoreError(409, "TOO_MANY", `Hasta ${MAX_PRODUCTS} productos por tienda`)
    const created = await createProductIn(tx, person, storeId, input)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "catalogo.producto",
      subject: input.name,
      detail: {
        creado: created.id,
        listPriceCents: input.listPriceCents,
        minPriceCents: input.minPriceCents,
      },
    })
    await logProductEvent(tx, storeId, created.id, person.userId, "creado", [])
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
    .select({
      id: productVariant.id,
      optionValues: productVariant.optionValues,
      stock: productVariant.stock,
    })
    .from(productVariant)
    .where(and(eq(productVariant.productId, current.id), isNull(productVariant.removedAt)))
    // Se toman las filas: una entrada a la vez no deja quitada una variante con stock.
    .for("update")
  const wanted = combinations(next)
  const reshaped = current.options.length !== next.length
  const gone = active.filter(
    (v) => reshaped || !wanted.some((combo) => sameCombo(combo, v.optionValues)),
  )
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
      .where(
        inArray(
          productVariant.id,
          gone.map((v) => v.id),
        ),
      )
  const kept = active.filter((v) => !gone.includes(v))
  // Solo se crean las combinaciones de un valor nuevo: lo que se quitó a mano no vuelve.
  const isNew = (combo: string[]) =>
    reshaped ||
    combo.some((value, i) => !current.options[i]?.values.some((old) => sameText(old, value)))
  const fresh = wanted.filter(
    (combo) => isNew(combo) && !kept.some((v) => sameCombo(combo, v.optionValues)),
  )
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
    await checkVersion(tx, storeId, productId, patch.version)
    const current = await productRow(tx, storeId, productId)
    const before = sheetOf(await detailIn(tx, storeId, productId))
    const listPriceCents = patch.listPriceCents ?? current.listPriceCents
    const minPriceCents =
      patch.minPriceCents !== undefined ? patch.minPriceCents : current.minPriceCents
    if (minPriceCents !== null && minPriceCents > listPriceCents)
      throw new StoreError(
        400,
        "VALIDATION_ERROR",
        "El precio mínimo no puede ser mayor que el de lista",
        {
          minPriceCents: "El precio mínimo no puede ser mayor que el de lista",
        },
      )
    if (patch.options) await applyOptions(tx, storeId, current, patch.options)
    const rubro = patch.rubro !== undefined ? patch.rubro : current.rubro
    let rubroData = current.rubroData
    if (patch.rubroData) {
      if (!rubro)
        throw new StoreError(400, "VALIDATION_ERROR", "Elige primero el rubro del producto", {
          rubro: "Elige el rubro",
        })
      const template = await templateIn(tx, storeId, rubro)
      const applied = applyRubroData(template, rubroData, patch.rubroData)
      if (!applied.ok)
        throw new StoreError(
          400,
          "VALIDATION_ERROR",
          Object.values(applied.fields)[0]!,
          applied.fields,
        )
      rubroData = applied.data
    }
    // La opción del color sigue a su nombre: si se movió, cambia su índice; si se quitó, no hay color.
    const colorName =
      current.colorOption !== null ? current.options[current.colorOption]?.name : undefined
    const colorIndex =
      patch.options && colorName !== undefined
        ? patch.options.findIndex((o) => sameText(o.name, colorName))
        : -1
    const colorMoved = patch.options !== undefined && current.colorOption !== null
    // El precio de revendedora queda bajo el de lista, como el precio por cantidad.
    const wholesale = patch.wholesale !== undefined ? patch.wholesale : wholesaleOf(current)
    if (wholesale && wholesale.unitPriceCents >= listPriceCents)
      throw new StoreError(
        400,
        "VALIDATION_ERROR",
        "El precio por mayor es menor que el de lista",
        {
          wholesale: "El precio por mayor es menor que el de lista",
        },
      )
    const options = patch.options ?? current.options
    for (const [i, promo] of (patch.promotions ?? []).entries())
      if (
        promo.scope &&
        !options[promo.scope.optionIndex]?.values.some((v) => sameText(v, promo.scope!.optionValue))
      )
        throw new StoreError(
          400,
          "VALIDATION_ERROR",
          "Esa promoción es de un color o talla que no está",
          {
            [`promotions.${i}.scope`]: "Ese color o talla no está en el producto",
          },
        )
    const changes = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
      ...(colorMoved ? { colorOption: colorIndex >= 0 ? colorIndex : null } : {}),
      ...(patch.rubro !== undefined ? { rubro: patch.rubro } : {}),
      ...(patch.rubroData !== undefined ? { rubroData } : {}),
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.status !== undefined ? statusColumns(patch.status) : {}),
      ...(patch.package !== undefined
        ? {
            packageWeightG: patch.package.weightG,
            packageLengthMm: patch.package.lengthMm,
            packageWidthMm: patch.package.widthMm,
            packageHeightMm: patch.package.heightMm,
          }
        : {}),
      ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
      ...(patch.web?.visible !== undefined ? { webVisible: patch.web.visible } : {}),
      ...(patch.web?.slug !== undefined ? { webSlug: patch.web.slug } : {}),
      ...(patch.wholesale !== undefined
        ? {
            wholesaleMinQuantity: patch.wholesale?.minQuantity ?? null,
            wholesalePriceCents: patch.wholesale?.unitPriceCents ?? null,
          }
        : {}),
      ...(patch.comboPercentOff !== undefined ? { comboPercentOff: patch.comboPercentOff } : {}),
      ...(patch.offers?.delivery !== undefined ? { offerDelivery: patch.offers.delivery } : {}),
      ...(patch.offers?.discount !== undefined ? { offerDiscount: patch.offers.discount } : {}),
      ...(patch.offers?.secondUnit !== undefined
        ? { offerSecondUnit: patch.offers.secondUnit }
        : {}),
      ...(patch.offers?.gift !== undefined ? { offerGift: patch.offers.gift } : {}),
      listPriceCents,
      minPriceCents,
      updatedAt: new Date(),
    }
    await tx.update(product).set(changes).where(eq(product.id, productId))
    if (patch.options) {
      await dropGoneColors(tx, productId)
      if (!patch.promotions) await followOptions(tx, productId, current.options, patch.options)
    }
    if (patch.quantityPrices) {
      for (const tier of patch.quantityPrices)
        if (tier.unitPriceCents >= listPriceCents)
          throw new StoreError(
            400,
            "VALIDATION_ERROR",
            "El precio por cantidad es menor que el de lista",
            {
              quantityPrices: "Cada precio por cantidad es menor que el de lista",
            },
          )
      await tx.delete(productQuantityPrice).where(eq(productQuantityPrice.productId, productId))
      if (patch.quantityPrices.length > 0)
        await tx
          .insert(productQuantityPrice)
          .values(patch.quantityPrices.map((tier) => ({ storeId, productId, ...tier })))
    }
    if (patch.promotions) {
      await tx.delete(productPromotion).where(eq(productPromotion.productId, productId))
      if (patch.promotions.length > 0)
        await tx.insert(productPromotion).values(
          patch.promotions.map(({ scope, ...promo }) => ({
            storeId,
            productId,
            ...promo,
            optionIndex: scope?.optionIndex ?? null,
            optionValue: scope
              ? (options[scope.optionIndex]?.values.find((v) => sameText(v, scope.optionValue)) ??
                scope.optionValue)
              : null,
          })),
        )
    }
    if (patch.links) {
      const others = [...new Set(patch.links.map((l) => l.productId))].filter(
        (id) => id !== productId,
      )
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
        .filter(
          (r, i, all) =>
            all.findIndex(
              (o) => o.productA === r.productA && o.productB === r.productB && o.kind === r.kind,
            ) === i,
        )
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
    const after = await detailIn(tx, storeId, productId)
    const sheet = sheetOf(after)
    const touched = Object.keys(patch).filter((key) => key in sheet) as (keyof typeof sheet)[]
    const diff = changesOf(
      Object.fromEntries(touched.map((key) => [key, before[key]])),
      Object.fromEntries(touched.map((key) => [key, sheet[key]])),
    )
    if (diff.length > 0)
      await logProductEvent(tx, storeId, productId, person.userId, "cambiado", diff)
    return after
  })
}

/**
 * Las promociones de un color o una talla siguen a su opción cuando cambian las opciones: por el
 * nombre de la opción y su valor. La de un valor que ya no está se borra: no tiene a quién bajarle.
 */
async function followOptions(
  tx: Db,
  productId: string,
  before: ProductOption[],
  after: ProductOption[],
) {
  const scoped = await tx
    .select()
    .from(productPromotion)
    .where(and(eq(productPromotion.productId, productId), isNotNull(productPromotion.optionIndex)))
  for (const promo of scoped) {
    const name = before[promo.optionIndex!]?.name
    const index = name === undefined ? -1 : after.findIndex((o) => sameText(o.name, name))
    const value =
      index >= 0 ? after[index]!.values.find((v) => sameText(v, promo.optionValue!)) : undefined
    if (value === undefined)
      await tx.delete(productPromotion).where(eq(productPromotion.id, promo.id))
    else if (index !== promo.optionIndex || value !== promo.optionValue)
      await tx
        .update(productPromotion)
        .set({ optionIndex: index, optionValue: value })
        .where(eq(productPromotion.id, promo.id))
  }
}

/** Las columnas del estado que pone la tienda (nulo: disponible o agotado, por su stock). */
function statusColumns(status: z.infer<typeof statusInput>) {
  return {
    status: status?.kind ?? null,
    statusDays: status?.kind === "encargo" ? status.days : null,
    statusPerDay: status?.kind === "cupo" ? status.perDay : null,
    statusDate: status?.kind === "preventa" ? status.date : null,
  }
}

/**
 * La ficha con la forma de `productPatch`: así el historial guarda cada cambio como se pide, y
 * deshacer es volver a pedir los valores de antes.
 */
export function sheetOf(detail: ProductDetail) {
  const status =
    detail.status === "encargo"
      ? { kind: "encargo" as const, days: detail.statusDays }
      : detail.status === "cupo"
        ? { kind: "cupo" as const, perDay: detail.statusPerDay }
        : detail.status === "preventa"
          ? { kind: "preventa" as const, date: detail.statusDate }
          : detail.status
            ? { kind: detail.status }
            : null
  return {
    name: detail.name,
    category: detail.category,
    description: detail.description,
    listPriceCents: detail.listPriceCents,
    minPriceCents: detail.minPriceCents,
    options: detail.options,
    quantityPrices: detail.quantityPrices,
    promotions: detail.promotions,
    wholesale: detail.wholesale,
    comboPercentOff: detail.comboPercentOff,
    offers: detail.offers,
    links: detail.links.map((l) => ({ productId: l.productId, kind: l.kind })),
    rubro: detail.rubro,
    rubroData: detail.rubroData,
    code: detail.code,
    status,
    package: detail.package,
    keywords: detail.keywords,
    web: detail.web,
  }
}

/**
 * Los colores que ya no están en la opción del color se borran, y sus fotos quedan para todos: el
 * color existe por su valor en la opción, no por su fila.
 */
export async function dropGoneColors(tx: Db, productId: string) {
  const [row] = await tx
    .select({ options: product.options, colorOption: product.colorOption })
    .from(product)
    .where(eq(product.id, productId))
  const values = row?.colorOption != null ? (row.options[row.colorOption]?.values ?? []) : []
  const looks = await tx
    .select({ id: productColor.id, value: productColor.value })
    .from(productColor)
    .where(eq(productColor.productId, productId))
  const gone = looks.filter((l) => !values.some((v) => sameText(v, l.value))).map((l) => l.id)
  if (gone.length === 0) return
  await tx.update(productPhoto).set({ colorId: null }).where(inArray(productPhoto.colorId, gone))
  // El video de un color que se va queda como el del producto si no tiene uno; si lo tiene, se
  // quita (la base anota su carpeta para borrarla del almacenamiento).
  const videos = await tx
    .select({ id: productVideo.id, colorId: productVideo.colorId })
    .from(productVideo)
    .where(eq(productVideo.productId, productId))
  let productSlot = videos.some((v) => v.colorId === null)
  for (const video of videos.filter((v) => v.colorId && gone.includes(v.colorId))) {
    if (productSlot) await tx.delete(productVideo).where(eq(productVideo.id, video.id))
    else {
      await tx.update(productVideo).set({ colorId: null }).where(eq(productVideo.id, video.id))
      productSlot = true
    }
  }
  await tx.delete(productColor).where(inArray(productColor.id, gone))
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
      and(
        eq(productVariant.id, variantId),
        eq(productVariant.storeId, storeId),
        isNull(productVariant.removedAt),
      ),
    )
    .for("update")
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
        .where(
          and(eq(productPhoto.id, patch.photoId), eq(productPhoto.productId, variant.productId)),
        )
      if (!photo) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está en el producto")
    }
    // Un código repetido lo rechaza el índice único de la base (`SKU_TAKEN`, `BARCODE_TAKEN`).
    await tx
      .update(productVariant)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productVariant.id, variantId))
    const before: Record<string, unknown> = {
      sku: variant.sku,
      priceCents: variant.priceCents,
      photoId: variant.photoId,
      barcode: variant.barcode,
    }
    const diff = changesOf(
      Object.fromEntries(Object.keys(patch).map((key) => [key, before[key]])),
      patch,
    )
    if (diff.length > 0)
      await logProductEvent(tx, storeId, variant.productId, person.userId, "cambiado", [
        { field: "variant", from: variant.optionValues, to: variant.optionValues },
        ...diff,
      ])
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
    // Un pedido abierto todavía tiene que descontarla: primero se entrega o se anula.
    const [open] = await tx
      .select({ number: saleOrder.number })
      .from(saleOrderLine)
      .innerJoin(saleOrder, eq(saleOrder.id, saleOrderLine.orderId))
      .where(
        and(
          eq(saleOrderLine.variantId, variantId),
          notInArray(saleOrder.state, ["entregado", "anulado"]),
        ),
      )
      .limit(1)
    if (open)
      throw new StoreError(
        409,
        "VARIANT_IN_ORDER",
        `Está en el pedido ${String(open.number).padStart(4, "0")}, todavía abierto. Entrégalo o anúlalo antes de quitarla.`,
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
    // Un valor que ya no usa ninguna variante sale de las opciones del producto.
    const rest = await tx
      .select({ optionValues: productVariant.optionValues })
      .from(productVariant)
      .where(and(eq(productVariant.productId, variant.productId), isNull(productVariant.removedAt)))
    const current = await productRow(tx, storeId, variant.productId)
    const options = current.options.map((option, i) => ({
      name: option.name,
      values: option.values.filter((value) =>
        rest.some((v) => v.optionValues[i] !== undefined && sameText(v.optionValues[i]!, value)),
      ),
    }))
    await tx
      .update(product)
      .set({ options, updatedAt: now })
      .where(eq(product.id, variant.productId))
    await dropGoneColors(tx, variant.productId)
    await logProductEvent(tx, storeId, variant.productId, person.userId, "cambiado", [
      { field: "variant", from: variant.optionValues, to: null },
    ])
    return detailIn(tx, storeId, variant.productId)
  })
}

/** El tipo de una imagen por sus primeros bytes, no por lo que dice quien la sube. */
export function imageType(bytes: Uint8Array): PhotoType | null {
  const at = (i: number) => bytes[i]
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg"
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b))
    return "image/png"
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  return null
}

export const photoPatch = z.object({
  /** El color al que pertenece (de `colors[].id`); nulo: vale para todos. */
  colorId: z.uuid().nullable().optional(),
  /** Su lugar entre las fotos: la primera es la que ve la clienta en el catálogo. */
  position: z
    .number()
    .int()
    .min(0)
    .max(MAX_PRODUCT_PHOTOS - 1)
    .optional(),
  /** Que sea la foto que manda Sofi cuando piden su color. */
  colorMain: z.boolean().optional(),
})

/**
 * Cambia a qué color pertenece una foto, su lugar o si es la que manda Sofi por su color. Moverla
 * de lugar corre las demás, sin huecos: «Mover» hace lo mismo que arrastrar.
 */
export async function updatePhoto(
  appDb: Db,
  person: Person,
  storeId: string,
  photoId: string,
  patch: z.infer<typeof photoPatch>,
) {
  uuidOr404(photoId, "Esa foto ya no está")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [photo] = await tx
      .select({
        id: productPhoto.id,
        productId: productPhoto.productId,
        colorId: productPhoto.colorId,
        position: productPhoto.position,
      })
      .from(productPhoto)
      .where(and(eq(productPhoto.id, photoId), eq(productPhoto.storeId, storeId)))
    if (!photo) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
    const changes: ProductChange[] = []
    const colorId = patch.colorId !== undefined ? patch.colorId : photo.colorId
    if (colorId) {
      const [color] = await tx
        .select({ id: productColor.id })
        .from(productColor)
        .where(and(eq(productColor.id, colorId), eq(productColor.productId, photo.productId)))
      if (!color) throw new StoreError(404, "NOT_FOUND", "Ese color ya no está en el producto")
    }
    if (patch.colorId !== undefined && patch.colorId !== photo.colorId) {
      // Si era la foto de su color y cambia de color, ese color se queda sin la suya.
      await tx
        .update(productColor)
        .set({ photoId: null, updatedAt: new Date() })
        .where(and(eq(productColor.productId, photo.productId), eq(productColor.photoId, photoId)))
      await tx
        .update(productPhoto)
        .set({ colorId: patch.colorId })
        .where(eq(productPhoto.id, photoId))
      changes.push({ field: "photoColor", from: photo.colorId, to: patch.colorId })
    }
    if (patch.colorMain !== undefined) {
      if (patch.colorMain && !colorId)
        throw new StoreError(400, "VALIDATION_ERROR", "Elige primero de qué color es la foto", {
          colorId: "Elige el color",
        })
      if (colorId) {
        const [look] = await tx
          .select({ photoId: productColor.photoId })
          .from(productColor)
          .where(eq(productColor.id, colorId))
        const next = patch.colorMain ? photoId : look?.photoId === photoId ? null : look?.photoId
        if (next !== look?.photoId) {
          await tx
            .update(productColor)
            .set({ photoId: next ?? null, updatedAt: new Date() })
            .where(eq(productColor.id, colorId))
          changes.push({ field: "colorPhoto", from: look?.photoId ?? null, to: next ?? null })
        }
      }
    }
    if (patch.position !== undefined && patch.position !== photo.position) {
      const all = await tx
        .select({ id: productPhoto.id })
        .from(productPhoto)
        .where(eq(productPhoto.productId, photo.productId))
        .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
      const order = all.map((p) => p.id).filter((id) => id !== photoId)
      order.splice(Math.min(patch.position, order.length), 0, photoId)
      for (const [position, id] of order.entries())
        await tx.update(productPhoto).set({ position }).where(eq(productPhoto.id, id))
      changes.push({ field: "photoPosition", from: photo.position, to: patch.position })
    }
    if (changes.length > 0)
      await logProductEvent(tx, storeId, photo.productId, person.userId, "foto", [
        { field: "photo", from: photoId, to: photoId },
        ...changes,
      ])
    return detailIn(tx, storeId, photo.productId)
  })
}
