// Contenido de las páginas interiores (agentes, omnicanal, sistema y confianza).
// Cada página atiende una búsqueda concreta: de ahí salen su título, su descripción y su h1.
// La documentación es privada, así que cada página explica sola qué hace esa parte y para quién.
// Sin cifras de precio: esas viven solo en el inicio y en /precios (src/lib/pricing.ts).
import type { FaqItem } from "./faq"
import { AGENT_COLORS, contactEmail } from "./site"

export type AgentIndex = 0 | 1 | 2
export type HeroVisualKind =
  | "agenda"
  | "odontograma"
  | "presupuestos"
  | "caja"
  | "enlace"
  | "reportes"
  | "sedes"
  | "whatsapp"
  | "seguridad"
  | "contacto"

export type CardItem = {
  title: string
  text: string
  href?: string
  agent?: AgentIndex
  label?: string
}
export type Step = {
  when?: string
  title: string
  text?: string
  agent?: AgentIndex
  channel?: string
}
export type ChatMsg = { ch: string; who: string; side: "in" | "out"; text: string }
export type LogEntry = { t: string; agent: AgentIndex; verb: string; obj: string; where: string }

export type Block =
  | { kind: "cards"; tag: string; title: string; lead?: string; items: CardItem[]; note?: string }
  | { kind: "steps"; tag: string; title: string; lead?: string; steps: Step[]; note?: string }
  | {
      kind: "split"
      tag: string
      title: string
      paragraphs: string[]
      points?: CardItem[]
      link?: { href: string; label: string }
    }
  | {
      kind: "chat"
      tag: string
      title: string
      lead?: string
      person: { initials: string; name: string; sub: string; text: string }
      messages: ChatMsg[]
      summary: string
      note?: string
    }
  | { kind: "log"; tag: string; title: string; lead?: string; entries: LogEntry[]; note: string }
  | {
      kind: "sheet"
      tag: string
      title: string
      lead?: string
      sheet: {
        head: string
        meta: string
        rows: { label: string; text: string; code?: string }[]
        done: string
      }
      note?: string
    }

export type PageHeroData =
  | {
      type: "scene"
      focus: "todos" | "recepcion" | "clinico" | "administrador"
      tag: string
      title: string
      accent: string
      accentColor?: string
      /** Por qué el agente se llama así: va como subtítulo en la portada de su página. */
      meaning?: string
      lead: string
    }
  | {
      type: "visual"
      visual: HeroVisualKind
      tag: string
      title: string
      accent?: string
      lead: string
      secondary?: { href: string; label: string }
    }

export type PageData = {
  path: string
  /** Título de la pestaña y de Google (sin « · odentIA», que agrega Base). */
  title: string
  description: string
  crumb: string
  parent?: [string, string]
  hero: PageHeroData
  blocks: Block[]
  related: string[]
  faqTitle?: string
  faq: FaqItem[]
  cta?: { title?: string; text?: string }
}

/** Nombres de los tres agentes (issue 183). La web siempre dice «Sofi», aunque cada clínica pueda renombrarla. */
export const AGENT_NAMES = ["Sofi", "Clío", "Argos"] as const
/** Colores de cada agente sobre fondo claro (para texto) y oscuro (para puntos y bordes). */
export const AGENT_LIGHT = [
  AGENT_COLORS.recepcion.light,
  AGENT_COLORS.clinico.light,
  AGENT_COLORS.administrador.light,
] as const
export const AGENT_DARK = [
  AGENT_COLORS.recepcion.dark,
  AGENT_COLORS.clinico.dark,
  AGENT_COLORS.administrador.dark,
] as const

/** Tarjetas de enlace a cada página, para la sección «Sigue por aquí». */
export const LINKS: Record<string, { label: string; text: string }> = {
  "/agentes": {
    label: "Los tres agentes",
    text: "Sofi en recepción, Clío en la consulta y Argos en lo pendiente, sobre la misma historia.",
  },
  "/agentes/recepcion": {
    label: "Sofi, tu agente de recepción",
    text: "Responde y agenda por todos tus canales, de día y de noche.",
  },
  "/agentes/asistente-clinico": {
    label: "Clío, tu agente clínico",
    text: "Ordena lo que dictas en la historia. Tú confirmas.",
  },
  "/agentes/administrador": {
    label: "Argos, tu agente administrador",
    text: "Recuerda citas, avisa controles y retoma presupuestos.",
  },
  "/omnicanal": {
    label: "Omnicanal",
    text: "Todos tus canales llegan a la misma persona y a su única historia.",
  },
  "/whatsapp-para-clinicas-dentales": {
    label: "WhatsApp para clínicas",
    text: "El número de tu clínica, atendido por tu equipo y por Sofi.",
  },
  "/agenda-odontologica": { label: "Agenda", text: "Por sede, unidad dental y profesional." },
  "/historia-clinica-y-odontograma": {
    label: "Historia y odontograma",
    text: "Odontograma FDI, diagnósticos codificados y cada atención en orden.",
  },
  "/presupuestos-dentales": {
    label: "Presupuestos",
    text: "Hasta tres opciones claras y el seguimiento de lo pendiente.",
  },
  "/caja-y-cobros": {
    label: "Caja y cobros",
    text: "Cobros, gastos, quién debe y el cierre de cada sede.",
  },
  "/portal-del-paciente": {
    label: "Su enlace",
    text: "Cada paciente reserva, cambia su cita y ve sus documentos.",
  },
  "/reportes": { label: "Reportes", text: "Lo que pasa en tu clínica, sin armar planillas." },
  "/varias-sedes": {
    label: "Varias sedes",
    text: "Un equipo, varias sedes y cada rol con lo suyo.",
  },
  "/seguridad": { label: "Seguridad", text: "Roles, clínicas separadas y cómo usamos la IA." },
  "/precios": {
    label: "Precios",
    text: "Un solo plan que vuelve como crédito. Pagas por el trabajo hecho.",
  },
  "/contacto": {
    label: "Habla con nosotros",
    text: "Escríbenos y te responde una persona del equipo.",
  },
}

// Ejemplos que se repiten (datos inventados, tomados del lienzo aprobado).
const CHAT_LUCIA: ChatMsg[] = [
  {
    ch: "Instagram",
    who: "Lucía",
    side: "in",
    text: "Hola, ¿cuánto me falta para que me quiten los brackets?",
  },
  {
    ch: "Instagram",
    who: "Sofi",
    side: "out",
    text: "Hola, Lucía. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. En tu control del martes 28 la Dra. Paredes te dirá cuánto falta. ¿Te lo recuerdo un día antes?",
  },
  { ch: "Instagram", who: "Lucía", side: "in", text: "Sí, porfa." },
  {
    ch: "WhatsApp",
    who: "Carmen, su mamá",
    side: "in",
    text: "Hola, soy la mamá de Lucía. ¿Podemos pasar su control del martes al viernes?",
  },
  {
    ch: "WhatsApp",
    who: "Sofi",
    side: "out",
    text: "Hola, Carmen. Claro: tengo el viernes 31 a las 16:00 con la Dra. Paredes. ¿Te lo dejo?",
  },
  { ch: "WhatsApp", who: "Carmen, su mamá", side: "in", text: "Sí, por favor." },
  {
    ch: "Correo",
    who: "Sofi",
    side: "out",
    text: "Confirmación para Carmen: control de ortodoncia de Lucía, viernes 31 a las 16:00, con la Dra. Paredes.",
  },
]
const PERSON_LUCIA = {
  initials: "LR",
  name: "Lucía Ramos",
  sub: "Paciente · 14 años",
  text: "Carmen, su mamá, es quien agenda y paga. Las dos escriben por canales distintos y todo queda en la misma ficha, sin duplicados y sin adivinar quién es por su número.",
}
const ACTS: LogEntry[] = [
  {
    t: "23:41",
    agent: 0,
    verb: "Agendó",
    obj: "la cita de Andrea para el jueves",
    where: "Agenda",
  },
  { t: "07:00", agent: 2, verb: "Recordó", obj: "las 18 citas del día", where: "WhatsApp" },
  {
    t: "08:15",
    agent: 0,
    verb: "Movió",
    obj: "la cita de Lucía al viernes y avisó a su mamá",
    where: "Agenda",
  },
  {
    t: "09:41",
    agent: 1,
    verb: "Escribió",
    obj: "la nota de Carlos, que la doctora confirmó",
    where: "Historia",
  },
  {
    t: "09:42",
    agent: 1,
    verb: "Propuso",
    obj: "el diagnóstico K02.1 y la resina del tarifario",
    where: "Historia",
  },
  {
    t: "13:21",
    agent: 0,
    verb: "Reenvió",
    obj: "el presupuesto de ortodoncia a Jorge",
    where: "Presupuestos",
  },
  {
    t: "16:05",
    agent: 2,
    verb: "Retomó",
    obj: "el presupuesto que Rosa no había respondido",
    where: "Presupuestos",
  },
  {
    t: "16:30",
    agent: 2,
    verb: "Dejó una tarea",
    obj: "a recepción: llamar a Pedro, que no tiene WhatsApp",
    where: "Tareas",
  },
]
const CASE_LUCIA: Step[] = [
  {
    when: "Lunes 19:10",
    channel: "Instagram",
    agent: 0,
    title: "Lucía pregunta cuánto le falta para quitarse los brackets.",
  },
  {
    when: "Lunes 19:11",
    channel: "Instagram",
    agent: 0,
    title: "Sofi le confirma su control del martes 28 y se ofrece a recordárselo.",
  },
  {
    when: "Miércoles 08:30",
    channel: "WhatsApp",
    agent: 0,
    title: "Carmen, su mamá, pide pasarlo al viernes y Sofi lo mueve.",
  },
  {
    when: "Jueves 16:00",
    channel: "Correo",
    agent: 2,
    title: "Le recuerda a Carmen el control de mañana.",
  },
  {
    when: "Viernes 16:20",
    channel: "Consulta",
    agent: 1,
    title: "La Dra. Paredes dicta el control y confirma la nota.",
  },
  {
    when: "Viernes 16:40",
    channel: "Historia",
    agent: 1,
    title: "Queda listo el próximo control, en seis meses.",
  },
  {
    when: "Seis meses después",
    channel: "WhatsApp",
    agent: 2,
    title: "Le escribe a Carmen, Lucía reserva y vuelve: cita recuperada.",
  },
]
const NOTE_CARLOS = {
  head: "Consulta de Carlos Medina",
  meta: "Dra. Paredes · 09:40",
  rows: [
    {
      label: "Consulta y evolución",
      text: "Dolor al frío en la pieza 36 desde hace una semana. Caries oclusal profunda en 36, percusión negativa.",
    },
    { label: "Diagnóstico", code: "K02.1", text: "Caries de la dentina · pieza 36" },
    { label: "Plan", text: "Restauración con resina en 36, del tarifario de la clínica." },
    { label: "Controles", text: "Control en seis meses." },
  ],
  done: "La Dra. Paredes confirmó y firmó. Ya está en la historia de Carlos.",
}
const FAQ_ERROR: FaqItem = {
  q: "¿Y si el agente no sabe qué responder o se equivoca?",
  a: "Si no sabe, le dice a la persona que alguien de tu equipo la va a atender y te deja el caso con todo lo que se habló. Todo lo que hace queda registrado, así que si se equivoca lo ves y lo corriges. Y nada clínico entra a la historia sin el sí del odontólogo.",
}
const FAQ_MODEL: FaqItem = {
  q: "¿Qué inteligencia artificial usa?",
  a: "ChatGPT 6, de OpenAI, con la cuenta de odentIA. No necesitas una cuenta propia ni una clave.",
}
const FAQ_META: FaqItem = {
  q: "¿Tengo que pagarle algo más a WhatsApp?",
  a: "Responder a quien te escribe, dentro de las 24 horas, no tiene costo de Meta. Los mensajes de plantilla, como un recordatorio fuera de esa ventana, los cobra Meta directamente a la clínica. odentIA te muestra el estimado.",
}
const FAQ_TRAINING: FaqItem = {
  q: "¿Usan los datos de mi clínica para entrenar la IA?",
  a: "[Por confirmar con el proveedor de IA y el abogado antes de publicar] No. Los datos de tu clínica se usan solo para atender a tus pacientes y no se usan para entrenar modelos de inteligencia artificial.",
}

const AGENTS_PARENT: [string, string] = ["Agentes", "/agentes"]

export const PAGES = {
  // ——— Pilar agéntica ———
  agentes: {
    path: "/agentes",
    title: "IA agéntica para clínicas dentales",
    description:
      "IA agéntica para tu clínica dental: Sofi responde y agenda en recepción por todos tus canales, Clío prepara la nota de tu dictado y Argos, el administrador, trae de vuelta a tus pacientes.",
    crumb: "Agentes",
    hero: {
      type: "scene",
      focus: "todos",
      tag: "Agentes",
      title: "IA agéntica para tu clínica dental:",
      accent: "tres agentes alrededor de cada paciente.",
      lead: "Sofi, tu agente de recepción, conversa por cualquier canal; Clío, tu agente clínico, documenta la consulta, y Argos, tu agente administrador, da seguimiento. Todo queda en una sola historia, y tu equipo decide.",
    },
    blocks: [
      {
        kind: "log",
        tag: "Agéntica",
        title: "Actúan, no solo conversan.",
        lead: "Agentes que actúan, no solo conversan. Agendan y mueven citas, preparan la nota clínica, recuerdan, retoman presupuestos y te avisan cuando hace falta una persona. Siempre dentro de lo que tú les permites.",
        entries: ACTS,
        note: "Un chatbot responde y deja el resto para una persona. Los agentes de odentIA hacen el cambio en tu sistema, y queda registrado quién lo hizo.",
      },
      {
        kind: "cards",
        tag: "Los tres agentes",
        title: "Cada uno con su trabajo, todos sobre la misma historia.",
        items: [
          {
            agent: 0,
            title: "Tu agente de recepción",
            label: "Responde, informa y agenda a cualquier hora.",
            text: "Contesta al momento por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo. Agenda, mueve o cancela citas siempre con el sí del paciente.",
            href: "/agentes/recepcion",
          },
          {
            agent: 1,
            title: "Tu agente clínico",
            label: "Prepara la nota mientras el odontólogo atiende. Solo falta su sí.",
            text: "Del dictado propone la nota, el diagnóstico con su código, el plan y los controles. Nada entra a la historia sin la confirmación del odontólogo.",
            href: "/agentes/asistente-clinico",
          },
          {
            agent: 2,
            title: "Tu agente administrador",
            label: "Recuerda citas y trae de vuelta a los pacientes.",
            text: "Recuerda cada cita, avisa los controles, retoma los presupuestos y ofrece otra fecha a quien faltó. Si no puede escribirle a alguien, le deja la tarea a tu equipo.",
            href: "/agentes/administrador",
          },
        ],
      },
      {
        kind: "steps",
        tag: "Las dos juntas",
        title: "Un caso, de principio a fin.",
        lead: "Empieza con una pregunta por Instagram y termina con Lucía de vuelta en su control. Cada paso dice qué agente lo hizo y por dónde.",
        steps: CASE_LUCIA,
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "cards",
        tag: "El control",
        title: "Tú decides qué hace cada agente.",
        lead: "Cada tarea se prende o se apaga con un toque. Lo que el agente no puede resolver, se lo deja a una persona y te dice por qué.",
        items: [
          {
            title: "Lo clínico lo confirma el odontólogo.",
            text: "Ninguna nota entra a la historia sin su sí.",
          },
          {
            title: "Pones un tope de gasto.",
            text: "Te avisamos antes de llegar y, al llegar, los casos nuevos pasan a tu equipo.",
          },
          {
            title: "Todo queda a la vista.",
            text: "Qué hizo cada agente, con quién y cuánto costó.",
          },
        ],
      },
      {
        kind: "split",
        tag: "Lo que viene",
        title: "Lista para los agentes de IA del navegador.",
        paragraphs: [
          "Los asistentes de IA de los navegadores ya empiezan a hacer tareas por las personas. Estamos preparando odentIA para ellos con WebMCP: un asistente podrá consultar los precios o calcular el mes sin leer la pantalla, y cualquier acción irá con la confirmación de la persona.",
          "Lo anunciaremos cuando funcione. Todavía no tiene fecha.",
        ],
      },
    ],
    related: [
      "/agentes/recepcion",
      "/agentes/asistente-clinico",
      "/agentes/administrador",
      "/omnicanal",
      "/seguridad",
      "/precios",
    ],
    faq: [
      {
        q: "¿Qué significa agéntica?",
        a: "Que los agentes no solo conversan, también actúan. Agendan, mueven citas, preparan la nota, recuerdan y retoman presupuestos, siempre dentro de lo que tú les permites.",
      },
      {
        q: "¿En qué se diferencia de un chatbot?",
        a: "Un chatbot responde y deja el resto para una persona. Los agentes de odentIA hacen el cambio en tu sistema, en la agenda, la historia o los presupuestos, y queda registrado quién lo hizo.",
      },
      {
        q: "¿Puedo apagar lo que no quiero que hagan?",
        a: "Sí. Cada tarea se prende o se apaga con un toque. Si apagas una, el agente se la deja a tu equipo.",
      },
      FAQ_ERROR,
      FAQ_MODEL,
    ],
  },

  recepcion: {
    path: "/agentes/recepcion",
    title: "Responder el WhatsApp de tu clínica dental automático",
    description:
      "Sofi, tu agente de recepción, responde el WhatsApp, Instagram, Messenger, Telegram, el chat de la web y el correo de tu clínica dental al momento, de día y de noche, y agenda con el sí del paciente.",
    crumb: "Sofi",
    parent: AGENTS_PARENT,
    hero: {
      type: "scene",
      focus: "recepcion",
      tag: "Sofi, tu agente de recepción",
      meaning: "De sophía, sabiduría: sabe todo de la clínica y responde con su tono, a cualquier hora.",
      title: "Responde el WhatsApp de tu clínica dental,",
      accent: "automático y a cualquier hora.",
      accentColor: AGENT_COLORS.recepcion.dark,
      lead: "Contesta WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo. Informa precios y horarios, agenda con el sí del paciente y le pasa a tu equipo lo que necesita a una persona.",
    },
    blocks: [
      {
        kind: "split",
        tag: "Qué hace",
        title: "Contesta al momento, de día y de noche.",
        paragraphs: [
          "Sofi contesta al momento, de día y de noche, por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo. Informa precios y horarios, y agenda, mueve o cancela citas siempre con el sí del paciente. Si hace falta una persona, le pasa el caso a tu equipo con un resumen.",
          "Se llama Sofi, o como tú le pongas, y tiene el tono de tu clínica: cercano, neutro o formal, de tú o de usted. Siempre dice que es un asistente virtual.",
        ],
        points: [
          {
            title: "Para recepción",
            text: "Menos mensajes repetidos y ninguna conversación perdida al cambiar de turno.",
          },
          {
            title: "Para tus pacientes",
            text: "Una respuesta al momento, aunque escriban de noche o en domingo.",
          },
        ],
      },
      {
        kind: "chat",
        tag: "Un ejemplo",
        title: "La misma conversación, aunque cambie de canal.",
        lead: "Lucía pregunta por Instagram y su mamá sigue por WhatsApp. Sofi sabe que hablan de la misma paciente.",
        person: PERSON_LUCIA,
        messages: CHAT_LUCIA,
        summary: "Una persona · 3 canales · 1 historia",
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "cards",
        tag: "Tú decides",
        title: "Lo que puede hacer, lo prendes o lo apagas.",
        items: [
          {
            agent: 0,
            title: "Responder mensajes",
            text: "Prendido: responde al momento, de día y de noche. Apagado: los mensajes esperan a que alguien de tu equipo los vea.",
          },
          {
            agent: 0,
            title: "Agendar citas",
            text: "Prendido: agenda en los horarios libres de quien atiende ese servicio, con el sí del paciente. Apagado: envía su enlace para que la persona elija la hora.",
          },
          {
            agent: 0,
            title: "Pasar el caso a tu equipo",
            text: "Cuando no sabe o hace falta una persona, se lo dice al paciente y te deja el caso con un resumen de lo que se habló.",
          },
        ],
      },
      {
        kind: "log",
        tag: "Registro",
        title: "Todo lo que hace queda anotado.",
        entries: ACTS.filter((a) => a.agent === 0),
        note: "Ejemplo con datos inventados. En tu clínica ves cada acción con quién la hizo y cuándo.",
      },
    ],
    related: [
      "/whatsapp-para-clinicas-dentales",
      "/omnicanal",
      "/agenda-odontologica",
      "/portal-del-paciente",
      "/agentes/administrador",
      "/precios",
    ],
    faq: [
      {
        q: "¿Mis pacientes sabrán que hablan con un asistente?",
        a: "Sí. Sofi siempre dice que es asistente virtual, con el nombre que tu clínica le ponga.",
      },
      {
        q: "¿Por qué canales responde?",
        a: "WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo (Gmail y Microsoft 365). No atiende llamadas ni SMS.",
      },
      {
        q: "¿Puede agendar sin que nadie revise?",
        a: "Agenda en los horarios libres de quien atiende ese servicio y siempre con el sí del paciente. Si prefieres, apagas esa tarea y envía su enlace para que la persona elija la hora.",
      },
      {
        q: "¿Puedo cambiarle el nombre y el tono?",
        a: "Sí. Viene como Sofi, pero le pones el nombre que quieras y eliges el tono de tu clínica: cercano, neutro o formal, de tú o de usted.",
      },
      FAQ_ERROR,
    ],
  },

  asistenteClinico: {
    path: "/agentes/asistente-clinico",
    title: "Dictado de notas clínicas para odontólogos",
    description:
      "Dicta la consulta y Clío, tu agente clínico, propone la nota, el diagnóstico con su código, el plan y los controles. Nada entra a la historia clínica sin la confirmación del odontólogo.",
    crumb: "Clío",
    parent: AGENTS_PARENT,
    hero: {
      type: "scene",
      focus: "clinico",
      tag: "Clío, tu agente clínico",
      meaning: "La musa de la historia: escribe la historia clínica mientras el odontólogo atiende.",
      title: "Dictado de notas clínicas para odontólogos:",
      accent: "la historia se escribe sola.",
      accentColor: AGENT_COLORS.clinico.dark,
      lead: "Propone la nota, el diagnóstico con su código, el plan y los controles mientras atiendes. Nada entra a la historia sin tu confirmación.",
    },
    blocks: [
      {
        kind: "steps",
        tag: "Cómo funciona",
        title: "Tú atiendes y dictas. Clío ordena.",
        steps: [
          {
            title: "Dictas mientras atiendes",
            text: "Hablas como siempre, con tus palabras. No hace falta llenar casillas durante la consulta.",
          },
          {
            title: "Propone lo que va en la historia",
            text: "La nota de la consulta, el diagnóstico con su código, el plan con los tratamientos de tu tarifario y los controles.",
          },
          {
            title: "Tú confirmas, corriges o descartas",
            text: "Nada entra a la historia hasta que das el sí. Si descartas, no queda nada.",
          },
          {
            title: "Queda en la historia del paciente",
            text: "Firmada por ti, junto con el resto de sus atenciones, lista para la próxima consulta.",
          },
        ],
      },
      {
        kind: "sheet",
        tag: "Un ejemplo",
        title: "Sugerencias para la historia.",
        lead: "Las sugerencias se arman mientras la doctora habla. Nada entra en la historia hasta que ella las confirma, y el precio sale siempre de tu tarifario.",
        sheet: NOTE_CARLOS,
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "cards",
        tag: "Lo que no hace",
        title: "Ayuda a documentar. Decides tú.",
        items: [
          {
            agent: 1,
            title: "No escribe sin tu sí",
            text: "Todo lo que propone espera tu confirmación. Lo que no se confirma no entra a la historia ni se cobra.",
          },
          {
            agent: 1,
            title: "No inventa precios",
            text: "El plan usa los tratamientos y precios del tarifario de tu clínica.",
          },
          {
            agent: 1,
            title: "No marca el odontograma por voz",
            text: "El odontograma lo actualizas tú, en la misma ficha del paciente.",
          },
        ],
      },
    ],
    related: [
      "/historia-clinica-y-odontograma",
      "/presupuestos-dentales",
      "/agentes/administrador",
      "/seguridad",
      "/agentes",
      "/precios",
    ],
    faq: [
      {
        q: "¿Lo que dicto entra directo a la historia?",
        a: "No. Clío propone la nota, el diagnóstico, el plan y los controles, y nada entra a la historia hasta que el odontólogo lo confirma. También puede corregirlo o descartarlo.",
      },
      {
        q: "¿Qué códigos usa para el diagnóstico?",
        a: "Propone cada diagnóstico con su código de la clasificación internacional de enfermedades, por ejemplo K02.1, caries de la dentina. El odontólogo lo revisa antes de confirmarlo.",
      },
      {
        q: "¿Puedo dictar el odontograma?",
        a: "No. Clío documenta la consulta; el odontograma lo actualizas tú en la ficha del paciente.",
      },
      {
        q: "¿Quién puede ver la nota?",
        a: "Quienes tienen permiso para ver la historia clínica en tu clínica. Recepción y caja ven solo lo que necesitan para su trabajo.",
      },
    ],
  },

  administrador: {
    path: "/agentes/administrador",
    title: "Recordatorios de citas y pacientes que no vuelven",
    description:
      "Argos, tu agente administrador, recuerda cada cita, avisa a quien le toca su control, retoma los presupuestos sin respuesta y ofrece otra fecha a quien faltó, para que tus pacientes vuelvan.",
    crumb: "Argos",
    parent: AGENTS_PARENT,
    hero: {
      type: "scene",
      focus: "administrador",
      tag: "Argos, tu agente administrador",
      meaning: "El gigante de los cien ojos: ve toda la clínica y no deja a ningún paciente atrás.",
      title: "Recordatorios de citas y pacientes que vuelven:",
      accent: "nadie se olvida de su control.",
      accentColor: AGENT_COLORS.administrador.dark,
      lead: "Recuerda cada cita, avisa los controles, retoma los presupuestos y ofrece otra fecha a quien faltó. Si no puede escribirle a alguien, te deja la tarea con el motivo.",
    },
    blocks: [
      {
        kind: "cards",
        tag: "Qué hace",
        title: "Lo pendiente, sin listas ni llamadas de más.",
        items: [
          {
            agent: 2,
            title: "Recuerda cada cita",
            text: "Un día antes y tres horas antes, por el canal donde conversa con el paciente.",
          },
          {
            agent: 2,
            title: "Avisa los controles",
            text: "Encuentra a quien ya le toca su control y le escribe con su enlace para reservar.",
          },
          {
            agent: 2,
            title: "Retoma los presupuestos",
            text: "Pregunta por los presupuestos que quedaron sin respuesta.",
          },
          {
            agent: 2,
            title: "Ofrece otra fecha a quien faltó",
            text: "Si alguien no llegó a su cita, le escribe para reprogramarla.",
          },
          {
            agent: 2,
            title: "Deja tareas a tu equipo",
            text: "Si no puede escribirle a alguien, por ejemplo porque no tiene WhatsApp, le deja la tarea a recepción con el motivo.",
          },
        ],
      },
      {
        kind: "steps",
        tag: "Un ejemplo",
        title: "Rosa vuelve a su control.",
        steps: [
          {
            when: "Lunes",
            agent: 2,
            title: "Rosa Vega tiene su control de 6 meses vencido hace tres semanas.",
            text: "Argos lo encuentra solo, sin que nadie revise listas.",
          },
          {
            when: "Lunes · 16:05",
            agent: 2,
            title: "Le escribe por WhatsApp con su enlace para reservar.",
            text: "«Hola, Rosa, soy Sofi, de Clínica Sonrisa Norte. Ya te toca tu control. Puedes elegir el día aquí.»",
          },
          {
            when: "Lunes · 16:20",
            title: "Rosa elige el viernes 24 a las 11:00 desde su enlace.",
            text: "La cita aparece en la agenda de la clínica.",
          },
          {
            when: "Viernes · 11:00",
            title: "Rosa llega y la atienden.",
            text: "Recién ahora cuenta como cita recuperada.",
          },
        ],
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "split",
        tag: "Lo que cuenta",
        title: "Que Rosa volvió y la atendieron.",
        paragraphs: [
          "Recordar y avisar es parte del servicio. Lo que se mide es la cita a la que el paciente asistió.",
          "Cada tarea se prende o se apaga. Si apagas una, Argos no escribe y te deja la lista para que tu equipo decida.",
        ],
        points: [
          {
            agent: 2,
            title: "Recordar la cita",
            text: "Un día antes y tres horas antes. Viene prendido.",
          },
          {
            agent: 2,
            title: "Avisar los controles",
            text: "Escribe a quien ya le toca su control. Apagado: te deja la lista y tu equipo decide a quién llamar.",
          },
          {
            agent: 2,
            title: "Retomar los presupuestos",
            text: "Pregunta por los presupuestos que quedaron sin respuesta. Apagado: los presupuestos esperan a tu equipo.",
          },
        ],
      },
    ],
    related: [
      "/agenda-odontologica",
      "/presupuestos-dentales",
      "/portal-del-paciente",
      "/whatsapp-para-clinicas-dentales",
      "/agentes/recepcion",
      "/precios",
    ],
    faq: [
      {
        q: "¿Cuándo envía los recordatorios?",
        a: "Un día antes y tres horas antes de cada cita, por el canal donde conversa con el paciente.",
      },
      {
        q: "¿Qué pasa si un paciente no tiene WhatsApp?",
        a: "Si no puede escribirle por ningún canal, le deja la tarea a tu equipo con el motivo, por ejemplo: llamar a Pedro, que no tiene WhatsApp.",
      },
      {
        q: "¿Los recordatorios por WhatsApp tienen costo?",
        a: "odentIA no cobra los recordatorios. Si se envían por WhatsApp fuera de las 24 horas de la última conversación, son mensajes de plantilla y Meta se los cobra directamente a la clínica; odentIA te muestra el estimado.",
      },
      {
        q: "¿Escribe a todos mis pacientes?",
        a: "Solo lo que tú prendes: recordar citas, avisar controles o retomar presupuestos. Las promociones solo van a quien aceptó recibirlas.",
      },
    ],
  },

  // ——— Pilar omnicanal ———
  omnicanal: {
    path: "/omnicanal",
    title: "Software omnicanal para clínicas dentales",
    description:
      "Software omnicanal para clínicas: WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo llegan a la misma persona y a su única historia, sin fichas repetidas.",
    crumb: "Omnicanal",
    hero: {
      type: "scene",
      focus: "todos",
      tag: "Omnicanal",
      title: "Software omnicanal para clínicas:",
      accent: "todos tus canales, una sola persona.",
      lead: "WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo llegan a una sola ficha por persona. Si alguien cambia de canal, la conversación sigue donde iba y nadie tiene que repetir nada.",
    },
    blocks: [
      {
        kind: "chat",
        tag: "Omnicanal",
        title: "Una conversación que cambia de canal sin perder el hilo.",
        lead: "Lucía escribe por Instagram, su mamá sigue por WhatsApp y la confirmación llega por correo: una sola conversación y una sola ficha.",
        person: PERSON_LUCIA,
        messages: CHAT_LUCIA,
        summary: "Una persona · 3 canales · 1 historia",
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "cards",
        tag: "Los canales",
        title: "Por donde te escriben.",
        lead: "Los conectas una vez y llegan todos al mismo lugar, para tu equipo y para tus agentes.",
        items: [
          {
            title: "WhatsApp",
            text: "El número de tu clínica, conectado a través de Meta.",
            href: "/whatsapp-para-clinicas-dentales",
          },
          {
            title: "Instagram y Messenger",
            text: "Los mensajes directos de las cuentas de tu clínica.",
          },
          { title: "Telegram", text: "Para quienes prefieren escribir por ahí." },
          { title: "Chat de tu web", text: "Una ventana de chat en la web de tu clínica." },
          {
            title: "Correo",
            text: "Gmail y Microsoft 365, en la misma conversación que lo demás.",
          },
        ],
        note: "No atendemos llamadas ni SMS. [Por confirmar: cada canal, probado con su proveedor real antes de publicar]",
      },
      {
        kind: "cards",
        tag: "Una persona, no un número",
        title: "Quien escribe no siempre es el paciente.",
        lead: "Una mamá agenda por su hija, un esposo paga por los dos. odentIA distingue al paciente de quien conversa y de quien responde por él, sin crear fichas repetidas.",
        items: [
          {
            title: "Una sola ficha por persona",
            text: "Todos los canales llegan a la misma persona y a su única historia clínica.",
          },
          {
            title: "Paciente, interlocutor y responsable",
            text: "Lucía es la paciente; Carmen, su mamá, conversa, agenda y paga. Cada una en su lugar.",
          },
          {
            title: "Sin adivinar por el número",
            text: "Que un mensaje llegue desde un teléfono conocido no basta para dar datos de un paciente.",
          },
          {
            title: "Todo el equipo ve el mismo hilo",
            text: "Recepción retoma la conversación donde la dejó Sofi, sin preguntar de nuevo lo que ya se habló.",
          },
        ],
      },
      {
        kind: "split",
        tag: "Omnicanal y agéntica",
        title: "Lo que empieza en un canal termina en tu agenda y en la historia del paciente.",
        paragraphs: [
          "Juntar los canales en una bandeja es solo la mitad. En odentIA los agentes actúan, no solo conversan: agendan, documentan la consulta, recuerdan la cita y traen de vuelta a tus pacientes. Tu equipo decide qué puede hacer cada uno.",
        ],
        link: { href: "/agentes", label: "Conoce a los tres agentes" },
      },
    ],
    related: [
      "/whatsapp-para-clinicas-dentales",
      "/agentes/recepcion",
      "/agentes",
      "/portal-del-paciente",
      "/seguridad",
      "/precios",
    ],
    faq: [
      {
        q: "¿Qué significa omnicanal?",
        a: "Que atiendes por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, y todo queda en una sola ficha por persona.",
      },
      {
        q: "¿Qué pasa si un paciente me escribe por otro canal?",
        a: "La conversación sigue donde iba. Tu equipo y tus agentes ven todo lo que se habló, por cualquier canal, en la misma ficha.",
      },
      {
        q: "¿Qué pasa si una mamá escribe por su hijo?",
        a: "odentIA distingue al paciente de quien conversa y de quien responde por él. Todo queda en la ficha del paciente, sin crear otra persona.",
      },
      {
        q: "¿Atienden llamadas o SMS?",
        a: "No. odentIA atiende mensajes escritos: WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo.",
      },
      {
        q: "¿Puedo usar el WhatsApp que ya tiene mi clínica?",
        a: "Conectas el número de tu clínica a través de Meta. [Por confirmar: conexión con Meta probada]",
      },
    ],
  },

  whatsapp: {
    path: "/whatsapp-para-clinicas-dentales",
    title: "WhatsApp Business para clínica dental",
    description:
      "WhatsApp Business para tu clínica dental: conecta tu número y responde, agenda y recuerda citas desde la ficha de cada paciente. Responder dentro de 24 horas no tiene costo de Meta.",
    crumb: "WhatsApp para clínicas",
    parent: ["Omnicanal", "/omnicanal"],
    hero: {
      type: "visual",
      visual: "whatsapp",
      tag: "WhatsApp",
      title: "WhatsApp Business para tu clínica dental,",
      accent: "con tu número de siempre.",
      lead: "Conecta el número de tu clínica y atiende cada mensaje desde odentIA: Sofi, tu agente de recepción, contesta al momento, agenda con el sí del paciente y le pasa a tu equipo lo que necesita a una persona.",
      secondary: { href: "/agentes/recepcion", label: "Conoce a Sofi" },
    },
    blocks: [
      {
        kind: "steps",
        tag: "Cómo se conecta",
        title: "Tu número, en tres pasos.",
        steps: [
          {
            title: "Conectas el número de tu clínica",
            text: "Desde tu cuenta de Meta, con pasos guiados dentro de odentIA. [Por confirmar: conexión con Meta probada]",
          },
          {
            title: "Eliges qué hace Sofi",
            text: "Responder, agendar o solo avisarle a tu equipo. Cada tarea se prende o se apaga.",
          },
          {
            title: "Cada mensaje llega a la ficha de la persona",
            text: "Junto con lo que escribió por Instagram, el chat de tu web o el correo.",
          },
        ],
      },
      {
        kind: "cards",
        tag: "Lo que cobra Meta",
        title: "Qué cuesta WhatsApp, sin letra chica.",
        items: [
          {
            title: "Responder no tiene costo de Meta",
            text: "Responder a quien te escribe, dentro de las 24 horas, no tiene costo de Meta.",
          },
          {
            title: "Las plantillas las cobra Meta a la clínica",
            text: "Los mensajes de plantilla, como un recordatorio fuera de esa ventana, los cobra Meta directamente a la clínica. odentIA te muestra el estimado.",
          },
          {
            title: "Lo que cobra odentIA",
            text: "Pagas por el trabajo hecho, no por mensaje. Lo ves en la página de precios.",
            href: "/precios",
          },
        ],
      },
      {
        kind: "cards",
        tag: "Qué pasa en tu WhatsApp",
        title: "Lo que hacen tus agentes por WhatsApp.",
        items: [
          {
            agent: 0,
            title: "Responde y agenda",
            text: "Informa precios y horarios, y agenda, mueve o cancela citas con el sí del paciente.",
          },
          {
            agent: 2,
            title: "Recuerda y trae de vuelta",
            text: "Recuerda cada cita, avisa los controles y ofrece otra fecha a quien faltó.",
          },
          {
            agent: 0,
            title: "Envía Su enlace",
            text: "Para que el paciente elija la hora, cambie su cita o vea sus documentos.",
            href: "/portal-del-paciente",
          },
          {
            title: "Tu equipo, cuando hace falta",
            text: "Lo que necesita a una persona pasa a tu equipo, con un resumen de lo que se habló.",
          },
        ],
      },
    ],
    related: [
      "/omnicanal",
      "/agentes/recepcion",
      "/agentes/administrador",
      "/portal-del-paciente",
      "/precios",
    ],
    faq: [
      {
        q: "¿Puedo usar el número que ya tiene mi clínica?",
        a: "Sí, conectas el número de tu clínica a través de Meta, con pasos guiados dentro de odentIA. [Por confirmar: conexión con Meta probada]",
      },
      FAQ_META,
      {
        q: "¿Qué es la ventana de 24 horas?",
        a: "Es la regla de Meta: cuando un paciente te escribe, durante las 24 horas siguientes puedes responderle libremente. Fuera de esa ventana, el primer mensaje tiene que ser una plantilla aprobada por Meta.",
      },
      {
        q: "¿Mi equipo también puede responder?",
        a: "Sí. Tu equipo ve las conversaciones en la ficha de cada persona y responde desde ahí cuando hace falta.",
      },
    ],
  },

  // ——— El sistema ———
  agenda: {
    path: "/agenda-odontologica",
    title: "Agenda odontológica online para tu clínica",
    description:
      "Agenda odontológica online por sede, unidad dental y profesional. Tus pacientes reservan desde su enlace, Sofi agenda por cualquier canal y Argos recuerda cada cita.",
    crumb: "Agenda",
    hero: {
      type: "visual",
      visual: "agenda",
      tag: "Agenda",
      title: "Agenda odontológica online,",
      accent: "por sede, unidad dental y profesional.",
      lead: "Cada servicio con quien lo atiende y sus horarios. Tus pacientes reservan desde su enlace; Sofi, tu agente de recepción, agenda por cualquier canal, y Argos, tu agente administrador, recuerda cada cita.",
      secondary: { href: "/precios", label: "Ver los precios" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Qué resuelve",
        title: "Una agenda que se llena y se cuida sola.",
        items: [
          {
            title: "Por sede, unidad dental y profesional",
            text: "Cada sede con sus unidades dentales y cada profesional con sus horarios.",
          },
          {
            title: "Cada servicio, con quien lo atiende",
            text: "Solo se ofrecen los horarios libres de quien hace ese servicio.",
          },
          {
            agent: 0,
            title: "Sofi agenda por cualquier canal",
            text: "Agenda, mueve o cancela citas con el sí del paciente, también de noche.",
            href: "/agentes/recepcion",
          },
          {
            title: "Tus pacientes reservan solos",
            text: "Desde Su enlace eligen sede, día y hora, y pueden cambiar su cita.",
            href: "/portal-del-paciente",
          },
          {
            agent: 2,
            title: "Recordatorios incluidos",
            text: "Argos recuerda cada cita un día antes y tres horas antes.",
            href: "/agentes/administrador",
          },
          {
            agent: 2,
            title: "Quien faltó, con otra fecha",
            text: "Si alguien no llegó, le ofrece otra fecha para que no se pierda el tratamiento.",
          },
        ],
      },
      {
        kind: "steps",
        tag: "Un ejemplo",
        title: "Una cita, de la pregunta a la consulta.",
        steps: [
          {
            when: "Miércoles · 23:40",
            channel: "WhatsApp",
            agent: 0,
            title: "Andrea escribe con la clínica cerrada: quiere una evaluación.",
            text: "Sofi le ofrece el jueves a las 10:30 con la Dra. Paredes o a las 16:30 con el Dr. Ríos.",
          },
          {
            when: "Miércoles · 23:41",
            channel: "Agenda",
            agent: 0,
            title: "Andrea elige las 10:30 y la cita aparece en la agenda del jueves 22.",
            text: "Sin que nadie de tu equipo tenga que estar despierto.",
          },
          {
            when: "Jueves · 07:30",
            channel: "WhatsApp",
            agent: 2,
            title: "Tres horas antes, Argos le recuerda la cita.",
            text: "Si la hubiera reservado con más tiempo, también le escribiría un día antes.",
          },
          { when: "Jueves · 10:30", channel: "Consulta", title: "Andrea llega a su evaluación." },
        ],
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "split",
        tag: "Para quién",
        title: "Cada quien ve la agenda que necesita.",
        paragraphs: [
          "Recepción coordina el día de todas las unidades dentales; cada odontólogo ve sus pacientes y sus horarios. Si tienes varias sedes, cada una tiene su agenda y el paciente sigue siendo uno solo.",
        ],
        link: { href: "/varias-sedes", label: "Cómo funciona con varias sedes" },
      },
    ],
    related: [
      "/portal-del-paciente",
      "/agentes/recepcion",
      "/agentes/administrador",
      "/varias-sedes",
      "/historia-clinica-y-odontograma",
      "/precios",
    ],
    faq: [
      {
        q: "¿Puedo organizar la agenda por sede y por profesional?",
        a: "Sí. Cada sede tiene sus unidades dentales y cada profesional sus horarios y los servicios que atiende.",
      },
      {
        q: "¿Mis pacientes pueden reservar solos?",
        a: "Sí, desde Su enlace: eligen sede, día y hora, y después pueden cambiar o cancelar su cita sin llamar.",
      },
      {
        q: "¿Cómo se evita dar una hora que ya está ocupada?",
        a: "Sofi y Su enlace solo ofrecen los horarios libres de quien atiende ese servicio. Si alguien toma un horario un instante antes, se pide elegir otro.",
      },
      {
        q: "¿Se envían recordatorios de las citas?",
        a: "Sí. Argos recuerda cada cita un día antes y tres horas antes. Es una tarea que se puede apagar.",
      },
    ],
  },

  historia: {
    path: "/historia-clinica-y-odontograma",
    title: "Historia clínica dental y odontograma digital",
    description:
      "Historia clínica dental con odontograma digital en notación FDI, diagnósticos codificados y cada atención en orden. Clío, tu agente clínico, prepara la nota de tu dictado y tú la confirmas.",
    crumb: "Historia y odontograma",
    hero: {
      type: "visual",
      visual: "odontograma",
      tag: "Historia y odontograma",
      title: "Historia clínica dental y odontograma digital,",
      accent: "en una sola ficha.",
      lead: "Odontograma con la notación internacional FDI, diagnósticos codificados y cada atención en orden. Clío, tu agente clínico, prepara la nota a partir de tu dictado y tú la confirmas.",
      secondary: { href: "/agentes/asistente-clinico", label: "Conoce a Clío" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Qué incluye",
        title: "Todo lo clínico del paciente, en orden.",
        items: [
          {
            title: "Odontograma FDI",
            text: "Cada pieza con su número de la notación internacional de dos dígitos, la que usan los odontólogos en todo el mundo.",
          },
          {
            title: "Diagnósticos con su código",
            text: "Cada diagnóstico queda codificado, para que la historia se lea igual en cualquier sede.",
          },
          {
            title: "Cada atención, en orden",
            text: "La consulta, la evolución, el plan y los controles de cada visita.",
          },
          {
            title: "Recetas, órdenes y consentimientos",
            text: "Listos para imprimir y, los consentimientos, para que el paciente los lea y firme desde su enlace.",
          },
          {
            title: "Una historia por persona",
            text: "Aunque escriba por varios canales o se atienda en varias sedes, el paciente tiene una sola historia.",
          },
        ],
      },
      {
        kind: "sheet",
        tag: "Con Clío",
        title: "Dictas la consulta. Confirmas la nota.",
        lead: "Clío propone la nota, el diagnóstico con su código, el plan y los controles. Nada entra a la historia sin tu sí.",
        sheet: NOTE_CARLOS,
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "cards",
        tag: "Quién ve qué",
        title: "Lo clínico, solo para quien atiende.",
        items: [
          { title: "Odontólogos", text: "Atienden con la historia completa del paciente." },
          {
            title: "Recepción",
            text: "Coordina citas y conversaciones sin ver lo que no necesita.",
          },
          { title: "Caja", text: "Cobra con lo que necesita para cobrar, nada más." },
          {
            title: "Todo queda registrado",
            text: "Quién escribió o firmó cada cosa y cuándo, sea una persona o un agente.",
            href: "/seguridad",
          },
        ],
      },
    ],
    related: [
      "/agentes/asistente-clinico",
      "/presupuestos-dentales",
      "/agenda-odontologica",
      "/seguridad",
      "/portal-del-paciente",
      "/precios",
    ],
    faq: [
      {
        q: "¿Qué notación usa el odontograma?",
        a: "La notación FDI de dos dígitos (ISO 3950), la más usada en el mundo: el primer número es el cuadrante y el segundo, la pieza.",
      },
      {
        q: "¿Puedo dictar el odontograma?",
        a: "No. Clío documenta la consulta a partir de tu dictado; el odontograma lo actualizas tú en la ficha.",
      },
      {
        q: "¿Quién puede ver la historia clínica?",
        a: "Los clínicos con permiso en tu clínica. Recepción y caja ven solo lo que necesitan para su trabajo, y cada clínica está separada de las demás.",
      },
      {
        q: "¿Puedo imprimir el odontograma y los documentos?",
        a: "Sí: el odontograma, las recetas, las órdenes y los consentimientos tienen su versión para imprimir.",
      },
    ],
  },

  presupuestos: {
    path: "/presupuestos-dentales",
    title: "Cómo hacer presupuestos dentales claros",
    description:
      "Cómo hacer presupuestos dentales: arma el presupuesto desde el tarifario de tu clínica, ofrece hasta tres opciones y deja que Argos, el administrador, retome los que quedaron sin respuesta.",
    crumb: "Presupuestos",
    hero: {
      type: "visual",
      visual: "presupuestos",
      tag: "Presupuestos",
      title: "Cómo hacer presupuestos dentales:",
      accent: "claros, con hasta tres opciones.",
      lead: "Arma el presupuesto desde el tarifario de tu clínica, ofrece hasta tres opciones y deja que Argos, tu agente administrador, retome los que quedaron sin respuesta.",
      secondary: { href: "/agentes/administrador", label: "Conoce a Argos" },
    },
    blocks: [
      {
        kind: "steps",
        tag: "Paso a paso",
        title: "Del diagnóstico a la respuesta del paciente.",
        steps: [
          {
            title: "Partes del plan de tratamiento",
            text: "Lo que el odontólogo dejó en la historia es el punto de partida.",
          },
          {
            title: "Eliges los tratamientos del tarifario",
            text: "Los precios salen de tu tarifario: nadie los escribe a mano.",
          },
          {
            title: "Armas hasta tres opciones",
            text: "Por ejemplo, el tratamiento completo y otro por etapas, para que el paciente compare con calma.",
          },
          {
            title: "El paciente lo ve y responde desde Su enlace",
            text: "Sin imprimir ni escanear. Si lo pide por un canal, Sofi, tu agente de recepción, se lo reenvía.",
          },
          {
            agent: 2,
            title: "Si no responde, Argos lo retoma",
            text: "Pregunta por el presupuesto que quedó sin respuesta, sin que tu equipo lleve la cuenta.",
          },
        ],
      },
      {
        kind: "cards",
        tag: "Por qué ayudan",
        title: "Presupuestos que se entienden y no se olvidan.",
        items: [
          {
            title: "Opciones claras",
            text: "Hasta tres opciones, cada una con sus tratamientos, para que el paciente decida sin presión.",
          },
          {
            title: "Precios de tu tarifario",
            text: "Los agentes nunca inventan ni cambian un precio: usan el de tu clínica.",
          },
          {
            title: "Seguimiento sin listas",
            text: "Ves qué está aprobado y qué está por aceptar, y Argos retoma lo pendiente.",
          },
        ],
      },
    ],
    related: [
      "/agentes/administrador",
      "/historia-clinica-y-odontograma",
      "/portal-del-paciente",
      "/caja-y-cobros",
      "/agentes/recepcion",
      "/precios",
    ],
    faq: [
      {
        q: "¿Cuántas opciones puedo ofrecer en un presupuesto?",
        a: "Hasta tres, cada una con sus tratamientos y sus precios del tarifario.",
      },
      {
        q: "¿El paciente puede aceptarlo solo?",
        a: "Sí. Lo ve y lo responde desde Su enlace, sin tener que ir a la clínica.",
      },
      {
        q: "¿Qué pasa con los presupuestos que nadie responde?",
        a: "Argos pregunta por ellos. Si prefieres hacerlo tú, apagas esa tarea y los presupuestos esperan a tu equipo.",
      },
      {
        q: "¿De dónde salen los precios?",
        a: "Del tarifario de tu clínica. Ningún agente escribe ni cambia un precio.",
      },
    ],
  },

  caja: {
    path: "/caja-y-cobros",
    title: "Control de caja para clínica dental",
    description:
      "Control de caja para tu clínica dental: cobros, adelantos, gastos y movimientos de efectivo por sede, quién debe y desde cuándo, y el cierre de caja con su hoja para firmar.",
    crumb: "Caja y cobros",
    hero: {
      type: "visual",
      visual: "caja",
      tag: "Caja y cobros",
      title: "Control de caja para tu clínica dental,",
      accent: "sede por sede.",
      lead: "Registra cobros, adelantos y gastos, mira quién debe y desde cuándo, y cierra la caja de cada sede con su hoja para firmar la entrega.",
      secondary: { href: "/reportes", label: "Ver los reportes" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Qué controla",
        title: "Lo que entra, lo que sale y lo que falta cobrar.",
        items: [
          { title: "Una caja por sede", text: "Se abre sola con el primer cobro del día." },
          { title: "Cobros y adelantos", text: "Con los medios de pago que configura tu clínica." },
          {
            title: "Gastos y movimientos de efectivo",
            text: "Ingresos y retiros de efectivo, con su motivo.",
          },
          {
            title: "Quién debe y desde cuándo",
            text: "Las deudas ordenadas por antigüedad, para cobrar a tiempo.",
          },
          {
            title: "Saldos a favor y devoluciones",
            text: "Cada movimiento queda en la cuenta del paciente.",
          },
          { title: "Cierre de caja", text: "Al cerrar, imprimes la hoja para firmar la entrega." },
        ],
      },
      {
        kind: "steps",
        tag: "Un ejemplo",
        title: "Un día en la caja de la sede Norte.",
        steps: [
          {
            when: "08:40",
            title: "El primer cobro abre la caja.",
            text: "Nadie tiene que acordarse de abrirla.",
          },
          {
            when: "12:15",
            title: "Carmen paga un adelanto del tratamiento de Lucía.",
            text: "Queda en la cuenta de Lucía, con su medio de pago.",
          },
          {
            when: "15:00",
            title: "Se registra la compra de materiales como gasto.",
            text: "Con el tipo de gasto y en qué se gastó.",
          },
          {
            when: "19:30",
            title: "Cierre de caja.",
            text: "Se imprime la hoja para firmar la entrega del día.",
          },
        ],
        note: "Ejemplo con datos inventados.",
      },
      {
        kind: "split",
        tag: "Para quién",
        title: "Caja cobra. La dueña ve el mes.",
        paragraphs: [
          "Caja ve lo que necesita para cobrar, sin la historia clínica. Quien dirige la clínica ve cuánto entró, cuánto se gastó y cuánto falta cobrar, por sede o de todas juntas, en los reportes.",
          "Las anulaciones piden un motivo y todo queda registrado: quién hizo cada movimiento y cuándo.",
        ],
        link: { href: "/reportes", label: "Ver qué muestran los reportes" },
      },
    ],
    related: ["/reportes", "/presupuestos-dentales", "/varias-sedes", "/seguridad", "/precios"],
    faq: [
      {
        q: "¿Funciona si tengo varias sedes?",
        a: "Sí. Cada sede tiene su propia caja y su cierre, y en los reportes ves todas juntas o una por una.",
      },
      {
        q: "¿Puedo anular un gasto o un movimiento?",
        a: "Sí, siempre escribiendo el motivo. La anulación queda registrada con quién la hizo y cuándo.",
      },
      {
        q: "¿Emite facturas electrónicas?",
        a: "Todavía no. La facturación electrónica depende de cada país y la anunciaremos cuando esté lista para el tuyo.",
      },
      {
        q: "¿Quién puede ver la caja?",
        a: "Quien tiene ese permiso en tu clínica, como caja y la dirección. Caja no ve la historia clínica.",
      },
    ],
  },

  enlace: {
    path: "/portal-del-paciente",
    title: "Reserva de citas online para dentistas: Su enlace",
    description:
      "Reserva de citas online para dentistas: con Su enlace cada paciente reserva, cambia su cita, ve sus documentos y responde sus presupuestos desde el teléfono, sin llamar ni descargar nada.",
    crumb: "Su enlace",
    hero: {
      type: "visual",
      visual: "enlace",
      tag: "Su enlace",
      title: "Reserva de citas online para dentistas,",
      accent: "con Su enlace.",
      lead: "Cada paciente reserva, cambia su cita y ve sus documentos desde su propio enlace, sin tener que llamar.",
      secondary: { href: "/agenda-odontologica", label: "Ver la agenda" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Qué puede hacer cada paciente",
        title: "Lo que antes era una llamada, ahora es un toque.",
        items: [
          {
            title: "Reservar su cita",
            text: "Elige la sede, el día y la hora. Si es su primera cita, después de elegir le pedimos unos datos.",
          },
          { title: "Cambiar o cancelar", text: "Desde el mismo enlace, sin escribirle a nadie." },
          {
            title: "Ver sus documentos",
            text: "Lo que la clínica le autoriza a ver, en un solo lugar.",
          },
          {
            title: "Responder sus presupuestos",
            text: "Ve las opciones y responde cuando lo decide.",
            href: "/presupuestos-dentales",
          },
          {
            title: "Leer y firmar consentimientos",
            text: "Antes de la cita, con calma, desde su teléfono.",
          },
        ],
      },
      {
        kind: "steps",
        tag: "Cómo llega",
        title: "Un enlace propio, sin contraseñas.",
        steps: [
          {
            agent: 0,
            title: "Tus agentes se lo envían",
            text: "Por el canal donde ya conversan: Sofi, tu agente de recepción, cuando pide una cita, y Argos, tu agente administrador, cuando le toca su control.",
          },
          {
            title: "Lo abre en el navegador",
            text: "No tiene que descargar ninguna aplicación ni crear una contraseña.",
          },
          {
            title: "Puede guardar su acceso",
            text: "Para volver, entra con su huella o su cara, o pide un enlace nuevo.",
          },
        ],
      },
      {
        kind: "split",
        tag: "Tú decides",
        title: "Cada clínica decide qué ve cada paciente.",
        paragraphs: [
          "Desde recepción se le da acceso a sus citas, sus presupuestos o sus documentos. Si un enlace venció, el paciente responde el mensaje y recibe uno nuevo.",
        ],
        link: { href: "/seguridad", label: "Cómo cuidamos los datos" },
      },
    ],
    related: [
      "/agenda-odontologica",
      "/presupuestos-dentales",
      "/agentes/recepcion",
      "/agentes/administrador",
      "/precios",
    ],
    faq: [
      {
        q: "¿El paciente tiene que descargar una aplicación?",
        a: "No. Su enlace se abre en el navegador del teléfono o de la computadora.",
      },
      {
        q: "¿Necesita una contraseña?",
        a: "No. Entra desde el enlace que le envía la clínica y, si quiere, guarda su acceso con su huella o su cara.",
      },
      {
        q: "¿Puede reservar un paciente nuevo?",
        a: "Sí. Elige día y hora y, como es su primera cita, después le pedimos unos datos para reservar.",
      },
      {
        q: "¿Qué pasa si el horario se ocupa mientras elige?",
        a: "Se le avisa que ese horario acaba de ocuparse y elige otro de la lista.",
      },
    ],
  },

  reportes: {
    path: "/reportes",
    title: "Indicadores de una clínica dental, sin planillas",
    description:
      "Los indicadores de tu clínica dental en un lugar: cómo respondieron a quien escribió, citas atendidas, pacientes nuevos, lo que entró, se gastó y falta cobrar.",
    crumb: "Reportes",
    hero: {
      type: "visual",
      visual: "reportes",
      tag: "Reportes",
      title: "Los indicadores de tu clínica dental,",
      accent: "sin armar planillas.",
      lead: "Cómo respondieron a quien escribió, si los pacientes vinieron y quién los atendió, el trabajo nuevo que entró y cuánto entró, se gastó y falta cobrar.",
      secondary: { href: "/caja-y-cobros", label: "Ver la caja" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Qué muestran",
        title: "Las preguntas de siempre, respondidas con tus datos.",
        items: [
          {
            title: "Atención",
            text: "Cómo respondimos a quien escribió, y en cuánto tiempo llegó la primera respuesta.",
          },
          { title: "Citas", text: "Si los pacientes vinieron y quién los atendió." },
          {
            title: "Pacientes y ventas",
            text: "El trabajo nuevo que entró y el que se hizo, con los pacientes nuevos.",
          },
          {
            title: "Finanzas",
            text: "Cuánto entró, cuánto se gastó y cuánto falta cobrar.",
            href: "/caja-y-cobros",
          },
          {
            title: "Tus agentes",
            text: "Qué hizo cada agente, con quién y cuánto costó.",
            href: "/agentes",
          },
        ],
      },
      {
        kind: "split",
        tag: "Sin copiar nada",
        title: "Por periodo y por sede, con lo que ya está en el sistema.",
        paragraphs: [
          "La agenda, las conversaciones, la historia y la caja están en el mismo sistema, así que los reportes salen solos. Eliges el periodo y la sede, o miras todas juntas.",
          "Cada persona ve los reportes que su rol le permite.",
        ],
        link: { href: "/varias-sedes", label: "Cómo funciona con varias sedes" },
      },
    ],
    related: ["/caja-y-cobros", "/varias-sedes", "/agenda-odontologica", "/agentes", "/precios"],
    faq: [
      {
        q: "¿Tengo que cargar datos aparte para ver los reportes?",
        a: "No. Salen de lo que ya pasa en el sistema: la agenda, las conversaciones, la historia y la caja.",
      },
      { q: "¿Puedo ver una sede sola?", a: "Sí. Eliges la sede y el periodo, o ves todas juntas." },
      {
        q: "¿Puedo ver lo que hicieron los agentes?",
        a: "Sí. Queda registrado qué hizo cada agente, con quién y cuánto costó.",
      },
      {
        q: "¿Quién puede ver los reportes?",
        a: "Quien tiene ese permiso en tu clínica. Cada rol ve lo que necesita.",
      },
    ],
  },

  sedes: {
    path: "/varias-sedes",
    title: "Software para cadena de clínicas dentales",
    description:
      "Software para cadenas de clínicas dentales: cada sede con su agenda, sus unidades dentales y su caja; cada paciente con una sola historia en todas; y cada rol con lo que le toca ver.",
    crumb: "Varias sedes",
    hero: {
      type: "visual",
      visual: "sedes",
      tag: "Varias sedes",
      title: "Software para cadena de clínicas dentales:",
      accent: "varias sedes, un solo equipo.",
      lead: "Cada sede con su agenda, sus unidades dentales y su caja; cada paciente con una sola historia en todas; y cada rol con lo que le toca ver.",
      secondary: { href: "/precios", label: "Ver los precios" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Cómo se organiza",
        title: "Cada sede con lo suyo. El paciente, uno solo.",
        items: [
          {
            title: "Una agenda por sede",
            text: "Con sus unidades dentales, sus profesionales y sus horarios.",
            href: "/agenda-odontologica",
          },
          {
            title: "Una caja por sede",
            text: "Con su propio cierre, y todas juntas en los reportes.",
            href: "/caja-y-cobros",
          },
          {
            title: "Un paciente, una historia",
            text: "Si se atiende en otra sede, su historia va con él.",
          },
          {
            agent: 0,
            title: "Los agentes, en todas las sedes",
            text: "Sofi, tu agente de recepción, ofrece los horarios de la sede que le conviene al paciente.",
          },
          {
            title: "Reportes por sede o de todas",
            text: "Comparas las sedes con los mismos datos.",
            href: "/reportes",
          },
        ],
      },
      {
        kind: "cards",
        tag: "Roles",
        title: "Cada quien ve lo que le toca.",
        lead: "Recepción coordina, los odontólogos atienden con la historia y caja cobra. Cada rol ve solo lo que necesita.",
        items: [
          { title: "Recepción", text: "La agenda y las conversaciones." },
          { title: "Odontólogos", text: "Sus pacientes y la historia clínica." },
          { title: "Caja", text: "Los cobros, los gastos y el cierre." },
          { title: "Dirección", text: "Los reportes de todas las sedes y la configuración." },
        ],
      },
      {
        kind: "split",
        tag: "Sin cobrar por sede",
        title: "Crecer no cambia tu plan.",
        paragraphs: [
          "Todo el sistema incluido, sin límite de odontólogos, sedes ni usuarios. Pagas por el trabajo que hacen tus agentes, no por cuántas sedes tienes.",
        ],
        link: { href: "/precios", label: "Ver los precios" },
      },
    ],
    related: ["/agenda-odontologica", "/caja-y-cobros", "/reportes", "/seguridad", "/precios"],
    faq: [
      {
        q: "¿Cuesta más tener más sedes?",
        a: "No. El plan incluye todo el sistema, sin límite de odontólogos, sedes ni usuarios.",
      },
      {
        q: "¿Un paciente puede atenderse en dos sedes?",
        a: "Sí, y tiene una sola historia: lo que se hizo en una sede se ve en la otra.",
      },
      {
        q: "¿Puedo ver los reportes de todas las sedes juntas?",
        a: "Sí, o de una sola. Eliges la sede y el periodo.",
      },
      {
        q: "¿Cada persona ve todas las sedes?",
        a: "Cada persona ve lo que su rol le permite. [Por confirmar: limitar a una persona a ciertas sedes]",
      },
    ],
  },

  // ——— Confianza ———
  seguridad: {
    path: "/seguridad",
    title: "Seguridad y privacidad de los datos de tu clínica",
    description:
      "Cómo cuida odentIA los datos de tu clínica dental: cada clínica separada, roles para recepción, clínicos y caja, agentes que actúan dentro de lo que permites y todo registrado.",
    crumb: "Seguridad",
    hero: {
      type: "visual",
      visual: "seguridad",
      tag: "Seguridad",
      title: "Seguridad y privacidad:",
      accent: "tu clínica, tus datos, tus reglas.",
      lead: "Cada clínica está separada de las demás, cada rol ve solo lo suyo, tu equipo decide qué hacen los agentes y todo queda registrado.",
      secondary: { href: "/contacto", label: "Habla con nosotros" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "La confianza",
        title: "Tu clínica, tus datos, tus reglas.",
        items: [
          {
            title: "Cada quien ve lo suyo",
            text: "Recepción coordina, los odontólogos atienden con la historia y caja cobra. Cada rol ve solo lo que necesita.",
          },
          {
            title: "Tu clínica, separada",
            text: "Los datos de cada clínica están aislados de las demás, también para los agentes.",
          },
          {
            title: "Tu equipo decide",
            text: "Los agentes actúan dentro de lo que les permites y te pasan el caso cuando hace falta una persona.",
          },
          {
            title: "Todo queda registrado",
            text: "Quién hizo qué y cuándo, sea un agente o una persona de tu equipo.",
          },
        ],
      },
      {
        kind: "cards",
        tag: "Cómo usamos la IA",
        title: "La IA ayuda. Las personas deciden.",
        items: [
          {
            agent: 0,
            title: "Dice que es virtual",
            text: "Sofi, tu agente de recepción, siempre dice que es asistente virtual, con el nombre que tu clínica le ponga.",
          },
          {
            agent: 1,
            title: "Lo clínico lo confirma el odontólogo",
            text: "Ninguna nota, diagnóstico ni plan entra a la historia sin su sí.",
          },
          {
            agent: 2,
            title: "Solo lo que tú prendes",
            text: "Cada tarea de los agentes se prende o se apaga. Las promociones solo van a quien aceptó recibirlas.",
          },
          {
            title: "Un modelo que probamos",
            text: "ChatGPT 6, de OpenAI, con la cuenta de odentIA. No necesitas una cuenta propia ni una clave.",
          },
          {
            title: "Un tope de gasto",
            text: "Te avisamos antes de llegar y, al llegar, los casos nuevos pasan a tu equipo.",
          },
        ],
      },
      {
        kind: "split",
        tag: "Los textos legales",
        title: "Privacidad y encargo de tratamiento, en preparación.",
        paragraphs: [
          "Tu clínica es la responsable de los datos de sus pacientes y odentIA los trata por encargo suyo. Los textos de privacidad, encargo de tratamiento y subencargados los está redactando un abogado y se publican antes de abrir.",
        ],
        points: [
          {
            title: "Privacidad",
            text: "Qué datos guardamos, para qué y cómo pedir verlos, corregirlos o borrarlos.",
            href: "/privacidad",
          },
          {
            title: "Encargo de tratamiento",
            text: "La relación entre tu clínica y odentIA con los datos de tus pacientes.",
            href: "/encargo-de-tratamiento",
          },
          {
            title: "Subencargados",
            text: "Quién más trata los datos y para qué.",
            href: "/subencargados",
          },
        ],
      },
    ],
    related: [
      "/agentes",
      "/historia-clinica-y-odontograma",
      "/varias-sedes",
      "/contacto",
      "/precios",
    ],
    faq: [
      FAQ_TRAINING,
      {
        q: "¿Otra clínica puede ver mis datos?",
        a: "No. Los datos de cada clínica están aislados de las demás, también para los agentes.",
      },
      {
        q: "¿Recepción puede ver la historia clínica?",
        a: "Cada rol ve solo lo que necesita: recepción coordina citas y conversaciones, los clínicos atienden con la historia y caja cobra.",
      },
      {
        q: "¿Puedo saber qué hizo un agente?",
        a: "Sí. Todo queda registrado: quién hizo qué y cuándo, sea un agente o una persona de tu equipo.",
      },
      {
        q: "¿El asistente puede hacerse pasar por una persona?",
        a: "No. Siempre dice que es un asistente virtual y, cuando hace falta una persona, le pasa el caso a tu equipo.",
      },
    ],
  },

  contacto: {
    path: "/contacto",
    title: "Habla con nosotros",
    description:
      "¿Quieres saber si odentIA le sirve a tu clínica dental? Escríbenos y te responde una persona del equipo, o pruébalo 30 días sin tarjeta.",
    crumb: "Habla con nosotros",
    hero: {
      type: "visual",
      visual: "contacto",
      tag: "Contacto",
      title: "Habla con nosotros.",
      lead: "¿Quieres saber si odentIA le sirve a tu clínica o tienes una duda? Escríbenos y te responde una persona del equipo.",
      secondary: { href: `mailto:${contactEmail}`, label: `Escribe a ${contactEmail}` },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Por dónde seguir",
        title: "Elige lo que te queda más cómodo.",
        items: [
          {
            title: "Escríbenos",
            text: `A ${contactEmail}. Cuéntanos cuántas sedes tienes y por dónde te escriben tus pacientes.`,
            href: `mailto:${contactEmail}`,
            label: "Escribir un correo",
          },
          {
            title: "Pruébalo tú mismo",
            text: "Te registras, conectas tus canales y tus agentes trabajan con el crédito de prueba. Sin tarjeta.",
          },
          {
            title: "Mira cómo cobramos",
            text: "Un solo plan y pagas por el trabajo hecho.",
            href: "/precios",
            label: "Ver los precios",
          },
        ],
      },
    ],
    related: ["/agentes", "/omnicanal", "/seguridad", "/precios"],
    faq: [
      {
        q: "¿Necesito hablar con alguien para probarlo?",
        a: "No. Te registras y tus agentes trabajan con el crédito de prueba. La prueba no pide tarjeta.",
      },
      {
        q: "¿Me ayudan a conectar mis canales?",
        a: "Escríbenos y te contamos cómo. [Por confirmar: acompañamiento en la puesta en marcha]",
      },
      {
        q: "¿Funciona en mi país?",
        a: "odentIA está hecho para clínicas de habla hispana. La moneda, la zona horaria y los documentos se configuran por clínica.",
      },
    ],
    cta: {
      title: "¿Lo ves en tu clínica?",
      text: "Pruébalo 30 días: tus agentes trabajan en tu clínica desde el primer día, sin tarjeta.",
    },
  },
} satisfies Record<string, PageData>

/** Páginas legales que aún no tienen texto propio (la plantilla breve de LegalPage). Las que ya lo tienen
 * viven en src/lib/legal/. */
export type LegalPageData = { path: string; title: string; description: string; covers: string }

export const LEGAL = {
  libro: {
    path: "/pe/libro-de-reclamaciones",
    title: "Libro de reclamaciones",
    description: "Libro de reclamaciones de odentIA para Perú. Texto en preparación.",
    covers:
      "Solo para Perú: dónde dejar un reclamo o una queja. Un abogado confirma si aplica a un servicio entre empresas.",
  },
} satisfies Record<string, LegalPageData>
