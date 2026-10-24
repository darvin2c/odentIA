import { bareProduct, type ProductUi } from "@odentia/clinic-app/product/product-ui"

/**
 * Lo que latidIA aporta a las pantallas comunes (ADR 0079). Por ahora, las
 * partes comunes sin agregados: el «dónde» se escribe en el texto (decisión 4
 * del issue 229) y Clío aún no dicta. La ficha médica, la receta y el catálogo
 * llegan en las entregas 5 a 8 del plan.
 */
export const medicalUi: ProductUi = bareProduct("medical")
