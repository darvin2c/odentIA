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
 * El que se propone según el tipo de gasto: la luz y el agua llegan con recibo de servicios
 * públicos, lo de un profesional suelto con recibo por honorarios, y un sueldo o «Otros» sin papel.
 * Es solo una propuesta: la persona lo cambia.
 */
export function suggestedReceiptType(countryCode: string, category: string): string {
  const peru = countryCode.toUpperCase() === "PE"
  switch (category) {
    case "Servicios":
      return peru ? "14" : "recibo"
    case "Laboratorio":
    case "Materiales":
    case "Alquiler":
      return peru ? "01" : "factura"
    case "Personal":
      return NO_RECEIPT_TYPE
    default:
      return peru ? "03" : "boleta"
  }
}
