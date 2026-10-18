import { AGENT_CASE_ROW, urgencyWord } from "./agent"
import type { ConversationAttention, ConversationClosure, InboxTopic, ResolvePreview } from "./crm"
import { timeAgo } from "./crm"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

/**
 * En qué está una conversación, en palabras, con lo que entrega el servidor
 * (`attention` y `closure`). La pantalla no deduce nada: lo que el servidor no
 * dice, no se escribe. El tono acompaña al texto y nunca lo reemplaza.
 */
export type ConversationTone = "urgent" | "team" | "waiting" | "patient" | "agent" | "closed"

export interface ConversationWords {
  text: string
  tone: ConversationTone
}

/** Cómo se dice el motivo de cierre, con quién lo cerró si fue una persona. */
export function closureWords(closure: ConversationClosure): string {
  switch (closure.reason) {
    case "resuelta":
      return "Cerrada por el agente · resuelta"
    case "sin_respuesta":
      return "Cerrada por el agente · sin respuesta del paciente"
    case "equipo":
      return closure.byName ? `Resuelta por ${closure.byName}` : "Resuelta por el equipo"
    case "manual":
      return closure.byName ? `Cerrada por ${closure.byName}` : "Cerrada"
  }
}

/** «hace 3 h», «ayer»… con la utilidad de la Bandeja; «ahora» se dice como un momento. */
function since(iso: string): string {
  const ago = timeAgo(iso)
  if (!ago) return ""
  return ago === "ahora" ? "hace un momento" : ago
}

/**
 * La palabra de la fila y de la cabecera del hilo (ADR 0049). Orden: cerrada;
 * su tema más urgente (de quién es: nadie, tú u otra persona); sin responder y
 * sin el agente; espera al paciente; la atiende el agente. Sin `attention`
 * (respuesta antigua en caché) una abierta no dice nada. El color sigue la
 * regla de la Bandeja: ámbar lo que pide a una persona, rojo solo «Ahora»,
 * turquesa lo que hace el agente y gris lo demás.
 */
export function conversationWords(input: {
  status: string
  attention?: ConversationAttention | null
  closure?: ConversationClosure | null
  /** Quien mira: un tema suyo se dice «Lo tienes tú». */
  myUserId?: string | null
}): ConversationWords | null {
  if (input.closure) return { text: closureWords(input.closure), tone: "closed" }
  if (input.status === "closed") return { text: "Cerrada", tone: "closed" }
  const attention = input.attention
  if (!attention) return null
  const topic = attention.topics?.[0]
  if (topic) return { text: topicWords(topic, input.myUserId ?? null), tone: topic.urgent ? "urgent" : "team" }
  // Sin temas en una respuesta antigua en caché: la urgencia del caso, como antes.
  if (attention.handoffPriority) {
    return {
      text: `${AGENT_CASE_ROW} · ${urgencyWord(attention.handoffPriority)}`,
      tone: attention.handoffPriority === "alta" ? "urgent" : "team",
    }
  }
  // Solo si el agente la atiende tiene sentido decir que espera.
  if (attention.teamLive && attention.agentAttending) return { text: "Conversa alguien del equipo · el agente espera", tone: "team" }
  // Mismo orden que las pestañas del servidor: esperar al paciente va antes que «Por responder».
  if (attention.pendingContact > 0) return { text: "Espera al paciente · cita propuesta", tone: "patient" }
  if (attention.awaitingPatientSince) {
    const nudged = attention.nudgedAt ? since(attention.nudgedAt) : ""
    return { text: nudged ? `Espera al paciente · se le recordó ${nudged}` : "Espera al paciente", tone: "patient" }
  }
  if (!attention.agentAttending && attention.unanswered === true) {
    return { text: "Por responder · el agente no la atiende", tone: "team" }
  }
  if (attention.agentAttending) {
    return {
      text: attention.outOfHours ? "La atiende el agente · responde al abrir" : "La atiende el agente",
      tone: "agent",
    }
  }
  return null
}

/** De quién es un tema, en una línea: «Te lo pasó el agente · Ahora», «Lo tienes tú», «Lo tiene Luis». */
export function topicWords(topic: InboxTopic, myUserId: string | null): string {
  const again = topic.askedAgainAt ? " · volvió a preguntar" : ""
  if (topic.assigneeUserId && topic.assigneeUserId === myUserId) return `Lo tienes tú${again}`
  if (topic.assigneeUserId) return `Lo tiene ${topic.assigneeName ?? "otra persona"}${again}`
  const who = topic.createdBy === "agent" ? AGENT_CASE_ROW : "Tema sin tomar"
  return `${who} · ${topic.urgent ? "Ahora" : urgencyWord(topic.priority)}${again}`
}

/** El texto del mensaje que originó el tema, en una línea, para la fila y la caja de texto. */
export function topicQuote(topic: InboxTopic, max = 90): string {
  const text = (topic.source?.body ?? topic.reason).replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Clave del día en la zona de la clínica (AAAA-MM-DD) para decir «hoy» o «ayer». */
function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

/**
 * Cuándo pasó algo, corto y en la hora de la clínica: «hoy 09:10», «ayer 18:42»,
 * «12/3 18:42» y, si fue otro año, «12/3/2025 18:42».
 */
export function whenWords(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const timeZone = activeOrgTimeZone()
  const time = date.toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit", timeZone })
  const day = dayKey(date, timeZone)
  if (day === dayKey(now, timeZone)) return `hoy ${time}`
  if (day === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return `ayer ${time}`
  const otherYear = day.slice(0, 4) !== dayKey(now, timeZone).slice(0, 4)
  const date_ = date.toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "numeric",
    ...(otherYear ? { year: "numeric" as const } : {}),
    timeZone,
  })
  return `${date_} ${time}`
}

/**
 * Hora de un mensaje en el hilo: solo la hora si es de hoy («09:10»); si no,
 * con su día como `whenWords` («ayer 18:42», «12/3 18:42»).
 */
export function messageTimeWords(iso: string, now: Date = new Date()): string {
  const words = whenWords(iso, now)
  return words.startsWith("hoy ") ? words.slice("hoy ".length) : words
}

/** Fecha y hora completas en la zona de la clínica, para el título de un mensaje. */
export function fullWhenWords(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString(activeOrgLocale(), { dateStyle: "full", timeStyle: "short", timeZone: activeOrgTimeZone() })
}

/** La franja del hilo cerrado: cómo y cuándo se cerró. */
export function closureBand(closure: ConversationClosure, now: Date = new Date()): string {
  const when = whenWords(closure.at, now)
  return when ? `${closureWords(closure)} · ${when}` : closureWords(closure)
}

/**
 * Lo que dice la confirmación de «Resolver», con lo que devuelve
 * `resolve-preview`: a quién, si se le escribe la despedida y qué más se cierra.
 */
export function resolveWords(name: string, preview: ResolvePreview): { description: string; also: string[] } {
  const description = preview.farewell
    ? `Se cerrará la conversación con ${name}, se le enviará la despedida de la clínica y el agente volverá a atenderla si escribe de nuevo.`
    : `Se cerrará la conversación con ${name}, pero no se le puede escribir: pasaron más de 23 horas desde su último mensaje. Se cerrará sin enviarle nada.`
  return { description, also: pendingWords(preview.handoffs, preview.pendingContact, "resolver") }
}

/** Lo que pasa con lo pendiente del hilo al resolver o al cerrar sin resolver. */
export function pendingWords(handoffs: number, pendingContact: number, how: "resolver" | "cerrar"): string[] {
  const words: string[] = []
  if (handoffs > 0) {
    const what = handoffs === 1 ? "el caso que te pasó el agente" : `los ${handoffs} casos que te pasó el agente`
    words.push(
      how === "resolver"
        ? `También se dará por resuelto ${what}.`
        : `También se cerrará sin resolver ${what}.`,
    )
  }
  if (pendingContact > 0) {
    words.push(
      pendingContact === 1
        ? "Vencerá la cita propuesta que esperaba su sí."
        : `Vencerán las ${pendingContact} citas propuestas que esperaban su sí.`,
    )
  }
  return words
}

/** La confirmación de «Cerrar sin resolver»: no hay despedida y el agente vuelve si escribe. */
export function closeWithoutResolvingWords(name: string): string {
  return `Se cerrará la conversación con ${name} sin enviarle nada. Si vuelve a escribir, la atenderá el agente.`
}

/** «Cerrar la conversación si el paciente no responde»: horas enteras entre 6 y 23. */
export const CLOSE_AFTER_HOURS_MIN = 6
export const CLOSE_AFTER_HOURS_MAX = 23

export function closeAfterHoursIssue(value: string): string | null {
  const text = value.trim()
  const hours = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN
  return hours >= CLOSE_AFTER_HOURS_MIN && hours <= CLOSE_AFTER_HOURS_MAX ? null : "Escribe un número de horas entre 6 y 23."
}
