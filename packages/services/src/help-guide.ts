import { normalizeForSearch, scoreKnowledgeMatch } from "./knowledge.js"

/* ---------- Guía de odentIA: el mapa del sistema que usa la Ayuda ---------- */

/**
 * Un tema por pantalla. Lo que identifica a la pantalla —ruta y nombre— tiene
 * que coincidir con el código: una prueba lo compara con las rutas y los menús
 * reales, y falla si un tema nombra algo que ya no existe o si aparece una
 * pantalla sin tema. Lo escrito a mano es poco: para qué sirve y con qué
 * palabras la busca la gente. Se cambia en el mismo cambio que la pantalla.
 */
export interface HelpTopic {
  id: string
  /** Ruta de la pantalla, tal como está en la aplicación. */
  path: string
  /** Nombre con el que el sistema la llama (el del menú). */
  title: string
  /** Sección del menú o de Configuración donde está. */
  parent: string | null
  /** Para qué sirve, en una o dos frases. */
  purpose: string
  /** Con qué palabras la busca la gente, aunque el sistema la llame de otro modo. */
  terms: string[]
  /** Preguntas frecuentes de esa pantalla con su respuesta. */
  faqs?: Array<{ q: string; a: string }>
  /** Permiso que hace falta para cambiar cosas ahí; ausente = basta con poder verla. */
  writePermission?: string
}

const SETTINGS = "Configuración"
/** Pantallas que se abren desde Integraciones: no están en la lista, pero se llega por ahí. */
const INTEGRATIONS = `${SETTINGS} › Integraciones`

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "inicio",
    path: "/home",
    title: "Inicio",
    parent: null,
    purpose: "Lo que te toca hoy. «Te espera» reúne en una lista, por orden de urgencia, los casos que pasó el agente, lo que espera tu aprobación, las conversaciones sin responder, las tareas, lo que recomienda el administrador y las personas a las que el agente no pudo escribir. Al lado, tu día: la agenda de la sede, tus pacientes o la caja, según tu trabajo.",
    terms: ["resumen del día", "pendientes", "panel", "dashboard", "qué tengo hoy", "recomendaciones"],
  },
  {
    id: "bandeja",
    path: "/inbox",
    title: "Bandeja",
    parent: null,
    purpose: "Todas las conversaciones con pacientes y contactos, de todos los canales, en un solo lugar. Desde ahí respondes, tomas la atención o la devuelves al agente.",
    terms: ["mensajes", "chats", "conversaciones", "responder", "inbox", "escribir a un paciente"],
    writePermission: "conversations.write",
    faqs: [
      { q: "¿Cómo respondo yo en vez del agente?", a: "Abre la conversación y pulsa «Tomar atención» en el panel de contexto. Desde ese momento respondes tú; con «Devolver al agente» vuelve a atender él." },
      { q: "¿Cómo veo en qué se basó una respuesta del agente?", a: "En la conversación, debajo de cada mensaje del agente, pulsa «En qué se basó». Verás qué consultó y qué datos se comprobaron antes de enviarlo." },
    ],
  },
  {
    id: "agenda",
    path: "/agenda",
    title: "Agenda",
    parent: null,
    purpose: "Las citas por día, por semana o en lista, de cada profesional. Desde ahí reservas, mueves y cancelas citas.",
    terms: ["citas", "calendario", "reservar", "turnos", "horario del día", "mover una cita", "cancelar una cita", "reprogramar"],
    writePermission: "appointments.write",
    faqs: [
      { q: "¿Cómo bloqueo un horario?", a: "En Configuración › Horarios y ausencias: registra una ausencia del profesional (de uno o varios días) o un feriado o cierre de la sede. En ese tramo no se puede reservar; las citas que ya estaban no se mueven solas." },
      { q: "¿Por qué no aparece un profesional en la agenda?", a: "Un profesional aparece cuando tiene un horario definido en Configuración › Horarios y ausencias. Sin horario explícito no se le pueden reservar citas." },
    ],
  },
  {
    id: "tareas",
    path: "/tasks",
    title: "Tareas",
    parent: null,
    purpose: "Los pendientes del equipo: llamadas, seguimientos y casos que pasó el agente, con su responsable y su vencimiento.",
    terms: ["pendientes", "recordatorios", "to do", "llamar", "asignar", "vencidas"],
    writePermission: "tasks.write",
  },
  {
    id: "pacientes",
    path: "/patients",
    title: "Pacientes",
    parent: "Personas",
    purpose: "La lista de pacientes y la ficha de cada uno: filiación, historia clínica, plan de tratamiento, presupuestos y pagos, según lo que tu rol puede ver.",
    terms: ["historia clínica", "ficha", "expediente", "registrar paciente", "nuevo paciente", "odontograma", "buscar paciente"],
    writePermission: "patients.write",
    faqs: [
      { q: "¿Cómo registro un paciente nuevo?", a: "En Pacientes, pulsa «Nuevo paciente». También puedes enviarle un enlace de registro desde la conversación para que complete sus datos." },
    ],
  },
  {
    id: "contactos",
    path: "/contacts",
    title: "Contactos",
    parent: "Personas",
    purpose: "Todas las personas que escribieron o que registraste, sean o no pacientes: sus datos, etiquetas, conversaciones y oportunidades.",
    terms: ["personas", "clientes", "leads", "interesados", "etiquetas", "teléfono", "directorio"],
    writePermission: "crm.write",
  },
  {
    id: "oportunidades",
    path: "/pipeline",
    title: "Oportunidades",
    parent: "Personas",
    purpose: "El tablero de seguimiento comercial: cada persona interesada en un tratamiento, en qué etapa está y cuál es su próxima acción.",
    terms: ["embudo", "pipeline", "ventas", "seguimiento", "interesados", "tablero", "kanban", "cerrar una oportunidad"],
    writePermission: "crm.write",
  },
  {
    id: "agente",
    path: "/agent",
    title: "Agente",
    parent: null,
    purpose: "El resumen de tus agentes: cómo van, qué necesita de ti y la entrada para configurar cada uno, aprobar lo que proponen, revisar lo que aprenden y mantener su conocimiento.",
    terms: ["inteligencia artificial", "ia", "bot", "asistente virtual", "automático", "aprobaciones", "conocimiento", "aprender", "tope diario", "autonomía"],
    writePermission: "agent.write",
    faqs: [
      { q: "¿Cómo enciendo el agente?", a: "En Agente, en la fila de Recepción, usa el interruptor. Te muestra cuatro comprobaciones (canal, lo básico de tu clínica, si lo probaste y quién recibe los casos) y con qué nivel empieza." },
      { q: "¿Cómo le enseño algo al agente?", a: "Los datos de tu clínica (precios, horarios, políticas) van en Agente › Conocimiento. Si respondió mal, corrígelo en Agente › Aprender: tu corrección queda como una lección que apruebas." },
    ],
  },
  {
    id: "administrador",
    path: "/agent/administrador",
    title: "Administrador",
    parent: "Agente",
    purpose: "El agente que mira cómo va la clínica. Su página es la lista de lo que puede hacer por su cuenta: recordar citas, avisar controles, retomar presupuestos o dejar tareas a tu equipo. Cada línea se prende o se apaga con su interruptor y dice quién lo hace, el agente o una persona.",
    terms: ["recordatorios", "mensajes automáticos", "automatizaciones", "confirmar cita", "avisos", "reglas", "seguimientos", "recomendaciones", "asesor"],
    writePermission: "agent.write",
    faqs: [
      { q: "¿Dónde enciendo los recordatorios de cita?", a: "En Agente › Administrador, en «Listas para activar», prende «Recordar la cita». Antes enciende al administrador con el interruptor de arriba. El recordatorio llega solo a quien aceptó recibirlo." },
      { q: "¿Puedo pedirle algo con mis palabras?", a: "Sí. En Agente › Administrador, escribe en «Dile qué quieres que haga» lo que quieres: prender, apagar o ajustar una línea, o que le ofrezca otra fecha a quien cancela su cita. Te lo deja como borrador con su flujo y una prueba con tus últimos 30 días; nada cambia hasta que lo prendas o lo guardes." },
      { q: "¿Por qué el agente no le escribió a una persona?", a: "En Agente › Administrador, abre la línea y mira «Qué pasó con cada persona»: dice el motivo (no aceptó mensajes, no tiene WhatsApp ni correo, o WhatsApp aún no aprueba el mensaje) y cómo habilitarlo." },
    ],
  },
  {
    id: "finanzas",
    path: "/finance",
    title: "Finanzas",
    parent: "Gestión",
    purpose: "La caja y lo cobrado: cierres de caja, movimientos, gastos, deudas y comisiones.",
    terms: ["caja", "cobros", "pagos", "ingresos", "gastos", "arqueo", "cierre de caja", "deudas", "cobranza", "comisiones"],
    writePermission: "finance.write",
  },
  {
    id: "servicios",
    path: "/services",
    title: "Servicios y precios",
    parent: "Gestión",
    purpose: "Lo que ofrece tu clínica y cuánto cuesta. De ahí salen los precios que ve el equipo, los presupuestos y lo que el agente puede decir.",
    terms: ["precios", "tarifario", "tarifas", "servicios y tarifas", "tratamientos", "prestaciones", "catálogo", "cuánto cuesta", "lista de precios"],
    writePermission: "settings.write",
  },
  {
    id: "comisiones",
    path: "/commissions",
    title: "Comisiones",
    parent: "Gestión",
    purpose: "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró, y el registro de su pago. Quien administra lo ve también como pestaña de Finanzas.",
    terms: ["comisión", "porcentaje", "pago a profesionales", "honorarios", "liquidación", "mis comisiones"],
    writePermission: "commissions.write",
  },
  {
    id: "inventario",
    path: "/inventory",
    title: "Inventario",
    parent: "Gestión",
    purpose: "Los productos e insumos, sus existencias por sede, las compras y los traslados.",
    terms: ["stock", "insumos", "materiales", "productos", "compras", "almacén", "existencias"],
    writePermission: "inventory.write",
  },
  {
    id: "reportes",
    path: "/reports",
    title: "Reportes",
    parent: "Gestión",
    purpose: "Cómo va la clínica en un periodo, comparado con el anterior: dinero, agenda, pacientes y ventas, y atención a quien escribe. Cada cifra abre la lista que la respalda.",
    terms: ["estadísticas", "indicadores", "métricas", "informes", "gráficos", "cuántas citas", "ventas del mes", "inasistencias", "pacientes nuevos", "presupuestos aceptados", "resultado del mes", "cuánto queda"],
  },
  {
    id: "organizacion",
    path: "/settings",
    title: "Datos de la clínica",
    parent: SETTINGS,
    purpose: "Los datos de tu clínica: razón social, documento fiscal, país, moneda, zona horaria e idioma. Con ellos se leen las fechas, los importes y los documentos.",
    terms: ["organización", "nombre de la clínica", "ruc", "moneda", "zona horaria", "empresa", "razón social"],
    writePermission: "settings.write",
  },
  {
    id: "sucursales",
    path: "/settings/branches",
    title: "Sedes",
    parent: SETTINGS,
    purpose: "Las sedes de tu clínica, con su dirección, teléfono y zona horaria. Puedes tener más de una.",
    terms: ["sede", "sucursal", "sucursales", "local", "locales", "dirección", "otra sede", "más de una sede"],
    writePermission: "settings.write",
    faqs: [{ q: "¿Puedo tener más de una sede?", a: "Sí. Cada sede se agrega en Configuración › Sedes, con su dirección y su zona horaria." }],
  },
  {
    id: "equipo",
    path: "/settings/team",
    title: "Equipo",
    parent: SETTINGS,
    purpose: "Quién forma parte de tu clínica y qué puede ver o hacer cada persona según su rol. Desde ahí invitas a alguien nuevo.",
    terms: ["usuarios", "invitar", "roles", "permisos", "recepcionista", "odontólogo", "agregar a alguien", "accesos", "miembros"],
    writePermission: "settings.write",
    faqs: [{ q: "¿Cómo invito a alguien a mi equipo?", a: "En Configuración › Equipo, pulsa «Invitar al equipo», escribe su correo y elige su rol. Le llega una invitación para crear su cuenta." }],
  },
  {
    id: "disponibilidad",
    path: "/settings/availability",
    title: "Horarios y ausencias",
    parent: SETTINGS,
    purpose: "El horario semanal y las ausencias de cada profesional, y de cada sede sus sillones, sus feriados y cierres y lo que dura una cita regular. Sin un horario aquí no se pueden reservar citas.",
    terms: ["horarios", "disponibilidad", "horario de atención", "días de atención", "sillones", "turnos del doctor", "agenda del profesional", "ausencias", "vacaciones", "feriados", "cierres", "duración de la cita"],
    writePermission: "settings.write",
    faqs: [{ q: "¿Dónde configuro los horarios?", a: "En Configuración › Horarios y ausencias. Ahí defines, por profesional y sede, los días y las horas de atención." }],
  },
  {
    id: "especialidades",
    path: "/settings/specialties",
    title: "Especialidades",
    parent: SETTINGS,
    purpose: "Las especialidades que atiende tu clínica; ordenan los servicios y el plan de tratamiento.",
    terms: ["ortodoncia", "endodoncia", "áreas", "tipos de tratamiento"],
    writePermission: "settings.write",
  },
  {
    id: "formularios",
    path: "/settings/forms",
    title: "Formularios y consentimientos",
    parent: SETTINGS,
    purpose: "Las plantillas de consentimientos informados y de cuestionarios que usa tu clínica, con sus versiones.",
    terms: ["consentimiento informado", "anamnesis", "cuestionario", "plantillas", "firma del paciente", "documentos para firmar"],
    writePermission: "settings.write",
  },
  {
    id: "registro_pacientes",
    path: "/settings/patient-registration",
    title: "Registro de pacientes",
    parent: SETTINGS,
    purpose: "Qué se le pide a un paciente cuando se registra con un enlace, y el aviso de privacidad que acepta.",
    terms: ["formulario de registro", "enlace de registro", "aviso de privacidad", "datos que pido al paciente", "alta de paciente"],
    writePermission: "settings.write",
  },
  {
    id: "acceso_pacientes",
    path: "/settings/patient-access",
    title: "Portal del paciente",
    parent: SETTINGS,
    purpose: "El portal donde el paciente ve sus citas y documentos: si está activo y cómo entra.",
    terms: ["portal", "acceso de pacientes", "que el paciente vea sus citas", "acceso del paciente", "pin"],
    writePermission: "settings.write",
  },
  {
    id: "medios-de-pago",
    path: "/settings/payment-methods",
    title: "Medios de pago y ticket",
    parent: SETTINGS,
    purpose: "Con qué puede pagar un paciente en tu clínica y cómo sale el ticket. Los medios que enciendas son los que ofrece caja al cobrar, en el orden que les des, y los que el agente puede mencionar. Ahí también eliges el ancho del ticket, el tamaño de hoja del presupuesto y la frase al pie.",
    terms: ["efectivo", "tarjeta", "transferencia", "billetera", "formas de pago", "cómo pagar", "métodos de pago", "ancho del ticket", "frase al pie", "pie del ticket", "tamaño de hoja", "impresora térmica"],
    writePermission: "settings.write",
  },
  {
    id: "pipelines",
    path: "/settings/pipelines",
    title: "Etapas de venta",
    parent: SETTINGS,
    purpose: "Las etapas del tablero de oportunidades: cuáles son, en qué orden y cuáles cierran como ganada o perdida.",
    terms: ["etapas", "embudo", "columnas del tablero", "fases de venta", "pipelines"],
    writePermission: "settings.write",
  },
  {
    id: "campos",
    path: "/settings/fields",
    title: "Campos de contacto",
    parent: SETTINGS,
    purpose: "Los datos propios que tu clínica quiere guardar de cada contacto, además de los que ya trae el sistema.",
    terms: ["campos personalizados", "datos adicionales", "campo nuevo", "información extra"],
    writePermission: "settings.write",
  },
  {
    // Conserva el identificador de «Canales»: sigue siendo donde se conecta por dónde te escriben.
    id: "canales",
    path: "/settings/integrations",
    title: "Integraciones",
    parent: SETTINGS,
    purpose: "Lo que tu clínica conecta una vez: WhatsApp, Instagram, Messenger y Telegram, el chat de tu sitio web, el correo de la clínica y el modelo del agente. Cada fila dice para qué sirve, con qué cuenta está y cómo va.",
    terms: ["canales", "conectar un canal", "telegram", "instagram", "messenger", "integración", "correo", "email", "gmail", "outlook", "buzón", "conectar correo"],
    writePermission: "settings.write",
  },
  {
    id: "whatsapp",
    path: "/settings/integrations/whatsapp",
    title: "WhatsApp",
    parent: INTEGRATIONS,
    purpose: "El número de WhatsApp de la clínica y los mensajes que WhatsApp deja enviar: aquí lo conectas y ves cuáles están aprobados.",
    terms: ["conectar whatsapp", "whatsapp", "número de whatsapp", "mensajes aprobados", "plantillas de whatsapp"],
    writePermission: "settings.write",
  },
  {
    id: "chat_web",
    path: "/settings/integrations/webchat",
    title: "Chat web",
    parent: INTEGRATIONS,
    purpose: "El chat que puedes poner en tu página web para que te escriban desde ahí.",
    terms: ["widget", "chat en mi página", "página web", "sitio web", "burbuja de chat"],
    writePermission: "settings.write",
  },
  {
    id: "ajustes_agente",
    path: "/settings/integrations/model",
    title: "Modelo del agente",
    parent: INTEGRATIONS,
    purpose: "Con qué entiende y escribe el agente: el modelo incluido con odentIA o la cuenta propia de la clínica, con su prueba de conexión. Lo del día a día —encenderlo, hasta dónde llega solo, el tope diario y sus indicaciones— está en Agente › Recepción.",
    terms: ["modelo", "proveedor", "clave de api", "cuenta propia", "probar conexión", "ajustes técnicos"],
    writePermission: "agent.write",
  },
  {
    id: "auditoria",
    path: "/settings/audit",
    title: "Actividad del equipo",
    parent: SETTINGS,
    purpose: "Quién hizo qué y cuándo en la clínica, dicho con palabras. Es una consulta: desde ahí no se cambia nada.",
    terms: ["auditoría", "historial de cambios", "quién cambió", "registro de actividad", "log", "bitácora"],
  },
] as const

const byId = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]))

export function helpTopic(id: string): HelpTopic | undefined {
  return byId.get(id)
}

/** Cómo se llega a la pantalla, dicho como en el menú: «Configuración › Horarios y ausencias». */
export function helpTopicLabel(topic: HelpTopic): string {
  return topic.parent && topic.parent !== topic.title ? `${topic.parent} › ${topic.title}` : topic.title
}

/** El tema de la pantalla donde está la persona: el de la ruta más larga que coincide. */
export function helpTopicForScreen(pathname: string): HelpTopic | undefined {
  const clean = pathname.replace(/\/+$/, "") || "/"
  return [...HELP_TOPICS]
    .filter((topic) => clean === topic.path || clean.startsWith(`${topic.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** Puntuación mínima para dar un tema por respuesta. Por debajo, la Ayuda dice que no sabe. */
export const HELP_MATCH_SCORE = 40
/** Cuántos temas responde como mucho a una pregunta. */
const HELP_MAX_ANSWERS = 2

export interface HelpMatch {
  topic: HelpTopic
  /** Pregunta frecuente que coincidió, si fue una; su respuesta es más precisa que el propósito. */
  faq: { q: string; a: string } | null
  score: number
}

/**
 * Los temas que responden a una pregunta, por palabras: el nombre de la
 * pantalla, las palabras con que la busca la gente y sus preguntas frecuentes.
 * Sin modelo: es barato, se puede probar y no inventa. Si nada coincide lo
 * bastante, no hay respuesta.
 */
export function matchHelpTopics(question: string): HelpMatch[] {
  const asked = normalizeForSearch(question)
  if (!asked) return []
  const matches: HelpMatch[] = []
  for (const topic of HELP_TOPICS) {
    let best: HelpMatch = {
      topic,
      faq: null,
      score: scoreKnowledgeMatch(question, { title: topic.title, body: topic.purpose, askForms: topic.terms }),
    }
    // Una palabra de búsqueda que aparece entera en la pregunta pesa más que palabras sueltas.
    for (const term of topic.terms) {
      const clean = normalizeForSearch(term)
      if (clean && asked.includes(clean)) best = { ...best, score: Math.max(best.score, 60 + clean.split(" ").length * 20) }
    }
    for (const faq of topic.faqs ?? []) {
      const score = scoreKnowledgeMatch(question, { title: faq.q, body: "", askForms: [] }) + 10
      if (score > best.score) best = { topic, faq, score }
    }
    if (best.score >= HELP_MATCH_SCORE) matches.push(best)
  }
  matches.sort((a, b) => b.score - a.score)
  const [first, second] = matches
  if (!first) return []
  // El segundo solo acompaña si está cerca del primero: una pregunta con dos partes.
  return second && second.score >= first.score * 0.7 ? [first, second].slice(0, HELP_MAX_ANSWERS) : [first]
}

/** Preguntas que la gente suele hacer en una pantalla, para ofrecerlas sin que escriba. */
export function helpSuggestions(pathname: string): string[] {
  const topic = helpTopicForScreen(pathname)
  const own = (topic?.faqs ?? []).map((faq) => faq.q)
  const general = ["¿Dónde configuro los horarios?", "¿Cómo invito a alguien a mi equipo?", "¿Cómo enciendo el agente?"]
  return [...new Set([...own, ...general])].slice(0, 3)
}
