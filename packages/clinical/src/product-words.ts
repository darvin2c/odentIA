import type { ClinicalProduct } from "./products.js"

/**
 * Las palabras que cambian de un producto a otro en lo que ve el equipo y el
 * paciente (entrega 3 del issue 229): quien atiende y lo que se reserva junto
 * con la sede y el profesional. Lo que lee el modelo va aparte, en
 * `ProductAgentTexts` de services, porque se mide antes de cambiarlo.
 */
export interface ProductWords {
  /** Quien atiende (el rol `clinician`): «Odontólogo», «odontólogo», «odontólogos». */
  clinician: { label: string; one: string; many: string }
  /**
   * Lo que se reserva con la sede y el profesional (`room`): «unidad dental» en
   * odentIA y «sala» en latidIA, donde «consultorio» es el lugar entero. Es
   * femenina en todos los productos: las frases no cambian de artículo.
   */
  room: { one: string; many: string }
}

const WORDS: Record<ClinicalProduct, ProductWords> = {
  dental: {
    clinician: { label: "Odontólogo", one: "odontólogo", many: "odontólogos" },
    room: { one: "unidad dental", many: "unidades dentales" },
  },
  medical: {
    clinician: { label: "Médico", one: "médico", many: "médicos" },
    room: { one: "sala", many: "salas" },
  },
}

/** Las palabras de un producto; sin decir cuál, las de odentIA. */
export function productWords(product: ClinicalProduct = "dental"): ProductWords {
  return WORDS[product]
}

/** La primera letra en mayúscula: «Unidad dental» al empezar una frase o un título. */
export function upperFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
}
