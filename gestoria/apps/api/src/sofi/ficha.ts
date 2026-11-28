import {
  type Db,
  type ProductStatus,
  product,
  productColor,
  productPhoto,
  productQuestion,
  productVideo,
  type RubroValue,
} from "@gestoria/db"
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm"
import { type TemplateField, templateIn } from "../rubros.js"
import { sameText } from "../texto.js"

/**
 * Lo que Sofi lee de la ficha de cada producto (lienzo «La ficha del producto», tableros 11, 12 y
 * 13): los datos del rubro enteros, el estado con lo que dice en cada uno, las preguntas que la
 * tienda ya respondió, los colores con su foto y el video, y lo que puede ofrecer de ese producto.
 * Es texto para el modelo, en palabras de la clienta. Lo que no está aquí, Sofi no lo afirma: deja
 * la pregunta a la tienda (`anotar_pregunta`).
 */

/** Las palabras de un mes, para decir una fecha como la dice la clienta («5 de diciembre»). */
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
]

/** «2026-12-05» → «5 de diciembre»; «2026-12» → «diciembre de 2026». */
export function dateWords(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number)
  const name = MONTHS[(month ?? 1) - 1] ?? ""
  return day ? `${day} de ${name}` : `${name} de ${year}`
}

/**
 * Lo que hace y dice Sofi en cada estado que pone la tienda (tablero 13; las mismas frases de
 * `STATES` en la pantalla de la ficha). «Ya no se vende» no llega aquí: no sale en la búsqueda.
 */
export function statusWords(row: {
  status: ProductStatus | null
  statusDays: number | null
  statusPerDay: number | null
  statusDate: string | null
}): string | null {
  switch (row.status) {
    case "encargo":
      return `Por encargo: no lo tiene ahora y lo consigue en ${row.statusDays} días. Dilo así: «No la tengo ahora: te la consigo en ${row.statusDays} días.» Se puede anotar el pedido: sale cuando llegue.`
    case "cupo":
      return `Con cupo por día: la tienda hace ${row.statusPerDay} por día. Pregunta para qué fecha lo quiere («Hago ${row.statusPerDay} por día. ¿Para qué fecha la quieres?»). No confirmes que hay cupo para una fecha: eso lo confirma una persona.`
    case "preventa":
      return `Preventa: llega el ${dateWords(row.statusDate ?? "")}. Dilo así: «Llega el ${dateWords(row.statusDate ?? "")}. Si la pides hoy, sale apenas llegue.»`
    case "liquidacion":
      return "Liquidación: «Está en liquidación: es su precio final.» No se negocia ni se rebaja más."
    default:
      return null
  }
}

/** Un dato del rubro como texto, con su unidad. Null si no está respondido. */
export function valueText(field: TemplateField, value: RubroValue | undefined): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number")
    return field.type === "fecha"
      ? null
      : `${String(value).replace(".", ",")}${field.unit ? ` ${field.unit}` : ""}`
  if ("noAplica" in value) return "No aplica"
  const unit = field.unit ? ` ${field.unit}` : ""
  const entries = Object.entries(value)
  if (entries.length === 0) return null
  if (field.type === "tabla")
    return entries
      .map(([size, cells]) => {
        const row = (Array.isArray(cells) ? cells : [])
          .map((cell, i) =>
            cell === null || cell === undefined
              ? null
              : `${field.columns?.[i] ?? `columna ${i + 1}`} ${String(cell).replace(".", ",")}${unit}`,
          )
          .filter(Boolean)
          .join(", ")
        return row ? `${size}: ${row}` : null
      })
      .filter(Boolean)
      .join("; ")
  return entries
    .filter(([, n]) => typeof n === "number")
    .map(([size, n]) => `${size}: ${String(n).replace(".", ",")}${unit}`)
    .join("; ")
}

/** Un dato del rubro de una fecha («2028-06») como lo dice Sofi. */
function fieldText(field: TemplateField, value: RubroValue | undefined): string | null {
  if (field.type === "fecha" && typeof value === "string") return dateWords(value)
  return valueText(field, value)
}

export interface SofiProductFacts {
  /** Lo que dice cada dato del rubro que la tienda respondió: «Cómo calza: Normal». */
  datos: { dato: string; valor: string }[]
  /** Lo que la ficha todavía no dice: Sofi no lo afirma. */
  sin_dato: string[]
  /** Lo que hace y dice en su estado (encargo, cupo, preventa, liquidación); null si está disponible. */
  estado: string | null
  /** Las preguntas que la tienda ya respondió y guardó en la ficha. */
  preguntas_respondidas: { pregunta: string; respuesta: string }[]
  /** Los colores y si tienen su foto para mandarla. */
  colores: { color: string; foto: boolean }[]
  /** El video (lo que muestra) si tiene; null si no. */
  video: string | null
  /** Lo que Sofi puede ofrecer de este producto para cerrar; lo demás, no. */
  puede_ofrecer: string[]
}

/** Lo que Sofi lee de la ficha de varios productos, en su misma transacción (`withAgent`). */
export async function sofiFactsIn(
  tx: Db,
  storeId: string,
  productIds: string[],
): Promise<Map<string, SofiProductFacts>> {
  const facts = new Map<string, SofiProductFacts>()
  if (productIds.length === 0) return facts
  const rows = await tx
    .select()
    .from(product)
    .where(and(eq(product.storeId, storeId), inArray(product.id, productIds)))
  const questions = await tx
    .select({
      productId: productQuestion.productId,
      question: productQuestion.question,
      answer: productQuestion.answer,
    })
    .from(productQuestion)
    .where(
      and(
        eq(productQuestion.storeId, storeId),
        inArray(productQuestion.productId, productIds),
        isNotNull(productQuestion.savedAt),
      ),
    )
    .orderBy(desc(productQuestion.savedAt))
  const looks = await tx
    .select({
      id: productColor.id,
      productId: productColor.productId,
      value: productColor.value,
      photoId: productColor.photoId,
    })
    .from(productColor)
    .where(and(eq(productColor.storeId, storeId), inArray(productColor.productId, productIds)))
  const photos = await tx
    .select({ productId: productPhoto.productId, colorId: productPhoto.colorId })
    .from(productPhoto)
    .where(and(eq(productPhoto.storeId, storeId), inArray(productPhoto.productId, productIds)))
  const videos = await tx
    .select({
      productId: productVideo.productId,
      colorId: productVideo.colorId,
      label: productVideo.label,
    })
    .from(productVideo)
    .where(and(eq(productVideo.storeId, storeId), inArray(productVideo.productId, productIds)))
    .orderBy(asc(productVideo.createdAt))
  const templates = new Map<string, TemplateField[]>()
  for (const row of rows) {
    let template: TemplateField[] = []
    if (row.rubro) {
      template = templates.get(row.rubro) ?? (await templateIn(tx, storeId, row.rubro))
      templates.set(row.rubro, template)
    }
    const datos: SofiProductFacts["datos"] = []
    const missing: string[] = []
    for (const field of template) {
      const text = fieldText(field, row.rubroData[field.key])
      if (text) datos.push({ dato: field.label, valor: text })
      else missing.push(field.label)
    }
    const colorValues = row.colorOption === null ? [] : (row.options[row.colorOption]?.values ?? [])
    const own = looks.filter((l) => l.productId === row.id)
    const colorVideo = (value: string) => {
      const look = own.find((l) => sameText(l.value, value))
      return videos.find((v) => v.productId === row.id && look && v.colorId === look.id)
    }
    const video =
      videos.find((v) => v.productId === row.id && v.colorId === null) ??
      colorValues.map(colorVideo).find(Boolean)
    const offers = [
      row.offerDelivery ? "envío gratis o más barato" : null,
      row.offerDiscount ? "unos soles de menos" : null,
      row.offerSecondUnit ? "precio especial en la 2.ª unidad" : null,
      row.offerGift ? `un regalo: ${row.offerGift}` : null,
    ].filter((o): o is string => o !== null)
    facts.set(row.id, {
      datos,
      sin_dato: missing,
      estado: statusWords(row),
      preguntas_respondidas: questions
        .filter((q) => q.productId === row.id && q.answer)
        .slice(0, 12)
        .map((q) => ({ pregunta: q.question, respuesta: q.answer! })),
      colores: colorValues.map((value) => {
        const look = own.find((l) => sameText(l.value, value))
        return {
          color: value,
          foto: look
            ? Boolean(look.photoId) ||
              photos.some((p) => p.productId === row.id && p.colorId === look.id)
            : false,
        }
      }),
      video: video ? video.label || "Video del producto" : null,
      puede_ofrecer: offers,
    })
  }
  return facts
}
