import type { AgentRole } from "./agent-roles.js"

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
  /** El nombre del producto, como se presenta un agente («Argos, de odentIA»); vacío: «el sistema». */
  name: string
  /**
   * Los meses sin venir de «Invitar a volver» y de «Sin venir» (los de
   * `ProductHooks.recallMonths`: 6 en odentIA, 12 en latidIA).
   */
  recallMonths: number
  /**
   * La primera visita que ofrece Sofi cuando un precio no es final o pasó el
   * tope de precios (odentIA: «la evaluación», «una evaluación, donde le dan
   * un presupuesto a su medida»).
   */
  visit: { word: string; offer: string }
  /** Quien atiende, en singular (odentIA: «odontólogo»; latidIA: «médico»). */
  clinician: string
  /**
   * Lo que cambia en las fichas de los agentes en otro producto (latidIA: Clío
   * para el médico, Sofi sin piezas ni odontograma); sin ello, las de odentIA.
   * No lo lee el modelo: son las páginas de los agentes.
   */
  roles?: Partial<
    Record<
      "recepcion" | "asistente_clinico",
      Partial<Pick<AgentRole, "nameReason" | "audience" | "role" | "functions" | "sees" | "notSees" | "never" | "confirms" | "behaves" | "learningOwner" | "later" | "learnsLater">>
    >
  >
  /**
   * Señales de alarma propias del producto, además de las comunes de
   * `agent/src/alarm.ts` (ADR 0084). Se prueban sobre el texto sin tildes y en
   * minúsculas; solo frases fuertes. odentIA no suma ninguna.
   */
  alarmSignals: readonly RegExp[]
  /**
   * Lo urgente sin señal de alarma (ADR 0084 y 0095) va con el teléfono para urgencias de la
   * clínica: con «telefono» se le da primero y después la hora más próxima; sin él, primero la
   * hora. Un dolor de muela se resuelve con la cita; en latidIA, un dolor abdominal que empeora
   * al caminar recibía primero un horario (auditoría del ADR 0104).
   */
  urgentFirst?: "telefono"
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
    /** Especialidades de ejemplo en el catálogo («'Endodoncia', 'Cirugía oral', 'Odontología general'»). */
    specialtyExamples: string
    /** Las fases del plan, como valores de la columna «fase». */
    phases: string
    /** Qué es «pago» en el embudo («aceptó y pagó algo»). */
    paid: string
    /** Quienes atienden pacientes, dicho en el catálogo del equipo («los odontólogos, los profesionales»). */
    clinicians: string
    /** El rol de quien atiende, como lo trae la vista del equipo («odontología»). */
    clinicianRole: string
    /** Lo de la historia clínica que Argos no lee, además de diagnósticos y notas («odontogramas, periodontogramas»). */
    clinicalCharts: string
    /** Un nombre de la calle y lo que es en la clínica, para «buscar_nombres» («extracciones» son los servicios de exodoncia). */
    streetName: string
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
  name: "",
  recallMonths: 6,
  visit: { word: "la consulta", offer: "una consulta" },
  clinician: "profesional",
  alarmSignals: [],
  clinic: { es: "", en: "" },
  room: "",
  site: "",
  receptionRules: [],
  tagExample: "",
  searchExamples: "",
  care: { scope: "", topics: "", body: "" },
  argos: {
    specialtyExample: "",
    searchExample: "",
    specialtyExamples: "",
    phases: "",
    paid: "pagó algo",
    clinicians: "los profesionales",
    clinicianRole: "profesional",
    clinicalCharts: "",
    streetName: "",
  },
  reports: { professional: "", eachProfessional: "", treatments: "", clinicalRecord: "" },
}

/** «odentIA», «latidIA» o, sin texto del producto, «el sistema». */
export const productName = (texts: ProductAgentTexts): string => texts.name || "el sistema"

/** «clínica dental» o, sin texto del producto, «clínica». */
export const clinicWord = (texts: ProductAgentTexts, lang: "es" | "en" = "es"): string =>
  texts.clinic[lang] || (lang === "es" ? "clínica" : "clinic")
