import type { ClinicalProduct } from "@odentia/clinical"

/**
 * Dónde se anestesia (QA del 16 nov): odentIA y latidIA (la cirugía menor) muestran «Usa anestesia
 * local» en el servicio y la línea de anestesia en la atención; vistIA no anestesia.
 */
export const USES_LOCAL_ANESTHESIA: Record<ClinicalProduct, boolean> = {
  dental: true,
  medical: true,
  optical: false,
}
