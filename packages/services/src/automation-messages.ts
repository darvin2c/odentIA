import type { TemplateCategory } from "@odentia/channels"
import type { ConsentPurpose } from "@odentia/db/schema/automation"

/**
 * Lo que odentIA escribe por su cuenta, declarado una sola vez: el texto, los
 * datos que lleva, sus botones y a qué permiso responde. De aquí salen la
 * plantilla que se pide a WhatsApp, el texto que se envía dentro de las 24
 * horas y el correo de respaldo: los tres dicen lo mismo.
 *
 * Los datos los pone el sistema (agenda, presupuestos, controles) al entregar;
 * ningún texto de aquí sale de un modelo. Estos son los textos con los que
 * viene cada clínica: cada una puede cambiarlos (`clinic-messages.ts`), y un
 * texto nuevo, de odentIA o de la clínica, es siempre otra plantilla con otro
 * nombre, nunca el cuerpo cambiado de una ya pedida.
 */

/** Qué hace un botón cuando la persona lo toca. */
/**
 * Lo que puede devolver un botón. «permiso_si» y «permiso_no» son la respuesta
 * a la pregunta del permiso general tras reservar: su id lleva la persona, no
 * un trabajo (`generalPermissionButtons`).
 */
/**
 * «presupuesto» era «Ver y responder» de la primera versión de «Presupuesto
 * listo»: tocarlo deja el PDF en la conversación. Desde «Su enlace» (ADR
 * 0037) ese botón abre su enlace (`MessageSpec.link`); la acción queda para
 * los mensajes que ya salieron con la versión anterior.
 */
export const REPLY_ACTIONS = ["confirmar", "responder", "baja", "permiso_si", "permiso_no", "presupuesto"] as const
export type ReplyAction = (typeof REPLY_ACTIONS)[number]

export interface MessageButton {
  /**
   * `confirmar` y `baja` los resuelve el sistema sin modelo; `responder` sigue
   * la conversación con el agente o con una persona.
   */
  action: ReplyAction
  title: string
  /**
   * Lo que la persona pide al tocar un botón que sigue la conversación: una
   * cita nueva (`reservar`) o mover la que tiene (`cambiar`). Con esto el turno
   * de Recepción ya sabe por dónde ir, sin preguntárselo a un modelo.
   */
  asks?: "reservar" | "cambiar"
}

/** Un mensaje ya escrito: lo que se pide a WhatsApp y lo que se envía. */
export interface MessageSpec {
  key: string
  /** La que se pide; el proveedor puede asignar otra. */
  category: TemplateCategory
  template: string
  /** Variables por posición: `{{1}}` es `variables[0]`. */
  body: string
  variables: readonly MessageVariable[]
  /** Botones de respuesta rápida, después del enlace si lo hay. */
  buttons: readonly MessageButton[]
  /**
   * Botón que abre «Su enlace» de la persona (ADR 0037): en WhatsApp es un botón
   * de dirección con el token al final; dentro de las 24 horas y por correo, la
   * dirección va escrita al final del texto. Lo pone el sistema al enviar.
   */
  link?: { title: string }
}

export interface AutomationMessage extends MessageSpec {
  key: AutomationMessageKey
  purpose: ConsentPurpose
  /** Asunto cuando sale por correo. */
  subject: string
}

/** Datos que un mensaje puede llevar. Cada uno tiene un ejemplo para pedir la plantilla. */
export const MESSAGE_VARIABLES = {
  persona: { label: "Nombre de la persona", example: "Lucía" },
  lugar: { label: "Clínica y sede", example: "Clínica Sonríe, sede Centro" },
  clinica: { label: "Nombre de la clínica", example: "Clínica Sonríe" },
  citas: {
    label: "Fecha, hora y profesional de la cita",
    example: "mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres",
  },
  cita_pasada: { label: "Fecha de la cita que no se dio", example: "lunes 12 de octubre" },
  control: { label: "Control pendiente", example: "Control de ortodoncia" },
  presupuesto: { label: "Título del presupuesto", example: "Ortodoncia" },
  resumen_presupuesto: { label: "Tratamientos y total del presupuesto", example: "3 tratamientos por S/ 540" },
  oportunidad: { label: "Título de la oportunidad", example: "Ortodoncia" },
} as const
export type MessageVariable = keyof typeof MESSAGE_VARIABLES

/** Todo mensaje deja darse de baja con un toque, de ese tipo de mensaje y no de los demás. */
const OPT_OUT: MessageButton = { action: "baja", title: "No enviar más" }

/**
 * Avisos de «Recordar la cita» cuando la cita cambia: se reservó, se movió o se
 * canceló. Son de la misma línea (su permiso es el de recordatorios) y cada uno
 * es un trabajo de su propio tipo, con la clave de su mensaje (ADR 0027).
 */
export const APPOINTMENT_NOTICE_KEYS = ["aviso_cita_reservada", "aviso_cita_movida", "aviso_cita_cancelada"] as const
export type AppointmentNoticeKey = (typeof APPOINTMENT_NOTICE_KEYS)[number]

export function isAppointmentNotice(kind: string): kind is AppointmentNoticeKey {
  return (APPOINTMENT_NOTICE_KEYS as readonly string[]).includes(kind)
}

/**
 * El aviso de cita reservada cuando a la persona le faltan datos para
 * atenderla: el mismo aviso, con el botón de «Su enlace» para completarlos
 * antes de venir (decisión 8). No es otro trabajo: sale en lugar del aviso de
 * reserva cuando faltan datos, y así no se le manda un segundo mensaje ese día.
 */
export const APPOINTMENT_DATA_NOTICE_KEY = "aviso_cita_reservada_datos"

export const AUTOMATION_MESSAGE_KEYS = [
  "recordatorio_cita",
  // Los avisos de la cita van junto a su línea, «Recordar la cita»; el de
  // reserva con «Su enlace», junto al de reserva.
  "aviso_cita_reservada",
  APPOINTMENT_DATA_NOTICE_KEY,
  "aviso_cita_movida",
  "aviso_cita_cancelada",
  "recordatorio_control",
  "seguimiento_presupuesto",
  "seguimiento_comercial",
  "seguimiento_no_asistencia",
  "cita_cancelada",
] as const
export type AutomationMessageKey = (typeof AUTOMATION_MESSAGE_KEYS)[number]

export const AUTOMATION_MESSAGES: Record<AutomationMessageKey, AutomationMessage> = {
  recordatorio_cita: {
    key: "recordatorio_cita",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_recordatorio_cita_v1",
    body: "Hola, {{1}}. Te recordamos la cita en {{2}}: {{3}}. Si necesitas cambiarla, responde a este mensaje.",
    variables: ["persona", "lugar", "citas"],
    buttons: [
      { action: "confirmar", title: "Confirmar" },
      { action: "responder", title: "No podré ir", asks: "cambiar" },
      OPT_OUT,
    ],
    subject: "Recordatorio de cita",
  },
  recordatorio_control: {
    key: "recordatorio_control",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_recordatorio_control_v1",
    body: "Hola, {{1}}. En {{2}} tienes pendiente este control: {{3}}. Responde a este mensaje y te buscamos un horario.",
    variables: ["persona", "clinica", "control"],
    buttons: [{ action: "responder", title: "Quiero agendar", asks: "reservar" }, OPT_OUT],
    subject: "Tienes un control pendiente",
  },
  seguimiento_presupuesto: {
    key: "seguimiento_presupuesto",
    purpose: "seguimiento",
    category: "marketing",
    template: "odentia_seguimiento_presupuesto_v1",
    body: "Hola, {{1}}. El presupuesto «{{2}}» que te presentamos en {{3}} sigue pendiente. ¿Quieres retomarlo o tienes alguna duda?",
    variables: ["persona", "presupuesto", "clinica"],
    buttons: [{ action: "responder", title: "Quiero retomarlo", asks: "reservar" }, OPT_OUT],
    subject: "Tu presupuesto sigue pendiente",
  },
  // Retoma una consulta que quedó con su próxima acción vencida. El botón no fija
  // camino: la persona sigue la conversación con Recepción, que sabe de qué
  // oportunidad viene por su contacto.
  seguimiento_comercial: {
    key: "seguimiento_comercial",
    purpose: "seguimiento",
    category: "marketing",
    template: "odentia_seguimiento_oportunidad_v1",
    body: "Hola, {{1}}. Te escribimos de {{2}} sobre tu consulta de «{{3}}». ¿Seguimos conversando?",
    variables: ["persona", "clinica", "oportunidad"],
    buttons: [{ action: "responder", title: "Sí, continuemos" }, OPT_OUT],
    subject: "¿Seguimos conversando?",
  },
  seguimiento_no_asistencia: {
    key: "seguimiento_no_asistencia",
    purpose: "seguimiento",
    category: "utility",
    template: "odentia_seguimiento_inasistencia_v1",
    body: "Hola, {{1}}. No pudimos verte en la cita del {{2}} en {{3}}. ¿Te buscamos otro horario?",
    variables: ["persona", "cita_pasada", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otro horario", asks: "reservar" }, OPT_OUT],
    subject: "¿Reprogramamos tu cita?",
  },
  // Lo recibe quien coordina la cita, que puede no ser quien la canceló: por eso
  // no dice «cancelaste».
  cita_cancelada: {
    key: "cita_cancelada",
    purpose: "seguimiento",
    category: "utility",
    template: "odentia_cita_cancelada_v1",
    body: "Hola, {{1}}. Se canceló la cita del {{2}} en {{3}}. ¿Te buscamos otra fecha?",
    variables: ["persona", "cita_pasada", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otra fecha", asks: "reservar" }, OPT_OUT],
    subject: "¿Te buscamos otra fecha?",
  },
  // Los tres avisos de «Recordar la cita». No piden confirmar: eso lo pide el
  // recordatorio, cerca de la fecha.
  aviso_cita_reservada: {
    key: "aviso_cita_reservada",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_aviso_cita_reservada_v1",
    body: "Hola, {{1}}. Tu cita en {{2}} quedó reservada: {{3}}. Si necesitas cambiarla, responde a este mensaje.",
    variables: ["persona", "lugar", "citas"],
    buttons: [{ action: "responder", title: "No podré ir", asks: "cambiar" }, OPT_OUT],
    subject: "Tu cita quedó reservada",
  },
  aviso_cita_reservada_datos: {
    key: "aviso_cita_reservada_datos",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_aviso_cita_datos_v1",
    body: "Hola, {{1}}. Te esperamos en {{2}}: {{3}}. Antes de venir, completa tus datos aquí.",
    variables: ["persona", "lugar", "citas"],
    link: { title: "Ver mi cita y mis datos" },
    buttons: [OPT_OUT],
    subject: "Tu cita quedó reservada: completa tus datos",
  },
  aviso_cita_movida: {
    key: "aviso_cita_movida",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_aviso_cita_movida_v1",
    body: "Hola, {{1}}. Tu cita en {{2}} cambió de fecha: ahora es {{3}}. Si no te queda bien, responde a este mensaje.",
    variables: ["persona", "lugar", "citas"],
    buttons: [{ action: "responder", title: "No podré ir", asks: "cambiar" }, OPT_OUT],
    subject: "Tu cita cambió de fecha",
  },
  aviso_cita_cancelada: {
    key: "aviso_cita_cancelada",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_aviso_cita_cancelada_v1",
    body: "Hola, {{1}}. Tu cita del {{2}} en {{3}} quedó cancelada. ¿Te buscamos otra fecha?",
    variables: ["persona", "cita_pasada", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otra fecha", asks: "reservar" }, OPT_OUT],
    subject: "Tu cita quedó cancelada",
  },
}

export function automationMessageOf(kind: string): AutomationMessage | null {
  return (AUTOMATION_MESSAGE_KEYS as readonly string[]).includes(kind)
    ? AUTOMATION_MESSAGES[kind as AutomationMessageKey]
    : null
}

/**
 * El mensaje que no sale solo: lo envía una persona desde la Bandeja cuando
 * pasaron 24 horas y WhatsApp ya no deja escribir con libertad. Continúa una
 * consulta que la persona inició, así que no responde a ningún permiso de
 * mensajes y solo se ofrece en una conversación donde ella ya escribió.
 */
export const RESUME_MESSAGE_KEY = "retomar_conversacion"
export const RESUME_MESSAGE: MessageSpec = {
  key: RESUME_MESSAGE_KEY,
  category: "utility",
  template: "odentia_retomar_conversacion_v1",
  body: "Hola, {{1}}. Te escribimos de {{2}} para continuar con tu consulta. ¿Seguimos por aquí?",
  variables: ["persona", "clinica"],
  buttons: [{ action: "responder", title: "Sí, continuemos" }],
}

/**
 * «Presupuesto listo» (paso 3 de la fase 3): lo envía quien entrega el
 * presupuesto desde Plan o el cierre de la atención, y el agente cuando la
 * persona se lo pide por el chat. Es parte del servicio: no pide permiso
 * previo (ADR 0030) y deja de salir solo si se dio de baja de los mensajes de
 * seguimiento. «Ver y responder» abre «Su enlace», donde lo ve y responde
 * (ADR 0037). Por WhatsApp dentro de las 24 horas sale con el PDF y su
 * enlace; por correo, con el PDF adjunto y su enlace.
 */
export const BUDGET_READY_MESSAGE_KEY = "presupuesto_listo"
export const BUDGET_READY_MESSAGE: MessageSpec = {
  key: BUDGET_READY_MESSAGE_KEY,
  category: "utility",
  template: "odentia_presupuesto_listo_v2",
  body: "Hola, {{1}}. Tu presupuesto está listo: {{2}}. Puedes verlo y decirnos qué aceptas aquí.",
  variables: ["persona", "resumen_presupuesto"],
  link: { title: "Ver y responder" },
  buttons: [],
}
/** Asunto cuando «Presupuesto listo» sale por correo. */
export const BUDGET_READY_SUBJECT = "Tu presupuesto está listo"

/**
 * «Su enlace» (ADR 0037): lo envía recepción con «Enviarle su enlace» (datos
 * por completar, un consentimiento por firmar) y lleva solo el botón que lo
 * abre. Es parte del servicio, como el aviso de su cita: no pide permiso y
 * deja de salir solo si se dio de baja de los recordatorios.
 */
export const PERSONAL_LINK_MESSAGE_KEY = "su_enlace"
export const PERSONAL_LINK_MESSAGE: MessageSpec = {
  key: PERSONAL_LINK_MESSAGE_KEY,
  category: "utility",
  template: "odentia_su_enlace_v1",
  body: "Hola, {{1}}. En {{2}} te dejamos aquí lo que tienes pendiente con nosotros.",
  variables: ["persona", "clinica"],
  link: { title: "Ver lo pendiente" },
  buttons: [],
}
/** Asunto cuando «Su enlace» sale por correo. */
export const PERSONAL_LINK_SUBJECT = "Lo que tienes pendiente con la clínica"

/** Los mensajes con los que viene cada clínica: los que envía el agente, el de la Bandeja, el del presupuesto y «Su enlace». */
export const CATALOG_MESSAGE_KEYS = [
  ...AUTOMATION_MESSAGE_KEYS,
  RESUME_MESSAGE_KEY,
  BUDGET_READY_MESSAGE_KEY,
  PERSONAL_LINK_MESSAGE_KEY,
] as const
export type CatalogMessageKey = (typeof CATALOG_MESSAGE_KEYS)[number]

export function catalogMessageOf(key: string): MessageSpec | null {
  if (key === RESUME_MESSAGE_KEY) return RESUME_MESSAGE
  if (key === BUDGET_READY_MESSAGE_KEY) return BUDGET_READY_MESSAGE
  if (key === PERSONAL_LINK_MESSAGE_KEY) return PERSONAL_LINK_MESSAGE
  return automationMessageOf(key)
}

/**
 * El texto con «Su enlace» escrito al final: lo que sale dentro de las 24
 * horas de WhatsApp y por correo, donde no hay botón de dirección.
 */
export function withLinkLine(text: string, link: { title: string } | undefined, url: string | null): string {
  return link && url ? `${text}\n\n${link.title}: ${url}` : text
}

/** Idioma de las plantillas: el de los textos del producto, sin variante de país. */
export const AUTOMATION_MESSAGE_LANGUAGE = "es"

/**
 * WhatsApp rechaza una variable con saltos de línea, tabulaciones o más de
 * cuatro espacios seguidos, y una vacía. Se limpia aquí para todas las vías.
 */
/**
 * «Clínica, sede X» para el dato `lugar`. Si la sede ya se llama «Sede …», no se
 * repite la palabra («Dental Smile, Sede Miraflores», no «sede Sede Miraflores»).
 */
export function placePhrase(clinic: string, branchName: string): string {
  const name = branchName.trim()
  return /^sede\b/i.test(name) ? `${clinic}, ${name}` : `${clinic}, sede ${name}`
}

/**
 * Un dato va siempre dentro de una frase que pone su propio punto: el punto
 * final del dato («Dental Smile S.A.C.») se quita para no escribir «S.A.C..».
 */
export function cleanVariable(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\.+$/, "")
}

/** Pone cada dato en su posición. Lanza si falta alguno: no se envía un mensaje a medias. */
export function renderMessage(
  spec: Pick<MessageSpec, "key" | "body" | "variables">,
  values: Partial<Record<MessageVariable, string>>,
) {
  const params = spec.variables.map((name) => {
    const value = cleanVariable(values[name] ?? "")
    if (!value) throw new Error(`Al mensaje «${spec.key}» le falta el dato «${name}»`)
    return value
  })
  const text = spec.body.replace(/\{\{(\d+)\}\}/g, (_, position: string) => params[Number(position) - 1] ?? "")
  return { params, text }
}

/** Valores de ejemplo, en el orden de las variables, para pedir la plantilla. */
export function messageExamples(spec: Pick<MessageSpec, "variables">): string[] {
  return spec.variables.map((name) => MESSAGE_VARIABLES[name].example)
}

// ------------------------------------------------- datos por nombre ---

/**
 * Quien edita un texto escribe sus datos por nombre (`{{persona}}`); WhatsApp
 * los recibe por posición (`{{1}}`). Las dos formas dicen lo mismo y se
 * convierten aquí, en un solo sitio.
 */
const NAMED_DATA = /\{\{\s*([^{}\s]+)\s*\}\}/g

export function isMessageVariable(name: string): name is MessageVariable {
  return Object.hasOwn(MESSAGE_VARIABLES, name)
}

/** El cuerpo por posición, con cada dato por su nombre. */
export function namedBody(spec: Pick<MessageSpec, "body" | "variables">): string {
  return spec.body.replace(/\{\{(\d+)\}\}/g, (whole, position: string) => {
    const name = spec.variables[Number(position) - 1]
    return name ? `{{${name}}}` : whole
  })
}

/** Datos que nombra un texto, en el orden en que aparecen y con sus repeticiones. */
export function dataNamesOf(body: string): string[] {
  return [...body.matchAll(NAMED_DATA)].map((match) => match[1] ?? "")
}

/**
 * El texto con datos por nombre, llevado a posiciones: el primero que aparece
 * es `{{1}}`. Solo vale para un texto ya validado (datos conocidos, una vez cada uno).
 */
export function positionalBody(body: string): { body: string; variables: MessageVariable[] } {
  const variables: MessageVariable[] = []
  const text = body.replace(NAMED_DATA, (whole, name: string) => {
    if (!isMessageVariable(name)) return whole
    if (!variables.includes(name)) variables.push(name)
    return `{{${variables.indexOf(name) + 1}}}`
  })
  return { body: text, variables }
}

/** El texto partido en lo fijo y lo que pone el sistema, para mostrarlo con lo segundo resaltado. */
export function splitNamedBody(body: string): { text: string; name: string | null }[] {
  const parts: { text: string; name: string | null }[] = []
  let last = 0
  for (const match of body.matchAll(NAMED_DATA)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: body.slice(last, at), name: null })
    parts.push({ text: match[0], name: match[1] ?? "" })
    last = at + match[0].length
  }
  if (last < body.length) parts.push({ text: body.slice(last), name: null })
  return parts
}

// ------------------------------------------------ botones de respuesta ---

const REPLY_PREFIX = "odentia"

/** Lo que devuelve un botón cuando la persona lo toca: acción y trabajo que lo originó. */
export function replyId(action: ReplyAction, jobId: string): string {
  return `${REPLY_PREFIX}:${action}:${jobId}`
}

/**
 * La pregunta del permiso de novedades y promociones, una sola vez por
 * persona, tras reservar (ADR 0030). Texto y botones fijos; la respuesta la
 * resuelve el sistema sin modelo.
 */
export const GENERAL_PERMISSION_QUESTION = "¿Te podemos escribir para enviarte novedades y promociones de la clínica?"
export const GENERAL_PERMISSION_YES = "¡Listo! Te enviaremos novedades y promociones. Puedes darte de baja cuando quieras."
export const GENERAL_PERMISSION_NO = "Entendido: no te enviaremos novedades ni promociones."

export function generalPermissionButtons(contactId: string): Array<{ id: string; title: string }> {
  return [
    { id: replyId("permiso_si", contactId), title: "Sí" },
    { id: replyId("permiso_no", contactId), title: "No, gracias" },
  ]
}

export function parseReplyId(value: string | null | undefined): { action: ReplyAction; jobId: string } | null {
  if (!value) return null
  const [prefix, action, jobId, ...rest] = value.split(":")
  if (prefix !== REPLY_PREFIX || rest.length > 0 || !jobId) return null
  if (!(REPLY_ACTIONS as readonly string[]).includes(action ?? "")) return null
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null
  return { action: action as ReplyAction, jobId }
}
