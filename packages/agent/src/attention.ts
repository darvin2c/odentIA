/**
 * Lo que Recepción lee de su conversación en cada turno (ADR 0104): la
 * atención en curso entera, no una ventana fija de mensajes. En WhatsApp la
 * gente escribe en pedazos: veinte mensajes eran tres o cuatro vueltas, y con
 * más Sofi volvía a pedir el nombre, la hora o el motivo porque ya no los veía.
 *
 * Y cómo va esa atención, leído de sus fuentes y no de la memoria del modelo:
 * la indicación de cada turno dice lo que falta, no lo que ya se hizo.
 */
import { ATTENTION_OPENING_MS, type AgentCaseState, normalizeForSearch } from "@odentia/services"

/** Lo que lee siempre, aunque la atención recién empiece: el aviso de cita que la persona responde. */
export const HISTORY_MIN_TAIL = 20
/** Mensajes que se leen de la base por turno, los más recientes. */
export const HISTORY_MAX_MESSAGES = 300
/**
 * Tope por tamaño de lo que el modelo lee del hilo: unas 6 000 palabras, mucho
 * más que una atención por WhatsApp. Pasado el tope se conservan el comienzo
 * y lo último, y el contexto dice cuántos mensajes quedaron fuera.
 */
export const HISTORY_CHARS = 24_000
/** Con la atención recortada, los primeros mensajes que se conservan: por qué escribió. */
export const HISTORY_HEAD = 4

/** Lo que pesa un mensaje en el historial: su texto y el sello de cuándo se dijo. */
const weight = (item: { body: string | null }): number => (item.body?.length ?? 0) + 40

/**
 * Acota el historial al tope sin cortarlo a ciegas: si no cabe entero, quedan
 * los primeros `head` (cómo empezó la atención) y los últimos que caben, y se
 * cuenta cuántos del medio no van. El último mensaje va siempre: es el que se
 * responde.
 */
export function fitHistory<T extends { body: string | null }>(
  items: T[],
  budget = HISTORY_CHARS,
  head = HISTORY_HEAD,
): { items: T[]; omitted: number } {
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  if (total <= budget || items.length <= head + 1) return { items, omitted: 0 }
  const first = items.slice(0, head)
  let room = budget - first.reduce((sum, item) => sum + weight(item), 0)
  const last: T[] = []
  for (let index = items.length - 1; index >= head; index -= 1) {
    const item = items[index]
    if (!item || (last.length > 0 && weight(item) > room)) break
    last.unshift(item)
    room -= weight(item)
  }
  return { items: [...first, ...last], omitted: items.length - first.length - last.length }
}

/** Lo de una cita que se propone o se hace en la conversación. */
const APPOINTMENT_ACTIONS = new Set(["reservar_cita", "reprogramar_cita", "cancelar_cita"])

/** Cómo va la atención en curso, contado por el código (ADR 0104). */
export interface AttentionProgress {
  /** Mensajes que ya le salieron a su nombre en esta atención (también lo automático). */
  replies: number
  /** Ya buscó horarios en esta atención (su consulta sigue a la vista). */
  offered: boolean
  /** La cita propuesta que espera su sí: «Reservar cita — Cita: …». */
  pending: string | null
  /** Lo último que quedó hecho con su cita en esta atención. */
  done: string | null
  /** Promociones vigentes que ya nombró en esta atención. */
  promotions: string[]
}

/**
 * Cómo va la atención: cuántas veces le respondió, si ya ofreció horarios, qué
 * espera su sí, qué quedó hecho y qué promociones ya nombró. Sale de los
 * mensajes que lee, del estado del caso y de las promociones de la clínica.
 */
export function attentionProgress(input: {
  items: Array<{ direction: string; senderKind: string; body: string | null; createdAt?: string }>
  startedAt: string
  state: Pick<AgentCaseState, "pending" | "recent" | "lookups">
  promotions: string[]
}): AttentionProgress {
  const opened = Date.parse(input.startedAt) - ATTENTION_OPENING_MS
  const inAttention = (at: string | undefined) => !at || Date.parse(at) >= opened
  const said = input.items.filter((item) => item.direction === "out" && item.senderKind === "agent" && inAttention(item.createdAt))
  const spoken = said.map((item) => normalizeForSearch(item.body ?? "")).join("\n")
  const describe = (item: { label: string; summary: string }) => `${item.label} — ${item.summary}`
  const pending = input.state.pending.find((item) => APPOINTMENT_ACTIONS.has(item.action))
  const done = input.state.recent.find((item) => item.status === "ejecutada" && APPOINTMENT_ACTIONS.has(item.action) && inAttention(item.at))
  return {
    replies: said.length,
    offered: input.state.lookups.some((item) => item.tool === "buscar_huecos" && inAttention(item.at)),
    pending: pending ? describe(pending) : null,
    done: done ? describe(done) : null,
    promotions: input.promotions.filter((name) => {
      const key = normalizeForSearch(name).trim()
      return key.length > 0 && spoken.includes(key)
    }),
  }
}

/**
 * Lo que cambia de un turno a otro en cómo se presenta y lo que ya ofreció:
 * el manual dice la regla una vez y aquí va si ya se cumplió.
 */
export function attentionLines(progress: AttentionProgress, persona: string): string[] {
  const lines = [
    progress.replies === 0
      ? `Es tu primera respuesta en esta atención: preséntate como ${persona} en una frase.`
      : "Ya le respondiste en esta atención: no te presentes ni vuelvas a saludar; ve directo a lo que pide.",
  ]
  if (progress.promotions.length) {
    const named = progress.promotions.map((name) => `«${name}»`).join(" y ")
    const one = progress.promotions.length === 1
    lines.push(
      `Ya le ofreciste en esta atención ${one ? "la promoción" : "las promociones"} ${named}: no ${one ? "la" : "las"} repitas salvo que vuelva a preguntar por el precio.`,
    )
  }
  return lines
}
