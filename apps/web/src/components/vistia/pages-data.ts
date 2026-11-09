// Las páginas interiores de vistIA: lo de buscadores, la portada, las secciones (los mismos bloques de
// las páginas interiores de odentIA, `ContentBlock`), los enlaces y las preguntas. Solo lo que vistIA
// hace hoy: agenda, conversaciones con Sofi, la ficha con su historia clínica, caja e inventario,
// reportes con Argos, Su enlace y varias sedes. Clío no trabaja en una óptica y no se nombra como algo
// que hace. Lo que llega en otras entregas (el examen de la vista en pantalla, la receta de lentes, el
// pedido al taller y su aviso) no se anuncia. Sin cifras de precio: esas viven en /precios.
// Los ejemplos son de la Óptica Lucero, una óptica inventada (como la Clínica Sonrisa Norte de odentIA).
import type { FaqItem } from "../../lib/faq"
import type { Block } from "../../lib/pages-data"

/** Los agentes de vistIA en los bloques: Sofi (0) y Argos (2), con los índices de `AGENT_NAMES`. */
const SOFI = 0
const ARGOS = 2

export type VistiaVisualKind = "agentes" | "sofi" | "argos" | "agenda" | "ficha" | "omnicanal" | "caja" | "enlace" | "reportes" | "seguridad"

export interface VistiaPageData {
  path: string
  /** Título de la pestaña y de Google (sin « · vistIA», que agrega Base). */
  title: string
  description: string
  crumb: string
  parent?: [string, string]
  hero: {
    tag: string
    title: string
    accent: string
    lead: string
    visual: VistiaVisualKind
    secondary?: { href: string; label: string }
  }
  blocks: Block[]
  /** Un bloque al que lleva un enlace de la portada («#dia»). */
  anchor?: { block: number; id: string }
  related: string[]
  faq: FaqItem[]
  cta: { title: string; text: string }
}

/** «Sigue por aquí»: lo que dice el enlace a cada página de vistIA. */
export const VISTIA_LINKS: Record<string, { label: string; text: string }> = {
  "/agentes": { label: "Los dos agentes", text: "Sofi en la recepción y Argos en lo pendiente, sobre la misma ficha." },
  "/agentes/recepcion": { label: "Sofi, tu agente de recepción", text: "Responde y agenda por todos tus canales, de día y de noche." },
  "/agentes/administrador": { label: "Argos, tu agente administrador", text: "Recuerda citas, invita al control y responde tus cifras." },
  "/omnicanal": { label: "Omnicanal y WhatsApp", text: "Todos tus canales llegan a la misma persona y a su única ficha." },
  "/agenda-para-opticas": { label: "Agenda y controles", text: "Por sede, sala de examen y optómetra, con recordatorios." },
  "/historia-clinica-electronica": { label: "Ficha e historia clínica", text: "Antecedentes, diagnósticos, consentimientos y pruebas del ojo." },
  "/caja-y-cobros": { label: "Caja, inventario y sedes", text: "Cobros, lo que vendes con su stock y el cierre de cada sede." },
  "/portal-del-cliente": { label: "Su enlace", text: "Tu cliente ve su cita, la cambia y ve sus documentos." },
  "/reportes": { label: "Reportes con Argos", text: "Lo que pasa en tu óptica, sin armar planillas." },
  "/buscador": { label: "Buscador", text: "Escribe un nombre o lo que buscas y llegas en un toque." },
  "/seguridad": { label: "Seguridad", text: "Cada rol ve solo lo suyo y tu óptica, aparte de las demás." },
  "/precios": { label: "Precios", text: "Pagas por el trabajo hecho, no por el software." },
  "/contacto": { label: "Habla con nosotros", text: "Escríbenos y te responde una persona del equipo." },
}

/** Lo que pasa cuando alguien escribe: lo mismo en varias páginas. */
const CHAT_ROSA = {
  person: {
    initials: "RP",
    name: "Rosa Paredes",
    sub: "Cliente · escribe un viernes de noche",
    text: "Ve borroso de lejos y quiere medirse la vista. Escribe por WhatsApp fuera de horario; la cita queda en la agenda de la optómetra sin que nadie del equipo la tome.",
  },
  messages: [
    { ch: "WhatsApp", who: "Rosa", side: "in" as const, text: "Hola, ¿atienden el sábado? Veo borroso de lejos y quiero medirme la vista." },
    {
      ch: "WhatsApp",
      who: "Sofi",
      side: "out" as const,
      text: "Hola, Rosa. Soy Sofi, asistente virtual de Óptica Lucero. El sábado tengo a las 10:00 o a las 11:30 con Andrea Quispe, en Lucero Centro. ¿Cuál te acomoda?",
    },
    { ch: "WhatsApp", who: "Rosa", side: "in" as const, text: "A las 10, porfa." },
    {
      ch: "WhatsApp",
      who: "Sofi",
      side: "out" as const,
      text: "Listo, Rosa: examen de la vista el sábado a las 10:00 con Andrea Quispe. Te lo recuerdo un día antes.",
    },
  ],
}

export const VISTIA_PAGES = {
  agentes: {
    path: "/agentes",
    title: "Agentes de IA para ópticas: Sofi en la recepción y Argos en la administración",
    description:
      "Dos agentes de IA para tu óptica: Sofi responde por WhatsApp, Instagram y más canales y agenda el examen de la vista; Argos recuerda citas, invita al control y responde las cifras de tu óptica.",
    crumb: "Agentes",
    hero: {
      tag: "Agentes",
      title: "Dos agentes que hacen el trabajo.",
      accent: "Tú decides hasta dónde.",
      lead: "Sofi atiende a quien escribe, por cualquier canal y a cualquier hora. Argos se ocupa de lo pendiente: recordar la cita, invitar al control y traer de vuelta a quien faltó. Todo queda en la ficha de cada cliente.",
      visual: "agentes",
      secondary: { href: "#dia", label: "Ver un día en la óptica" },
    },
    anchor: { block: 1, id: "dia" },
    blocks: [
      {
        kind: "cards",
        tag: "Los dos",
        title: "Uno en la recepción y otro en la administración.",
        lead: "No conversan por conversar: hacen el trabajo, dentro de lo que tú les permites.",
        items: [
          {
            agent: SOFI,
            title: "Sofi · recepción",
            text: "Responde por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo. Informa servicios y precios, ofrece los horarios libres y agenda con el sí de la persona.",
            href: "/agentes/recepcion",
          },
          {
            agent: ARGOS,
            title: "Argos · administración",
            text: "Recuerda las citas, ofrece otro horario a quien faltó, invita al control que toca y responde lo que le preguntes de tu óptica, con las cifras de Reportes.",
            href: "/agentes/administrador",
          },
        ],
      },
      {
        kind: "steps",
        tag: "Un día en la óptica",
        title: "De la primera pregunta al control del año siguiente.",
        lead: "Tu equipo hace lo que le toca: examinar, vender y cobrar. Lo demás lo llevan los agentes, y todo queda en la ficha de Rosa.",
        steps: [
          { when: "Viernes · 23:41", channel: "WhatsApp", title: "Rosa pregunta si atienden el sábado.", text: "Sofi le ofrece los horarios libres de la optómetra y la agenda con su sí.", agent: SOFI },
          { when: "Viernes · 23:42", title: "La cita queda en la agenda.", text: "Con la optómetra, la sala de examen y la sede. Recepción la ve el sábado al llegar." },
          { when: "Sábado · 10:00", title: "Andrea Quispe la examina.", text: "Lo que encuentra queda en la historia clínica de Rosa." },
          { when: "Sábado · 10:40", channel: "Caja", title: "Rosa elige su montura y paga.", text: "Caja cobra el examen y la montura; la montura sale del stock de Lucero Centro." },
          { when: "Un año después", channel: "WhatsApp", title: "Argos la invita a su control anual de la vista.", text: "Si responde que sí, Sofi le agenda la hora.", agent: ARGOS },
        ],
        note: "Un día de ejemplo.",
      },
      {
        kind: "split",
        tag: "Tú decides",
        title: "Lo que hace cada agente, lo prendes o lo apagas.",
        paragraphs: [
          "Cada agente hace solo lo que le permites. Si apagas «Agendar citas», Sofi envía el enlace para que la persona elija la hora; si apagas «Avisar los controles», Argos te deja la lista y tu equipo decide a quién escribir.",
          "Tu equipo siempre puede tomar una conversación: Sofi espera y le deja un resumen de lo que se habló.",
        ],
        points: [
          { title: "Sofi dice que es asistente virtual", text: "Nunca se hace pasar por una persona del equipo.", agent: SOFI },
          { title: "Argos responde con tus cifras", text: "Las mismas de Reportes, y te dice cómo las calculó.", agent: ARGOS },
          { title: "Todo queda registrado", text: "Qué hizo cada agente, a quién y cuándo, en la ficha de cada persona." },
        ],
      },
    ],
    related: ["/agentes/recepcion", "/agentes/administrador", "/omnicanal", "/precios"],
    faq: [
      {
        q: "¿Por qué dos agentes?",
        a: "Porque en vistIA no trabaja Clío, el agente que escucha la consulta y la ordena. En una óptica la medida de la vista la escribe quien examina: un número mal oído son unos lentes mal hechos.",
      },
      {
        q: "¿Los agentes ven la historia clínica?",
        a: "Sofi no: ve la agenda, los servicios y precios, el conocimiento de tu óptica y los datos de contacto de la persona. Argos responde cifras sin que el modelo vea los nombres de tus clientes.",
      },
      {
        q: "¿Y si el agente no sabe qué responder?",
        a: "Le dice a la persona que alguien de tu equipo la va a atender y te deja el caso con todo lo que se habló.",
      },
      {
        q: "¿Cómo se cobra lo que hacen?",
        a: "Por el trabajo hecho: cada cosa que hace un agente tiene su precio y la ves en tu cuenta, fila por fila. Recordar una cita no se cobra. Los precios están en la página Precios.",
      },
    ],
    cta: { title: "Tus agentes, desde el primer día.", text: "Sofi atiende y Argos cuida lo pendiente. Tú decides qué hace cada uno." },
  },

  recepcion: {
    path: "/agentes/recepcion",
    title: "Sofi, agente de IA de recepción para ópticas: responde y agenda por WhatsApp",
    description:
      "Sofi es el agente de recepción de vistIA: responde a tus clientes por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, a cualquier hora, y les agenda el examen de la vista con su sí.",
    crumb: "Sofi",
    parent: ["Agentes", "/agentes"],
    hero: {
      tag: "Sofi · recepción",
      title: "Sofi responde a tus clientes",
      accent: "y les agenda el examen.",
      lead: "Por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, de día y de noche. Informa tus servicios y precios, ofrece los horarios libres y agenda con el sí de la persona.",
      visual: "sofi",
    },
    blocks: [
      { kind: "chat", tag: "Una conversación", title: "Un viernes a las 23:41, la cita ya está hecha.", ...CHAT_ROSA, summary: "Agendó Sofi · viernes 23:41", note: "Ejemplo. Sofi usa los horarios, los servicios y los precios de tu óptica." },
      {
        kind: "cards",
        tag: "Lo que hace hoy",
        title: "Lo que tu recepción hace todo el día, también de noche.",
        items: [
          { title: "Responde a cualquier hora", text: "En todos tus canales, con lo que tu óptica le enseñó: servicios, precios, horarios, dirección y medios de pago." },
          { title: "Agenda con el sí de la persona", text: "Ofrece los horarios libres de cada optómetra y sala de examen. También mueve o cancela una cita." },
          { title: "Sabe quién le escribe", text: "Escriba por donde escriba, la conversación llega a la ficha de la persona. Nunca la reconoce solo por su teléfono." },
          { title: "Una urgencia de la vista no espera", text: "Si alguien cuenta que dejó de ver de golpe o que le cayó un químico en el ojo, Sofi le dice a dónde acudir y el caso pasa a tu equipo con prioridad." },
          { title: "Tu equipo toma la palabra", text: "Cualquiera del equipo puede escribir en la conversación. Sofi espera y le deja un resumen." },
          { title: "Dice que es asistente virtual", text: "Se presenta como la asistente virtual de tu óptica. Nunca se hace pasar por una persona." },
        ],
      },
      {
        kind: "split",
        tag: "Lo que no ve",
        title: "Sofi agenda sin ver la historia clínica.",
        paragraphs: [
          "Sofi ve lo que necesita para atender: la agenda, tus servicios y precios, los medios de pago, el conocimiento de tu óptica y los datos de contacto de la persona.",
          "No ve la historia clínica, ni los diagnósticos, ni la medida de la vista, ni la caja.",
        ],
        link: { href: "/seguridad", label: "Cómo protegemos tus datos" },
      },
    ],
    related: ["/omnicanal", "/agenda-para-opticas", "/agentes/administrador", "/precios"],
    faq: [
      { q: "¿Sofi dice que es un agente?", a: "Sí. Se presenta como la asistente virtual de tu óptica y nunca se hace pasar por una persona del equipo." },
      {
        q: "¿Y si no sabe qué responder?",
        a: "Le dice a la persona que alguien de tu equipo la va a atender y te deja el caso con todo lo que se habló. Lo que hace queda registrado.",
      },
      { q: "¿Puede agendar para otra persona?", a: "Sí. Si una mamá escribe para agendar a su hijo, la cita es del hijo y la conversación sigue con la mamá. Cada uno con su ficha." },
      { q: "¿Cuánto cobra Sofi?", a: "Una vez por conversación, según lo que hizo: responder, reservar, o que la persona vino a su cita. Los precios están en la página Precios." },
    ],
    cta: { title: "Que nadie se quede sin respuesta.", text: "Sofi atiende tus canales de día y de noche, con los horarios de tu óptica." },
  },

  administrador: {
    path: "/agentes/administrador",
    title: "Argos, agente de IA administrador para ópticas: recordatorios, controles y reportes",
    description:
      "Argos es el agente administrador de vistIA: recuerda las citas, ofrece otro horario a quien faltó, invita al control anual de la vista y responde lo que le preguntes de tu óptica con las cifras de Reportes.",
    crumb: "Argos",
    parent: ["Agentes", "/agentes"],
    hero: {
      tag: "Argos · administración",
      title: "Argos cuida lo pendiente",
      accent: "y te dice cómo va tu óptica.",
      lead: "Recuerda las citas, ofrece otro horario a quien faltó e invita al control que toca. Y en Reportes responde lo que le preguntes, con las cifras de tu óptica.",
      visual: "argos",
    },
    blocks: [
      {
        kind: "log",
        tag: "Lo que hace solo",
        title: "Lo que nadie tiene tiempo de hacer, hecho.",
        lead: "Cada mensaje sale por el canal de la persona y queda en su ficha.",
        entries: [
          { t: "09:00", agent: ARGOS, verb: "Recordó", obj: "a Julia su control de lentes de contacto de mañana", where: "WhatsApp" },
          { t: "10:30", agent: ARGOS, verb: "Invitó", obj: "a Miguel a su control anual de la vista", where: "WhatsApp" },
          { t: "12:10", agent: ARGOS, verb: "Ofreció otro horario", obj: "a Pedro, que faltó el martes", where: "WhatsApp" },
          { t: "17:00", agent: ARGOS, verb: "Recuperó", obj: "la cita de Pedro: vino y lo atendieron", where: "Agenda" },
        ],
        note: "Registro de ejemplo.",
      },
      {
        kind: "cards",
        tag: "Pregúntale",
        title: "Lo que quieras saber de tu óptica, en una pregunta.",
        lead: "Escribes la pregunta en Reportes o en el buscador y Argos responde con las mismas cifras de Reportes. Te dice cómo lo calculó; lo que no puede responder te lo dice y no cuenta.",
        items: [
          { title: "«¿Cuántos exámenes de la vista cobramos en octubre?»", text: "Con lo cobrado, comparado con septiembre." },
          { title: "«¿Qué se vendió más este mes?»", text: "Los servicios y productos que más se cobraron." },
          { title: "«¿Quién me debe?»", text: "Cuánto te deben y desde cuándo, persona por persona." },
        ],
        note: "Puedes fijar una respuesta en tu resumen o descargarla.",
      },
      {
        kind: "split",
        tag: "Tú decides",
        title: "Cada cosa que hace Argos, la prendes o la apagas.",
        paragraphs: [
          "Si apagas algo, Argos te deja la lista y tu equipo decide a quién escribir. Responde cifras sin que el modelo vea los nombres de tus clientes.",
        ],
        points: [
          { title: "Recordar las citas", text: "Un día antes, por el canal de la persona. No se cobra.", agent: ARGOS },
          { title: "Ofrecer otro horario a quien faltó", text: "Si reserva y viene, es una cita recuperada.", agent: ARGOS },
          { title: "Avisar los controles", text: "El control anual de la vista o el de los lentes de contacto, a tiempo.", agent: ARGOS },
          { title: "Invitar a volver", text: "A quien lleva tiempo sin venir. Si no puede escribirle, te deja una tarea de llamada.", agent: ARGOS },
        ],
      },
    ],
    related: ["/reportes", "/agenda-para-opticas", "/agentes/recepcion", "/precios"],
    faq: [
      { q: "¿Cuánto cobra Argos?", a: "Recordar no se cobra. Se cobra la cita recuperada: cuando vuelve quien no tenía cita y viene. Sus preguntas, según tu plan. Los precios están en la página Precios." },
      { q: "¿Argos ve los nombres de mis clientes?", a: "El modelo no: responde con las cifras de Reportes sin ver quién es quién. Las listas con nombres las ves tú, en la aplicación." },
      { q: "¿Y si no quiero que escriba a alguien?", a: "Apagas lo que no quieras y te deja la lista. Y quien pidió no recibir mensajes no los recibe; los avisos de su cita, sí." },
    ],
    cta: { title: "Lo pendiente, al día.", text: "Argos recuerda, invita al control y te dice cómo va tu óptica." },
  },

  agenda: {
    path: "/agenda-para-opticas",
    title: "Agenda para ópticas: citas por optómetra y sala de examen, con recordatorios",
    description:
      "Agenda para ópticas con vistIA: cada cita con su optómetra, su sala de examen y su sede; Sofi agenda por WhatsApp y tus demás canales, Argos recuerda la cita y el control anual de la vista se repite solo.",
    crumb: "Agenda",
    hero: {
      tag: "Agenda",
      title: "La agenda de tu óptica,",
      accent: "llena y al día.",
      lead: "Cada cita con su optómetra, su sala de examen y su sede. Sofi agenda por tus canales, Argos recuerda la cita y el control que se repite vuelve solo a la agenda.",
      visual: "agenda",
    },
    blocks: [
      {
        kind: "cards",
        tag: "Lo que trae",
        title: "Lo que necesita una óptica para no perder citas.",
        items: [
          { title: "Por optómetra y sala de examen", text: "Cada cita con quién atiende, dónde y en qué sede. Los horarios libres salen de la agenda de cada uno." },
          { title: "Sofi agenda", text: "Por WhatsApp y tus demás canales, a cualquier hora, con el sí de la persona.", agent: SOFI },
          { title: "Argos recuerda", text: "La cita de mañana, por el canal de la persona. Recordar no se cobra.", agent: ARGOS },
          { title: "Controles que se repiten", text: "El control anual de la vista o el de los lentes de contacto: cada 1, 3, 6 o 12 meses, hasta «Dejar de repetir»." },
          { title: "Tu cliente la cambia", text: "Desde su enlace, en los horarios libres. El que deja se libera para otro.", href: "/portal-del-cliente", label: "Ver Su enlace" },
          { title: "Varias sedes", text: "Cada sede con su agenda y su horario; tú las ves juntas o una por una." },
        ],
      },
      {
        kind: "steps",
        tag: "Si alguien falta",
        title: "Una cita perdida no se queda así.",
        steps: [
          { when: "Martes · 16:00", title: "Pedro no vino a su examen.", text: "Recepción la marca como «No vino»." },
          { when: "Miércoles · 12:10", channel: "WhatsApp", title: "Argos le ofrece otro horario.", text: "Con los horarios libres de la semana.", agent: ARGOS },
          { when: "Jueves · 17:00", title: "Pedro viene.", text: "Es una cita recuperada, y así se cuenta en Reportes." },
        ],
      },
    ],
    related: ["/agentes/recepcion", "/agentes/administrador", "/portal-del-cliente", "/historia-clinica-electronica"],
    faq: [
      { q: "¿Puedo tener varias salas de examen?", a: "Sí, y varias sedes. Cada cita va con su optómetra, su sala de examen y su sede." },
      { q: "¿Los recordatorios se cobran?", a: "No. Los recordatorios y los avisos de cita no se cobran." },
      { q: "¿Qué pasa si Sofi no puede agendar?", a: "Si apagas «Agendar citas», Sofi envía el enlace para que la persona elija la hora. Y tu equipo siempre puede tomar la conversación." },
    ],
    cta: { title: "Tu agenda, llena y al día.", text: "Sofi agenda, Argos recuerda y el control anual vuelve solo." },
  },

  historia: {
    path: "/historia-clinica-electronica",
    title: "Historia clínica para ópticas: la ficha de cada cliente, con sus pruebas del ojo",
    description:
      "Historia clínica electrónica para ópticas con vistIA: la ficha de cada cliente con sus conversaciones y citas, antecedentes y alergias, diagnósticos con CIE-10 o CIE-11, consentimientos y las pruebas del ojo con su informe.",
    crumb: "Ficha e historia clínica",
    hero: {
      tag: "Ficha e historia clínica",
      title: "Cada cliente, una sola ficha",
      accent: "con toda su historia.",
      lead: "Sus datos, sus conversaciones, sus citas y su historia clínica en el mismo lugar: antecedentes, alergias, diagnósticos, consentimientos y las pruebas del ojo con su informe.",
      visual: "ficha",
    },
    blocks: [
      {
        kind: "cards",
        tag: "Lo que guarda",
        title: "Lo de la vista, a mano en la ficha.",
        items: [
          { title: "Antecedentes y alergias", text: "Lo que cuenta la persona y lo que confirma quien la atiende, cada cosa con quién la registró." },
          { title: "Diagnósticos, lo del ojo primero", text: "Escribes «miopía» o «conjuntivitis» y sale primero lo del ojo, con la CIE-10 o la CIE-11 según tu país." },
          { title: "Pruebas del ojo", text: "Retinografía, topografía corneal, OCT, campo visual y fotos del ojo, con su informe, en su ficha." },
          { title: "Consentimientos para revisar", text: "Como la dilatación de las pupilas: vienen sugeridos y tu óptica los lee y los ajusta a lo que hace." },
          { title: "Controles", text: "El control anual de la vista y el de adaptación de los lentes de contacto, en la agenda." },
          { title: "Firmada no se cambia", text: "Al firmar, la atención queda fija. Si algo cambia, se agrega una adenda con el nombre y la hora." },
        ],
      },
      {
        kind: "split",
        tag: "Una sola persona",
        title: "Cliente en la caja, paciente en el examen. La misma ficha.",
        paragraphs: [
          "En la óptica se habla de clientes, y cuando alguien se examina tiene su historia clínica. Es la misma persona y la misma ficha: nunca dos.",
          "Si una mamá agenda por su hijo, la cita y la historia son del hijo y la conversación es con la mamá. Cada uno con lo suyo.",
        ],
        points: [
          { title: "Recepción", text: "Agenda y conversa sin ver la historia clínica." },
          { title: "Optómetra", text: "Atiende con la historia, las pruebas y los documentos." },
          { title: "Caja", text: "Cobra sin ver el diagnóstico." },
        ],
        link: { href: "/seguridad", label: "Qué ve cada rol" },
      },
    ],
    related: ["/agenda-para-opticas", "/caja-y-cobros", "/seguridad", "/buscador"],
    faq: [
      { q: "¿Recepción puede ver la historia clínica?", a: "No. Recepción lleva la agenda, las conversaciones y los datos de contacto. La historia la ve quien atiende." },
      { q: "¿Puedo subir las pruebas que trae el cliente?", a: "Sí. Las pruebas del ojo que se hacen en tu óptica o que llegan de un centro van en su ficha, con su informe." },
      { q: "¿Y si me equivoqué en una atención ya firmada?", a: "Agregas una adenda que lo aclara, con tu nombre y la hora. Lo firmado no se borra ni se reescribe." },
      { q: "¿Puedo dar una copia de su historia?", a: "Sí: en PDF para leer y en HL7 FHIR, un estándar que otro sistema puede cargar." },
    ],
    cta: { title: "Cada cliente, con toda su historia.", text: "Una sola ficha por persona, con lo que le toca ver a cada rol." },
  },

  omnicanal: {
    path: "/omnicanal",
    title: "WhatsApp y omnicanal para ópticas: todos tus mensajes en una bandeja",
    description:
      "Omnicanal para ópticas con vistIA: WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo en una sola bandeja y en la ficha de cada cliente, con Sofi respondiendo a cualquier hora.",
    crumb: "Omnicanal",
    hero: {
      tag: "Omnicanal",
      title: "Escriba por donde escriba,",
      accent: "es la misma persona.",
      lead: "WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo llegan a una sola bandeja y a la ficha de cada cliente. Sofi responde; tu equipo toma la palabra cuando quiere.",
      visual: "omnicanal",
    },
    blocks: [
      {
        kind: "chat",
        tag: "Dos canales, una persona",
        title: "Pregunta por Instagram, agenda por WhatsApp.",
        person: {
          initials: "CR",
          name: "Carmen Ríos",
          sub: "Responsable de Tomás, su hijo",
          text: "Pregunta el precio por Instagram y al día siguiente agenda por WhatsApp para su hijo. Todo cae en la misma conversación y la cita queda en la ficha de Tomás.",
        },
        messages: [
          { ch: "Instagram", who: "Carmen", side: "in", text: "Hola, ¿cuánto cuesta el examen de la vista para un niño?" },
          { ch: "Instagram", who: "Sofi", side: "out", text: "Hola, Carmen. Soy Sofi, asistente virtual de Óptica Lucero. Te paso el precio del examen de la vista de nuestro tarifario. ¿Quieres que le reserve una hora?" },
          { ch: "WhatsApp", who: "Carmen", side: "in", text: "Hola, soy Carmen, la de Instagram. ¿Tienen el lunes en la tarde para Tomás?" },
          { ch: "WhatsApp", who: "Sofi", side: "out", text: "Hola, Carmen. El lunes a las 16:30 con Andrea Quispe, en Lucero Norte. ¿Te lo dejo?" },
        ],
        summary: "Instagram y WhatsApp · una conversación",
        note: "Ejemplo. No se adivina quién es por su número ni se crea una ficha nueva por las dudas: cuando se sabe quién es, la conversación se une a su ficha de siempre.",
      },
      {
        kind: "cards",
        tag: "Tus canales",
        title: "Los que ya usan tus clientes.",
        items: [
          { title: "WhatsApp", text: "El número de tu óptica, conectado con pasos guiados a través de Meta. Lo que cobra Meta se le paga a Meta." },
          { title: "Instagram y Messenger", text: "Los mensajes directos de tu página, en la misma bandeja." },
          { title: "Telegram", text: "Para quien prefiere escribir por ahí." },
          { title: "El chat de tu web", text: "Una línea de código en tu página; Sofi responde ahí mismo." },
          { title: "Correo", text: "Los correos que llegan a tu óptica, junto a lo demás de cada persona." },
        ],
      },
    ],
    related: ["/agentes/recepcion", "/agenda-para-opticas", "/historia-clinica-electronica", "/precios"],
    faq: [
      { q: "¿Necesito WhatsApp Business?", a: "No para empezar: Sofi responde también por Instagram, Messenger, Telegram, el chat de tu web y el correo. Para WhatsApp conectas el número de tu óptica a través de Meta, con pasos guiados." },
      { q: "¿WhatsApp se cobra aparte?", a: "WhatsApp lo cobra Meta directamente a tu óptica, con sus propias tarifas, y lo revisas en tu cuenta de Meta. vistIA no lo cobra ni lo estima." },
      { q: "¿Puede escribir mi equipo en la misma conversación?", a: "Sí. Cualquiera del equipo toma la palabra y Sofi espera; al volver, sabe lo que se habló." },
      { q: "¿Qué pasa si alguien escribe desde otro número?", a: "No se adivina por el número ni se crea una ficha nueva por las dudas. Cuando se sabe quién es, la conversación se une a su ficha de siempre." },
      { q: "¿Tengo que cambiar de número?", a: "No. Conectas el número de tu óptica desde tu cuenta de Meta, con pasos guiados, y tus clientes siguen escribiendo al de siempre." },
    ],
    cta: { title: "Todos tus canales, una sola bandeja.", text: "Cada mensaje llega a la persona que lo escribió y a su única ficha." },
  },

  caja: {
    path: "/caja-y-cobros",
    title: "Caja e inventario para ópticas: cobros, ventas y stock por sede",
    description:
      "Caja e inventario para ópticas con vistIA: cobra el examen y lo que vendes en un solo paso, lleva lo que debe cada cliente y el stock de monturas, lunas y lentes de cada sede, y cierra la caja con su hoja.",
    crumb: "Caja, inventario y sedes",
    hero: {
      tag: "Caja, inventario y sedes",
      title: "Cobra el examen y lo que vendes,",
      accent: "en la misma caja.",
      lead: "Cada cobro con su ticket, los adelantos y lo que debe cada cliente. Lo que vendes sale del stock de la sede y el cierre de caja se imprime para firmar.",
      visual: "caja",
    },
    blocks: [
      {
        kind: "cards",
        tag: "La caja",
        title: "Cobrar en un paso, sin cuadernos.",
        items: [
          { title: "Cobros y adelantos", text: "Qué paga, cuánto y con qué medio, en un solo formulario. Puede pagar la persona o su responsable." },
          { title: "Lo que vendes, en el mismo cobro", text: "«Agregar producto» toma su precio de venta y lo descuenta del stock de la sede." },
          { title: "Quién debe", text: "Lo que debe cada cliente y desde cuándo, sin sumar a mano." },
          { title: "Gastos", text: "Lo que sale de la caja, con su comprobante." },
          { title: "Cierre de caja", text: "Lo cobrado de cada medio, contado al cerrar, con su hoja para firmar." },
        ],
      },
      {
        kind: "cards",
        tag: "El inventario",
        title: "Monturas, lunas y lentes, con lo que queda en cada sede.",
        lead: "Los lentes, las monturas y las lunas son productos de tu inventario: se compran, se guardan en cada sede y se venden.",
        items: [
          { title: "Productos con su precio de venta", text: "Monturas, lunas, lentes de contacto, lentes de sol, estuches y líquidos, con su código." },
          { title: "Stock por sede", text: "Lo vendido sale de la sede del cobro. Si se anula, vuelve." },
          { title: "Compras a tus proveedores", text: "Registras la compra, recibes lo que llega y anotas lo que pagaste." },
          { title: "Contar lo que hay", text: "Cuentas lo que hay en la sede y el inventario se pone al día." },
          { title: "Empezar con tu lista", text: "Pegas tu lista de productos desde una planilla y empiezas." },
        ],
      },
      {
        kind: "split",
        tag: "Varias sedes",
        title: "Cada sede con lo suyo; tú lo ves todo junto.",
        paragraphs: [
          "Cada sede tiene su agenda, su caja y su stock. Quien trabaja en una ve lo de su sede; quien administra, todas juntas o una por una.",
        ],
        points: [
          { title: "Agenda por sede", text: "Con sus salas de examen y su horario." },
          { title: "Caja por sede", text: "Con su cierre y su hoja." },
          { title: "Stock por sede", text: "Lo que se vende sale de la sede donde se cobra." },
        ],
      },
    ],
    related: ["/reportes", "/historia-clinica-electronica", "/agenda-para-opticas", "/precios"],
    faq: [
      { q: "¿Puedo vender sin que haya un examen?", a: "Sí. En el cobro de la persona agregas el producto y lo cobras, haya examen o no." },
      { q: "¿Emite factura electrónica?", a: "Todavía no. La facturación electrónica depende de cada país y la anunciaremos cuando esté lista para el tuyo." },
      { q: "¿Y si vendo algo que no estaba en el stock?", a: "El cobro sigue y el producto queda como faltante en esa sede, para que lo revises." },
      { q: "¿Cuántas sedes puedo tener?", a: "Las que necesites, sin pagar más por sede ni por usuario." },
    ],
    cta: { title: "La caja y el stock, al día.", text: "Cobra el examen y lo que vendes, sede por sede." },
  },

  portal: {
    path: "/portal-del-cliente",
    title: "Portal del cliente para ópticas: su cita y sus documentos en un enlace",
    description:
      "Su enlace para los clientes de tu óptica con vistIA: cada cliente ve su próxima cita, la cambia o la cancela, llena sus datos antes de llegar y ve sus documentos. Sin aplicación y sin contraseña.",
    crumb: "Su enlace",
    hero: {
      tag: "Su enlace",
      title: "Tu cliente ve su cita",
      accent: "sin llamar a la óptica.",
      lead: "Cada cliente tiene su enlace: ve su próxima cita, la cambia o la cancela, llena sus datos antes de llegar y descarga su comprobante. Sin aplicación y sin contraseña.",
      visual: "enlace",
    },
    blocks: [
      {
        kind: "steps",
        tag: "Cómo entra",
        title: "Sin descargar nada.",
        steps: [
          { title: "Le llega por su canal", text: "Sofi se lo envía cuando pide una cita, y también va en el aviso de su control.", agent: SOFI },
          { title: "Lo abre en el navegador", text: "No descarga nada ni crea una contraseña." },
          { title: "Vuelve con su huella o su cara", text: "Si tu óptica le da acceso al portal, la primera vez guarda su acceso en el teléfono. Si su enlace venció, responde el mensaje y recibe uno nuevo." },
        ],
      },
      {
        kind: "cards",
        tag: "Lo que decide",
        title: "Lo suyo, en sus manos.",
        items: [
          { title: "Su cita", text: "Reserva, cambia o cancela en los horarios libres. El que deja se libera para otro." },
          { title: "Sus datos", text: "Los llena antes de llegar. Lo que declara queda como declarado por la persona." },
          { title: "Sus papeles", text: "El comprobante, para descargar durante 30 días." },
          { title: "Sus mensajes", text: "Elige qué mensajes recibe. Los avisos de su cita le llegan siempre." },
        ],
      },
    ],
    related: ["/agenda-para-opticas", "/agentes/recepcion", "/omnicanal", "/seguridad"],
    faq: [
      { q: "¿El cliente tiene que descargar una aplicación?", a: "No. Su enlace se abre en el navegador del teléfono." },
      { q: "¿Qué pasa si el enlace venció?", a: "Responde el mensaje de la óptica y recibe uno nuevo. No hay contraseñas que recordar." },
      { q: "¿Lo que llena entra directo a la historia clínica?", a: "Entra como lo que declaró la persona, no como algo que el optómetra confirmó." },
    ],
    cta: { title: "Menos llamadas para cambiar una cita.", text: "Cada cliente con su enlace, en el canal donde ya te escribe." },
  },

  reportes: {
    path: "/reportes",
    title: "Reportes para ópticas: cobrado, clientes, citas y lo que hicieron tus agentes",
    description:
      "Reportes para ópticas con vistIA: lo cobrado y lo que te deja, los clientes nuevos, las citas y quién faltó, comparado con el mes anterior. Y si quieres saber algo más, se lo preguntas a Argos.",
    crumb: "Reportes",
    hero: {
      tag: "Reportes con Argos",
      title: "Lo que pasa en tu óptica,",
      accent: "sin armar planillas.",
      lead: "Lo cobrado, los clientes nuevos, las citas y quién faltó, comparado con el mes anterior y con palabras, no solo con colores. Y si quieres saber algo más, se lo preguntas a Argos.",
      visual: "reportes",
    },
    blocks: [
      {
        kind: "cards",
        tag: "Cinco pestañas",
        title: "Cada cifra, comparada con el mes anterior.",
        items: [
          { title: "Resumen", text: "Lo cobrado, los clientes nuevos y quién faltó a su cita, en una mirada." },
          { title: "Finanzas", text: "De lo cobrado a lo que te deja: el impuesto y las comisiones aparte, y lo que te deben." },
          { title: "Pacientes", text: "Quienes te buscaron por primera vez y hasta dónde llegaron: agendaron, vinieron, pagaron." },
          { title: "Agenda", text: "Las citas atendidas, quién faltó y qué tan llena está la agenda." },
          { title: "Agente", text: "Lo que hicieron Sofi y Argos en el mes: conversaciones, citas y citas recuperadas." },
        ],
      },
      {
        kind: "split",
        tag: "Pregúntale a Argos",
        title: "Si no está en una pestaña, pregúntalo.",
        paragraphs: [
          "Escribes la pregunta en Reportes o en el buscador, como «¿Qué se vendió más este mes?», y Argos responde con las mismas cifras de Reportes y te dice cómo lo calculó.",
          "Lo que no puede responder te lo dice, y esa pregunta no cuenta.",
        ],
        link: { href: "/agentes/administrador", label: "Conoce a Argos" },
      },
    ],
    related: ["/caja-y-cobros", "/agentes/administrador", "/buscador", "/precios"],
    faq: [
      { q: "¿Puedo ver una sede sola?", a: "Sí. Todas las sedes juntas o una por una." },
      { q: "¿Cuántas preguntas le puedo hacer a Argos?", a: "Depende de tu plan: lo ves en la página Precios. Las que no puede responder no cuentan." },
      { q: "¿Quién ve Reportes?", a: "Quien tiene ese permiso en su rol, como el propietario o el administrador." },
    ],
    cta: { title: "Tu óptica, en números claros.", text: "Reportes listos y Argos para lo que quieras preguntar." },
  },

  seguridad: {
    path: "/seguridad",
    title: "Seguridad de los datos de tu óptica: cada rol con su permiso",
    description:
      "Seguridad en vistIA: cada rol ve solo lo suyo, la historia clínica firmada no se cambia, queda quién la consultó, tu óptica está separada de las demás y tus clientes pueden pedir sus datos.",
    crumb: "Seguridad",
    hero: {
      tag: "Seguridad",
      title: "Cada quien ve",
      accent: "lo suyo.",
      lead: "Recepción agenda sin ver la historia clínica. Caja cobra sin ver el diagnóstico. Quien examina atiende con todo lo clínico. Y Sofi, que responde a tus clientes, tampoco ve la historia.",
      visual: "seguridad",
      secondary: { href: "/contacto", label: "Pregúntanos" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "La historia clínica",
        title: "Lo clínico, con su cuidado.",
        items: [
          { title: "Firmada no se cambia", text: "Al firmar, la atención queda fija. Si después algo cambia, se agrega una adenda con el nombre y la hora." },
          { title: "Quién la consultó", text: "Cada vez que alguien abre la historia de un cliente queda una línea: quién, qué parte y a qué hora." },
          { title: "Solo quien atiende", text: "Recepción y caja no pueden abrirla, ni encontrarla en el buscador." },
        ],
      },
      {
        kind: "cards",
        tag: "Tus datos",
        title: "Tu óptica, separada de las demás.",
        lead: "Esto es lo que hace el sistema hoy, sin adornos.",
        items: [
          { title: "Aislada por óptica", text: "Los datos de cada óptica están separados de los demás en la base de datos, también para los agentes." },
          { title: "El permiso se revisa en el servidor", text: "No basta con esconder un botón: cada pedido se revisa contra el rol de quien lo hace." },
          { title: "Conexión cifrada", text: "Todo viaja cifrado entre tu equipo y vistIA. Las claves de tus canales se guardan cifradas." },
          { title: "Todo queda registrado", text: "Quién hizo qué y cuándo, sea una persona de tu equipo o un agente. Anular pide motivo." },
          { title: "Los agentes, con límites", text: "Sofi dice que es asistente virtual y no ve la historia. Argos responde cifras sin que el modelo vea los nombres." },
        ],
      },
      {
        kind: "split",
        tag: "La persona y sus datos",
        title: "Si un cliente pide sus datos, sabes qué hacer.",
        paragraphs: [
          "Registras el pedido en su ficha y el sistema te recuerda responder dentro de 10 días. Puede pedir una copia (en PDF y en HL7 FHIR), corregir un dato, no recibir mensajes o borrar lo que no es clínico.",
          "Comprobar que es la persona o su representante es un paso del pedido, nunca por el número de teléfono.",
        ],
        points: [
          { title: "Lo que todavía no podemos decir", text: "No mostramos sellos ni certificaciones de seguridad: todavía no tenemos ninguna que mostrar, y no vamos a insinuarla." },
        ],
      },
    ],
    related: ["/historia-clinica-electronica", "/agentes/recepcion", "/contacto", "/precios"],
    faq: [
      { q: "¿Recepción puede ver la historia clínica?", a: "No. Recepción lleva la agenda, las conversaciones y los datos de contacto, pero no la historia." },
      { q: "¿Puedo saber quién abrió una historia?", a: "Sí. Cada vez que alguien abre la historia de un cliente queda una línea con quién, qué parte y a qué hora." },
      { q: "¿Otra óptica puede ver mis datos?", a: "No. Cada óptica está separada de las demás en la base de datos, también para los agentes." },
      { q: "¿Usan los datos de mi óptica para entrenar la IA?", a: "No. Los datos de tu óptica se usan solo para atender a tus clientes; no los usamos para entrenar modelos." },
    ],
    cta: { title: "Tus datos, cuidados.", text: "Cada rol con su permiso y tu óptica aparte de las demás." },
  },
} satisfies Record<string, VistiaPageData>
