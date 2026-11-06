import { MEDICAL_KIND_WORDS, MEDICAL_SERVICE_KINDS, MEDICAL_SPECIALTIES } from "@odentia/medical"
import type { ProductCatalog } from "../product-catalog.js"

/**
 * El catálogo de latidIA (issue 229, entrega 8): los tipos de su biblioteca y
 * las cinco especialidades con que nace todo consultorio, en cualquier país.
 */
export const medicalCatalog: ProductCatalog = {
  kinds: MEDICAL_SERVICE_KINDS,
  kindWords: MEDICAL_KIND_WORDS,
  // Cómo piden los pacientes una atención médica y cómo se llama en el catálogo.
  everydayWords: {
    chequeo: ["consulta", "control", "evaluacion"],
    revision: ["consulta", "control", "evaluacion"],
    analisis: ["laboratorio", "examen"],
    vacuna: ["inmunizacion"],
    inyeccion: ["inyectable", "aplicacion"],
    suero: ["hidratacion"],
  },
  specialties: () => MEDICAL_SPECIALTIES,
}
