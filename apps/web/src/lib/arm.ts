// ARM (Agentic Relationship Management) frente a un CRM: lo que dice la web de los tres productos.
// La pregunta «¿Qué es un ARM?» de cada portada y la página /arm-vs-crm salen de aquí, para que
// digan lo mismo. Solo se promete lo que hacen hoy los agentes de cada producto (los textos de sus
// páginas en lib/site.ts y components/*/faq.ts); la comparación es contra «un CRM» en general,
// sin nombrar a nadie ni decir «los únicos» (veracidad publicitaria).
import type { FaqItem } from "./faq"
import { HAS_CLIO, ofProduct, WORDS } from "./product"

export const ARM_PATH = "/arm-vs-crm"

/** Lo que hacen los agentes de cada producto, en una frase. */
const AGENTS_DO = ofProduct({
  dental:
    "Sofi atiende por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo y agenda, Clío prepara la nota de lo que dictas y Argos recuerda las citas, retoma los presupuestos y trae de vuelta a tus pacientes",
  medical:
    "Sofi atiende por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo y agenda, Clío ordena la consulta que dictas y Argos trae de vuelta a tus pacientes",
  optical:
    "Sofi atiende por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo y agenda el examen de la vista, y Argos recuerda los controles y trae de vuelta a tus clientes",
})

/** «¿Qué es un ARM?»: la primera pregunta de cada portada y de /arm-vs-crm. */
export const armFaq: FaqItem = {
  q: "¿Qué es un ARM?",
  a: `ARM es Agentic Relationship Management. Un CRM guarda lo que tu equipo anota y espera a que alguien haga el resto. En un ARM, los agentes hacen el trabajo: ${AGENTS_DO}, todo en una sola ficha por ${WORDS.patient === "cliente" ? "cliente" : "persona"} y siempre dentro de lo que tú les permites. ${WORDS.name} nació así; no es un CRM al que le agregaron IA.`,
}

export interface ArmRow {
  /** Lo que hay que hacer. */
  task: string
  crm: string
  arm: string
}

const P = WORDS.patients

/** La comparación de /arm-vs-crm, fila por fila. */
export const ARM_ROWS: ArmRow[] = [
  {
    task: "Quién hace el trabajo",
    crm: "Tu equipo anota, busca y persigue. El sistema espera.",
    arm: "Tus agentes responden, agendan y hacen seguimiento. Tu equipo decide y atiende.",
  },
  {
    task: "Los mensajes",
    crm: "Una bandeja más que alguien tiene que mirar.",
    arm: "Sofi responde a cualquier hora por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo.",
  },
  {
    task: `La ficha de tus ${P}`,
    crm: "Registros que alguien llena a mano, uno por canal.",
    arm: ofProduct({
      dental: "Una sola ficha por persona: escriba por donde escriba, es la misma, con su historia.",
      medical: "Una sola ficha por persona: escriba por donde escriba, es la misma, con su historia.",
      optical: "Una sola ficha por cliente: escriba por donde escriba, es el mismo, con todo lo que habló y compró.",
    }),
  },
  {
    task: "La agenda",
    crm: "Un recordatorio para que alguien llame.",
    arm: "Sofi agenda con el sí de la persona y Argos le recuerda su cita.",
  },
  ...(HAS_CLIO
    ? [
        {
          task: "La consulta",
          crm: "No entra al consultorio.",
          arm: `Dictas y Clío prepara la nota. Nada entra a la historia hasta que el ${WORDS.clinician} confirma.`,
        },
      ]
    : []),
  {
    task: "El seguimiento",
    crm: "Una lista de pendientes que crece cada semana.",
    arm: ofProduct({
      dental: "Argos retoma los presupuestos y trae de vuelta a quien no volvió.",
      medical: "Argos trae de vuelta a quien no volvió y le ofrece otro horario a quien faltó.",
      optical: "Argos invita al control y le ofrece otro horario a quien faltó.",
    }),
  },
  {
    task: "Quién manda",
    crm: "Todo depende de quién se acuerde.",
    arm: "Prendes o apagas cada tarea, y queda registrado qué hizo cada agente.",
  },
  {
    task: "Lo que pagas",
    crm: "Licencias por usuario, trabajes o no.",
    arm: "Por lo que hacen tus agentes, sin límite de usuarios. Recordar no se cobra, y la cita recuperada, solo si la persona viene.",
  },
]
