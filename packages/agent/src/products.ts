import type { orgProduct } from "@odentia/services"
import { DENTAL_DICTATION_PROFILE } from "./dental/dictation.js"
import type { DictationProfile } from "./dictation.js"
import { MEDICAL_DICTATION_PROFILE } from "./medical/dictation.js"

type ClinicalProduct = Awaited<ReturnType<typeof orgProduct>>

/**
 * El único lugar del agente que conoce los productos (ADR 0079), como
 * `products.ts` en los servicios: con qué prompt, esquema y doble de
 * demostración dicta Clío en cada uno. Un producto sin dictado no dicta
 * (los servicios lo dicen antes: `requireDictatingProduct`).
 */
const DICTATION: Record<ClinicalProduct, DictationProfile | null> = {
  dental: DENTAL_DICTATION_PROFILE,
  // La de latidIA (issue 229, entrega 10): se mide con `eval:dictado-medico` antes de abrir consultorios.
  medical: MEDICAL_DICTATION_PROFILE,
}

export function dictationProfileFor(product: ClinicalProduct): DictationProfile | null {
  return DICTATION[product]
}
