import type { TemplateCategory } from "@odentia/channels"
import type { ConsentPurpose } from "@odentia/db/schema/automation"

/**
 * Lo que odentIA escribe por su cuenta, declarado una sola vez: el texto, los
 * datos que lleva, sus botones y a qué permiso responde. De aquí salen la
 * plantilla que se pide a WhatsApp, el texto que se envía dentro de las 24
 * horas y el correo de respaldo: los tres dicen lo mismo.
 *
 * Los datos los pone el sistema (agenda, presupuestos, controles) al entregar;
 * ningún texto de aquí sale de un modelo. Un texto nuevo es una plantilla
 * nueva: se cambia la versión del nombre, nunca el cuerpo de una ya pedida.
 */

/** Qué hace un botón cuando la persona lo toca. */
export const REPLY_ACTIONS = ["confirmar", "responder", "baja"] as const
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

export interface AutomationMessage {
  key: AutomationMessageKey
  purpose: ConsentPurpose
  /** La que se pide; el proveedor puede asignar otra. */
  category: TemplateCategory
  template: string
  /** Variables por posición: `{{1}}` es `variables[0]`. */
  body: string
  variables: readonly MessageVariable[]
  buttons: readonly MessageButton[]
  /** Asunto cuando sale por correo. */
  subject: string
}

/** Datos que un mensaje puede llevar. Cada uno tiene un ejemplo para pedir la plantilla. */
export const MESSAGE_VARIABLES = {
  persona: { label: "Nombre de la persona", example: "Lucía" },
  lugar: { label: "Clínica y sede", example: "Clínica Sonríe, sede Centro" },
  clinica: { label: "Nombre de la clínica", example: "Clínica Sonríe" },
  citas: {
    label: "De quién es la cita, fecha y hora en la zona de la sede, y profesional",
    example: "mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres",
  },
  cita_pasada: { label: "Fecha de la cita que no se dio", example: "lunes 12 de octubre" },
  control: { label: "Control pendiente", example: "Control de ortodoncia" },
  presupuesto: { label: "Título del presupuesto", example: "Ortodoncia" },
} as const
export type MessageVariable = keyof typeof MESSAGE_VARIABLES

/** Todo mensaje deja darse de baja con un toque, de ese tipo de mensaje y no de los demás. */
const OPT_OUT: MessageButton = { action: "baja", title: "No enviar más" }

export const AUTOMATION_MESSAGE_KEYS = [
  "recordatorio_cita",
  "recordatorio_control",
  "seguimiento_presupuesto",
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
}

export function automationMessageOf(kind: string): AutomationMessage | null {
  return (AUTOMATION_MESSAGE_KEYS as readonly string[]).includes(kind)
    ? AUTOMATION_MESSAGES[kind as AutomationMessageKey]
    : null
}

/** Idioma de las plantillas: el de los textos del producto, sin variante de país. */
export const AUTOMATION_MESSAGE_LANGUAGE = "es"

/**
 * WhatsApp rechaza una variable con saltos de línea, tabulaciones o más de
 * cuatro espacios seguidos, y una vacía. Se limpia aquí para todas las vías.
 */
export function cleanVariable(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Pone cada dato en su posición. Lanza si falta alguno: no se envía un mensaje a medias. */
export function renderMessage(spec: AutomationMessage, values: Partial<Record<MessageVariable, string>>) {
  const params = spec.variables.map((name) => {
    const value = cleanVariable(values[name] ?? "")
    if (!value) throw new Error(`Al mensaje «${spec.key}» le falta el dato «${name}»`)
    return value
  })
  const text = spec.body.replace(/\{\{(\d+)\}\}/g, (_, position: string) => params[Number(position) - 1] ?? "")
  return { params, text }
}

/** Valores de ejemplo, en el orden de las variables, para pedir la plantilla. */
export function messageExamples(spec: AutomationMessage): string[] {
  return spec.variables.map((name) => MESSAGE_VARIABLES[name].example)
}

// ------------------------------------------------ botones de respuesta ---

const REPLY_PREFIX = "odentia"

/** Lo que devuelve un botón cuando la persona lo toca: acción y trabajo que lo originó. */
export function replyId(action: ReplyAction, jobId: string): string {
  return `${REPLY_PREFIX}:${action}:${jobId}`
}

export function parseReplyId(value: string | null | undefined): { action: ReplyAction; jobId: string } | null {
  if (!value) return null
  const [prefix, action, jobId, ...rest] = value.split(":")
  if (prefix !== REPLY_PREFIX || rest.length > 0 || !jobId) return null
  if (!(REPLY_ACTIONS as readonly string[]).includes(action ?? "")) return null
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null
  return { action: action as ReplyAction, jobId }
}
