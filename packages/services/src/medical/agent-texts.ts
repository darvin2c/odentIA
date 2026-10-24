import type { ProductAgentTexts } from "../product-agent.js"
import { medicalHooks } from "./hooks.js"

/**
 * Las palabras de latidIA en lo que lee el modelo (issue 229, entrega 9): un
 * consultorio médico, sus salas y su consulta. Sin «dónde» en el presupuesto
 * (la parte del cuerpo se escribe) ni reglas propias de Sofi todavía. Se miden
 * antes de abrir consultorios reales.
 */
export const MEDICAL_AGENT_TEXTS: ProductAgentTexts = {
  name: "latidIA",
  recallMonths: medicalHooks.recallMonths,
  visit: {
    word: "la consulta",
    offer: "una consulta, donde el médico ve qué necesita y cuánto costará",
  },
  clinician: "médico",
  // Las urgencias de un consultorio que no están entre las comunes: el
  // embarazo que sangra o el bebé que deja de moverse, la piel morada, quien
  // no reacciona, el peor dolor de cabeza, vomitar sangre y tomar de más.
  alarmSignals: [
    /\bembarazada\b[^.!?]{0,40}\b(sangrando|sangrado|sangro|me baja sangre)\b/,
    /\b(estoy sangrando|tengo sangrado|me baja sangre)\b[^.!?]{0,40}\bembarazada\b/,
    /\b(ya )?no siento (que se mueva |moverse )?(a )?(mi |el )?bebe\b/,
    /\bse me (rompio|reviento) la (fuente|bolsa)\b/,
    /\b(labios|cara|boca|unas) morad(o|a)s\b/,
    /\bse (puso|esta poniendo) morad(o|a)\b/,
    /\bno (reacciona|despierta)\b/,
    /\b(peor|mas fuerte) dolor de cabeza de (mi|su) vida\b/,
    /\bvomit\w*\b[^.!?]{0,15}\bsangre\b/,
    /\b(se tomo|me tome|se trago|me trague) (todas las|muchas|un frasco de|toda la caja de) (pastillas|pildoras)\b/,
    /\benvenen/,
  ],
  clinic: { es: "consultorio médico", en: "medical practice" },
  room: "sala",
  site: "",
  receptionRules: [],
  tagExample: "interesado-control-prenatal",
  searchExamples: "«me duele la garganta», «control del niño», «pediatra»",
  care: {
    scope: "primary medical care, health",
    topics: "health, symptoms, medicines or care after a medical visit",
    body: "health, the body",
  },
  argos: {
    specialtyExample: "Ginecología y obstetricia",
    searchExample: "ginecología",
    specialtyExamples: "'Medicina general', 'Pediatría', 'Ginecología y obstetricia'",
    phases: "'general'",
    paid: "vino y pagó algo: la consulta cobrada; no hay presupuesto que aceptar",
    clinicians: "los médicos, los profesionales",
    clinicianRole: "medicina",
    clinicalCharts: "signos vitales, examen físico",
    streetName:
      "«el ginecólogo» es la especialidad de Ginecología y obstetricia, «inyecciones» son los servicios de inyectables",
  },
  reports: {
    professional: "médico",
    eachProfessional: "de cada médico",
    treatments: "consultas, controles, ecografías",
    clinicalRecord: "signos vitales",
  },
}
