import { ALARM_NOT, type ProductAgentTexts } from "../product-agent.js"
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
  roles: {
    // Lo que ve Sofi, sin piezas ni odontograma.
    recepcion: {
      sees: "La conversación y lo acordado. Agenda, servicios, precios y los medios de pago que acepta la clínica. El conocimiento de la clínica. Las citas y los datos de contacto de la persona; sus presupuestos ya entregados, como los recibe ella (tratamientos y precios); su saldo solo si la clínica lo autoriza.",
      notSees:
        "Historia clínica (diagnósticos, notas ni signos vitales) ni caja. Lo que lleva un presupuesto que tu clínica aún prepara.",
    },
    // La ficha de Clío para el médico (entrega 10): lo que dicta un consultorio.
    asistente_clinico: {
      nameReason: "La musa de la historia: escribe la historia clínica mientras el médico atiende.",
      audience: "Para el médico, dentro de la atención",
      role: "Convierte lo que el médico dicta en el borrador de la atención, para que revise y firme sin escribir.",
      functions: [
        {
          id: "nota",
          label: "Consulta y evolución",
          description: "Motivo, enfermedad actual, evolución, indicaciones y pronóstico.",
          fixed: true,
          tools: [],
        },
        {
          id: "examen",
          label: "Signos vitales y examen físico",
          description:
            "Las medidas dichas («presión 118 con 76, temperatura 38 y medio») y cada sistema que nombra, normal o con lo que encontró. Lo que no dicta queda «No examinado».",
          fixed: true,
          tools: [],
        },
        {
          id: "diagnostico",
          label: "Diagnóstico",
          description:
            "Registra el código de la lista de la clínica que nombró el médico, presuntivo o definitivo.",
          fixed: true,
          tools: [],
        },
        {
          id: "plan",
          label: "Indicaciones",
          description:
            "Busca cada prestación dictada en los servicios del consultorio; si no hay una sola, la elige el médico.",
          fixed: true,
          tools: [],
        },
        {
          id: "receta",
          label: "Receta",
          description:
            "Prepara la receta con lo dictado (medicamento, dosis, frecuencia y duración), calcula la cantidad y avisa si choca con una alergia. El médico la emite con su colegiatura.",
          fixed: true,
          tools: [],
        },
        {
          id: "controles",
          label: "Controles",
          description: "Deja sugerido el próximo control.",
          fixed: true,
          tools: [],
        },
        {
          id: "descanso",
          label: "Descanso médico",
          description:
            "Lo deja listo con los días dictados. El médico lo emite con su firma, y la persona decide si su diagnóstico figura.",
          fixed: true,
          tools: [],
        },
      ],
      sees: "Lo que el médico dicta en esa atención. Las sugerencias de ese dictado que aún no decide, para entender una corrección dicha en voz alta. Los servicios de la clínica y la lista de diagnósticos, para reconocer lo dictado.",
      notSees:
        "El resto de la historia clínica ni las atenciones anteriores. Conversaciones ni caja.",
      never:
        "Guardar sin que el médico confirme. Firmar o cerrar la atención. Diagnosticar por su cuenta. Escuchar sin que el médico pulse «Dictar». Tocar atenciones de otros profesionales.",
      confirms: "El médico que lleva la atención: confirma cada sugerencia y firma.",
      behaves:
        "Registra solo lo que el médico dijo, sin completar lo que falta. Si se corrige al dictar, vale lo último. Una prestación que no encuentra, o que coincide con varias, queda «Por revisar» para que el médico elija.",
      learningOwner: "No guarda nada de un médico ni de la clínica.",
      learnsLater: "Recordar los términos de cada médico, como algo suyo.",
    },
  },
  // Las urgencias de un consultorio que no están entre las comunes: el
  // embarazo que sangra o el bebé que deja de moverse, la piel morada, quien
  // no reacciona, el peor dolor de cabeza, vomitar sangre y tomar de más. Negadas
  // justo antes no cuentan: «estoy embarazada y no tengo sangrado», «vomitó sin sangre».
  alarmSignals: [
    new RegExp(
      String.raw`\bembarazada\b[^.!?]{0,40}${ALARM_NOT}\b(sangrando|sangrado|sangro|me baja sangre)\b`,
    ),
    new RegExp(
      String.raw`${ALARM_NOT}\b(estoy sangrando|tengo sangrado|me baja sangre)\b[^.!?]{0,40}\bembarazada\b`,
    ),
    /\b(ya )?no siento (que se mueva |moverse )?(a )?(mi |el )?bebe\b/,
    new RegExp(String.raw`${ALARM_NOT}\bse me (rompio|reviento) la (fuente|bolsa)\b`),
    new RegExp(String.raw`${ALARM_NOT}\b(labios|cara|boca|unas) morad(o|a)s\b`),
    new RegExp(String.raw`${ALARM_NOT}\bse (puso|esta poniendo) morad(o|a)\b`),
    /\bno (reacciona|despierta)\b/,
    /\b(peor|mas fuerte) dolor de cabeza de (mi|su) vida\b/,
    new RegExp(String.raw`${ALARM_NOT}\bvomit\w*\b[^.!?]{0,15}${ALARM_NOT}\bsangre\b`),
    new RegExp(
      String.raw`${ALARM_NOT}\b(se tomo|me tome|se trago|me trague) (todas las|muchas|un frasco de|toda la caja de) (pastillas|pildoras)\b`,
    ),
    new RegExp(String.raw`${ALARM_NOT}\benvenen`),
    // Signo general de peligro de AIEPI (IMCI, OMS): un bebé que no puede beber ni
    // tomar el pecho necesita atención ya (auditoría del 27-oct: 39,5 °C y no lacta).
    // «39.5 de fiebre»: el punto entre dígitos no corta la frase.
    /\b(bebe|bebito|bebita|recien nacid[oa])\b(?:[^.!?]|(?<=\d)\.(?=\d)){0,80}\bno (quiere |puede )?(lactar|lacta|tomar? (el )?(pecho|teta|leche))\b/,
    /\bno (quiere |puede )?(lactar|lacta)\b(?:[^.!?]|(?<=\d)\.(?=\d)){0,80}\b(bebe|bebito|bebita|recien nacid[oa])\b/,
  ],
  // En un consultorio, lo urgente se orienta primero por teléfono: que la evalúen hoy, y la hora después.
  urgentFirst: "telefono",
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
