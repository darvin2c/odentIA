import { CORE_VITAL_KEYS, type VitalSignKey } from "@odentia/clinical"

/**
 * Los signos vitales del consultorio (decisión 6 del issue 229): los de
 * siempre, el perímetro cefálico de los niños y la glucosa capilar de quien
 * vive con diabetes. El IMC no se registra: sale del peso y la talla.
 */
export const MEDICAL_VITAL_KEYS: readonly VitalSignKey[] = [
  ...CORE_VITAL_KEYS,
  "perimetroCefalico",
  "glucosaCapilar",
]
