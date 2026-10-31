import type { SuggestedConsentTemplate } from "@odentia/clinical"

/**
 * Los consentimientos que latidIA sugiere a un consultorio (issue 229, entrega
 * 6): los procedimientos que suelen hacerse en la consulta de medicina
 * general. Como los de odentIA, nacen activos y sin revisar.
 */
export const MEDICAL_CONSENT_TEMPLATES: readonly SuggestedConsentTemplate[] = [
  {
    key: "procedimiento-menor",
    title: "Procedimiento menor en consultorio",
    servicePrefixes: ["sutura-simple", "drenaje-de-absceso", "extraccion-de-una"],
    sections: {
      procedure:
        "Procedimiento menor en el consultorio, con anestesia local: por ejemplo, la sutura de una herida, el drenaje de un absceso o el retiro de una lesión pequeña de la piel.",
      benefits: [
        "Tratar la lesión en la misma consulta",
        "Evitar que la herida o la infección empeoren",
      ],
      risks: [
        "Dolor o molestia en la zona",
        "Sangrado o hematoma",
        "Infección de la herida",
        "Cicatriz visible",
        "Reacción al anestésico local, poco frecuente",
      ],
      alternatives: [
        "Tratamiento con medicamentos, cuando es posible",
        "Derivación a un centro con sala de operaciones",
      ],
      consequences: "La lesión o la infección pueden empeorar si no se tratan.",
    },
  },
  {
    key: "inyectables",
    title: "Aplicación de medicamentos inyectables",
    servicePrefixes: ["inyectable-"],
    sections: {
      procedure:
        "Aplicación de un medicamento por vía intramuscular, subcutánea o endovenosa en el consultorio.",
      benefits: ["Que el medicamento actúe antes o cuando no puede tomarse por boca"],
      risks: [
        "Dolor o moretón donde se aplica",
        "Mareo o desmayo",
        "Infección en el sitio de la inyección, poco frecuente",
        "Reacción alérgica, rara vez grave",
      ],
      alternatives: ["El mismo medicamento por boca, cuando existe y es adecuado"],
      consequences: "Sin el medicamento, la enfermedad puede tardar más en mejorar o empeorar.",
    },
  },
  {
    key: "toma-de-muestras",
    title: "Toma de muestras",
    servicePrefixes: ["toma-de-muestra-de-sangre"],
    sections: {
      procedure:
        "Toma de una muestra de sangre, orina o secreción para estudiarla en el laboratorio.",
      benefits: ["Confirmar el diagnóstico", "Elegir el tratamiento y seguir cómo responde"],
      risks: [
        "Dolor o moretón donde se pincha",
        "Mareo o desmayo",
        "Repetir la toma si la muestra no alcanza",
      ],
      alternatives: ["Tomar la muestra en un laboratorio"],
      consequences: "Sin el examen, el diagnóstico puede quedar incompleto.",
    },
  },
]
