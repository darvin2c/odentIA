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
  // Las consultas y los controles de `biblioteca_medica.csv`; los procedimientos y las pruebas no.
  consultations: [
    "consulta-medicina-general",
    "consulta-de-control",
    "consulta-a-domicilio",
    "consulta-medicina-familiar",
    "consulta-medicina-interna",
    "consulta-pediatria",
    "consulta-ginecologia",
    "control-nino-sano-menor-1",
    "control-nino-sano-1-a-4",
    "control-nino-sano-5-a-11",
    "chequeo-preventivo-adulto",
    "chequeo-preventivo-adulto-mayor",
    "planificacion-familiar",
    "control-prenatal-4-a-6",
    "control-prenatal-7-o-mas",
  ],
}
