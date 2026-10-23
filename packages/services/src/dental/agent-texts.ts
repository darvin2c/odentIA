import type { ProductAgentTexts } from "../product-agent.js"

/**
 * Las palabras de odentIA en lo que lee el modelo (ADR 0079, entrega 6): las
 * mismas de antes de separar lo común de lo dental, carácter por carácter.
 */
export const DENTAL_AGENT_TEXTS: ProductAgentTexts = {
  clinic: { es: "clínica dental", en: "dental clinic" },
  room: "unidad dental",
  site: "pieza",
  receptionRules: [
    // Decisión 10 del visor de tomografía: la tomografía llega en CD, USB o ZIP a la clínica, nunca por el chat ni por un enlace.
    "Si la persona quiere enviar una tomografía por aquí (o un enlace del centro de imágenes para descargarla), dile que la traiga a su cita en CD, USB o ZIP y que en la clínica la suben a su ficha; no prometas abrir enlaces ni revisar archivos.",
  ],
  tagExample: "interesado-ortodoncia",
  searchExamples: "«dientes amarillos», «frenillos», «ortodoncista»",
  care: {
    scope: "dental care, the mouth",
    topics: "teeth, the mouth, eating or care after a dental procedure",
    body: "teeth, the mouth",
  },
  argos: { specialtyExample: "Ortodoncia y Ortopedia Maxilar", searchExample: "ortodoncia" },
  reports: {
    professional: "doctor u odontólogo",
    eachProfessional: "de cada dentista",
    treatments: "ortodoncia, limpieza, blanqueamiento",
    clinicalRecord: "piezas dentales",
  },
}
