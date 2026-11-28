import {
  type Db,
  product,
  productLink,
  productPhoto,
  productPromotion,
  productQuestion,
  store,
  storeDeliveryMethod,
  storeLink,
  storePaymentMethod,
} from "@gestoria/db"
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm"
import type { Storage } from "./archivos.js"
import { colorsIn, productRow, type SaleState, saleStateOf } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { storeClockIn } from "./hora.js"
import { APP_LINK_SECONDS, PUBLIC_LINK_SECONDS, publicProduct, shownMediaIn } from "./medios.js"
import { variantPrices } from "./pedidos.js"
import { autoUnitCents } from "./precio.js"
import { RUBROS, templateIn } from "./rubros.js"
import { dateWords, valueText } from "./sofi/ficha.js"
import { inStore } from "./tiendas.js"

/**
 * La página de un producto en la vitrina de la tienda (lienzo «La ficha del producto», «Vitrina
 * viva»): lo que ve la clienta en el celular y en la web (`<tienda>.gestoria24.com/<producto>`).
 * Es una pieza: hoy la usan la vista previa de la ficha y «Probar como clienta»; el catálogo por
 * link la usará igual.
 *
 * Solo lo vendible: el nombre, el texto, los colores con su hex, las tallas que hay, el precio de
 * hoy con su promoción y el precio por cantidad, el estado, lo que la tienda ya respondió y los
 * datos del rubro que llenó, y sus fotos y su video. Nunca el costo, el mínimo, lo que Sofi puede
 * ofrecer, los códigos, el stock exacto (solo «quedan pocas», hasta 3), las preguntas sin
 * responder ni nada del equipo.
 */

/** Hasta cuántas quedan se dice el número: más, solo «hay». */
const FEW = 3

/** Lo que se dice de un estado en la vitrina; null si está disponible o agotado (sale del stock). */
function stateText(row: {
  status: string | null
  statusDays: number | null
  statusDate: string | null
}): string | null {
  switch (row.status) {
    case "encargo":
      return `Por encargo · llega en ${row.statusDays} días`
    case "cupo":
      return "Hecho a pedido"
    case "preventa":
      return `Preventa · llega el ${dateWords(row.statusDate ?? "")}`
    case "liquidacion":
      return "Liquidación · precio final"
    default:
      return null
  }
}

export interface ShowcaseVariant {
  id: string
  color: string | null
  size: string | null
  priceCents: number
  /** El precio sin la promoción, si la tiene: se muestra tachado. */
  listCents: number
  available: boolean
  /** Cuántas quedan, solo si son pocas; null si hay más o se vende sin stock. */
  left: number | null
  promotion: { name: string; percentOff: number; endsOn: string } | null
}

/** La página del producto, dentro de la tienda (`db` ya filtra por ella). */
export async function showcaseIn(
  db: Db,
  storage: Storage | null | undefined,
  storeId: string,
  productId: string,
  seconds: number,
) {
  const row = await productRow(db, storeId, productId)
  const { today } = await storeClockIn(db, storeId)
  const [shop] = await db
    .select({
      name: store.name,
      publicName: store.publicName,
      brandColor: store.brandColor,
      currency: store.currency,
    })
    .from(store)
    .where(eq(store.id, storeId))
  const [link] = await db
    .select({ name: storeLink.name })
    .from(storeLink)
    .where(and(eq(storeLink.storeId, storeId), eq(storeLink.current, true)))
  const variants = await variantPrices(db, storeId, today, undefined, productId)
  const colorIndex = row.colorOption
  const colors = await colorsIn(db, row)
  const sizeIndex = row.options.findIndex((_, i) => i !== colorIndex)
  const promotions = await db
    .select({ name: productPromotion.name, endsOn: productPromotion.endsOn })
    .from(productPromotion)
    .where(
      and(
        eq(productPromotion.productId, productId),
        lte(productPromotion.startsOn, today),
        gte(productPromotion.endsOn, today),
      ),
    )
  const shown: ShowcaseVariant[] = variants.map((v) => {
    const price = autoUnitCents(v.pricing, 1)
    const available = v.stock > 0 || v.sellsWithoutStock
    return {
      id: v.id,
      color: colorIndex === null ? null : (v.optionValues[colorIndex] ?? null),
      size: sizeIndex < 0 ? null : (v.optionValues[sizeIndex] ?? null),
      priceCents: price,
      listCents: v.pricing.listUnitCents,
      available,
      left: !v.sellsWithoutStock && v.stock > 0 && v.stock <= FEW ? v.stock : null,
      promotion:
        v.promotion && v.pricing.percentOff
          ? {
              name: v.promotion,
              percentOff: v.pricing.percentOff,
              endsOn: promotions.find((p) => p.name === v.promotion)?.endsOn ?? today,
            }
          : null,
    }
  })
  const stock = variants.reduce((n, v) => n + v.stock, 0)
  const template = row.rubro ? await templateIn(db, storeId, row.rubro) : []
  const answers = await db
    .select({ question: productQuestion.question, answer: productQuestion.answer })
    .from(productQuestion)
    .where(
      and(
        eq(productQuestion.storeId, storeId),
        eq(productQuestion.productId, productId),
        isNotNull(productQuestion.savedAt),
      ),
    )
    .orderBy(desc(productQuestion.savedAt))
    .limit(4)
  const links = await db
    .select({ a: productLink.productA, b: productLink.productB })
    .from(productLink)
    .where(
      and(
        eq(productLink.kind, "combina"),
        or(eq(productLink.productA, productId), eq(productLink.productB, productId)),
      ),
    )
  const otherIds = links.map((l) => (l.a === productId ? l.b : l.a))
  const others = otherIds.length
    ? await db
        .select({
          id: product.id,
          name: product.name,
          slug: product.webSlug,
          listPriceCents: product.listPriceCents,
        })
        .from(product)
        .where(
          and(
            eq(product.storeId, storeId),
            inArray(product.id, otherIds),
            eq(product.webVisible, true),
            sql`${product.status} is distinct from 'no_se_vende'`,
          ),
        )
    : []
  const firstPhotos = others.length
    ? await db
        .select({ productId: productPhoto.productId, objectKey: productPhoto.objectKey })
        .from(productPhoto)
        .where(
          and(
            eq(productPhoto.storeId, storeId),
            inArray(
              productPhoto.productId,
              others.map((o) => o.id),
            ),
            isNotNull(productPhoto.objectKey),
            sql`${productPhoto.cutout} is distinct from 'usada'`,
          ),
        )
        .orderBy(asc(productPhoto.position))
    : []
  const deliveries = await db
    .select()
    .from(storeDeliveryMethod)
    .where(and(eq(storeDeliveryMethod.storeId, storeId), eq(storeDeliveryMethod.isActive, true)))
    .orderBy(asc(storeDeliveryMethod.createdAt))
  const payments = await db
    .select({ name: storePaymentMethod.name })
    .from(storePaymentMethod)
    .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.isActive, true)))
    .orderBy(asc(storePaymentMethod.createdAt))
  const rubro = row.rubro ? RUBROS[row.rubro] : null
  const state: SaleState = saleStateOf(row.status, stock)
  return {
    store: {
      name: shop!.publicName ?? shop!.name,
      color: shop!.brandColor,
      currency: shop!.currency,
      link: link?.name ?? null,
      deliveries: deliveries.map((d) => ({
        id: d.id,
        name: d.name,
        eta: d.eta,
        /** Gratis, fijo, por zona o se acuerda en el chat. */
        cost: d.cost,
        priceCents: d.cost === "fijo" ? (d.priceCents ?? 0) : null,
        zones: d.cost === "por_zona" ? d.zones : [],
        freeFromCents: d.freeFromCents,
      })),
      payments: payments.map((p) => p.name),
    },
    product: {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      slug: row.webSlug,
      visible: row.webVisible,
      state,
      stateText: stateText(row),
      rowLabel: rubro?.rowLabel ?? "Color",
      columnLabel: rubro?.columnLabel ?? (sizeIndex < 0 ? null : row.options[sizeIndex]!.name),
      colors: colors.map((c) => ({ value: c.value, hex: c.hex, hex2: c.hex2 })),
      sizes: sizeIndex < 0 ? [] : row.options[sizeIndex]!.values,
      variants: shown,
      quantityPrices: variants[0]?.pricing.quantityPrices ?? [],
      answers: answers.map((a) => ({ question: a.question, answer: a.answer! })),
      facts: template
        .map((field) => ({ label: field.label, value: valueText(field, row.rubroData[field.key]) }))
        .filter((f): f is { label: string; value: string } => !!f.value && f.value !== "No aplica")
        .slice(0, 6),
      combina: await Promise.all(
        others.map(async (o) => {
          const key = firstPhotos.find((p) => p.productId === o.id)?.objectKey
          return {
            id: o.id,
            name: o.name,
            slug: o.slug,
            priceCents: o.listPriceCents,
            photo: key && storage ? await storage.signedUrl(`${key}/miniatura`, seconds) : null,
          }
        }),
      ),
    },
    media: storage
      ? await shownMediaIn(db, storage, storeId, productId, seconds)
      : { photos: [], videos: [], expiresAt: null },
  }
}

export type Showcase = Awaited<ReturnType<typeof showcaseIn>>

/**
 * La página pública de un producto: solo de un producto que se ve en la web (`web_visible`), por
 * el link vigente de la tienda. Sin cuenta: es lo público de la tienda.
 */
export async function publicShowcase(
  ownerDb: Db,
  storage: Storage | null | undefined,
  link: string,
  slugOrId: string,
) {
  const found = await publicProduct(ownerDb, link, slugOrId)
  if (!found) return null
  return showcaseIn(ownerDb, storage, found.storeId, found.productId, PUBLIC_LINK_SECONDS)
}

/**
 * La vista previa de la ficha: la misma página, para el equipo, aunque todavía no se muestre en la
 * web (así se ve antes de encenderla).
 */
export async function previewShowcase(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  productId: string,
) {
  return inStore(appDb, person, storeId, "catalogo.ver", (tx) =>
    showcaseIn(tx, storage, storeId, productId, APP_LINK_SECONDS),
  )
}
