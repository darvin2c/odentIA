import type { orgProduct } from "@odentia/services"
import { DENTAL_DICTATION_PROFILE } from "./dental/dictation.js"
import type { DictationProfile } from "./dictation.js"

type ClinicalProduct = Awaited<ReturnType<typeof orgProduct>>

/**
 * El único lugar del agente que conoce los productos (ADR 0079), como
 * `products.ts` en los servicios: con qué prompt, esquema y doble de
 * demostración dicta Clío en cada uno. Un producto sin dictado no dicta
 * (los servicios lo dicen antes: `requireDictatingProduct`).
 */
const DICTATION: Record<ClinicalProduct, DictationProfile | null> = {
  dental: DENTAL_DICTATION_PROFILE,
  medical: null,
}

export function dictationProfileFor(product: ClinicalProduct): DictationProfile | null {
  return DICTATION[product]
}
