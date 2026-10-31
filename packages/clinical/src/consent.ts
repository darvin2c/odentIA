/**
 * Consentimiento informado estructurado.
 *
 * Secciones fijas que exige la información al paciente antes de un
 * procedimiento (Ley 29414 de derechos de las personas usuarias de los
 * servicios de salud, art. 15.4 y 27, y su reglamento DS 027-2015-SA, art. 24):
 * procedimiento propuesto, beneficios esperados, riesgos y molestias,
 * alternativas y consecuencias de no tratarse. El diagnóstico que lo motiva y
 * el profesional que informa se toman del contexto clínico al generar el
 * documento, no de la plantilla.
 *
 * Los textos sugeridos nacen activos para que la clínica no empiece en papel, y
 * quedan marcados «sin revisar» hasta que alguien de ella los lea: no bloquean,
 * pero la pantalla dice cuáles faltan.
 */

export interface ConsentSections {
  /** Procedimiento propuesto, en lenguaje comprensible. */
  procedure: string
  benefits: string[]
  risks: string[]
  alternatives: string[]
  /** Consecuencias previsibles de no realizar el procedimiento. */
  consequences: string
  /** Indicaciones o información adicional (opcional). */
  notes?: string | null
}

export const CONSENT_SECTION_LABELS = {
  procedure: "Procedimiento propuesto",
  diagnosis: "Diagnóstico que lo motiva",
  benefits: "Beneficios esperados",
  risks: "Riesgos y molestias",
  alternatives: "Alternativas",
  consequences: "Consecuencias de no tratarse",
  notes: "Información adicional",
} as const

/** Declaración que la persona firmante confirma al firmar. */
export const CONSENT_DECLARATION =
  "He leído y comprendido la información, pude hacer preguntas y fueron respondidas. Autorizo el procedimiento descrito y sé que puedo revocar este consentimiento antes de que se realice."

/**
 * Lo que dice el documento sobre su firma: es simple, y no es la firma
 * digital certificada que reconoce la ley de firmas del país
 * (`ClinicalCountryProfile.signatureLaw`), si tiene una (#47).
 */
export function consentSignatureNote(signatureLaw: string | null): string {
  return `Firma electrónica simple: firmas manuscritas capturadas como evidencia; no constituyen firma digital certificada${signatureLaw ? ` (${signatureLaw})` : ""}.`
}

function cleanText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${label}: texto obligatorio`)
  const text = value.trim()
  if (text.length < min || text.length > max) throw new Error(`${label}: ${min}–${max} caracteres`)
  return text
}

function cleanList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}: lista obligatoria`)
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
  if (items.length < 1) throw new Error(`${label}: al menos un elemento`)
  if (items.length > 20) throw new Error(`${label}: como máximo 20 elementos`)
  for (const item of items)
    if (item.length > 500) throw new Error(`${label}: cada elemento hasta 500 caracteres`)
  return items
}

/** Valida y normaliza las secciones; lanza Error con el campo que falla. */
export function parseConsentSections(raw: unknown): ConsentSections {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Las secciones del consentimiento son obligatorias")
  const r = raw as Record<string, unknown>
  const notes = typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : null
  if (notes && notes.length > 4000) throw new Error("Información adicional: hasta 4000 caracteres")
  return {
    procedure: cleanText(r.procedure, CONSENT_SECTION_LABELS.procedure, 10, 4000),
    benefits: cleanList(r.benefits, CONSENT_SECTION_LABELS.benefits),
    risks: cleanList(r.risks, CONSENT_SECTION_LABELS.risks),
    alternatives: cleanList(r.alternatives, CONSENT_SECTION_LABELS.alternatives),
    consequences: cleanText(r.consequences, CONSENT_SECTION_LABELS.consequences, 10, 4000),
    notes,
  }
}

/** Texto plano equivalente (búsqueda, impresión simple y compatibilidad). */
export function consentSectionsToText(sections: ConsentSections): string {
  const list = (items: string[]) => items.map((item) => `• ${item}`).join("\n")
  return [
    `${CONSENT_SECTION_LABELS.procedure}\n${sections.procedure}`,
    `${CONSENT_SECTION_LABELS.benefits}\n${list(sections.benefits)}`,
    `${CONSENT_SECTION_LABELS.risks}\n${list(sections.risks)}`,
    `${CONSENT_SECTION_LABELS.alternatives}\n${list(sections.alternatives)}`,
    `${CONSENT_SECTION_LABELS.consequences}\n${sections.consequences}`,
    ...(sections.notes ? [`${CONSENT_SECTION_LABELS.notes}\n${sections.notes}`] : []),
  ].join("\n\n")
}

export interface SuggestedConsentTemplate {
  key: string
  title: string
  sections: ConsentSections
  /**
   * Comienzo de la clave, en la biblioteca, de los tratamientos que lo piden.
   * Sin ellos (la anestesia, las radiografías) no se pide solo: esos actos van
   * dentro de otros y pedirlo en cada uno solo agregaría firmas.
   */
  servicePrefixes?: readonly string[]
}

/** Plantillas sugeridas por procedimiento: cada clínica nace con ellas activas. */
export const SUGGESTED_CONSENT_TEMPLATES: readonly SuggestedConsentTemplate[] = [
  {
    key: "anestesia-local",
    title: "Anestesia local odontológica",
    sections: {
      procedure:
        "Aplicación de anestésico local por infiltración o bloqueo troncular para realizar el tratamiento dental sin dolor.",
      benefits: ["Realizar el tratamiento sin dolor", "Mayor comodidad durante la atención"],
      risks: [
        "Adormecimiento de labio, lengua o mejilla por varias horas",
        "Dolor o hematoma en el sitio de punción",
        "Mordedura accidental de la zona adormecida",
        "Reacción alérgica o malestar general, poco frecuentes",
        "Alteración temporal de la sensibilidad, rara vez prolongada",
      ],
      alternatives: [
        "Realizar el procedimiento sin anestesia, cuando sea posible",
        "Sedación en un centro autorizado",
      ],
      consequences:
        "Algunos procedimientos no pueden realizarse sin anestesia por el dolor que producen.",
    },
  },
  {
    key: "exodoncia",
    title: "Exodoncia simple o quirúrgica",
    servicePrefixes: ["exodoncia-"],
    sections: {
      procedure:
        "Extracción de la pieza dentaria indicada con anestesia local; puede requerir separar la encía, retirar hueso, dividir la pieza y suturar.",
      benefits: ["Eliminar el foco de infección y el dolor", "Evitar daño a las piezas vecinas"],
      risks: [
        "Dolor, inflamación y limitación de la apertura bucal por algunos días",
        "Sangrado, infección o alveolitis (inflamación del alvéolo)",
        "Alteración de la sensibilidad del labio o la lengua, generalmente temporal",
        "Fractura de raíces o de la pieza, comunicación con el seno maxilar en piezas superiores",
      ],
      alternatives: [
        "Tratamiento conservador de la pieza cuando sea posible (endodoncia, restauración)",
        "Control periódico sin intervención",
      ],
      consequences:
        "Persistencia o empeoramiento de la infección, dolor, quistes o daño a las piezas vecinas.",
    },
  },
  {
    key: "endodoncia",
    title: "Tratamiento de conductos (endodoncia)",
    servicePrefixes: ["endodoncia-", "retratamiento-de-endodoncia-"],
    sections: {
      procedure:
        "Limpieza, conformación y sellado de los conductos radiculares de la pieza indicada, con anestesia local y aislamiento.",
      benefits: ["Conservar la pieza dentaria", "Eliminar el dolor y la infección"],
      risks: [
        "Molestias o dolor después de la sesión",
        "Fractura de instrumentos dentro del conducto",
        "Persistencia de la infección que requiera retratamiento o cirugía",
        "Debilitamiento de la pieza; puede requerir corona",
      ],
      alternatives: ["Extracción de la pieza", "Control sin tratamiento"],
      consequences: "Progresión de la infección, absceso, dolor y pérdida de la pieza.",
    },
  },
  {
    key: "periodoncia",
    title: "Tratamiento periodontal",
    servicePrefixes: ["raspado-y-alisado-radicular-", "curetaje-subgingival", "cirugia-periodontal-", "colgajo-con-alisado-radicular-"],
    sections: {
      procedure:
        "Raspado y alisado radicular para retirar sarro y placa bajo la encía, con anestesia local cuando sea necesario.",
      benefits: [
        "Controlar la inflamación y el sangrado de encías",
        "Frenar la pérdida de hueso de soporte",
      ],
      risks: [
        "Sensibilidad dental temporal",
        "Retracción de la encía y espacios entre dientes",
        "Molestias o sangrado leve después del tratamiento",
      ],
      alternatives: ["Profilaxis y control de higiene", "Cirugía periodontal en casos avanzados"],
      consequences: "Avance de la enfermedad periodontal, movilidad y pérdida de piezas.",
    },
  },
  {
    key: "implante",
    title: "Implante dental",
    servicePrefixes: ["colocacion-de-implante-"],
    sections: {
      procedure:
        "Colocación quirúrgica de un implante en el hueso maxilar para reponer una pieza ausente; requiere período de integración antes de la corona.",
      benefits: [
        "Reponer la pieza ausente con estabilidad",
        "Mejorar la masticación y la estética",
      ],
      risks: [
        "Dolor, inflamación y hematoma",
        "Falta de integración o pérdida del implante",
        "Lesión de nervios o del seno maxilar",
        "Necesidad de injerto óseo adicional",
      ],
      alternatives: ["Puente fijo", "Prótesis removible", "No reponer la pieza"],
      consequences:
        "Desplazamiento de piezas vecinas, pérdida de hueso y dificultad para masticar.",
    },
  },
  {
    key: "ortodoncia",
    title: "Tratamiento de ortodoncia",
    servicePrefixes: ["ortodoncia-integral-", "ortodoncia-limitada-", "ortodoncia-interceptiva-", "aparatologia-"],
    sections: {
      procedure:
        "Colocación de aparatos fijos o removibles para mover las piezas dentarias y corregir la mordida durante el tiempo estimado del tratamiento.",
      benefits: ["Mejorar la posición dentaria y la mordida", "Facilitar la higiene y la función"],
      risks: [
        "Molestias y úlceras durante los ajustes",
        "Desmineralización o caries si la higiene es insuficiente",
        "Reabsorción radicular",
        "Recidiva si no se usan los retenedores",
      ],
      alternatives: ["Alineadores removibles", "No realizar tratamiento"],
      consequences: "Persistencia de la maloclusión y sus efectos en la función y la higiene.",
    },
  },
  {
    key: "blanqueamiento",
    title: "Blanqueamiento dental",
    servicePrefixes: ["blanqueamiento-"],
    sections: {
      procedure:
        "Aplicación de un agente blanqueador sobre el esmalte en consultorio o con férulas en casa, según indicación.",
      benefits: ["Aclarar el color de los dientes"],
      risks: [
        "Sensibilidad dental temporal",
        "Irritación de la encía",
        "Resultado variable; las restauraciones no cambian de color",
      ],
      alternatives: ["Carillas o restauraciones estéticas", "No realizar tratamiento"],
      consequences: "El color dental se mantiene; no afecta la salud bucal.",
    },
  },
  {
    key: "protesis",
    title: "Prótesis dental",
    servicePrefixes: ["corona-de-", "corona-metal-", "protesis-completa-", "protesis-parcial-", "puente-"],
    sections: {
      procedure:
        "Preparación de piezas, toma de impresiones y adaptación de una prótesis fija o removible para reponer piezas ausentes.",
      benefits: ["Recuperar la masticación y la estética", "Evitar el desplazamiento de piezas"],
      risks: [
        "Sensibilidad de las piezas preparadas",
        "Período de adaptación con molestias o úlceras",
        "Desajuste o fractura que requiera reparación",
      ],
      alternatives: ["Implantes", "Otro tipo de prótesis", "No reponer las piezas"],
      consequences: "Dificultad para masticar, desplazamiento de piezas y pérdida de hueso.",
    },
  },
  {
    key: "odontopediatria",
    title: "Atención odontopediátrica",
    sections: {
      procedure:
        "Tratamientos preventivos y restauradores en el menor (sellantes, flúor, restauraciones, pulpotomías o extracciones de piezas temporales), con manejo de conducta adaptado a su edad.",
      benefits: [
        "Tratar la caries y prevenir nuevas lesiones",
        "Conservar el espacio para las piezas permanentes",
      ],
      risks: [
        "Molestias durante o después de la atención",
        "Mordedura de labio o mejilla tras la anestesia",
        "Necesidad de repetir el tratamiento si no hay colaboración",
      ],
      alternatives: [
        "Atención bajo sedación o anestesia general en centro autorizado",
        "Control y prevención sin tratamiento restaurador",
      ],
      consequences: "Dolor, infección y pérdida prematura de piezas temporales.",
      notes: "Firma el representante legal vigente del menor.",
    },
  },
  {
    key: "radiografias",
    title: "Exámenes radiográficos",
    sections: {
      procedure:
        "Toma de radiografías intraorales o extraorales (periapical, interproximal, panorámica o tomografía) con protección radiológica.",
      benefits: [
        "Diagnosticar lesiones no visibles en el examen clínico",
        "Planificar y controlar el tratamiento",
      ],
      risks: [
        "Exposición a dosis bajas de radiación ionizante",
        "Molestia por la colocación de la placa o el sensor",
      ],
      alternatives: ["Diagnóstico solo con examen clínico, con menor precisión"],
      consequences: "Lesiones no detectadas o planificación incompleta del tratamiento.",
      notes: "Informa si estás o podrías estar embarazada.",
    },
  },
]
