import { dentalProfileFor, TREATMENT_KINDS, type TreatmentKind } from "@odentia/dental"
import type { ProductCatalog } from "../product-catalog.js"

/**
 * Cómo pide la gente cada tipo de la biblioteca: así «me sangran las encías»
 * encuentra la periodoncia aunque la clínica renombre su especialidad.
 */
const KIND_WORDS: Record<TreatmentKind, string> = {
  diagnostico: "revisión, chequeo, evaluación, radiografía",
  prevencion: "limpieza, prevenir caries, flúor",
  restauradora: "curación de caries, empaste, resina",
  endodoncia: "tratamiento de conducto, matar el nervio, dolor de muela",
  periodoncia: "encías que sangran, sarro, piorrea",
  cirugia: "sacar una muela o un diente, extracción",
  protesis: "dientes postizos, dentadura, corona, funda",
  implantologia: "reemplazar un diente perdido, diente fijo",
  ortodoncia: "brackets, frenillos, alinear los dientes",
  odontopediatria: "niños, dientes de leche",
  estetica: "apariencia de la sonrisa, dientes más blancos o parejos",
  disfuncion: "mandíbula, bruxismo, rechinar los dientes",
  anestesia: "sedación",
  general: "atención dental",
}

/** El catálogo de odentIA: los tipos de su biblioteca y las especialidades odontológicas de cada país (ADR 0069). */
export const dentalCatalog: ProductCatalog = {
  kinds: TREATMENT_KINDS,
  kindWords: KIND_WORDS,
  specialties: (country) => dentalProfileFor(country).specialties.list,
}
