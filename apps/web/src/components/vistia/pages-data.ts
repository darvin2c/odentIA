// Las páginas interiores de vistIA: lo de buscadores, la portada, las secciones (los mismos bloques de
// las páginas interiores de odentIA, `ContentBlock`), los enlaces y las preguntas. Solo lo que vistIA
// hace hoy: agenda, conversaciones con Sofi, la ficha con su historia clínica, el examen de la vista en
// pantalla, la receta de lentes, el pedido al laboratorio o al taller con su aviso, caja e inventario,
// reportes con Argos, Su enlace con el portal y varias sedes. Clío no trabaja en una óptica y no se
// nombra como algo que hace. Cada afirmación sale de la app o de su Ayuda, con sus palabras (los nombres
// de los botones y de los pasos). Sin cifras de precio: esas viven en /precios.
// Los ejemplos son de la Óptica Lucero, una óptica inventada (como la Clínica Sonrisa Norte de odentIA).
import type { FaqItem } from "../../lib/faq"
import type { Block } from "../../lib/pages-data"
import { signatureFaq } from "../../lib/signature-faq"

/** Los agentes de vistIA en los bloques: Sofi (0) y Argos (2), con los índices de `AGENT_NAMES`. */
const SOFI = 0
const ARGOS = 2

export type VistiaVisualKind = "agentes" | "sofi" | "argos" | "agenda" | "ficha" | "pedido" | "omnicanal" | "caja" | "enlace" | "reportes" | "seguridad"

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
  "/historia-clinica-electronica": { label: "Examen, receta e historia clínica", text: "El examen de la vista en pantalla, la receta de lentes y las pruebas del ojo." },
  "/pedidos-de-lentes": { label: "Pedidos de lentes", text: "Vendes con adelanto y sigues cada pedido hasta entregarlo." },
  "/caja-y-cobros": { label: "Caja, inventario y sedes", text: "Cobros, lo que vendes con su stock y el cierre de cada sede." },
  "/portal-del-cliente": { label: "Su enlace y portal", text: "Tu cliente cambia su cita sin llamar y tiene sus documentos en su portal." },
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
      "Dos agentes de IA para tu óptica: Sofi responde por WhatsApp, Instagram y más canales, agenda el examen de la vista y dice cómo va el pedido de lentes; Argos recuerda citas, invita al control y responde las cifras de tu óptica.",
    crumb: "Agentes",
    hero: {
      tag: "Agentes",
      title: "Dos agentes que hacen el trabajo.",
      accent: "Tú decides hasta dónde.",
      lead: "Sofi atiende a quien escribe, por cualquier canal y a cualquier hora. Argos se ocupa de lo pendiente: recordar la cita, invitar al control y traer de vuelta a quien faltó. Todo queda en la ficha de cada cliente.",
      visual: "agentes",
      secondary: { href: "#dia", label: "Ver un caso completo" },
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
            text: "Responde por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo. Informa servicios y precios, agenda con el sí de la persona y le dice cómo va su pedido de lentes.",
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
        tag: "Un caso completo",
        title: "De la primera pregunta a los lentes entregados.",
        lead: "Tu equipo hace lo que le toca: examinar, vender y entregar. Lo demás lo llevan los agentes, y todo queda en la ficha de Rosa.",
        steps: [
          { when: "Viernes · 23:41", channel: "WhatsApp", title: "Rosa pregunta si atienden el sábado.", text: "Sofi le ofrece los horarios libres de la optómetra y la agenda con su sí. La cita queda en la agenda.", agent: SOFI },
          { when: "Sábado · 10:00", title: "Andrea Quispe la examina.", text: "Anota la agudeza visual y la refracción de cada ojo, y emite su receta de anteojos, firmada." },
          { when: "Sábado · 10:40", channel: "Ventas", title: "Rosa elige su montura y deja un adelanto.", text: "«Vender lentes» arma el pedido con su receta. La montura sale del stock de Lucero Centro y el adelanto entra a la caja, con su ticket." },
          { when: "Miércoles · 18:20", channel: "WhatsApp", title: "Rosa pregunta si ya están sus lentes.", text: "Sofi le dice en qué paso está su pedido y para cuándo se le prometió.", agent: SOFI },
          { when: "Jueves · 11:00", channel: "WhatsApp", title: "«Tus lentes ya están listos para recoger».", text: "El aviso le llega cuando tu equipo marca el pedido listo." },
          { when: "Un año después", channel: "WhatsApp", title: "Argos la invita a su control anual de la vista.", text: "Si responde que sí, Sofi le agenda la hora.", agent: ARGOS },
        ],
        note: "Un caso de ejemplo.",
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
    related: ["/agentes/recepcion", "/agentes/administrador", "/precios"],
    faq: [
      {
        q: "¿Por qué dos agentes?",
        a: "Porque en vistIA no trabaja Clío, el agente que escucha la consulta y la ordena. En una óptica la medida de la vista la escribe quien examina: un número mal oído son unos lentes mal hechos.",
      },
      {
        q: "¿Los agentes ven la historia clínica?",
        a: "Sofi no: ve la agenda, los servicios y precios, el conocimiento de tu óptica, los datos de contacto de la persona y cómo va su pedido. Argos responde cifras sin que el modelo vea los nombres de tus clientes.",
      },
      {
        q: "¿Y si el agente no sabe qué responder?",
        a: "Le dice a la persona que alguien de tu equipo la va a atender y te deja el caso en Inicio, en «Te espera», con todo lo que se habló.",
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
      "Sofi es el agente de recepción de vistIA: responde a tus clientes por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, a cualquier hora, les agenda el examen de la vista con su sí y les dice si sus lentes ya están listos.",
    crumb: "Sofi",
    parent: ["Agentes", "/agentes"],
    hero: {
      tag: "Sofi · recepción",
      title: "Sofi responde a tus clientes",
      accent: "y les agenda el examen.",
      lead: "Por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, de día y de noche. Informa tus servicios y precios, agenda con el sí de la persona y responde «¿ya están mis lentes?».",
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
          { title: "«¿Ya están mis lentes?»", text: "Le dice en qué paso está su pedido y para cuándo se le prometió. Nunca le dice la receta.", href: "/pedidos-de-lentes", label: "Ver los pedidos" },
          { title: "Sabe quién le escribe", text: "Escriba por donde escriba, la conversación llega a la ficha de la persona. Nunca la reconoce solo por su teléfono." },
          { title: "Una urgencia de la vista no espera", text: "Si alguien cuenta que dejó de ver de golpe o que le cayó un químico en el ojo, Sofi le dice a dónde acudir y el caso pasa a tu equipo con prioridad." },
          { title: "Tu equipo toma la palabra", text: "Cualquiera del equipo puede escribir en la conversación. Sofi espera y le deja un resumen." },
        ],
      },
      {
        kind: "split",
        tag: "Tú le enseñas",
        title: "Sofi aprende de tu óptica, y tú apruebas lo que aprende.",
        paragraphs: [
          "Sofi lee al momento los datos de tu óptica: horarios, sedes, servicios, precios y medios de pago. Lo que solo tú sabes, como el estacionamiento o las cuotas, lo agregas en «Conocimiento».",
          "Si respondió mal, la corriges: tu corrección queda como una lección y Sofi la usa recién cuando quien dirige la óptica la aprueba.",
        ],
        points: [
          { title: "«Conocimiento»", text: "Todo lo que Sofi sabe de tu óptica, en un solo lugar.", agent: SOFI },
          { title: "«Aprender»", text: "Lo que conviene revisar de sus respuestas, para corregirlo o darlo por bueno.", agent: SOFI },
          { title: "«Probar»", text: "Una conversación real con una persona de prueba, también con Sofi apagada.", agent: SOFI },
        ],
      },
      {
        kind: "split",
        tag: "Lo que no ve",
        title: "Sofi agenda sin ver la historia clínica.",
        paragraphs: [
          "Sofi ve lo que necesita para atender: la agenda, tus servicios y precios, los medios de pago, el conocimiento de tu óptica, los datos de contacto de la persona y cómo va su pedido.",
          "No ve la historia clínica, ni los diagnósticos, ni la medida de la vista, ni la caja.",
        ],
        link: { href: "/seguridad", label: "Cómo protegemos tus datos" },
      },
    ],
    related: ["/omnicanal", "/agenda-para-opticas", "/pedidos-de-lentes"],
    faq: [
      { q: "¿Sofi dice que es un agente?", a: "Sí. Se presenta como la asistente virtual de tu óptica y nunca se hace pasar por una persona del equipo." },
      {
        q: "¿Y si no sabe qué responder?",
        a: "Le dice a la persona que alguien de tu equipo la va a atender y te deja el caso en Inicio, en «Te espera», con todo lo que se habló. Lo que hace queda registrado.",
      },
      {
        q: "¿Le dice a mi cliente cuánto le falta pagar de sus lentes?",
        a: "Solo a la propia persona, a su representante o a quien paga por ella. A quien escribe por ella sin esa facultad le dice en qué paso está el pedido y para cuándo se prometió. Si no encuentra el pedido, dice que lo confirma con tu equipo: no inventa fechas ni montos.",
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
        note: "Puedes fijar una respuesta en tu Resumen o descargarla. Y cada lunes te llega por correo el resumen de la semana, con lo que recomienda Argos.",
      },
      {
        kind: "split",
        tag: "Tú decides",
        title: "Cada cosa que hace Argos, la prendes o la apagas.",
        paragraphs: [
          "Si apagas algo, Argos te deja la lista y tu equipo decide a quién escribir. Responde cifras sin que el modelo vea los nombres de tus clientes.",
          "Y si quieres algo distinto, se lo pides con tus palabras en «Dile qué quieres que haga»: te lo deja como borrador y, cuando se puede, con una prueba sobre tus últimos 30 días. Nada cambia hasta que lo prendas.",
        ],
        points: [
          { title: "Recordar las citas", text: "Un día antes, por el canal de la persona. No se cobra.", agent: ARGOS },
          { title: "Ofrecer otro horario a quien faltó", text: "Si reserva y viene, es una cita recuperada.", agent: ARGOS },
          { title: "Avisar los controles", text: "El control anual de la vista o el de los lentes de contacto, a tiempo.", agent: ARGOS },
          { title: "Invitar a volver", text: "A quien lleva tiempo sin venir. Si no puede escribirle, te deja una tarea de llamada.", agent: ARGOS },
        ],
      },
    ],
    related: ["/reportes", "/agenda-para-opticas", "/precios"],
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
    related: ["/agentes/recepcion", "/portal-del-cliente", "/historia-clinica-electronica"],
    faq: [
      { q: "¿Puedo tener varias salas de examen?", a: "Sí, y varias sedes. Cada cita va con su optómetra, su sala de examen y su sede." },
      { q: "¿Los recordatorios se cobran?", a: "No. Los recordatorios y los avisos de cita no se cobran." },
      { q: "¿Qué pasa si Sofi no puede agendar?", a: "Si apagas «Agendar citas», Sofi envía el enlace para que la persona elija la hora. Y tu equipo siempre puede tomar la conversación." },
      {
        q: "¿Puedo ver mis citas en mi calendario?",
        a: "Sí, si atiendes: «Mi calendario» lleva tus citas a Google Calendar, Apple u Outlook, junto a lo demás de tu día. De cada cita muestra solo las iniciales, nunca el nombre, el servicio ni el motivo.",
      },
    ],
    cta: { title: "Tu agenda, llena y al día.", text: "Sofi agenda, Argos recuerda y el control anual vuelve solo." },
  },

  historia: {
    path: "/historia-clinica-electronica",
    title: "Historia clínica electrónica para ópticas: examen de la vista, receta de lentes y pruebas del ojo",
    description:
      "Historia clínica electrónica para ópticas con vistIA: el examen de la vista en pantalla (agudeza visual, refracción y distancia pupilar), la receta de anteojos y de lentes de contacto firmada y con código QR, diagnósticos con CIE-10 o CIE-11, consentimientos y pruebas del ojo.",
    crumb: "Examen e historia clínica",
    hero: {
      tag: "Examen, receta e historia clínica",
      title: "Del examen de la vista a la receta,",
      accent: "en la ficha de cada cliente.",
      lead: "El examen se anota en pantalla, ojo por ojo, y de él sale la receta de lentes, firmada y con su código QR. Todo queda en la única ficha de la persona, con sus antecedentes, sus diagnósticos y sus pruebas del ojo.",
      visual: "ficha",
    },
    blocks: [
      {
        kind: "cards",
        tag: "El examen de la vista",
        title: "La medida de la vista, en pantalla y ojo por ojo.",
        lead: "La escribe quien examina, en la atención. Nada se dicta: un número mal oído son unos lentes mal hechos.",
        items: [
          { title: "Agudeza visual", text: "De cada ojo, sin y con corrección, de lejos y de cerca. Como la escribes siempre: 20/20, 20/25+1, 0,8 o J1." },
          { title: "Refracción", text: "Esfera, cilindro, eje, adición y prisma de cada ojo. Si un dato no cuadra, te lo dice junto a ese dato." },
          { title: "Distancia pupilar", text: "La de cada ojo, que es la que pide el taller, y la binocular de lejos y de cerca si la mides." },
          { title: "Salud del ojo", text: "El examen externo, las pupilas y el fondo de ojo, y la presión si la mides." },
          { title: "«Conviene que lo vea un oftalmólogo»", text: "Te avisa si la presión pasa de 21 mmHg, si hay hallazgos en las pupilas o en el fondo de ojo, o si con corrección no llega a 20/40. Solo informa: tú decides si lo derivas." },
          { title: "Con quién viene y qué usa", text: "Quién acompaña si es menor, si ya usa anteojos o lentes de contacto y lo que importa para su vista." },
        ],
      },
      {
        kind: "cards",
        tag: "La receta de lentes",
        title: "La receta sale del examen, firmada y con su código QR.",
        items: [
          { title: "De anteojos y de lentes de contacto", text: "Son dos recetas. La de lentes de contacto ya viene llevada al ojo para que la revises, y pide la curva base, el diámetro y la marca." },
          { title: "La firmas tú", text: "Con tu colegiatura. Se imprime con un código QR que dice si sigue vigente, vencida o anulada." },
          { title: "Dice hasta cuándo vale", text: "Vale 12 meses desde su fecha. Vencida, la ficha y la venta avisan que conviene un examen nuevo, y no impiden nada." },
          { title: "La que trae de su oftalmólogo", text: "«Transcribir receta externa» guarda la graduación, quién la firmó y la foto. Queda «Sin verificar» hasta que un optómetra la revisa." },
          { title: "Si te equivocaste", text: "Una receta emitida no se edita: la anulas con su motivo y emites otra desde su examen." },
          { title: "De la receta al pedido", text: "Tu cliente la ve en su portal. Y al vender, el pedido lleva una copia para el taller.", href: "/pedidos-de-lentes", label: "Ver los pedidos" },
        ],
      },
      {
        kind: "cards",
        tag: "Lo que guarda",
        title: "Lo demás de la vista, a mano en la ficha.",
        items: [
          { title: "Antecedentes y alergias", text: "Lo que cuenta la persona y lo que confirma quien la atiende, cada cosa con quién la registró." },
          { title: "Diagnósticos, lo del ojo primero", text: "Escribes «miopía» o «conjuntivitis» y sale primero lo del ojo, con la CIE-10 o la CIE-11 según tu país." },
          { title: "Pruebas del ojo", text: "Retinografía, topografía corneal, OCT, campo visual y fotos del ojo, con su informe, en su ficha." },
          { title: "Consentimientos que se firman", text: "La dilatación de las pupilas y la adaptación de lentes de contacto vienen sugeridos para que los revises. Se firman en la tablet, desde su teléfono o en papel." },
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
          { title: "Optómetra", text: "Atiende con la historia, el examen, las recetas y las pruebas." },
          { title: "Ventas", text: "Al vender ve la receta de lentes vigente, sin el resto de la historia." },
          { title: "Caja", text: "Cobra sin ver el diagnóstico." },
        ],
        link: { href: "/seguridad", label: "Qué ve cada rol" },
      },
    ],
    related: ["/pedidos-de-lentes", "/agenda-para-opticas", "/seguridad"],
    faq: [
      { q: "¿Recepción puede ver la historia clínica?", a: "No. Recepción lleva la agenda, las conversaciones y los datos de contacto. La historia la ve quien atiende." },
      {
        q: "¿Puedo dictar el examen de la vista?",
        a: "No. En vistIA no trabaja Clío, el agente que ordena lo que se dicta: la medida de la vista la escribe quien examina, porque un número mal oído son unos lentes mal hechos.",
      },
      {
        q: "¿Y si mi cliente ya trae su receta?",
        a: "La transcribes con «Transcribir receta externa»: la graduación de cada ojo, la fecha, quién la firmó y su foto. Queda «Sin verificar» hasta que un optómetra la revisa, y recién entonces el cliente la ve en su portal. Sin verificar no impide vender: se avisa.",
      },
      {
        q: "¿También receto gotas?",
        a: "Sí. La receta de medicamentos es otra, aparte de la de lentes: trae lágrimas artificiales y lo del ojo rojo o alérgico en su lista, y lo que no está se escribe.",
      },
      { q: "¿Puedo subir las pruebas que trae el cliente?", a: "Sí. Las pruebas del ojo que se hacen en tu óptica o que llegan de un centro van en su ficha, con su informe." },
      { q: "¿Y si me equivoqué en una atención ya firmada?", a: "Agregas una adenda que lo aclara, con tu nombre y la hora. Lo firmado no se borra ni se reescribe." },
      signatureFaq("el optómetra"),
      { q: "¿Puedo dar una copia de su historia?", a: "Sí: en PDF para leer y en HL7 FHIR, un estándar que otro sistema puede cargar." },
    ],
    cta: { title: "Del examen a la receta, sin papeles sueltos.", text: "Una sola ficha por persona, con lo que le toca ver a cada rol." },
  },

  pedidos: {
    path: "/pedidos-de-lentes",
    title: "Pedidos de lentes para ópticas: del adelanto al aviso «tus lentes ya están listos»",
    description:
      "Pedidos de lentes con vistIA: vendes con la receta, la montura y el adelanto, sigues cada pedido en el laboratorio o en tu taller, ves los atrasados y tu cliente recibe el aviso «Tus lentes ya están listos para recoger».",
    crumb: "Pedidos de lentes",
    hero: {
      tag: "Pedidos de lentes",
      title: "Vendes los lentes hoy.",
      accent: "Sabes dónde están hasta entregarlos.",
      lead: "«Vender lentes» arma el pedido con la receta, la montura, las lunas y el adelanto. Cada paso queda marcado, del laboratorio a la entrega. Y tu cliente recibe «Tus lentes ya están listos para recoger».",
      visual: "pedido",
      secondary: { href: "#pedido", label: "Ver un pedido paso a paso" },
    },
    anchor: { block: 0, id: "pedido" },
    blocks: [
      {
        kind: "steps",
        tag: "Un pedido, paso a paso",
        title: "Del adelanto a la entrega, sin cuaderno de pedidos.",
        lead: "Cada paso dice quién lo marcó y cuándo. Y no se vuelve atrás: si algo salió mal, se rehace.",
        steps: [
          { when: "Sábado · 10:40", channel: "Ventas", title: "Rosa elige su montura y deja un adelanto.", text: "«Vender lentes»: su receta vigente, la montura del inventario, las lunas con su precio, para cuándo y el adelanto. Sale su ticket." },
          { when: "Sábado · 10:45", title: "El pedido queda «Por enviar».", text: "Con una copia de la receta y las alturas de montaje, para quien lo hace." },
          { when: "Lunes · 09:10", channel: "Taller", title: "«Enviado al laboratorio».", text: "Un toque marca el paso que sigue: «Llegó del laboratorio», «Revisado: está listo»." },
          { when: "Miércoles · 18:20", channel: "WhatsApp", title: "Rosa pregunta si ya están sus lentes.", text: "Sofi le dice en qué paso está su pedido y para cuándo se le prometió.", agent: SOFI },
          { when: "Jueves · 11:00", channel: "WhatsApp", title: "El pedido queda «Listo» y Rosa recibe el aviso.", text: "«Tus lentes ya están listos para recoger». El pedido dice si el aviso salió, si llegó o si falló." },
          { when: "Viernes · 17:30", channel: "Caja", title: "Rosa recoge sus lentes.", text: "El pedido dice cuánto le falta pagar y ofrece el cobro de siempre. Después, «Entregar»." },
        ],
        note: "Un pedido de ejemplo.",
      },
      {
        kind: "cards",
        tag: "Lo que trae",
        title: "Lo que una óptica necesita para no perder un pedido.",
        items: [
          { title: "«Vender lentes», en un formulario", text: "Para quién, la receta, lo que lleva, las medidas para montar, quién lo hace, para cuándo y el adelanto." },
          { title: "Adelanto con varios medios", text: "Hasta tres medios de pago en el mismo adelanto, o «Sin adelanto». Se cobra en la caja de siempre, con su ticket." },
          { title: "La montura, del inventario", text: "La buscas por nombre, marca o modelo, o pasas el lector por su código de barras. Las lunas se escriben con su precio." },
          { title: "«Atrasados»", text: "Los que pasaron el día prometido sin estar listos, juntos en una pestaña. El buscador encuentra por número, persona o quién lo hace." },
          { title: "Rehacer sin cobrar otra vez", text: "Si no ve bien con sus lentes nuevos, «Rehacer» saca otro pedido unido al original, con lo mismo. Lo que faltaba pagar sigue en el nuevo." },
          { title: "Con receta o sin ella", text: "Si la receta venció o no se verificó, te lo dice y no impide vender. Y si no hay receta, eliges «Sin receta»." },
        ],
      },
      {
        kind: "split",
        tag: "Tu cliente",
        title: "Tu cliente sabe cómo van sus lentes sin llamar.",
        paragraphs: [
          "Al marcar el pedido listo le llega «Tus lentes ya están listos para recoger», por WhatsApp o por correo. Si el aviso no salió o falló, el pedido te lo dice y lo reenvías con «Enviar el aviso».",
          "Y si pregunta antes, no tiene que esperar a que alguien revise: se lo dice Sofi, o lo mira en su portal.",
        ],
        points: [
          { title: "Sofi responde «¿ya están mis lentes?»", text: "En qué paso está su pedido y para cuándo se le prometió.", agent: SOFI },
          { title: "«Tus pedidos», en su portal", text: "Si ya está listo para recoger, para cuándo y lo que le falta pagar.", href: "/portal-del-cliente" },
          { title: "En su ficha", text: "Cada pedido de la persona, con su número y cómo va, junto a lo que paga." },
        ],
      },
      {
        kind: "split",
        tag: "Quién hace qué",
        title: "El taller ve el pedido, no la historia clínica.",
        paragraphs: [
          "Ventas vende y cobra con la receta de lentes vigente a la vista, sin el resto de la historia. El Taller ve los pedidos con sus medidas y la copia de la receta con que se hacen, marca cómo van y no ve importes.",
          "Cada vez que alguien ve la copia de la receta en un pedido, queda anotado en las consultas a la historia de esa persona.",
        ],
        points: [
          { title: "Ventas y Caja", text: "Venden, cobran el adelanto y lo que falta, rehacen y anulan. Caja vende sin ver la receta." },
          { title: "Taller", text: "Marca cada paso y reenvía el aviso. Ve los pedidos y sus tareas." },
          { title: "Recepción y optómetra", text: "Ven cómo va el pedido, sin cambiarlo." },
        ],
        link: { href: "/seguridad", label: "Qué ve cada rol" },
      },
    ],
    related: ["/historia-clinica-electronica", "/caja-y-cobros", "/portal-del-cliente"],
    faq: [
      {
        q: "¿Sirve si mando los lentes a un laboratorio de afuera?",
        a: "Sí. En cada pedido escribes quién lo hace: un laboratorio o tu taller propio. Si tu taller no pasa por el laboratorio, «Marcar listo» salta los pasos del medio.",
      },
      {
        q: "¿Puedo vender sin receta?",
        a: "Sí. En «Vender lentes» eliges «Sin receta», y el pedido va sin ella. Si la persona tiene una receta vencida o sin verificar, te lo avisa y no impide vender: tú decides.",
      },
      {
        q: "¿Tiene que pagar todo para llevarse sus lentes?",
        a: "El sistema no lo exige. El pedido listo dice cuánto falta y ofrece cobrarlo ahí mismo, con el cobro de siempre. Tú decides si entregas.",
      },
      {
        q: "¿Qué hago si no ve bien con sus lentes nuevos?",
        a: "En el pedido, «Rehacer», con por qué se rehace y para cuándo. Sale otro pedido unido al original, con lo mismo y sin cobrar otra vez; lo que faltaba pagar sigue en el nuevo.",
      },
      {
        q: "¿Y si mi cliente se arrepiente?",
        a: "«Anular», con el motivo, mientras no se haya entregado. Lo que no tiene nada cobrado se anula con el pedido y vuelve al inventario. Lo que ya tiene un pago queda en su cuenta: tú decides si lo devuelves o lo cobras.",
      },
      {
        q: "¿El aviso de lentes listos sale siempre por WhatsApp?",
        a: "Por WhatsApp sale con un mensaje aprobado por Meta, que tu óptica pide al conectar su número. Si la persona te escribió en las últimas 24 horas, le llega escrito; si no hay WhatsApp, por correo. Si no pudo salir, el pedido te lo dice para que la llames.",
      },
      {
        q: "¿Puedo hacerle un pedido a alguien que no está registrado?",
        a: "El pedido va a nombre de un cliente con ficha: lo registras con sus nombres, apellidos y celular, y le vendes. Lo que no necesita pedido, como unos lentes de sol, se vende sin ficha con «Venta de mostrador».",
      },
    ],
    cta: { title: "Ningún pedido perdido.", text: "Del adelanto a la entrega, con el aviso a tu cliente." },
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
    related: ["/agentes/recepcion", "/agenda-para-opticas", "/precios"],
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
      "Caja e inventario para ópticas con vistIA: cobra el examen y lo que vendes en un solo paso, con ficha o en venta de mostrador, lleva lo que debe cada cliente, tus gastos y el stock de monturas, lunas y lentes de cada sede, y cierra la caja con su hoja.",
    crumb: "Caja, inventario y sedes",
    hero: {
      tag: "Caja, inventario y sedes",
      title: "Cobra el examen y lo que vendes,",
      accent: "en la misma caja.",
      lead: "Cada cobro con su ticket, los adelantos y lo que debe cada cliente. Lo que vendes sale del stock de la sede, con ficha o sin ella, y el cierre de caja se imprime para firmar.",
      visual: "caja",
      secondary: { href: "/pedidos-de-lentes", label: "Ver los pedidos de lentes" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "La caja",
        title: "Cobrar en un paso, sin cuadernos.",
        items: [
          { title: "Cobros y adelantos", text: "Qué paga, cuánto y con qué medio, en un solo formulario. Puede pagar la persona o su responsable." },
          { title: "Lo que vendes, en el mismo cobro", text: "«Agregar producto» toma su precio de venta y lo descuenta del stock de la sede." },
          { title: "Venta de mostrador, sin ficha", text: "Unos lentes de sol o un estuche: buscas o escaneas el producto, cobras y se imprime el ticket. Sin abrirle una ficha a nadie." },
          { title: "Quién debe", text: "Lo que debe cada cliente y desde cuándo, sin sumar a mano." },
          { title: "Gastos y facturas por pagar", text: "Lo que pagas con su comprobante, la factura del laboratorio que pagas después y lo que se repite cada mes. «Descargar el mes» se lo pasa a tu contador." },
          { title: "Cierre de caja", text: "Lo cobrado de cada medio, contado al cerrar, con su hoja para firmar." },
        ],
      },
      {
        kind: "cards",
        tag: "El inventario",
        title: "Monturas, lunas y lentes, con lo que queda en cada sede.",
        lead: "Los lentes, las monturas y las lunas son productos de tu inventario: se compran, se guardan en cada sede y se venden.",
        items: [
          { title: "Productos con su precio de venta", text: "Monturas, lunas, lentes de contacto, lentes de sol, estuches y líquidos." },
          { title: "Con su código de barras", text: "Cada producto con su código, marca, modelo, color y medidas. Al vender lo encuentras por marca o modelo, o pasando el lector." },
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
    related: ["/pedidos-de-lentes", "/reportes", "/precios"],
    faq: [
      {
        q: "¿Puedo vender sin que haya un examen?",
        a: "Sí. Lo suelto, como unos lentes de sol, se vende con «Venta de mostrador», sin ficha. A un cliente con ficha se lo agregas en su cobro, con «Agregar producto». Y los lentes con medida se venden con su pedido.",
      },
      {
        q: "¿Puedo cobrar en dólares además de mi moneda?",
        a: "Sí. Activas una segunda moneda y pones el tipo de cambio de hoy. Desde ahí cobras y registras gastos en ella, y pones en ella el precio de tus servicios; lo que vendes de tu inventario lleva su precio en tu moneda. Cada moneda tiene su caja y su cierre.",
      },
      {
        q: "¿Lleva las comisiones de mis optómetras?",
        a: "Sí. Fijas lo que se lleva cada profesional y cada mes ves su liquidación: lo que le corresponde por lo que atendió y ya se cobró, cómo se calcula y cuánto falta pagarle. Cada uno ve solo lo suyo, en «Mis honorarios».",
      },
      { q: "¿Emite factura electrónica?", a: "Todavía no. La facturación electrónica depende de cada país y la anunciaremos cuando esté lista para el tuyo." },
      { q: "¿Y si vendo algo que no estaba en el stock?", a: "El cobro sigue y el producto queda como faltante en esa sede, para que lo revises." },
      { q: "¿Cuántas sedes puedo tener?", a: "Las que necesites, sin pagar más por sede ni por usuario." },
    ],
    cta: { title: "La caja y el stock, al día.", text: "Cobra el examen y lo que vendes, sede por sede." },
  },

  portal: {
    path: "/portal-del-cliente",
    title: "Portal del cliente para ópticas: su cita en un enlace y sus documentos en su portal",
    description:
      "Su enlace y el portal para los clientes de tu óptica con vistIA: cada cliente ve su próxima cita, la cambia o la cancela y llena sus datos antes de llegar, sin aplicación. Sus documentos le llegan en PDF y en su portal ve sus recetas de lentes y sus pedidos.",
    crumb: "Su enlace y portal",
    hero: {
      tag: "Su enlace y portal",
      title: "Tu cliente ve su cita",
      accent: "sin llamar a la óptica.",
      lead: "Cada cliente tiene su enlace: ve su próxima cita, la cambia o la cancela, llena sus datos y firma su consentimiento antes de llegar. Sin aplicación y sin contraseña. Y en su portal tiene todo lo suyo: sus recetas de lentes, sus pedidos y sus documentos.",
      visual: "enlace",
    },
    blocks: [
      {
        kind: "steps",
        tag: "Cómo entra",
        title: "Sin descargar nada.",
        steps: [
          { title: "Le llega por su canal", text: "Sofi se lo envía cuando pide una cita, y también va en el aviso de su control.", agent: SOFI },
          { title: "Lo abre en el navegador", text: "No descarga nada ni crea una contraseña. Ahí están sus pendientes: su cita, sus datos y lo que le toca firmar." },
          { title: "Su portal, con su huella o su cara", text: "Si tu óptica le da acceso al portal, la primera vez guarda su acceso en el teléfono y después entra con su huella o su cara. Ese acceso no vence: dura hasta que tu óptica lo quite." },
        ],
      },
      {
        kind: "cards",
        tag: "Su enlace",
        title: "Lo pendiente, en sus manos.",
        items: [
          { title: "Su cita", text: "Reserva, cambia o cancela en los horarios libres. El que deja se libera para otro." },
          { title: "Sus datos y su firma", text: "Llena sus datos antes de llegar, y lo que declara queda como declarado por la persona. Su consentimiento lo lee y lo firma desde su teléfono; si es menor, lo firma en la óptica quien lo representa." },
          { title: "Sus mensajes", text: "Elige qué mensajes recibe. Los avisos de su cita le llegan siempre." },
        ],
      },
      {
        kind: "cards",
        tag: "Sus documentos",
        title: "Cada papel le llega en PDF. Y en su portal están todos.",
        lead: "Su enlace no guarda papeles: lleva lo pendiente. Lo que tu óptica le entrega le llega a su chat o a su correo, y queda en su portal.",
        items: [
          { title: "En PDF, por WhatsApp o por correo", text: "La orden o el consentimiento firmado salen con «Enviar», y el cajón dice antes por dónde le llega. El comprobante sale por correo al cobrar." },
          { title: "Su portal, con todo lo suyo", text: "Sus citas, sus recetas de lentes, sus documentos y su cuenta. Lo anulado se ve marcado y una receta vencida dice «Vencida»." },
          { title: "«Tus pedidos»", text: "Si sus lentes ya están listos para recoger, para cuándo y lo que le falta pagar.", href: "/pedidos-de-lentes", label: "Ver los pedidos" },
          { title: "Un QR en cada papel", text: "Cualquiera comprueba con el código, sin cuenta, si ese papel sigue vigente." },
          { title: "Tu óptica decide qué se ve", text: "Citas, presupuestos, cuenta y documentos: lo eliges una vez para toda la óptica. Y un archivo se puede ocultar del portal." },
          { title: "Lo que nunca ve", text: "Las notas de sus atenciones no salen en el portal, ni lo que es de otra persona." },
        ],
      },
    ],
    related: ["/agenda-para-opticas", "/pedidos-de-lentes", "/seguridad"],
    faq: [
      { q: "¿El cliente tiene que descargar una aplicación?", a: "No. Su enlace y su portal se abren en el navegador del teléfono." },
      {
        q: "¿Qué diferencia hay entre su enlace y su portal?",
        a: "Su enlace le llega por su canal y lleva lo pendiente: su cita, sus datos y lo que le toca firmar. El portal se lo da tu óptica, entra con su huella o su cara y muestra todo lo suyo, sin vencer: sus recetas de lentes, sus pedidos, su cuenta y sus documentos.",
      },
      {
        q: "¿Qué pasa si el enlace venció?",
        a: "La misma página le ofrece «Enviarme uno nuevo» y le llega por su canal. Si no se puede, le dice que escriba a la óptica. No hay contraseñas que recordar.",
      },
      {
        q: "¿Cómo recibe su receta de lentes?",
        a: "Se la imprimes con «Imprimir», y la ve y la descarga en su portal. La receta que trae de afuera aparece en su portal cuando un optómetra la verifica.",
      },
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
        tag: "Lo que trae",
        title: "Cada cifra, comparada con el mes anterior.",
        items: [
          { title: "Resumen", text: "Lo cobrado, los clientes nuevos y quién faltó a su cita, en una mirada. Y la meta del mes que tú pones." },
          { title: "Finanzas", text: "De lo cobrado a lo que te deja: el impuesto y las comisiones aparte, y lo que te deben." },
          { title: "Pacientes", text: "Quienes te buscaron por primera vez y hasta dónde llegaron: agendaron, vinieron, pagaron." },
          { title: "Agenda", text: "Las citas atendidas, quién faltó y qué tan llena está la agenda." },
          { title: "Agente", text: "Lo que hicieron Sofi y Argos en el mes: conversaciones, citas y citas recuperadas." },
          { title: "El resumen del lunes", text: "Un correo cada lunes con cuatro cifras de la semana anterior y, si hay, lo que cambió y lo que recomienda Argos. Le llega a quien creó la óptica; los demás lo prenden para sí." },
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
        points: [
          { title: "«Fijar en Resumen»", text: "La respuesta que quieres tener a la vista queda en tu Resumen.", agent: ARGOS },
          { title: "«Descargar»", text: "Cada lista se descarga, y también las tablas Por profesional y Comisiones y las respuestas de Argos que traen filas." },
        ],
        link: { href: "/agentes/administrador", label: "Conoce a Argos" },
      },
    ],
    related: ["/caja-y-cobros", "/agentes/administrador", "/buscador"],
    faq: [
      { q: "¿Puedo ver una sede sola?", a: "Sí. Todas las sedes juntas o una por una." },
      { q: "¿Cuántas preguntas le puedo hacer a Argos?", a: "Depende de tu plan: lo ves en la página Precios. Las que no puede responder no cuentan." },
      { q: "¿Quién ve Reportes?", a: "Quien tiene ese permiso en su rol, como el propietario o el administrador." },
      {
        q: "¿Puedo ponerle una meta al mes?",
        a: "Sí. En el Resumen pones la meta de lo cobrado y la de los pacientes nuevos. Una raya marca cuánto del mes ya pasó: si tu barra va por delante, vas bien.",
      },
    ],
    cta: { title: "Tu óptica, en números claros.", text: "Reportes listos y Argos para lo que quieras preguntar." },
  },

  seguridad: {
    path: "/seguridad",
    title: "Seguridad de los datos de tu óptica: cada rol con su permiso",
    description:
      "Seguridad en vistIA: recepción, optómetra, caja, ventas y taller ven solo lo suyo, la historia clínica firmada no se cambia, queda quién la consultó, tu óptica está separada de las demás y tus clientes pueden pedir sus datos.",
    crumb: "Seguridad",
    hero: {
      tag: "Seguridad",
      title: "Cada quien ve",
      accent: "lo suyo.",
      lead: "Recepción agenda sin ver la historia clínica. Caja cobra sin ver el diagnóstico. Ventas vende con la receta de lentes a la vista y nada más de la historia. El taller ve solo los pedidos. Y Sofi, que responde a tus clientes, tampoco ve la historia.",
      visual: "seguridad",
      secondary: { href: "/contacto", label: "Pregúntanos" },
    },
    blocks: [
      {
        kind: "cards",
        tag: "Los roles de una óptica",
        title: "El mostrador, el examen, la caja y el taller, cada uno con su permiso.",
        lead: "Eliges el rol al invitar a cada persona, y lo cambias cuando quieras.",
        items: [
          { title: "Recepción", text: "Registra clientes y lleva la agenda, las conversaciones y las tareas. Ve cómo va un pedido. No ve la historia clínica ni la caja." },
          { title: "Optómetra", text: "Atiende con la historia, el examen de la vista, las recetas y las pruebas del ojo. Sin caja." },
          { title: "Caja", text: "Cobra, lleva los gastos, cierra la caja y entrega los pedidos listos. Sin historia clínica ni agenda." },
          { title: "Ventas", text: "Atiende el mostrador: registra clientes, agenda, vende y cobra, con el inventario y sus precios. De la historia ve solo la receta de lentes vigente. No cierra la caja." },
          { title: "Taller", text: "Ve los pedidos con sus medidas y la copia de la receta con que se hacen, y marca cómo van. Sin importes; fuera de los pedidos, solo sus tareas." },
          { title: "Propietario y administrador", text: "Ven todo y configuran la óptica. Solo el propietario nombra o quita a otros propietarios." },
        ],
      },
      {
        kind: "cards",
        tag: "La historia clínica",
        title: "Lo clínico, con su cuidado.",
        items: [
          { title: "Firmada no se cambia", text: "Al firmar, la atención queda fija. Si después algo cambia, se agrega una adenda con el nombre y la hora." },
          { title: "Quién la consultó", text: "Cada vez que alguien abre la historia de un cliente queda una línea: quién, qué parte y a qué hora. También cuando el taller ve la copia de una receta." },
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
          { title: "Verificación en dos pasos", text: "Cada persona la activa en su perfil, y tu óptica puede pedírsela a todo el equipo." },
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
    related: ["/historia-clinica-electronica", "/pedidos-de-lentes", "/contacto"],
    faq: [
      { q: "¿Recepción puede ver la historia clínica?", a: "No. Recepción lleva la agenda, las conversaciones y los datos de contacto, pero no la historia." },
      {
        q: "¿Quien vende puede ver la historia clínica?",
        a: "No. Ventas ve solo la receta de lentes vigente al vender, sin los diagnósticos ni el resto de la historia. Y el taller ve la copia de la receta que va en el pedido, nada más.",
      },
      { q: "¿Puedo saber quién abrió una historia?", a: "Sí. Cada vez que alguien abre la historia de un cliente queda una línea con quién, qué parte y a qué hora." },
      { q: "¿Otra óptica puede ver mis datos?", a: "No. Cada óptica está separada de las demás en la base de datos, también para los agentes." },
      { q: "¿Usan los datos de mi óptica para entrenar la IA?", a: "No. Los datos de tu óptica se usan solo para atender a tus clientes; no los usamos para entrenar modelos." },
    ],
    cta: { title: "Tus datos, cuidados.", text: "Cada rol con su permiso y tu óptica aparte de las demás." },
  },
} satisfies Record<string, VistiaPageData>
