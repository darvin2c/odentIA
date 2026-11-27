import {
  conversation,
  type Db,
  product,
  productColor,
  productEvent,
  productPhoto,
  productPromotion,
  productQuestion,
  productVariant,
  storeTemplateField,
} from "@gestoria/db"
import { and, asc, eq } from "drizzle-orm"
import { RUBROS } from "./rubros.js"

/**
 * La ficha del producto de Calzados Rosa (lienzo «La ficha del producto»), con los datos del
 * prototipo: la plantilla de calzado ajustada por la tienda (con «Alto de la suela»), los datos del
 * rubro, los colores con su hex y su foto, un estado de cada tipo que pone la tienda, el precio de
 * revendedora, una promoción solo de una talla y otra solo de un color, el combo y lo que Sofi
 * puede ofrecer, el paquete para la agencia, los códigos, las preguntas respondidas y sin
 * responder, y un poco de historial. Solo para desarrollo y demostraciones; se agrega una vez.
 */

const OWNER = "semilla-rosa"
const ADMIN = "semilla-mario"
const SALES = "semilla-lucia"

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const dateOnly = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

/** Un EAN-13 de ejemplo con su dígito verificador (prefijo 775, el de GS1 Perú). */
function ean13(body12: string): string {
  const digits = [...body12].map(Number)
  const sum = digits.reverse().reduce((total, d, i) => total + d * (i % 2 === 0 ? 3 : 1), 0)
  return `${body12}${(10 - (sum % 10)) % 10}`
}

export async function seedDemoSheet(tx: Db, storeId: string): Promise<void> {
  const products = await tx
    .select({ id: product.id, name: product.name, rubro: product.rubro })
    .from(product)
    .where(eq(product.storeId, storeId))
  const idOf = (name: string) => {
    const found = products.find((p) => p.name === name)
    if (!found) throw new Error(`semilla: falta ${name}`)
    return found.id
  }
  if (products.length === 0 || products.some((p) => p.rubro !== null)) return
  const zapatilla = idOf("Zapatilla urbana")
  const sandalia = idOf("Sandalia")
  const botin = idOf("Botín de cuero marrón")
  const mocasin = idOf("Mocasín azul")

  // La plantilla de calzado de la tienda: la del prototipo, con «Alto de la suela» que suma.
  await tx.insert(storeTemplateField).values([
    ...RUBROS.calzado.fields.map((field, position) => ({
      storeId,
      rubro: "calzado" as const,
      key: field.key,
      position,
      needed: field.needed,
      updatedBy: OWNER,
      updatedAt: daysAgo(7),
    })),
    {
      storeId,
      rubro: "calzado" as const,
      key: "alto_suela",
      position: RUBROS.calzado.fields.length,
      needed: false,
      label: "Alto de la suela",
      type: "numero" as const,
      unit: "cm",
      updatedBy: OWNER,
      updatedAt: daysAgo(7),
    },
  ])

  const update = (id: string, values: Partial<typeof product.$inferInsert>) =>
    tx.update(product).set(values).where(eq(product.id, id))
  await update(zapatilla, {
    rubro: "calzado",
    rubroData: {
      horma: "Normal",
      ancho: "Una talla más",
      material: "Sintético",
      plantilla: {
        "35": 22.5,
        "36": 23,
        "37": 23.5,
        "38": 24,
        "39": 24.5,
        "40": 25,
        "41": 25.5,
        "42": 26,
      },
      alto_suela: 3,
    },
    code: "ZAP-URB",
    colorOption: 0,
    keywords: ["zapa blanca", "tenis", "zapatilla de tela"],
    webSlug: "zapatilla-urbana",
    packageWeightG: 900,
    packageLengthMm: 320,
    packageWidthMm: 200,
    packageHeightMm: 120,
    wholesaleMinQuantity: 6,
    wholesalePriceCents: 8500,
    comboPercentOff: 10,
    offerGift: "Medias tobilleras",
  })
  await update(sandalia, {
    rubro: "calzado",
    rubroData: { horma: "Normal", material: "Sintético", limpia: "Con un paño húmedo." },
    code: "SAN-TAC",
    colorOption: 0,
    keywords: ["sandalia de taco bajo"],
    webSlug: "sandalia",
    offerSecondUnit: true,
  })
  // En liquidación: su precio es el final.
  await update(botin, {
    rubro: "calzado",
    rubroData: { horma: "Chico", ancho: "Una talla más", material: "Cuero" },
    code: "BOT-MAR",
    status: "liquidacion",
    webSlug: "botin-de-cuero-marron",
    offerDiscount: false,
  })
  // Agotado, pero se consigue por encargo: Sofi lo vende sin stock.
  await update(mocasin, {
    rubro: "calzado",
    rubroData: { material: "Gamuza" },
    status: "encargo",
    statusDays: 7,
    webVisible: false,
  })

  // Los colores con su hex y su foto: la de la blanca y la de la negra de la zapatilla.
  const photos = await tx
    .select({ id: productPhoto.id })
    .from(productPhoto)
    .where(eq(productPhoto.productId, zapatilla))
    .orderBy(asc(productPhoto.position))
  const sandaliaPhotos = await tx
    .select({ id: productPhoto.id })
    .from(productPhoto)
    .where(eq(productPhoto.productId, sandalia))
    .orderBy(asc(productPhoto.position))
  const [blanca, negra, sandaliaNegra, sandaliaBeige] = await tx
    .insert(productColor)
    .values([
      {
        storeId,
        productId: zapatilla,
        value: "blanca",
        hex: "#f2f0ea",
        photoId: photos[0]?.id ?? null,
      },
      {
        storeId,
        productId: zapatilla,
        value: "negra",
        hex: "#1f1f1f",
        photoId: photos[1]?.id ?? null,
      },
      {
        storeId,
        productId: sandalia,
        value: "negra",
        hex: "#1c1c1c",
        photoId: sandaliaPhotos[0]?.id ?? null,
      },
      // Bicolor: beige con la tira dorada.
      {
        storeId,
        productId: sandalia,
        value: "beige",
        hex: "#e7d8c3",
        hex2: "#b08d57",
        photoId: sandaliaPhotos[1]?.id ?? null,
      },
    ])
    .returning({ id: productColor.id })
  // La primera y la tercera son de la blanca (la primera es la que manda Sofi); la segunda, de la negra.
  for (const photo of [photos[0], photos[2]])
    if (photo)
      await tx.update(productPhoto).set({ colorId: blanca!.id }).where(eq(productPhoto.id, photo.id))
  if (photos[1])
    await tx
      .update(productPhoto)
      .set({ colorId: negra!.id })
      .where(eq(productPhoto.id, photos[1].id))

  for (const [photo, color] of [
    [sandaliaPhotos[0], sandaliaNegra],
    [sandaliaPhotos[1], sandaliaBeige],
  ] as const)
    if (photo && color)
      await tx.update(productPhoto).set({ colorId: color.id }).where(eq(productPhoto.id, photo.id))

  // Los códigos de barras de la zapatilla blanca.
  const variants = await tx
    .select({ id: productVariant.id, values: productVariant.optionValues })
    .from(productVariant)
    .where(eq(productVariant.productId, zapatilla))
  for (const [i, v] of variants.filter((v) => v.values[0] === "blanca").entries())
    await tx
      .update(productVariant)
      .set({ barcode: ean13(`77512345${String(100 + i).padStart(4, "0")}`) })
      .where(eq(productVariant.id, v.id))

  // Una promoción solo de la talla 35 y otra solo de la negra (no se suman: va la mejor).
  await tx.insert(productPromotion).values([
    {
      storeId,
      productId: zapatilla,
      name: "Liquidación talla 35",
      percentOff: 30,
      startsOn: dateOnly(0),
      endsOn: dateOnly(10),
      optionIndex: 1,
      optionValue: "35",
    },
    {
      storeId,
      productId: zapatilla,
      name: "Negra de temporada",
      percentOff: 10,
      startsOn: dateOnly(3),
      endsOn: dateOnly(17),
      optionIndex: 0,
      optionValue: "negra",
    },
  ])

  // Lo que Sofi no supo: una sin responder, una que Lucía propuso guardar y una ya en la ficha.
  const [chat] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.storeId, storeId)))
    .limit(1)
  await tx.insert(productQuestion).values([
    {
      storeId,
      productId: zapatilla,
      conversationId: chat?.id ?? null,
      question: "¿La zapatilla destiñe al lavarla?",
      askedBy: "agente:sofi",
      askedAt: daysAgo(0),
    },
    {
      storeId,
      productId: zapatilla,
      conversationId: chat?.id ?? null,
      question: "¿Tiene plantilla acolchada?",
      askedBy: "agente:sofi",
      askedAt: daysAgo(1),
      answer: "Sí, la plantilla es acolchada y se puede sacar.",
      answeredBy: SALES,
      answeredAt: daysAgo(1),
      saveRequested: true,
    },
    {
      storeId,
      productId: zapatilla,
      question: "¿Es impermeable?",
      askedBy: OWNER,
      askedAt: daysAgo(6),
      answer: "No. Con lluvia fuerte se moja.",
      answeredBy: OWNER,
      answeredAt: daysAgo(6),
      savedBy: OWNER,
      savedAt: daysAgo(6),
    },
  ])

  // Un poco de historial: quién cambió qué.
  await tx.insert(productEvent).values([
    { storeId, productId: zapatilla, actorUserId: OWNER, action: "creado", createdAt: daysAgo(8) },
    {
      storeId,
      productId: zapatilla,
      actorUserId: ADMIN,
      action: "cambiado",
      changes: [{ field: "minPriceCents", from: 9900, to: 10000 }],
      createdAt: daysAgo(5),
    },
    {
      storeId,
      productId: zapatilla,
      actorUserId: OWNER,
      action: "pregunta",
      changes: [{ field: "question", from: null, to: "No. Con lluvia fuerte se moja." }],
      createdAt: daysAgo(6),
    },
  ])
}
