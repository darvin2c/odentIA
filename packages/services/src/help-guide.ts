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

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "inicio",
    path: "/home",
    title: "Inicio",
    parent: null,
    purpose: "Tu jornada de un vistazo: lo pendiente de ti, las citas de hoy, las tareas y lo que recomienda el asesor.",
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
    purpose: "Las citas por día, profesional y sillón. Desde ahí reservas, mueves y cancelas citas, y ves la lista de espera.",
    terms: ["citas", "calendario", "reservar", "turnos", "horario del día", "mover una cita", "cancelar una cita", "lista de espera"],
    writePermission: "appointments.write",
    faqs: [
      { q: "¿Cómo bloqueo un horario?", a: "En Agenda, elige el día y el profesional y usa «Bloquear horario». El bloqueo impide reservar en ese tramo; las citas que ya estaban no se mueven solas." },
      { q: "¿Por qué no aparece un profesional en la agenda?", a: "Un profesional aparece cuando tiene un horario definido en Configuración › Disponibilidad. Sin horario explícito no se le pueden reservar citas." },
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
    terms: ["inteligencia artificial", "ia", "bot", "asistente virtual", "automático", "aprobaciones", "conocimiento", "aprender"],
    writePermission: "agent.write",
    faqs: [
      { q: "¿Cómo enciendo el agente?", a: "En Agente, en la fila de Recepción, usa el interruptor. Te muestra cuatro comprobaciones (canal, lo básico de tu clínica, si lo probaste y quién recibe los casos) y con qué nivel empieza." },
      { q: "¿Cómo le enseño algo al agente?", a: "Los datos de tu clínica (precios, horarios, políticas) van en Agente › Conocimiento. Si respondió mal, corrígelo en Agente › Aprender: tu corrección queda como una lección que apruebas." },
    ],
  },
  {
    id: "finanzas",
    path: "/finance",
    title: "Finanzas",
    parent: "Gestión",
    purpose: "La caja y lo cobrado: turnos de caja, movimientos, gastos, cuotas y comisiones.",
    terms: ["caja", "cobros", "pagos", "ingresos", "gastos", "arqueo", "cuotas", "deudas", "cobranza", "comisiones"],
    writePermission: "finance.write",
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
    id: "automatizaciones",
    path: "/automations",
    title: "Automatizaciones",
    parent: "Gestión",
    purpose: "Los mensajes que salen solos según una regla: recordatorios de cita, confirmaciones y seguimientos, con su horario de silencio.",
    terms: ["recordatorios", "mensajes automáticos", "confirmar cita", "avisos", "reglas", "plantillas"],
    writePermission: "crm.write",
  },
  {
    id: "reportes",
    path: "/reports",
    title: "Reportes",
    parent: "Gestión",
    purpose: "Los números de la clínica en un periodo: citas, atención de conversaciones, oportunidades y cobros.",
    terms: ["estadísticas", "indicadores", "métricas", "informes", "gráficos", "cuántas citas", "ventas del mes"],
  },
  {
    id: "organizacion",
    path: "/settings",
    title: "Organización",
    parent: SETTINGS,
    purpose: "Los datos de tu clínica: razón social, documento fiscal, país, moneda, zona horaria e idioma.",
    terms: ["datos de la clínica", "nombre de la clínica", "ruc", "moneda", "zona horaria", "empresa"],
    writePermission: "settings.write",
  },
  {
    id: "sucursales",
    path: "/branches",
    title: "Sucursales",
    parent: SETTINGS,
    purpose: "Las sedes de tu clínica, con su dirección, teléfono y zona horaria. Puedes tener más de una.",
    terms: ["sede", "sedes", "local", "locales", "dirección", "otra sede", "más de una sede"],
    writePermission: "settings.write",
    faqs: [{ q: "¿Puedo tener más de una sede?", a: "Sí. Cada sede se agrega en Configuración › Sucursales, con su dirección y su zona horaria." }],
  },
  {
    id: "equipo",
    path: "/members",
    title: "Equipo y permisos",
    parent: SETTINGS,
    purpose: "Quién forma parte de tu clínica y qué puede ver o hacer cada persona según su rol. Desde ahí invitas a alguien nuevo.",
    terms: ["usuarios", "invitar", "roles", "permisos", "recepcionista", "odontólogo", "agregar a alguien", "accesos"],
    writePermission: "settings.write",
    faqs: [{ q: "¿Cómo invito a alguien a mi equipo?", a: "En Configuración › Equipo y permisos, pulsa «Invitar», escribe su correo y elige su rol. Le llega una invitación para crear su cuenta." }],
  },
  {
    id: "servicios",
    path: "/services",
    title: "Servicios y tarifas",
    parent: SETTINGS,
    purpose: "Lo que ofrece tu clínica y cuánto cuesta. De ahí salen los precios que ve el equipo, los presupuestos y lo que el agente puede decir.",
    terms: ["precios", "tarifario", "tratamientos", "prestaciones", "catálogo", "cuánto cuesta", "lista de precios"],
    writePermission: "settings.write",
  },
  {
    id: "disponibilidad",
    path: "/settings/availability",
    title: "Disponibilidad",
    parent: SETTINGS,
    purpose: "Los días y las horas en que atiende cada profesional en cada sede, y los sillones. Sin un horario aquí no se pueden reservar citas.",
    terms: ["horarios", "horario de atención", "días de atención", "sillones", "turnos del doctor", "agenda del profesional"],
    writePermission: "appointments.write",
    faqs: [{ q: "¿Dónde configuro los horarios?", a: "En Configuración › Disponibilidad. Ahí defines, por profesional y sede, los días y las horas de atención." }],
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
    id: "canales",
    path: "/settings/channels",
    title: "Canales",
    parent: SETTINGS,
    purpose: "Por dónde te escriben: aquí conectas WhatsApp, Telegram, Instagram, Messenger y los demás canales a la Bandeja.",
    terms: ["conectar whatsapp", "whatsapp", "telegram", "instagram", "messenger", "número de whatsapp", "integración"],
    writePermission: "settings.write",
  },
  {
    id: "chat_web",
    path: "/settings/webchat",
    title: "Chat web",
    parent: SETTINGS,
    purpose: "El chat que puedes poner en tu página web para que te escriban desde ahí.",
    terms: ["widget", "chat en mi página", "página web", "sitio web", "burbuja de chat"],
    writePermission: "settings.write",
  },
  {
    id: "correo",
    path: "/settings/mail",
    title: "Correo",
    parent: SETTINGS,
    purpose: "Los buzones de correo de la clínica conectados a la Bandeja.",
    terms: ["email", "gmail", "outlook", "buzón", "conectar correo"],
    writePermission: "settings.write",
  },
  {
    id: "ajustes_agente",
    path: "/settings/agent",
    title: "Agente",
    parent: SETTINGS,
    purpose: "Los ajustes técnicos del agente: proveedor del modelo, tope diario y autonomía acto por acto. Lo del día a día está en la pantalla Agente.",
    terms: ["modelo", "proveedor", "clave de api", "tope diario", "autonomía", "ajustes técnicos"],
    writePermission: "agent.write",
  },
  {
    id: "pipelines",
    path: "/settings/pipelines",
    title: "Pipelines",
    parent: SETTINGS,
    purpose: "Las etapas del tablero de oportunidades: cuáles son, en qué orden y cuáles cierran como ganada o perdida.",
    terms: ["etapas", "embudo", "columnas del tablero", "fases de venta"],
    writePermission: "crm.write",
  },
  {
    id: "campos",
    path: "/settings/fields",
    title: "Campos",
    parent: SETTINGS,
    purpose: "Los datos propios que tu clínica quiere guardar de cada contacto, además de los que ya trae el sistema.",
    terms: ["campos personalizados", "datos adicionales", "campo nuevo", "información extra"],
    writePermission: "crm.write",
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
    title: "Acceso de pacientes",
    parent: SETTINGS,
    purpose: "El portal donde el paciente ve sus citas y documentos: si está activo y cómo entra.",
    terms: ["portal del paciente", "portal", "que el paciente vea sus citas", "acceso del paciente", "pin"],
    writePermission: "settings.write",
  },
  {
    id: "auditoria",
    path: "/settings/audit",
    title: "Auditoría",
    parent: SETTINGS,
    purpose: "El registro de quién cambió qué y cuándo en la clínica.",
    terms: ["historial de cambios", "quién cambió", "registro de actividad", "log", "bitácora"],
  },
] as const

const byId = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]))

export function helpTopic(id: string): HelpTopic | undefined {
  return byId.get(id)
}

/** Cómo se llega a la pantalla, dicho como en el menú: «Configuración › Disponibilidad». */
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
