import type { ClinicalProduct } from "./products.js"

/**
 * Las palabras que cambian de un producto a otro en lo que ve el equipo y el
 * paciente (entrega 3 del issue 229): su nombre, quien atiende y lo que se reserva junto
 * con la sede y el profesional. Lo que lee el modelo va aparte, en
 * `ProductAgentTexts` de services, porque se mide antes de cambiarlo.
 */
export interface ProductWords {
  /** El nombre del producto: «odentIA» o «latidIA». */
  name: string
  /** Su marca visual (`BrandId` de `@odentia/ui`): el logo, el isotipo y el color. */
  brand: "odentia" | "latidia"
  /** Cómo se llama el lugar en la voz de la marca («Entra a tu clínica», «Entra a tu consultorio»), y con su artículo. */
  place: { one: string; indefinite: string }
  /** Quien atiende (el rol `clinician`): «Odontólogo», «odontólogo», «odontólogos». */
  clinician: { label: string; one: string; many: string }
  /**
   * Lo que se reserva con la sede y el profesional (`room`): «unidad dental» en
   * odentIA y «sala» en latidIA, donde «consultorio» es el lugar entero. Es
   * femenina en todos los productos: las frases no cambian de artículo.
   */
  room: { one: string; many: string }
  /**
   * Los ejemplos de los campos y de los textos de ayuda: lo que se escribe en
   * una clínica dental o en un consultorio (revisión final del issue 229).
   */
  examples: {
    /** Lo que se pide al reservar o se pregunta por precio: «una limpieza». */
    service: string
    /** Un motivo de consulta, sin «Ej.:». */
    visitReason: string
    /** Un procedimiento que pide consentimiento. */
    consentProcedure: string
    /** Una imagen que se ordena, un estudio que se sube y de dónde viene. */
    imagingOrder: string
    imagingTitle: string
    imagingSource: string
    /** Una interconsulta. */
    referral: string
    /** Una especialidad de la clínica. */
    specialty: string
    /** Lo que se ofrece en una oportunidad. */
    treatment: string
    /** Lo que no es medicamento ni alimento en la lista de alergias. */
    allergyOthers: string
    /** Un producto que se vende y varios, en plural. */
    soldItem: string
    soldItems: string
    /** Un insumo que se usa en la atención y también se vende. */
    usedAndSold: string
  }
  /** Lo que hace estándar y completa una consulta de Clío (`consultationTierOf` en services). */
  clioTiers: { estandar: string; completa: string }
}

const WORDS: Record<ClinicalProduct, ProductWords> = {
  dental: {
    name: "odentIA",
    brand: "odentia",
    place: { one: "clínica", indefinite: "una clínica" },
    clinician: { label: "Odontólogo", one: "odontólogo", many: "odontólogos" },
    room: { one: "unidad dental", many: "unidades dentales" },
    examples: {
      service: "una limpieza",
      visitReason: "dolor en muela inferior derecha desde anoche",
      consentProcedure: "Exodoncia pieza 38",
      imagingOrder: "Radiografía panorámica",
      imagingTitle: "Panorámica inicial",
      imagingSource: "Sensor intraoral · sala 2 o centro externo",
      referral: "Evaluación de ortodoncia",
      specialty: "Endodoncia",
      treatment: "Ortodoncia",
      allergyOthers: "materiales dentales",
      soldItem: "un cepillo",
      soldItems: "cepillos, blanqueadores",
      usedAndSold: "Un enjuague puede usarse en la limpieza y venderse.",
    },
    clioTiers: {
      estandar: "Nota con diagnóstico, receta, controles u odontograma",
      completa: "Armó el presupuesto",
    },
  },
  medical: {
    name: "latidIA",
    brand: "latidia",
    place: { one: "consultorio", indefinite: "un consultorio" },
    clinician: { label: "Médico", one: "médico", many: "médicos" },
    room: { one: "sala", many: "salas" },
    examples: {
      service: "una consulta",
      visitReason: "fiebre y dolor de garganta desde hace dos días",
      consentProcedure: "Infiltración en la rodilla derecha",
      imagingOrder: "Radiografía de tórax",
      imagingTitle: "Radiografía de tórax inicial",
      imagingSource: "Ecógrafo · sala 2 o centro externo",
      referral: "Evaluación por cardiología",
      specialty: "Pediatría",
      treatment: "Control de diabetes",
      allergyOthers: "látex",
      soldItem: "un tensiómetro",
      soldItems: "tensiómetros, glucómetros",
      usedAndSold: "Un antiséptico puede usarse en una curación y venderse.",
    },
    clioTiers: {
      estandar: "Nota con examen o diagnóstico, receta o controles",
      completa: "Dejó indicado lo que sigue",
    },
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
