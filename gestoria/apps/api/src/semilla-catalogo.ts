import { crc32, deflateSync } from "node:zlib"
import {
  type Db,
  type ProductOption,
  product,
  productLink,
  productPhoto,
  productPromotion,
  productQuantityPrice,
  productVariant,
  stockMovement,
  store,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { eq } from "drizzle-orm"
import { combinations, makeSku } from "./catalogo.js"
import { limaTemplate } from "./entregas.js"

/** Calzados Rosa despacha desde Gamarra, en La Victoria (UBIGEO 150115). */
const SHIP_FROM = "150115"

/**
 * La configuración de Calzados Rosa (paso B3, tableros 6, 7 y 14): sus medios de pago, sus
 * formas de entrega y un catálogo de calzado con variantes, stock, kardex, un precio mínimo,
 * un precio por cantidad y una promoción. Solo para desarrollo y demostraciones, como el resto
 * de `semilla.ts`. Se agrega una vez: si la tienda ya tiene algo de esto, no lo toca.
 */

const OWNER = "semilla-rosa"
const ADMIN = "semilla-mario"

/**
 * Un PNG hecho aquí, para no guardar imágenes en el repositorio: `rows` son las filas de píxeles
 * sin el byte de filtro; `channels`, 3 (RGB) o 4 (RGBA).
 */
export function pngOf(size: number, channels: 3 | 4, rows: Buffer[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.writeUInt8(8, 8) // 8 bits por canal
  header.writeUInt8(channels === 4 ? 6 : 2, 9) // RGBA o RGB
  const pixels = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Una foto de ejemplo: un PNG de un color. */
export function solidPng(rgb: [number, number, number], size = 240): Buffer {
  const row = Buffer.alloc(size * 3)
  for (let x = 0; x < size; x++) row.set(rgb, x * 3)
  return pngOf(
    size,
    3,
    Array.from({ length: size }, () => row),
  )
}

/** Hace tantos días, para que el kardex de ejemplo quede siempre en el pasado. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const dateOnly = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
const sizes = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i))

interface SeedProduct {
  name: string
  category: string
  description: string
  listPriceCents: number
  minPriceCents?: number
  options: ProductOption[]
  /** El precio propio de algunas variantes, por su primer valor. */
  priceBy?: Record<string, number>
  /** Cuántas entraron de cada variante hace seis días, y a qué costo. */
  stock: (values: string[]) => number
  costCents: (values: string[]) => number
  colors: [number, number, number][]
}

const CATALOG: SeedProduct[] = [
  {
    name: "Zapatilla urbana",
    category: "Zapatillas",
    description: "Cuero sintético, planta de goma. Horma normal: pide tu talla de siempre.",
    listPriceCents: 12900,
    minPriceCents: 10000,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: sizes(35, 42) },
    ],
    priceBy: { negra: 8900 },
    stock: ([color, size]) =>
      color === "blanca" ? (size === "42" ? 0 : 3) : size === "35" ? 0 : 2,
    costCents: ([color]) => (color === "blanca" ? 6800 : 5500),
    colors: [
      [254, 215, 170],
      [251, 146, 60],
    ],
  },
  {
    name: "Sandalia",
    category: "Sandalias",
    description: "Taco bajo de 3 cm, correa ajustable con hebilla. Suela antideslizante.",
    listPriceCents: 8900,
    options: [
      { name: "Color", values: ["negra", "beige"] },
      { name: "Talla", values: sizes(35, 39) },
    ],
    stock: ([color]) => (color === "negra" ? 2 : 2),
    costCents: () => 4200,
    colors: [[231, 229, 228]],
  },
  {
    name: "Botín de cuero marrón",
    category: "Botines",
    description:
      "Cuero natural, cierre lateral y forro térmico. Horma un poco ajustada: si dudas, una talla más.",
    listPriceCents: 21900,
    options: [{ name: "Talla", values: sizes(39, 43) }],
    stock: ([size]) => (size === "43" ? 0 : size === "39" ? 3 : 1),
    costCents: () => 13500,
    colors: [[180, 120, 80]],
  },
  {
    name: "Mocasín azul",
    category: "Mocasines",
    description: "Gamuza sintética, sin cordones. Ideal para oficina.",
    listPriceCents: 14900,
    options: [{ name: "Talla", values: sizes(38, 42) }],
    stock: () => 1,
    costCents: () => 7900,
    colors: [[147, 197, 253]],
  },
]

export async function seedDemoConfiguration(tx: Db, storeId: string): Promise<void> {
  const [anyPayment] = await tx
    .select({ id: storePaymentMethod.id })
    .from(storePaymentMethod)
    .where(eq(storePaymentMethod.storeId, storeId))
    .limit(1)
  if (!anyPayment)
    // Cobros (tablero 6): Yape y Plin con su celular y su titular (el QR lo suma semilla-cobros.ts),
    // la transferencia con su banco, su cuenta y un CCI con sus dígitos de control, y lo de al
    // recibir con su nota. Lo que envía Sofi lo arma el servidor igual que aquí.
    await tx.insert(storePaymentMethod).values([
      {
        storeId,
        kind: "yape",
        name: "Yape",
        typeCode: "68",
        collection: "comprobante",
        phone: "+51987654321",
        holder: "Rosa Quispe M.",
        details: "Yape al 987 654 321 a nombre de Rosa Quispe M.",
      },
      {
        storeId,
        kind: "plin",
        name: "Plin",
        typeCode: "68",
        collection: "comprobante",
        phone: "+51987654321",
        holder: "Rosa Quispe M.",
        details: "Plin al 987 654 321 a nombre de Rosa Quispe M.",
      },
      {
        storeId,
        kind: "transferencia",
        name: "Transferencia BCP",
        typeCode: "30",
        collection: "comprobante",
        bankCode: "002",
        accountNumber: "191-2345678-0-12",
        cci: "00219100234567801253",
        holder: "Rosa Quispe Mamani",
        details:
          "BCP · cuenta 191-2345678-0-12 · CCI 002 191 002345678012 53 · a nombre de Rosa Quispe Mamani",
      },
      {
        storeId,
        kind: "efectivo",
        name: "Efectivo al recibir",
        typeCode: "10",
        collection: "al_recibir",
        details: "Solo en tus zonas de Lima, con tu repartidor",
      },
      {
        storeId,
        kind: "pos",
        name: "Tarjeta con tu POS",
        typeCode: "48",
        collection: "al_recibir",
        details: "Kevin lleva el POS de la tienda",
      },
      {
        storeId,
        kind: "link",
        name: "Link de pago (Yape o tarjeta)",
        typeCode: "68",
        collection: "link",
        details: "",
      },
    ])
  const [anyDelivery] = await tx
    .select({ id: storeDeliveryMethod.id })
    .from(storeDeliveryMethod)
    .where(eq(storeDeliveryMethod.storeId, storeId))
    .limit(1)
  if (!anyDelivery)
    await tx.insert(storeDeliveryMethod).values([
      {
        storeId,
        name: "Reparto en Lima",
        type: "DeliveryModeOwnFleet",
        cost: "por_zona",
        // La plantilla de Lima desde La Victoria (Gamarra): seis zonas con los 50 distritos.
        zones: limaTemplate(SHIP_FROM),
        acceptsPayOnDelivery: true,
        maxDiscountCents: 1000,
        freeFromCents: 20000,
      },
      {
        storeId,
        name: "Recojo en la tienda",
        type: "OnSitePickup",
        cost: "gratis",
        details: "Jr. Gamarra 650, La Victoria · stand 214",
        openingHours: [{ days: [1, 2, 3, 4, 5, 6], opens: 10 * 60, closes: 19 * 60 }],
        readyIn: "2h",
        acceptsPayOnDelivery: true,
      },
      {
        storeId,
        name: "Envío a provincia",
        type: "ParcelService",
        cost: "fijo",
        priceCents: 800,
        agencies: ["Shalom", "Olva Courier"],
        freight: "al_recoger",
        eta: "De 2 a 4 días",
      },
    ])
  // Desde dónde despacha: La Victoria. Las franjas de la plantilla van con las de Despachos.
  await tx.update(store).set({ shipFrom: SHIP_FROM }).where(eq(store.id, storeId))

  const [anyProduct] = await tx
    .select({ id: product.id })
    .from(product)
    .where(eq(product.storeId, storeId))
    .limit(1)
  if (anyProduct) return
  const skus = new Set<string>()
  const ids: Record<string, string> = {}
  for (const seed of CATALOG) {
    const [row] = await tx
      .insert(product)
      .values({
        storeId,
        name: seed.name,
        category: seed.category,
        description: seed.description,
        listPriceCents: seed.listPriceCents,
        minPriceCents: seed.minPriceCents ?? null,
        options: seed.options,
        createdAt: daysAgo(8),
      })
      .returning({ id: product.id })
    const productId = row!.id
    ids[seed.name] = productId
    const photos = await tx
      .insert(productPhoto)
      .values(
        seed.colors.map((rgb, position) => ({
          storeId,
          productId,
          position,
          contentType: "image/png" as const,
          content: solidPng(rgb),
          createdBy: OWNER,
        })),
      )
      .returning({ id: productPhoto.id })
    for (const values of combinations(seed.options)) {
      const own = seed.priceBy?.[values[0] ?? ""]
      const [variant] = await tx
        .insert(productVariant)
        .values({
          storeId,
          productId,
          optionValues: values,
          sku: makeSku(seed.name, values, skus),
          priceCents: own ?? null,
          // La zapatilla negra tiene su propia foto.
          photoId: own && photos[1] ? photos[1].id : null,
        })
        .returning({ id: productVariant.id })
      const entered = seed.stock(values)
      const variantId = variant!.id
      const moves: (typeof stockMovement.$inferInsert)[] = []
      if (seed.name === "Mocasín azul") {
        // Agotado: entró uno de cada talla y se vendieron todos.
        moves.push(
          {
            storeId,
            variantId,
            kind: "entrada",
            quantity: 1,
            unitCostCents: seed.costCents(values),
            actorUserId: ADMIN,
            createdAt: daysAgo(13),
          },
          {
            storeId,
            variantId,
            kind: "venta",
            quantity: -1,
            reference: `01${values[0]}`,
            actorUserId: OWNER,
            createdAt: daysAgo(4),
          },
        )
      } else if (entered > 0) {
        moves.push({
          storeId,
          variantId,
          kind: "entrada",
          quantity:
            seed.name === "Zapatilla urbana" && values.join(" ") === "blanca 38" ? 4 : entered,
          unitCostCents: seed.costCents(values),
          reason: "Compra al proveedor",
          actorUserId: ADMIN,
          createdAt: daysAgo(6),
        })
        if (seed.name === "Zapatilla urbana" && values.join(" ") === "blanca 38")
          moves.push(
            {
              storeId,
              variantId,
              kind: "ajuste",
              quantity: -1,
              reason: "par dañado",
              actorUserId: OWNER,
              createdAt: daysAgo(2),
            },
            {
              storeId,
              variantId,
              kind: "venta",
              quantity: -1,
              reference: "0142",
              actorUserId: OWNER,
              createdAt: daysAgo(1),
            },
          )
      }
      // En orden: la base anota el saldo de cada uno.
      for (const move of moves) await tx.insert(stockMovement).values(move)
    }
  }
  await tx.insert(productQuantityPrice).values({
    storeId,
    productId: ids["Zapatilla urbana"]!,
    minQuantity: 2,
    unitPriceCents: 11000,
  })
  await tx.insert(productPromotion).values({
    storeId,
    productId: ids.Sandalia!,
    name: "Semana de sandalias",
    percentOff: 15,
    startsOn: dateOnly(-1),
    endsOn: dateOnly(6),
  })
  const pair = (a: string, b: string, kind: "parecido" | "combina") => {
    const [x, y] = [ids[a]!, ids[b]!].sort()
    return { storeId, productA: x!, productB: y!, kind }
  }
  await tx
    .insert(productLink)
    .values([
      pair("Zapatilla urbana", "Mocasín azul", "parecido"),
      pair("Botín de cuero marrón", "Mocasín azul", "parecido"),
      pair("Zapatilla urbana", "Sandalia", "combina"),
    ])
}
