/**
 * Los productos de odentIA (ADR 0079): cada clínica es de uno. Lo común le
 * pregunta al suyo lo que cambia (qué pasa al cerrar una atención, qué cuenta
 * la historia); el código de cada producto vive en su paquete.
 *
 * Lo común nunca compara productos a mano (`product === "medical" ? … : …`):
 * decide con un mapa completo por producto (`Record<ClinicalProduct, …>`), así
 * un producto nuevo no cae en silencio en lo de otro y el compilador señala cada
 * lugar que tiene que decidir algo para él. Lo vigila `product-choices.test.ts`.
 */
export const CLINICAL_PRODUCTS = ["dental", "medical"] as const
export type ClinicalProduct = (typeof CLINICAL_PRODUCTS)[number]

/**
 * El producto base, odentIA: el de lo que no dice su producto (las clínicas de
 * antes, una petición fuera de los dominios conocidos) y el de la plataforma,
 * cuyo dominio es `COOKIE_DOMAIN`.
 */
export const BASE_PRODUCT = "dental" satisfies ClinicalProduct

/** Los productos con dominio propio: todos menos el base (latidIA: `MEDICAL_DOMAIN`). */
export type DomainProduct = Exclude<ClinicalProduct, typeof BASE_PRODUCT>

/**
 * El dominio de cada producto con dominio propio, completo: un producto nuevo
 * obliga a decir el suyo (o `undefined`, que lo deja en el de la plataforma).
 */
export type ProductDomains = Record<DomainProduct, string | undefined>

export function isClinicalProduct(value: unknown): value is ClinicalProduct {
  return typeof value === "string" && (CLINICAL_PRODUCTS as readonly string[]).includes(value)
}
