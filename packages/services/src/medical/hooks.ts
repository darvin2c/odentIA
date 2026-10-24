import { MEDICAL_VITAL_KEYS } from "@odentia/medical"
import { NO_PRODUCT_HOOKS, type ProductHooks } from "../product-hooks.js"
import { medicalExamination } from "./examination.js"

/**
 * Lo que latidIA hace en los momentos de lo común (ADR 0079). Sin «dónde»
 * (la parte del cuerpo se escribe, decisión 4 del issue 229) ni dictado
 * todavía; su examen es por sistemas y registra dos signos vitales más.
 */
export const medicalHooks: ProductHooks = {
  ...NO_PRODUCT_HOOKS,
  examination: medicalExamination,
  vitals: MEDICAL_VITAL_KEYS,
}
