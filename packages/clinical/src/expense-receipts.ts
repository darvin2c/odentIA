/**
 * El comprobante de lo que paga la clínica (un gasto), por país (ADR 0167).
 *
 * En el Perú es la tabla 10 de SUNAT («Tipo de comprobante de pago o documento»): con el tipo y el
 * RUC del proveedor, el contador sabe qué puede usar como crédito fiscal del IGV. En otro país, sin
 * su tabla oficial cargada, se dicen los papeles de siempre, sin código: no se inventa uno.
 */

export interface ExpenseReceiptType {
  /** El código oficial del país (SUNAT tabla 10); en un país sin tabla, una clave estable. */
  code: string
  /** Como se dice en la pantalla y como se guarda en `receipt_kind` (lo que se busca). */
  label: string
  /** Pide el documento del proveedor (RUC): es lo que el contador necesita. */
  asksTaxId: boolean
}

/**
 * Cómo se dice cada tipo de gasto (QA de Gastos, G25): «Personal» se leía como el gasto propio y
 * «Servicios» como lo que se vende. Solo cambia la palabra: el valor guardado sigue igual.
 */
const CATEGORY_WORDS: Record<string, string> = { Personal: "Sueldos", Servicios: "Servicios básicos" }

export function expenseCategoryWord(category: string): string {
  return CATEGORY_WORDS[category] ?? category
}

/** Los tipos de documento tributario de un proveedor (el RUC en el Perú): los que van al comprobante. */
const TAX_DOCUMENTS = new Set(["RUC", "RUT", "NIT", "RFC", "CUIT", "NIF", "CIF"])

export function isTaxDocument(docType: string | null | undefined): boolean {
  return docType ? TAX_DOCUMENTS.has(docType.toUpperCase()) : false
}

/** «Sin comprobante»: no es un tipo del país, es que no hubo papel. */
export const NO_RECEIPT_TYPE = "sin"

const PERU: ExpenseReceiptType[] = [
  { code: "03", label: "Boleta de venta", asksTaxId: false },
  { code: "01", label: "Factura", asksTaxId: true },
  { code: "02", label: "Recibo por honorarios", asksTaxId: true },
  { code: "14", label: "Recibo de servicios públicos", asksTaxId: false },
  { code: "12", label: "Ticket", asksTaxId: false },
]

const GENERIC: ExpenseReceiptType[] = [
  { code: "boleta", label: "Boleta", asksTaxId: false },
  { code: "factura", label: "Factura", asksTaxId: true },
  { code: "recibo", label: "Recibo", asksTaxId: false },
  { code: "ticket", label: "Ticket", asksTaxId: false },
]

/** Los comprobantes de un país, en el orden en que se ofrecen; sin «Sin comprobante». */
export function expenseReceiptTypes(countryCode: string): ExpenseReceiptType[] {
  return countryCode.toUpperCase() === "PE" ? PERU : GENERIC
}

/** El tipo con ese código en ese país, o nada. */
export function expenseReceiptType(countryCode: string, code: string | null | undefined): ExpenseReceiptType | null {
  if (!code) return null
  return expenseReceiptTypes(countryCode).find((type) => type.code === code) ?? null
}

/**
 * El que se propone según el tipo de gasto, solo donde casi no hay duda: la luz y el agua llegan con
 * recibo de servicios públicos, y un sueldo no lleva papel. En lo demás no se propone nada: un
 * comprobante propuesto que nadie mira se guardaría como si existiera (QA antes de entregar).
 */
export function suggestedReceiptType(countryCode: string, category: string): string {
  const peru = countryCode.toUpperCase() === "PE"
  switch (category) {
    case "Servicios":
      return peru ? "14" : "recibo"
    case "Personal":
      return NO_RECEIPT_TYPE
    default:
      return ""
  }
}

/**
 * ¿Cuadra este RUC? Once números, con un prefijo de contribuyente (10, 15, 16, 17 o 20) y el último
 * que lo comprueba (módulo 11, como lo calcula SUNAT). Sirve para avisar, no para frenar.
 */
export function rucLooksValid(value: string): boolean {
  const ruc = value.replace(/\s+/g, "")
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((total, weight, index) => total + weight * Number(ruc[index]), 0)
  const rest = 11 - (sum % 11)
  const check = rest === 10 ? 0 : rest === 11 ? 1 : rest
  return check === Number(ruc[10])
}
