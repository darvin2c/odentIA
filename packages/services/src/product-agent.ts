/**
 * Lo que el modelo lee del producto (ADR 0079, entrega 6): los agentes tienen
 * una parte común y un bloque de su producto. Aquí van solo las palabras que
 * cambian entre productos; cada prompt las pone en su sitio. Un texto vacío
 * deja la frase común sin el agregado del producto.
 *
 * Cambiar una palabra de odentIA cambia lo que el modelo lee: la prueba
 * `product-prompts.test.ts` lo compara con lo de antes y, si la diferencia es a
 * propósito, se mide el agente antes de aceptarla.
 */
export interface ProductAgentTexts {
  /** Qué es la clínica, en español y en inglés («clínica dental», «dental clinic»); vacío: «clínica». */
  clinic: { es: string; en: string }
  /** El recurso que se reserva con la sede y el profesional (odentIA: «unidad dental»). */
  room: string
  /** Lo que se dice del sitio de un tratamiento al leer un presupuesto (odentIA: «pieza»); vacío: nada. */
  site: string
  /** Reglas de Sofi que son del producto (odentIA: la tomografía llega en CD, USB o ZIP). */
  receptionRules: readonly string[]
  /** Ejemplo de etiqueta para el contacto (odentIA: «interesado-ortodoncia»). */
  tagExample: string
  /** Ejemplos de lo que pide una persona con sus palabras (odentIA: «dientes amarillos»…). */
  searchExamples: string
  /** Lo que atiende la clínica, para que «fuera de tema» no lo marque (inglés). */
  care: {
    /** «dental care, the mouth» */
    scope: string
    /** «teeth, the mouth, eating or care after a dental procedure» */
    topics: string
    /** «teeth, the mouth»: de qué escribe una persona que no es spam. */
    body: string
  }
  /** Argos: ejemplos de nombres de la clínica en sus herramientas. */
  argos: {
    /** «Ortodoncia y Ortopedia Maxilar» */
    specialtyExample: string
    /** «ortodoncia» */
    searchExample: string
  }
  /** Reportes: cómo se nombra al profesional, sus tratamientos y lo clínico de un paciente. */
  reports: {
    /** «doctor u odontólogo» */
    professional: string
    /** «de cada dentista» */
    eachProfessional: string
    /** «ortodoncia, limpieza, blanqueamiento» */
    treatments: string
    /** «piezas dentales» */
    clinicalRecord: string
  }
}

/** Un producto sin textos propios: las frases comunes, sin agregados. */
export const NO_AGENT_TEXTS: ProductAgentTexts = {
  clinic: { es: "", en: "" },
  room: "",
  site: "",
  receptionRules: [],
  tagExample: "",
  searchExamples: "",
  care: { scope: "", topics: "", body: "" },
  argos: { specialtyExample: "", searchExample: "" },
  reports: { professional: "", eachProfessional: "", treatments: "", clinicalRecord: "" },
}

/** «clínica dental» o, sin texto del producto, «clínica». */
export const clinicWord = (texts: ProductAgentTexts, lang: "es" | "en" = "es"): string =>
  texts.clinic[lang] || (lang === "es" ? "clínica" : "clinic")
