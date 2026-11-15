// ARM (Agentic Relationship Management) frente a lo que una clínica usa hoy: un CRM, un chatbot, el
// software de gestión de siempre y WhatsApp con cuaderno. La pregunta «¿Qué es un ARM?» de cada
// portada y la página /comparar salen de aquí, para que digan lo mismo.
// Voz de la web: destacar lo que hacemos bien. Solo se promete lo que hacen hoy los agentes de cada
// producto (sus páginas en lib/site.ts y components/*/faq.ts; Sofi no ve la historia clínica, según
// packages/auth/src/permissions.ts). Cada alternativa es una categoría en general, sin nombrar a nadie
// ni decir «los únicos» (veracidad publicitaria); donde hacen algo a medias, se dice «a medias».
import type { FaqItem } from "./faq"
import { HAS_CLIO, ofProduct, WORDS } from "./product"

export const ARM_PATH = "/comparar"

/** Lo que hacen los agentes de cada producto, en una frase. */
const AGENTS_DO = ofProduct({
  dental:
    "Sofi atiende por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo y agenda, Clío prepara la nota de lo que dictas y Argos recuerda las citas, retoma los presupuestos y trae de vuelta a tus pacientes",
  medical:
    "Sofi atiende por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo y agenda, Clío ordena la consulta que dictas y Argos trae de vuelta a tus pacientes",
  optical:
    "Sofi atiende por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo y agenda el examen de la vista, y Argos recuerda los controles y trae de vuelta a tus clientes",
})

/** «¿Qué es un ARM?»: la primera pregunta de cada portada y de /comparar. */
export const armFaq: FaqItem = {
  q: "¿Qué es un ARM?",
  a: `ARM es Agentic Relationship Management. Un CRM guarda lo que tu equipo anota y espera a que alguien haga el resto. En un ARM, los agentes hacen el trabajo: ${AGENTS_DO}, todo en una sola ficha por ${WORDS.patient === "cliente" ? "cliente" : "persona"} y siempre dentro de lo que tú les permites. ${WORDS.name} nació así; no es un CRM al que le agregaron IA.`,
}

const P = WORDS.patients
const NAME = WORDS.name

/** Lo que hace Argos en cada producto con quien no volvió o faltó. */
const ARGOS_BACK = ofProduct({
  dental: "Argos retoma los presupuestos y trae de vuelta a quien no volvió.",
  medical: "Argos trae de vuelta a quien no volvió y le ofrece otro horario a quien faltó.",
  optical: "Argos invita al control y le ofrece otro horario a quien faltó.",
})

/** El sistema de cada producto, en pocas palabras. */
const SYSTEM = ofProduct({
  dental: "historia clínica, odontograma, presupuestos y caja",
  medical: "historia clínica, receta, descanso médico y caja",
  optical: "examen de la vista, receta de lentes, pedidos y caja",
})

// ——— La tabla general ———

export type Mark = "si" | "medias" | "no"
export type AltKey = "crm" | "chatbot" | "software" | "manual"

export interface Alternative {
  key: AltKey
  /** El nombre en la pestaña y en la columna. */
  label: string
  /** El nombre dentro de una frase: «odentIA vs un CRM». */
  inline: string
  /** «Con un CRM», en la cabecera de su comparación. */
  with: string
  /** Por qué no alcanza, en una frase. */
  pitch: string
  rows: { task: string; them: string; us: string }[]
}

export interface MatrixRow {
  task: string
  marks: Record<AltKey, Mark>
}

/** Lo que una clínica necesita y quién lo hace. odentIA lo hace todo; las demás, según la categoría. */
export const MATRIX: MatrixRow[] = [
  {
    task: "Responde a cualquier hora por WhatsApp, Instagram, Messenger, Telegram, tu web y el correo",
    marks: { crm: "medias", chatbot: "medias", software: "no", manual: "no" },
  },
  {
    task: "Agenda la cita con el sí de la persona",
    marks: { crm: "medias", chatbot: "medias", software: "no", manual: "no" },
  },
  {
    task: `Una sola ficha por ${WORDS.patient === "cliente" ? "cliente" : "persona"}, con todos sus canales`,
    marks: { crm: "medias", chatbot: "no", software: "no", manual: "no" },
  },
  ...(HAS_CLIO
    ? [{ task: "Prepara la nota de la consulta mientras atiendes", marks: { crm: "no", chatbot: "no", software: "no", manual: "no" } as Record<AltKey, Mark> }]
    : []),
  {
    task: ofProduct({
      dental: "Recuerda las citas, retoma presupuestos y trae de vuelta a quien no volvió",
      medical: "Recuerda las citas y trae de vuelta a quien no volvió",
      optical: "Recuerda las citas, invita al control y trae de vuelta a quien no volvió",
    }),
    marks: { crm: "medias", chatbot: "no", software: "medias", manual: "no" },
  },
  {
    task: `El sistema completo: ${SYSTEM}`,
    marks: { crm: "no", chatbot: "no", software: "si", manual: "no" },
  },
  {
    task: "Tú enciendes cada agente y eliges sus seguimientos, y queda registrado qué hizo",
    marks: { crm: "medias", chatbot: "medias", software: "no", manual: "no" },
  },
  {
    task: "Sin límite de usuarios: pagas por el trabajo hecho",
    marks: { crm: "no", chatbot: "medias", software: "no", manual: "no" },
  },
]

// ——— Cada alternativa, fila por fila ———

export const ALTERNATIVES: Alternative[] = [
  {
    key: "crm",
    label: "Un CRM",
    inline: "un CRM",
    with: "Con un CRM",
    pitch: "Un CRM ordena el trabajo de tu equipo. Un ARM lo hace.",
    rows: [
      {
        task: "Quién hace el trabajo",
        them: "Tu equipo anota, busca y persigue. El sistema espera.",
        us: "Tus agentes responden, agendan y hacen seguimiento. Tu equipo decide y atiende.",
      },
      {
        task: "Los mensajes",
        them: "Una bandeja más que alguien tiene que mirar.",
        us: "Sofi responde a cualquier hora por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo.",
      },
      {
        task: `La ficha de tus ${P}`,
        them: "Registros que alguien llena a mano.",
        us: ofProduct({
          dental: "Una sola ficha por persona, con todos sus canales y su historia clínica.",
          medical: "Una sola ficha por persona, con todos sus canales y su historia clínica.",
          optical: "Una sola ficha por cliente, con todo lo que habló y compró.",
        }),
      },
      ...(HAS_CLIO
        ? [{ task: "La consulta", them: "No entra al consultorio.", us: `Dictas y Clío prepara la nota. Nada entra a la historia hasta que el ${WORDS.clinician} confirma.` }]
        : []),
      { task: "El seguimiento", them: "Una lista de pendientes que crece cada semana.", us: ARGOS_BACK },
      { task: "Lo que pagas", them: "Licencias por usuario, trabajes o no.", us: "Por lo que hacen tus agentes, sin límite de usuarios." },
    ],
  },
  {
    key: "chatbot",
    label: "Un chatbot",
    inline: "un chatbot",
    with: "Con un chatbot",
    pitch: "Un chatbot conversa. Un ARM conversa y hace el trabajo.",
    rows: [
      {
        task: "Qué hace",
        them: "Responde preguntas y le pasa el resto a alguien.",
        us: "Responde y hace el cambio: agenda, mueve la cita y queda registrado quién lo hizo.",
      },
      {
        task: "Los canales",
        them: "Uno o dos, cada uno por su lado.",
        us: "WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, en la misma ficha.",
      },
      {
        task: `Lo que sabe de tus ${P}`,
        them: "Lo que se dijo en esa conversación.",
        us: `Sus citas y todo lo que habló por cualquier canal. La historia clínica queda para el ${WORDS.clinician}.`,
      },
      { task: "Después de la conversación", them: "Se olvida.", us: ARGOS_BACK },
      ...(HAS_CLIO ? [{ task: "La consulta", them: "No entra.", us: "Clío prepara la nota de lo que dictas, y tú confirmas." }] : []),
      {
        task: "Cuando no sabe",
        them: "«Un asesor te contactará.»",
        us: "Se lo deja a tu equipo con el resumen de lo que pasó y te dice por qué.",
      },
    ],
  },
  {
    key: "software",
    label: "El software de siempre",
    inline: "el software de siempre",
    with: "Con el software de siempre",
    pitch: `El software de siempre espera a que lo uses. ${NAME} trabaja contigo.`,
    rows: [
      { task: "Quién lo usa", them: "Solo tu equipo, a mano.", us: "Tu equipo y tus agentes, que hacen parte del trabajo." },
      { task: "Los mensajes", them: "Fuera del sistema, en el WhatsApp de un celular.", us: "Dentro, en la ficha de cada persona." },
      { task: "La agenda", them: "Alguien anota cada cita.", us: "Sofi agenda con el sí de la persona." },
      ...(HAS_CLIO ? [{ task: "La nota", them: "La escribes tú, al final del día.", us: "Dictas y Clío la prepara. Tú confirmas." }] : []),
      { task: "El seguimiento", them: "Un reporte que alguien tiene que leer.", us: ARGOS_BACK },
      { task: "Lo que pagas", them: "Una licencia por usuario o por sede.", us: "Por lo que hacen tus agentes, sin límite de usuarios." },
    ],
  },
  {
    key: "manual",
    label: "WhatsApp y cuaderno",
    inline: "WhatsApp y cuaderno",
    with: "Con WhatsApp y cuaderno",
    pitch: `Lo que hoy depende de que alguien se acuerde, en ${NAME} pasa solo.`,
    rows: [
      { task: "De noche", them: "El mensaje espera hasta mañana.", us: "Sofi responde y agenda a cualquier hora." },
      { task: "La agenda", them: "Un cuaderno, y alguien que se acuerde de avisar.", us: "Una agenda donde Argos recuerda las citas a quien aceptó sus avisos." },
      { task: "Los datos", them: "En el celular de quien atendió.", us: `En la ficha de ${WORDS.theClinic}, y cada rol ve solo lo suyo.` },
      { task: `Los ${P} que no volvieron`, them: "Se pierden.", us: ARGOS_BACK },
      { task: "Si cambias de recepcionista", them: "Se va con lo que sabía.", us: "Todo queda en la ficha." },
    ],
  },
]

// ——— Una página por alternativa: /comparar/<alternativa> ———

/** Las áreas de la clínica donde trabajan los agentes de cada producto. */
export const AREAS = ofProduct({
  dental: "la recepción, la consulta y la administración",
  medical: "la recepción, la consulta y la administración",
  optical: "la recepción y la administración",
})

/** Traer a los pacientes: la misma respuesta que las portadas (la carga la hace nuestro equipo). */
const IMPORT_FAQ: FaqItem = {
  q: `¿Puedo traer a mis ${P}?`,
  a: `Sí. Nos envías tu Excel o lo que exporta tu sistema, tal como lo tienes, y nuestro equipo carga a tus ${P} por ti; lo dudoso lo revisamos contigo antes de cargarlo. Las citas, los saldos y la historia anterior todavía no se cargan.`,
}

export interface AltPage {
  /** La dirección de su página. */
  path: string
  /** El nombre de la tarjeta de la izquierda en la escena de la portada («Tu CRM»). */
  them: string
  seoTitle: string
  seoDescription: string
  title: string
  accent: string
  lead: string
  faq: FaqItem[]
}

export const ALT_PAGES: Record<AltKey, AltPage> = {
  crm: {
    path: "/comparar/crm",
    them: "Tu CRM",
    seoTitle: `${NAME} vs CRM: el ARM para ${WORDS.audience} que hace el trabajo`,
    seoDescription: `Un CRM guarda lo que tu equipo anota y espera. ${NAME} es un ARM: agentes de IA que responden, agendan y traen de vuelta a tus ${P}. Compáralos fila por fila.`,
    title: "Un CRM te pide trabajo.",
    accent: `${NAME} lo hace por ti.`,
    lead: `Un CRM guarda lo que tu equipo anota y espera a que alguien haga el resto. ${NAME} es un ARM: agentes de IA que responden, agendan y hacen seguimiento en ${AREAS} de ${WORDS.yourClinic}.`,
    faq: [armFaq, IMPORT_FAQ],
  },
  chatbot: {
    path: "/comparar/chatbot",
    them: "Tu chatbot",
    seoTitle: `${NAME} vs chatbot: agentes de IA que hacen el trabajo de ${WORDS.yourClinic}`,
    seoDescription: `Un chatbot responde y le pasa el resto a alguien. En ${NAME}, Sofi responde por todos tus canales y agenda con el sí de la persona, y Argos sigue cuando la conversación termina.`,
    title: "Un chatbot conversa.",
    accent: `${NAME} hace el trabajo.`,
    lead: `Un chatbot responde y le pasa el resto a alguien. En ${NAME}, Sofi responde por WhatsApp, Instagram, Messenger, Telegram, tu web y el correo, agenda con el sí de la persona y deja todo en su ficha. Y Argos sigue cuando la conversación termina.`,
    faq: [
      {
        q: "¿En qué se diferencia de un chatbot?",
        a: `Un chatbot responde y deja el resto para una persona. Los agentes de ${NAME} hacen el cambio en tu sistema, en la agenda y en los seguimientos, y queda registrado quién lo hizo.`,
      },
      {
        q: "¿Y si Sofi no sabe qué responder?",
        a: "Se lo deja a tu equipo con el resumen de lo que pasó y el motivo, y la conversación sigue en la misma ficha.",
      },
      armFaq,
    ],
  },
  software: {
    path: "/comparar/software-tradicional",
    them: "Tu software",
    seoTitle: `${NAME} vs el software de siempre para ${WORDS.audience}`,
    seoDescription: `El software de siempre guarda tu agenda y tus historias, pero todo lo hace tu equipo a mano. ${NAME} trae ${SYSTEM}, y además agentes de IA que responden, agendan y hacen seguimiento.`,
    title: "El software de siempre espera a que lo uses.",
    accent: `${NAME} trabaja contigo.`,
    lead: `Guarda tu agenda y tus historias, pero todo lo hace tu equipo a mano. ${NAME} trae ${SYSTEM}, y además agentes de IA que responden, agendan y hacen seguimiento.`,
    faq: [
      {
        q: `¿${NAME} reemplaza a mi software?`,
        a: `Sí. Trae ${SYSTEM}, y además agentes que hacen parte del trabajo de ${WORDS.yourClinic}.`,
      },
      IMPORT_FAQ,
      armFaq,
    ],
  },
  manual: {
    path: "/comparar/whatsapp-y-cuaderno",
    them: "Tu cuaderno",
    seoTitle: `De WhatsApp y cuaderno a ${NAME}: ${WORDS.yourClinic} sin depender de la memoria`,
    seoDescription: `Mensajes que esperan hasta mañana, citas en un cuaderno y ${P} que no vuelven. Con ${NAME}, Sofi responde y agenda a cualquier hora y Argos recuerda las citas a quien aceptó sus avisos.`,
    title: "WhatsApp y cuaderno dependen de tu memoria.",
    accent: `${NAME} no se olvida.`,
    lead: `Mensajes que esperan hasta mañana, citas en un cuaderno y ${P} que no vuelven. Con ${NAME}, Sofi responde y agenda a cualquier hora, Argos recuerda las citas a quien aceptó sus avisos y todo queda en la ficha de ${WORDS.theClinic}.`,
    faq: [
      {
        q: "¿Qué pasa con los mensajes que llegan de noche?",
        a: "Sofi los responde y agenda con el sí de la persona. Lo que no puede resolver se lo deja a tu equipo, con el resumen de lo que pasó.",
      },
      IMPORT_FAQ,
      armFaq,
    ],
  },
}
