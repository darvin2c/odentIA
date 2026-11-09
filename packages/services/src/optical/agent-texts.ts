import { ALARM_NOT, type ProductAgentTexts } from "../product-agent.js"
import { opticalHooks } from "./hooks.js"

/**
 * Las palabras de vistIA en lo que lee el modelo: una óptica, su sala de examen
 * y su examen de la vista. Sin «dónde» en el presupuesto (el ojo se dice en la
 * atención). Se miden antes de abrir ópticas reales.
 */
export const OPTICAL_AGENT_TEXTS: ProductAgentTexts = {
  name: "vistIA",
  recallMonths: opticalHooks.recallMonths,
  visit: {
    word: "el examen de la vista",
    offer: "un examen de la vista, donde el optómetra mide su vista y le dice qué lentes necesita",
  },
  clinician: "optómetra",
  roles: {
    // Lo que ve Sofi, sin piezas ni odontograma.
    recepcion: {
      sees: "La conversación y lo acordado. Agenda, servicios, precios y los medios de pago que acepta la óptica. El conocimiento de la óptica. Las citas y los datos de contacto de la persona; sus presupuestos ya entregados, como los recibe ella (servicios y precios); su saldo solo si la óptica lo autoriza.",
      notSees:
        "Historia clínica (diagnósticos, notas ni la medida de la vista) ni caja. Lo que lleva un presupuesto que tu óptica aún prepara.",
    },
    // Clío no dicta en una óptica: la página del agente lo dice «Aún no disponible».
    asistente_clinico: { available: false },
  },
  // Las urgencias de la vista que no están entre las comunes: dejar de ver de golpe,
  // la cortina o sombra que tapa la vista, los destellos con manchas (la retina que
  // se desprende), un químico o algo clavado en el ojo, el dolor fuerte del ojo con
  // vómitos (glaucoma agudo) y ver doble de repente. Van a una emergencia, no a la
  // óptica. Negadas justo antes no cuentan: «no he perdido la vista».
  alarmSignals: [
    new RegExp(
      String.raw`\b(de repente|de golpe|derepente|subitamente)\b[^.!?]{0,40}${ALARM_NOT}\b(no veo nada|deje de ver|dejo de ver|perdi la vista|perdio la vista|perdi la vision|me quede ciego|me quede ciega)\b`,
    ),
    new RegExp(
      String.raw`${ALARM_NOT}\b(no veo nada|deje de ver|dejo de ver|perdi la vista|perdio la vista|perdi la vision|me quede ciego|me quede ciega)\b[^.!?]{0,40}\b(de repente|de golpe|derepente|subitamente)\b`,
    ),
    new RegExp(
      String.raw`${ALARM_NOT}\b(una )?(cortina|sombra|telon|mancha negra)\b[^.!?]{0,30}\b(me )?(tapa|cubre|baja|sube|tapo|cubrio)\b[^.!?]{0,20}\b(la vista|el ojo|un ojo|mi ojo)\b`,
    ),
    new RegExp(
      String.raw`${ALARM_NOT}\b(destellos|relampagos|flashes|luces que brillan)\b[^.!?]{0,60}\b(manchas|moscas|moscos|puntos negros|telarana|telaranas)\b`,
    ),
    new RegExp(
      String.raw`${ALARM_NOT}\b(manchas|moscas|moscos|puntos negros|telarana|telaranas)\b[^.!?]{0,60}\b(destellos|relampagos|flashes)\b`,
    ),
    new RegExp(
      String.raw`\b(me|le|se me|se le) (cayo|salpico|entro)\b[^.!?]{0,30}\b(lejia|cloro|acido|soda caustica|cal|quimico|detergente)\b[^.!?]{0,30}\bojos?\b`,
    ),
    new RegExp(
      String.raw`\b(lejia|cloro|acido|soda caustica|cal|quimico|detergente)\b[^.!?]{0,30}\b(me|le|se me|se le) (cayo|salpico|entro)\b[^.!?]{0,30}\bojos?\b`,
    ),
    new RegExp(
      String.raw`\b(se me|se le) (clavo|incrusto|metio)\b[^.!?]{0,30}\b(vidrio|metal|astilla|clavo|alambre|fierro)\b[^.!?]{0,30}\bojo\b`,
    ),
    new RegExp(String.raw`${ALARM_NOT}\bdolor (muy )?(fuerte|intenso)\b[^.!?]{0,20}\bojo\b[^.!?]{0,60}\b(vomit\w*|nausea\w*)`),
    new RegExp(
      String.raw`\b(de repente|de golpe|derepente)\b[^.!?]{0,30}${ALARM_NOT}\bveo doble\b|${ALARM_NOT}\bveo doble\b[^.!?]{0,30}\b(de repente|de golpe|derepente)\b`,
    ),
  ],
  clinic: { es: "óptica", en: "optical store" },
  room: "sala de examen",
  site: "",
  receptionRules: [
    "Si la persona pregunta si sus lentes ya están listos, cuándo los entregan o cuánto le falta pagar, dile que lo confirmas con el equipo de la óptica; no inventes fechas ni montos.",
  ],
  tagExample: "interesado-progresivos",
  searchExamples: "«no veo bien de lejos», «pupilentes», «lentes para leer»",
  care: {
    scope: "eye care, vision, eyeglasses and contact lenses",
    topics: "the eyes, vision, eyeglasses, contact lenses or care after an eye exam",
    body: "the eyes, vision",
  },
  argos: {
    specialtyExample: "Contactología",
    searchExample: "lentes de contacto",
    specialtyExamples: "'Optometría', 'Contactología', 'Terapia visual'",
    phases: "'general'",
    paid: "vino y pagó algo: el examen o los lentes; no hay presupuesto que aceptar",
    clinicians: "los optómetras, los profesionales",
    clinicianRole: "optometría",
    clinicalCharts: "exámenes de la vista",
    streetName:
      "«la medida» es el examen de la vista, «pupilentes» son los servicios de lentes de contacto",
  },
  reports: {
    professional: "optómetra",
    eachProfessional: "de cada optómetra",
    treatments: "exámenes de la vista, lentes de contacto, terapia visual",
    clinicalRecord: "exámenes de la vista",
  },
}
