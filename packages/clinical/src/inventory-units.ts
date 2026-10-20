/**
 * Unidades del inventario (ADR 0067, issue 44): en pantalla siempre la
 * palabra; detrás, su código internacional cuando lo tiene. Lo que se cuenta
 * usa UN/CEFACT Rec 20 (con los envases de la Rec 21 en su forma «X…»), lo que
 * se mide usa UCUM. «guante», «jeringa», «cartucho» o «sobre» no tienen código
 * propio: quedan como unidad con su nombre (`code` nulo), sin inventar uno.
 */

export type InventoryUnitSystem = "UNECE_REC20" | "UCUM"

export interface InventoryUnit {
  /** La palabra en singular, como se escribe en pantalla. */
  word: string
  plural: string
  code: string | null
  system: InventoryUnitSystem | null
}

/** Las que se ofrecen en la lista; cualquier otra palabra vale como unidad con su nombre. */
export const INVENTORY_UNITS: readonly InventoryUnit[] = [
  { word: "unidad", plural: "unidades", code: "C62", system: "UNECE_REC20" },
  { word: "par", plural: "pares", code: "PR", system: "UNECE_REC20" },
  { word: "guante", plural: "guantes", code: null, system: null },
  { word: "caja", plural: "cajas", code: "XBX", system: "UNECE_REC20" },
  { word: "paquete", plural: "paquetes", code: "XPK", system: "UNECE_REC20" },
  { word: "frasco", plural: "frascos", code: "XBO", system: "UNECE_REC20" },
  { word: "jeringa", plural: "jeringas", code: null, system: null },
  { word: "cartucho", plural: "cartuchos", code: null, system: null },
  { word: "tubo", plural: "tubos", code: "XTU", system: "UNECE_REC20" },
  { word: "sobre", plural: "sobres", code: null, system: null },
  { word: "rollo", plural: "rollos", code: "XRO", system: "UNECE_REC20" },
  { word: "cepillo", plural: "cepillos", code: null, system: null },
  { word: "mililitro", plural: "mililitros", code: "mL", system: "UCUM" },
  { word: "gramo", plural: "gramos", code: "g", system: "UCUM" },
]

const BY_WORD = new Map(INVENTORY_UNITS.map((unit) => [unit.word, unit]))
const BY_CODE = new Map(INVENTORY_UNITS.filter((unit) => unit.code).map((unit) => [unit.code as string, unit]))

/** La unidad de la lista con esa palabra (en minúsculas, sin espacios de más), o null. */
export function findInventoryUnit(word: string): InventoryUnit | null {
  return BY_WORD.get(word.trim().toLowerCase()) ?? null
}

/** La unidad de la lista con ese código, o null. */
export function inventoryUnitByCode(code: string): InventoryUnit | null {
  return BY_CODE.get(code) ?? null
}

/** Plural en español de una unidad que no está en la lista (regla corta: vocal + s, consonante + es). */
function pluralOf(word: string): string {
  const known = BY_WORD.get(word)
  if (known) return known.plural
  if (/[aeiouáéó]$/i.test(word)) return `${word}s`
  if (/z$/i.test(word)) return `${word.slice(0, -1)}ces`
  if (/[íú]$/i.test(word) || /s$/i.test(word) || /x$/i.test(word)) return word
  return `${word}es`
}

/** La unidad para una cantidad: «1 guante», «2 guantes», «−3 jeringas». */
export function unitFor(quantity: number, unit: string): string {
  return Math.abs(quantity) === 1 ? unit : pluralOf(unit)
}

/**
 * Una cantidad con su unidad, con el separador de miles de la clínica:
 * «1,100 guantes». `locale` es el de la clínica.
 */
export function quantityWords(quantity: number, unit: string, locale = "es"): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(quantity)
  return `${number} ${unitFor(quantity, unit)}`
}

/**
 * Lo que hay en unidades de uso dicho también en unidades de compra cuando
 * hay factor: «1,100 guantes · 11 cajas». Si no es exacto, solo las de uso.
 */
export function stockWords(
  quantity: number,
  product: { unit: string; purchaseUnit: string | null; purchaseFactor: number },
  locale = "es",
): string {
  const use = quantityWords(quantity, product.unit, locale)
  if (!product.purchaseUnit || product.purchaseFactor <= 1 || quantity <= 0 || quantity % product.purchaseFactor !== 0) return use
  return `${use} · ${quantityWords(quantity / product.purchaseFactor, product.purchaseUnit, locale)}`
}
