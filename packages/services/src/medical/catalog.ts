import { MEDICAL_KIND_WORDS, MEDICAL_SERVICE_KINDS, MEDICAL_SPECIALTIES } from "@odentia/medical"
import type { ProductCatalog } from "../product-catalog.js"

/**
 * El catálogo de latidIA (issue 229, entrega 8): los tipos de su biblioteca y
 * las cinco especialidades con que nace todo consultorio, en cualquier país.
 */
export const medicalCatalog: ProductCatalog = {
  kinds: MEDICAL_SERVICE_KINDS,
  kindWords: MEDICAL_KIND_WORDS,
  specialties: () => MEDICAL_SPECIALTIES,
}
