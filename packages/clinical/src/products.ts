/**
 * Los productos de odentIA (ADR 0079): cada clínica es de uno. Lo común le
 * pregunta al suyo lo que cambia (qué pasa al cerrar una atención, qué cuenta
 * la historia); el código de cada producto vive en su paquete.
 */
export const CLINICAL_PRODUCTS = ["dental", "medical"] as const
export type ClinicalProduct = (typeof CLINICAL_PRODUCTS)[number]

export function isClinicalProduct(value: unknown): value is ClinicalProduct {
  return typeof value === "string" && (CLINICAL_PRODUCTS as readonly string[]).includes(value)
}
