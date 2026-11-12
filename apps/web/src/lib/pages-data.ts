// Contenido de las páginas interiores (agentes, omnicanal, sistema y confianza).
// Cada página atiende una búsqueda concreta: de ahí salen su título, su descripción y su h1.
// La documentación es privada, así que cada página explica sola qué hace esa parte y para quién.
// Sin cifras de precio: esas viven solo en el inicio y en /precios (src/lib/pricing.ts).
import type { FaqItem } from "./faq"
import { AGENT_COLORS } from "./site"

export type AgentIndex = 0 | 1 | 2
export type HeroVisualKind =
  | "agenda"
  | "caja"
  | "enlace"
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

/**
 * Una página con su propio diseño (paso 3 de la web): de aquí solo toma lo de buscadores, las migas y,
 * si las usa, sus preguntas y «Sigue por aquí». Su portada y sus secciones viven en su componente.
 */
export type OwnPageData = Pick<PageData, "path" | "title" | "description" | "crumb" | "parent"> & Partial<Pick<PageData, "faq" | "related">>

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
  "/radiografias-y-tomografia": {
    label: "Radiografías y tomografía",
    text: "Panorámica, cortes y medidas en la ficha, sin instalar nada.",
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
    text: "Cada paciente reserva y cambia su cita. En su portal ve sus documentos.",
  },
  "/reportes": { label: "Reportes", text: "Lo que pasa en tu clínica, sin armar planillas." },
  "/varias-sedes": {
    label: "Varias sedes",
    text: "Un equipo, varias sedes y cada rol con lo suyo.",
  },
  "/seguridad": { label: "Seguridad", text: "Roles, clínicas separadas y cómo usamos la IA." },
  "/precios": {
    label: "Precios",
    text: "Lo que cobra cada agente y lo que nunca se cobra. Pagas por el trabajo hecho.",
  },
  "/contacto": {
    label: "Habla con nosotros",
    text: "Escríbenos y te responde una persona del equipo.",
  },
}

// Ejemplos que se repiten (datos inventados, tomados del lienzo aprobado).
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
    title: "Le escribe a Carmen, y Lucía reserva su control y vuelve.",
  },
]
const FAQ_ERROR: FaqItem = {
  q: "¿Y si el agente no sabe qué responder o se equivoca?",
  a: "Si no sabe, le dice a la persona que alguien de tu equipo la va a atender y te deja el caso con todo lo que se habló. Todo lo que hace queda registrado, así que si se equivoca lo ves y lo corriges. Y nada clínico entra a la historia sin el sí del odontólogo.",
}
// Argos responde con las cifras oficiales de Reportes (ADR 0075 y 0078); cuántas preguntas trae el plan lo dice Precios.
const FAQ_ARGOS: FaqItem = {
  q: "¿Le puedo preguntar a Argos por las cifras de mi clínica?",
  a: "Sí. Escribes la pregunta en Reportes o en el buscador, por ejemplo «¿Qué se vendió más este mes?», y Argos responde con las mismas cifras de Reportes y te dice cómo lo calculó. Puedes fijar la respuesta en tu resumen o descargarla. Lo que no puede responder te lo dice y no cuenta.",
}
const FAQ_MODEL: FaqItem = {
  q: "¿Qué inteligencia artificial usa?",
  a: "ChatGPT 6, de OpenAI, con la cuenta de odentIA. No necesitas una cuenta propia ni una clave.",
}
const FAQ_TRAINING: FaqItem = {
  q: "¿Usan los datos de mi clínica para entrenar la IA?",
  a: "No. Los datos de tu clínica se usan solo para atender a tus pacientes. odentIA no los usa para entrenar modelos, y los proveedores de inteligencia artificial que usa por API tampoco: OpenAI, el de ChatGPT, y TypeSafe AI, cuyo modelo entiende qué pide cada mensaje.",
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
            text: "Contesta al momento por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo. Agenda, mueve o cancela citas siempre con el sí del paciente. Y aprende de tus correcciones: cada lección la aprueba quien dirige la clínica.",
            href: "/agentes/recepcion",
          },
          {
            agent: 1,
            title: "Tu agente clínico",
            label: "Prepara la nota mientras el odontólogo atiende. Solo falta su sí.",
            text: "Del dictado propone la nota, el odontograma, el diagnóstico con su código, el plan, la receta y los controles. Nada entra a la historia sin la confirmación del odontólogo.",
            href: "/agentes/asistente-clinico",
          },
          {
            agent: 2,
            title: "Tu agente administrador",
            label: "Recuerda citas y trae de vuelta a los pacientes.",
            text: "Recuerda cada cita, avisa los controles, retoma los presupuestos y ofrece otra fecha a quien faltó. Si no puede escribirle a alguien, le deja la tarea a tu equipo. Le pides con tus palabras lo que quieres que haga, y te responde lo que le preguntes con las cifras de tu clínica.",
            href: "/agentes/administrador",
          },
        ],
      },
      {
        kind: "steps",
        tag: "Un caso",
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
            title: "Pones un presupuesto del mes.",
            text: "Te avisamos antes de llegar y, al llegar, las conversaciones nuevas pasan a tu equipo.",
          },
          {
            title: "Todo queda a la vista.",
            text: "Qué hizo cada agente, con quién y cuánto costó.",
          },
        ],
      },
      // WebMCP (issue 88) se anuncia cuando funcione con un agente real, en su propia página.
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
      "Dicta la consulta y Clío, tu agente clínico, propone la nota, el odontograma, el diagnóstico con su código, el plan, la receta y los controles. Nada entra a la historia clínica sin la confirmación del odontólogo.",
    crumb: "Clío",
    parent: AGENTS_PARENT,
    faq: [
      {
        q: "¿Lo que dicto entra directo a la historia?",
        a: "No. Clío propone la nota, el odontograma, el diagnóstico, el plan, la receta y los controles, y nada entra a la historia hasta que el odontólogo lo confirma. También puede corregirlo o descartarlo.",
      },
      {
        q: "¿Qué códigos usa para el diagnóstico?",
        a: "Propone cada diagnóstico con su código de la clasificación internacional de enfermedades, por ejemplo K02.1, caries de la dentina. El odontólogo lo revisa antes de confirmarlo.",
      },
      {
        q: "¿Puedo dictar el odontograma?",
        a: "Sí. Lo que dices de una pieza (una caries, una pieza ausente, una corona) queda como sugerencia en el odontograma y entra cuando la confirmas. Los implantes, las endodoncias y la movilidad se siguen marcando en la pieza.",
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
    faq: [
      {
        q: "¿Cuándo envía los recordatorios?",
        a: "Un día antes y tres horas antes de cada cita, como viene, por el canal donde conversa con el paciente. Puedes poner de uno a tres avisos, entre una hora y una semana antes.",
      },
      {
        q: "¿Qué pasa si un paciente no tiene WhatsApp?",
        a: "Si no puede escribirle por ningún canal, le deja la tarea a tu equipo con el motivo, por ejemplo: llamar a Pedro, que no tiene WhatsApp.",
      },
      {
        q: "¿Los recordatorios por WhatsApp tienen costo?",
        a: "odentIA no cobra los recordatorios. Si salen por WhatsApp, Meta puede cobrarlos directamente a la clínica, con sus propias tarifas: lo revisas en tu cuenta de Meta.",
      },
      {
        q: "¿Escribe a todos mis pacientes?",
        a: "Solo lo que tú prendes: recordar citas, avisar controles o retomar presupuestos. Las promociones solo van a quien aceptó recibirlas.",
      },
      FAQ_ARGOS,
    ],
  },

  // ——— Pilar omnicanal ———
  omnicanal: {
    path: "/omnicanal",
    title: "Software omnicanal para clínicas dentales",
    description:
      "Software omnicanal para clínicas: WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo llegan a la misma persona y a su única historia, sin fichas repetidas.",
    crumb: "Omnicanal",
    related: [
      "/whatsapp-para-clinicas-dentales",
      "/agentes/recepcion",
      "/agentes",
      "/portal-del-paciente",
      "/seguridad",
      "/precios",
    ],
  },

  whatsapp: {
    path: "/whatsapp-para-clinicas-dentales",
    title: "WhatsApp Business para clínica dental",
    description:
      "WhatsApp Business para tu clínica dental: conecta tu número y responde, agenda y recuerda citas desde la ficha de cada paciente. Lo que cobra Meta lo revisas en tu cuenta de Meta.",
    crumb: "WhatsApp para clínicas",
    parent: ["Omnicanal", "/omnicanal"],
    related: [
      "/omnicanal",
      "/agentes/recepcion",
      "/agentes/administrador",
      "/portal-del-paciente",
      "/precios",
    ],
  },

  // ——— El sistema ———
  agenda: {
    path: "/agenda-odontologica",
    title: "Agenda odontológica online para tu clínica",
    description:
      "Agenda odontológica online por sede, unidad dental y profesional. Tus pacientes reservan desde su enlace, Sofi agenda por cualquier canal y Argos recuerda cada cita.",
    crumb: "Agenda",
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
        a: "Sí. Argos recuerda cada cita un día antes y tres horas antes, como viene, y tú cambias cuándo. Es la línea «Recordar la cita» y se puede apagar.",
      },
      {
        q: "¿Puedo ver mis citas en el calendario de mi celular?",
        a: "Sí, si atiendes pacientes. En la Agenda, «Mi calendario» te da un enlace solo tuyo para añadir tus citas a Google Calendar, Apple u Outlook. De cada cita se ve «Paciente» con sus iniciales, nunca el nombre, el servicio ni el motivo, y desde tu calendario no se mueve ni se reserva nada.",
      },
      {
        q: "¿Cómo sé quién ya llegó?",
        a: "Recepción marca «Llegó» y el odontólogo lo ve en su sala de espera, en Inicio: quién llegó, desde qué hora y cuánto lleva esperando. «Atender» abre la atención en un clic.",
      },
    ],
  },

  historia: {
    path: "/historia-clinica-y-odontograma",
    title: "Historia clínica electrónica dental y odontograma digital",
    description:
      "Historia clínica electrónica dental con odontograma digital en notación FDI, diagnósticos codificados, consentimientos con firma electrónica y cada atención en orden. Clío, tu agente clínico, prepara la nota de tu dictado y tú la confirmas.",
    crumb: "Historia y odontograma",
    faq: [
      {
        q: "¿Qué notación usa el odontograma?",
        a: "La notación FDI de dos dígitos (ISO 3950), la más usada en el mundo: el primer número es el cuadrante y el segundo, la pieza.",
      },
      {
        q: "¿Puedo dictar el odontograma?",
        a: "Sí. Lo que dices de una pieza (una caries, una pieza ausente, una corona) queda como sugerencia en el odontograma y entra cuando la confirmas. Los implantes, las endodoncias y la movilidad se siguen marcando en la pieza.",
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

  imagenes: {
    path: "/radiografias-y-tomografia",
    title: "Visor de radiografías y tomografía dental en el navegador",
    description:
      "Abre radiografías y tomografías (CBCT) en la ficha del paciente, sin instalar programas: panorámica y cortes, medidas, brillo y contraste, y cada imagen con su pieza y su fecha de toma.",
    crumb: "Radiografías y tomografía",
    parent: ["Historia y odontograma", "/historia-clinica-y-odontograma"],
    faq: [
      {
        q: "¿Qué archivos abre?",
        a: "Radiografías en JPG, PNG o DICOM y tomografías en DICOM: la carpeta del CD del centro de imágenes, un ZIP o los archivos sueltos, hasta 1,5 GB por estudio. Lee las compresiones JPEG, JPEG-LS, JPEG 2000 y RLE.",
      },
      {
        q: "¿Tengo que instalar un programa?",
        a: "No. La tomografía se arma en el navegador, en la ficha del paciente. Si quieres verla en el programa del equipo, «Descargar» te la da en un ZIP.",
      },
      {
        q: "¿Puedo planificar un implante con estas medidas?",
        a: "Las medidas son orientativas: sirven para conversar el caso y dejarlo anotado. Para planificar una cirugía, confírmalas en el programa del equipo de tomografía.",
      },
      {
        q: "¿Quién puede ver las imágenes?",
        a: "Quien atiende y tiene permiso clínico. Recepción puede subir la tomografía que trae el paciente y ver que llegó, sin abrirla.",
      },
      {
        q: "¿Se puede ver en el celular?",
        a: "Sí, para mirar. Medir y ajustar el arco se hace en una pantalla más grande.",
      },
    ],
  },

  presupuestos: {
    path: "/presupuestos-dentales",
    title: "Cómo hacer presupuestos dentales claros",
    description:
      "Cómo hacer presupuestos dentales: arma el presupuesto desde el tarifario de tu clínica, ofrece hasta tres opciones y deja que Argos, el administrador, retome los que quedaron sin respuesta.",
    crumb: "Presupuestos",
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
      "Control de caja para tu clínica dental: cobros, gastos y cierre de caja por sede, quién debe y desde cuándo, las comisiones de cada odontólogo y el inventario que se descuenta solo.",
    crumb: "Caja y cobros",
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
      {
        q: "¿Puedo cobrar en soles y en dólares?",
        a: "Sí. Activas la otra moneda en los datos de tu clínica y escribes el tipo de cambio de hoy. Lo que está en dólares se debe en dólares hasta que se paga, el paciente puede pagarlo en soles y cada moneda tiene su caja y su cierre.",
      },
      {
        q: "¿Calcula las comisiones de los odontólogos?",
        a: "Sí. Le pones a cada profesional su porcentaje de lo cobrado, o un monto fijo por un servicio, y cada mes ves su liquidación: cuánto falta pagar, cómo se calcula y cada cobro por fecha. Cada odontólogo ve solo lo suyo en «Mis honorarios».",
      },
      {
        q: "¿Lleva el inventario de materiales?",
        a: "Sí. Cada servicio dice qué materiales usa y se descuentan solos al firmar la atención, en la sede donde se atendió. También registras las compras, cuentas lo que hay a fin de mes y vendes productos desde el cobro.",
      },
    ],
  },

  enlace: {
    path: "/portal-del-paciente",
    title: "Reserva de citas online para dentistas: Su enlace",
    description:
      "Reserva de citas online para dentistas: con Su enlace cada paciente reserva, cambia su cita y responde su presupuesto desde el teléfono, sin llamar ni descargar nada. En su portal ve sus documentos.",
    crumb: "Su enlace",
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
      {
        q: "¿Su enlace y el portal son lo mismo?",
        a: "No. Su enlace lleva lo que tiene pendiente: su cita, sus datos, su presupuesto y lo que tiene por firmar, sin crear una cuenta. El portal es para ver todo lo suyo cuando quiera: el acceso se le da en la clínica, comprobando su documento, y no vence.",
      },
      {
        q: "¿Un paciente nuevo puede registrarse solo?",
        a: "Sí, con el enlace de tu clínica o el código QR de recepción. Tú eliges qué se le pregunta, dato por dato, y lo ve con tu logo y el color de tu marca.",
      },
    ],
  },

  reportes: {
    path: "/reportes",
    title: "Indicadores de una clínica dental, sin planillas",
    description:
      "Los indicadores de tu clínica dental en un lugar: cómo respondieron a quien escribió, citas atendidas, pacientes nuevos, lo que entró, se gastó y falta cobrar.",
    crumb: "Reportes",
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
      FAQ_ARGOS,
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
        a: "Cada persona ve lo que su rol le permite: recepción coordina, los odontólogos atienden con la historia y caja cobra.",
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
      "¿Quieres saber si odentIA le sirve a tu clínica dental? Escríbenos y te responde una persona del equipo, o pruébalo sin tarjeta.",
    crumb: "Habla con nosotros",
  },
} satisfies Record<string, PageData | OwnPageData>
