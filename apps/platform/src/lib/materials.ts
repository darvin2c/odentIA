/**
 * Materiales y venta en pantalla (ADR 0067): cómo se dicen las cantidades de
 * un producto en una frase y cómo se lee una cantidad escrita. Sin reglas del
 * inventario: lo que se descuenta, de dónde y cuánto lo decide el servidor;
 * aquí solo se escribe con las palabras de la clínica.
 */
import { quantityWords, unitFor } from "@odentia/clinical"
import type { ServiceMaterialLine, ServicesWithoutMaterials } from "./services"

/** Sin tildes y en minúsculas, para comparar palabras. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/** La primera letra en minúscula para ponerla dentro de una frase; una sigla («EDTA») queda igual. */
function lowerFirst(text: string): string {
  if (text.length < 2) return text.toLowerCase()
  const second = text.charAt(1)
  if (second !== second.toLowerCase()) return text
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * Un material dicho dentro de una frase: «2 guantes de nitrilo» cuando el
 * nombre ya empieza por su unidad («Guantes de nitrilo»), y si no, la unidad
 * y el nombre: «1 sobre de pasta profiláctica».
 */
export function materialPhrase(
  item: { name: string; unit: string; quantity: number },
  locale: string,
): string {
  const name = item.name.trim()
  const words = quantityWords(item.quantity, item.unit, locale)
  const match = /^(\S+)(.*)$/u.exec(name)
  if (match) {
    const first = fold(match[1] ?? "")
    if (first === fold(item.unit) || first === fold(unitFor(2, item.unit)))
      return `${words}${match[2] ?? ""}`
  }
  return `${words} de ${lowerFirst(name)}`
}

/** «a», «a y b», «a, b y c». */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

/** La línea del cierre: «se descuentan de Sede Miraflores: 2 guantes, 1 sobre de pasta profiláctica y 1 eyector». */
export function closingMaterialsWords(
  materials: {
    branch: { name: string }
    items: ReadonlyArray<{ name: string; unit: string; quantity: number }>
  },
  locale: string,
): string {
  const verb =
    materials.items.length === 1 && materials.items[0]?.quantity === 1
      ? "se descuenta"
      : "se descuentan"
  return `${verb} de ${materials.branch.name}: ${listWords(materials.items.map((item) => materialPhrase(item, locale)))}.`
}

/** Un porcentaje con el formato de la clínica: «72 %», «1.8 %». */
export function formatShare(share: number, locale: string, fractionDigits = 0): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: fractionDigits,
  }).format(share)
}

/** «del último mes», «de la última semana» o «de los últimos 90 días». */
function periodWords(days: number): string {
  if (days === 30) return "del último mes"
  if (days === 7) return "de la última semana"
  if (days === 1) return "de ayer y hoy"
  return `de los últimos ${days} días`
}

/** El título de la tarjeta: «Empieza por estos 5» o «Empieza por este». */
export function withoutMaterialsTitle(count: number): string {
  return count === 1 ? "Empieza por este" : `Empieza por estos ${count}`
}

/**
 * La frase de «Empieza por estos 5»: «Son el 72 % de tus atenciones del
 * último mes y todavía no tienen materiales:». Lo que sigue son los servicios.
 */
export function withoutMaterialsIntro(
  result: Pick<ServicesWithoutMaterials, "days" | "share" | "services">,
  locale: string,
): string {
  const period = periodWords(result.days)
  const one = result.services.length === 1
  const tail = one ? "y todavía no tiene materiales:" : "y todavía no tienen materiales:"
  if (result.share === null) {
    return one
      ? `Es el servicio que más se hizo ${period} ${tail}`
      : `Son los servicios que más se hicieron ${period} ${tail}`
  }
  const amount =
    result.share > 0 && Math.round(result.share * 100) === 0
      ? `menos del ${formatShare(0.01, locale)}`
      : `el ${formatShare(result.share, locale)}`
  return `${one ? "Es" : "Son"} ${amount} de tus atenciones ${period} ${tail}`
}

/**
 * Una cantidad escrita a mano, entera y sin flechas: acepta el separador de
 * miles de la clínica («1,000») y espacios. Null si no es un número entero.
 */
export function parseWholeQuantity(text: string, locale: string): number | null {
  let group = ","
  try {
    group =
      new Intl.NumberFormat(locale).formatToParts(10000).find((part) => part.type === "group")
        ?.value ?? ","
  } catch {
    // Locale desconocido: se queda la coma.
  }
  const cleaned = text
    .trim()
    .split(group)
    .join("")
    .replace(/[\s  ]/g, "")
  if (!/^\d+$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : null
}

/** Una cantidad para un campo, con el formato de la clínica. */
export function formatWholeQuantity(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/* ---------------- materiales de un servicio, en el formulario ---------------- */

/** Una fila del formulario de materiales: lo escrito se conserva tal cual hasta guardar. */
export interface MaterialDraftLine {
  productId: string
  name: string
  unit: string
  quantityText: string
  /** Falso si ya no se descuenta (producto desactivado o que ya no se usa en las atenciones). */
  discounted: boolean
}

export function draftLineOf(item: ServiceMaterialLine, locale: string): MaterialDraftLine {
  return {
    productId: item.productId,
    name: item.name,
    unit: item.unit,
    quantityText: formatWholeQuantity(item.quantity, locale),
    discounted: item.discounted,
  }
}

/** ¿Lo que hay en el formulario es distinto de lo guardado? */
export function materialsChanged(
  lines: readonly MaterialDraftLine[],
  saved: ReadonlyArray<{ productId: string; quantity: number }>,
  locale: string,
): boolean {
  if (lines.length !== saved.length) return true
  const before = new Map(saved.map((item) => [item.productId, item.quantity]))
  return lines.some(
    (line) => before.get(line.productId) !== parseWholeQuantity(line.quantityText, locale),
  )
}

/**
 * Lo que se envía al guardar, o el error de cada fila («Escribe cuánto se usa
 * cada vez»). Los topes son los del servidor.
 */
export function materialsToSave(
  lines: readonly MaterialDraftLine[],
  locale: string,
  max: number,
): { items: Array<{ productId: string; quantity: number }> } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const items: Array<{ productId: string; quantity: number }> = []
  for (const line of lines) {
    const quantity = parseWholeQuantity(line.quantityText, locale)
    if (line.quantityText.trim() === "") errors[line.productId] = "Escribe cuánto se usa cada vez."
    else if (quantity === null) errors[line.productId] = "Escribe un número entero, sin decimales."
    else if (quantity < 1 || quantity > max)
      errors[line.productId] = `Va de 1 a ${formatWholeQuantity(max, locale)}.`
    else items.push({ productId: line.productId, quantity })
  }
  return Object.keys(errors).length > 0 ? { errors } : { items }
}

/**
 * «Copiar de otro servicio»: suma a la lista lo que el otro servicio usa y
 * esta aún no tiene. Lo que ya está queda con su cantidad, y lo que el otro ya
 * no descuenta (desactivado) no se copia: el servidor no lo aceptaría nuevo.
 */
export function mergeCopiedMaterials(
  lines: readonly MaterialDraftLine[],
  copied: readonly ServiceMaterialLine[],
  locale: string,
): { lines: MaterialDraftLine[]; added: number; kept: number; skipped: number } {
  const present = new Set(lines.map((line) => line.productId))
  const next = [...lines]
  let added = 0
  let kept = 0
  let skipped = 0
  for (const item of copied) {
    if (present.has(item.productId)) {
      kept += 1
      continue
    }
    if (!item.discounted) {
      skipped += 1
      continue
    }
    next.push(draftLineOf(item, locale))
    present.add(item.productId)
    added += 1
  }
  return { lines: next, added, kept, skipped }
}

/** Lo que dice la pantalla después de copiar. */
export function copiedMaterialsWords(
  serviceName: string,
  result: { added: number; kept: number; skipped: number },
): string {
  if (result.added === 0 && result.kept === 0 && result.skipped === 0)
    return `«${serviceName}» no tiene materiales.`
  const parts: string[] = []
  if (result.added > 0)
    parts.push(
      result.added === 1
        ? `Se copió 1 material de «${serviceName}»`
        : `Se copiaron ${result.added} materiales de «${serviceName}»`,
    )
  else parts.push(`De «${serviceName}» no se copió nada nuevo`)
  if (result.kept > 0)
    parts.push(
      result.kept === 1
        ? "1 ya estaba y queda con su cantidad"
        : `${result.kept} ya estaban y quedan con su cantidad`,
    )
  if (result.skipped > 0)
    parts.push(
      result.skipped === 1
        ? "1 ya no se usa en las atenciones"
        : `${result.skipped} ya no se usan en las atenciones`,
    )
  return `${parts.join("; ")}. Revisa las cantidades y guarda.`
}

/* ---------------- venta desde «Cobrar» ---------------- */

/**
 * El aviso al elegir lo que se vende: «No hay en Sede Miraflores: quedará como
 * faltante» o, si no alcanza, cuánto hay. Null si alcanza.
 */
export function saleStockNote(
  product: { onHand: number; onHandText: string | null },
  quantity: number,
  branchName: string,
): string | null {
  if (product.onHand <= 0) return `No hay en ${branchName}: quedará como faltante.`
  if (quantity > product.onHand)
    return `En ${branchName} hay ${product.onHandText ?? product.onHand}: lo que falta quedará como faltante.`
  return null
}

/**
 * «salieron 2 de Sede Miraflores» bajo el concepto de un producto: se descuenta
 * al agregarlo, así que en la lista ya salió.
 */
export function saleDeductionWords(quantity: number, branchName: string): string {
  return quantity === 1 ? `salió 1 de ${branchName}` : `salieron ${quantity} de ${branchName}`
}
