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

/** Una pregunta por el nombre de quien escribe: «¿Con quién tengo el gusto?», «¿me dices tus nombres y apellidos?». */
const ASKS_NAME = /\b(con quien tengo el gusto|tus? nombres?|sus? nombres?|te llamas|your (full )?name|who am i (speaking|talking))\b/
/** Las preguntas de un mensaje, sin el resto: «te registro con tu nombre» no pregunta nada. */
const questionsOf = (body: string): string[] => body.split(/(?<=[.!?\n])\s+/).filter((part) => part.includes("?"))

/** Cuántas preguntas de un mensaje piden el nombre de quien escribe: dos es pedirlo dos veces. */
export function nameQuestionsIn(body: string): number {
  return questionsOf(body).filter((question) => ASKS_NAME.test(normalizeForSearch(question))).length
}

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
  /** Cuántas de sus respuestas en esta atención le preguntaron a quien escribe cómo se llama. */
  namesAsked: number
  /** Ya le habló por su nombre en esta atención (si se sabe cuál es). */
  usedName: boolean
}

/**
 * Cómo va la atención: cuántas veces le respondió, si ya ofreció horarios, qué
 * espera su sí, qué quedó hecho, qué promociones ya nombró y si ya preguntó o
 * usó su nombre. Sale de los mensajes que lee, del estado del caso, de las
 * promociones de la clínica y de la ficha de quien escribe.
 */
export function attentionProgress(input: {
  items: Array<{ direction: string; senderKind: string; body: string | null; createdAt?: string }>
  startedAt: string
  state: Pick<AgentCaseState, "pending" | "recent" | "lookups">
  promotions: string[]
  /** Los nombres de quien escribe, si su ficha los tiene. */
  name?: string | null
}): AttentionProgress {
  const opened = Date.parse(input.startedAt) - ATTENTION_OPENING_MS
  const inAttention = (at: string | undefined) => !at || Date.parse(at) >= opened
  const said = input.items.filter((item) => item.direction === "out" && item.senderKind === "agent" && inAttention(item.createdAt))
  const spoken = said.map((item) => normalizeForSearch(item.body ?? "")).join("\n")
  const describe = (item: { label: string; summary: string }) => `${item.label} — ${item.summary}`
  const pending = input.state.pending.find((item) => APPOINTMENT_ACTIONS.has(item.action))
  const done = input.state.recent.find((item) => item.status === "ejecutada" && APPOINTMENT_ACTIONS.has(item.action) && inAttention(item.at))
  // Basta su primer nombre: «Valeria» por «Valeria Fernanda».
  const firstName = normalizeForSearch(input.name ?? "").split(" ")[0] ?? ""
  return {
    replies: said.length,
    offered: input.state.lookups.some((item) => item.tool === "buscar_huecos" && inAttention(item.at)),
    pending: pending ? describe(pending) : null,
    done: done ? describe(done) : null,
    promotions: input.promotions.filter((name) => {
      const key = normalizeForSearch(name).trim()
      return key.length > 0 && spoken.includes(key)
    }),
    namesAsked: said.filter((item) => nameQuestionsIn(item.body ?? "") > 0).length,
    usedName: firstName.length > 0 && ` ${spoken.replace(/\n/g, " ")} `.includes(` ${firstName} `),
  }
}

/**
 * Lo que cambia de un turno a otro en cómo se presenta, lo que ya ofreció y lo
 * que sabe de quien escribe: el manual dice la regla una vez y aquí va si ya se
 * cumplió. Una falla de «no usó su nombre» o «se lo volvió a pedir» se arregla
 * con este dato contado (auditoría del ADR 0104).
 */
export function attentionLines(
  progress: AttentionProgress,
  persona: string,
  who: { name?: string | null; saves?: boolean } = {},
): string[] {
  const lines = [
    progress.replies === 0
      ? `Es tu primera respuesta en esta atención: preséntate como ${persona} en una frase.`
      : "Ya le respondiste en esta atención: no te presentes ni vuelvas a saludar; ve directo a lo que pide.",
  ]
  const save = who.saves ? "guárdalo con update_contact en este mismo paso y " : ""
  if (who.name) {
    if (!progress.usedName) lines.push(`Se llama ${who.name}: aún no le hablaste por su nombre en esta atención; hazlo en esta respuesta.`)
  } else if (progress.namesAsked > 1) {
    lines.push(`Ya le preguntaste cómo se llama ${progress.namesAsked} veces en esta atención: no se lo vuelvas a preguntar. Si ya te lo dijo, ${save}háblale por su nombre.`)
  } else if (progress.namesAsked === 1) {
    // Quien no contestó queda sin nombre: el juez lo pide, pero no en cada mensaje (auditoría del ADR 0104).
    lines.push(
      `Ya le preguntaste cómo se llama en esta atención. Si te lo dijo, ${save}háblale por su nombre; si no te lo dijo, no se lo preguntes en cada mensaje: pídeselo una vez más, con naturalidad, solo cuando haga falta (para reservarle o para pasar su caso).`,
    )
  } else {
    lines.push(
      `Aún no sabes cómo se llama quien escribe ni se lo preguntaste en esta atención: si ya te lo dijo en la conversación, ${save}háblale por su nombre; si no, pregúntaselo al final de esta respuesta, sin frenar lo que pidió.`,
    )
  }
  if (progress.promotions.length) {
    const named = progress.promotions.map((name) => `«${name}»`).join(" y ")
    const one = progress.promotions.length === 1
    lines.push(
      `Ya le ofreciste en esta atención ${one ? "la promoción" : "las promociones"} ${named}: no ${one ? "la" : "las"} repitas salvo que vuelva a preguntar por el precio.`,
    )
  }
  return lines
}
