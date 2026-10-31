import type { Db } from "./client.js"
import { dentalLibrary } from "./dental/library.js"
import { medicalLibrary } from "./medical/library.js"
import { seedProcedureCodes } from "./procedure-codes.js"

/**
 * Lo de cada producto en la base (ADR 0079): sus bibliotecas. Es el único
 * lugar de la base que conecta lo de odentIA y lo de latidIA con lo común,
 * como `products.ts` en los servicios.
 */
export const PRODUCT_LIBRARIES = [dentalLibrary, medicalLibrary] as const

/** El catálogo entero: las listas oficiales y las bibliotecas de los dos productos, en una transacción. */
export function seedCatalog(db: Db) {
  return seedProcedureCodes(db, PRODUCT_LIBRARIES, { partial: false })
}
