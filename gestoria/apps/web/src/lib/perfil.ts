import { storeToday } from "./pedidos"

/**
 * El perfil de la clienta (ADR 0240): lo que Argos sabe de ella, cada dato con su fuente, y
 * cuándo se le puede escribir. Los tipos son los del servidor (`GET /api/tiendas/:id/clientes/:id`
 * devuelve `customer.profile`); aquí solo se dicen. Lo que corrige una persona queda suyo: Argos
 * no lo vuelve a pisar.
 */

export type CustomerFactKey =
  | "medida"
  | "distrito"
  | "cumpleanos"
  | "canal"
  | "instagram"
  | "gustos"
export type FactSource = "chat" | "pedido" | "respuesta" | "tienda"
export type ProfileChannel = "whatsapp" | "instagram" | "messenger"
export type ConsentState = "si" | "no" | "baja" | "sin_preguntar"

export interface FactStep {
  value: string
  source: FactSource
  quote: string | null
  orderNumber: string | null
  /** null: lo anotó Argos. */
  byName: string | null
  at: string
}

export interface ProfileFact {
  key: CustomerFactKey
  label: string
  /** Como se lee («14 de marzo»). */
  value: string
  /** Como se guarda y se corrige («--03-14»). */
  raw: string
  source: FactSource
  quote: string | null
  orderNumber: string | null
  at: string
  byName: string | null
  /** Otros valores que también dijo: está «Por confirmar» hasta que una persona elige. */
  /** Las otras posibilidades: como se leen y como se guardan (lo que se envía al elegir una). */
  alternatives: { value: string; raw: string }[]
  history: FactStep[]
}

export interface CustomerProfile {
  /** «Talla de calzado», «Talla», «Tono»…: lo que mide la tienda. */
  measureLabel: string
  facts: Partial<Record<CustomerFactKey, ProfileFact>>
  consent: {
    state: ConsentState
    quote: string | null
    at: string | null
    channel: ProfileChannel | null
  }
  channels: ProfileChannel[]
  /** Soporte mira sin corregir. */
  canCorrect: boolean
}

/** Las dos columnas de «Lo que Argos sabe de ella», en su orden, con lo que se dice sin el dato. */
export const FACT_COLUMNS: { key: CustomerFactKey; label: string | null; empty: string }[][] = [
  [
    { key: "medida", label: null, empty: "Todavía no lo dijo" },
    { key: "distrito", label: "Distrito", empty: "Sin entregas todavía" },
    { key: "cumpleanos", label: "Cumpleaños", empty: "Solo si ella lo dice" },
  ],
  [
    { key: "canal", label: "Canal preferido", empty: "Argos lo anota cuando lo diga" },
    { key: "instagram", label: "Instagram", empty: "No escribió por Instagram" },
    { key: "gustos", label: "Lo que le gusta", empty: "Argos lo anota cuando lo diga" },
  ],
]

export const PROFILE_CHANNELS: Record<ProfileChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** «26 set», con el día de la tienda; con el año si no es el de hoy. */
export function shortDate(iso: string, timeZone: string, today = storeToday(timeZone)): string {
  const date = new Date(iso)
  const sameYear = storeToday(timeZone, date).slice(0, 4) === today.slice(0, 4)
  let text: string
  try {
    text = new Intl.DateTimeFormat("es-PE", {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
      timeZone,
    }).format(date)
  } catch {
    text = new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short" }).format(date)
  }
  return text.replace(/\./g, "").replace(/ de /g, " ")
}

/** «09:48», con la hora de la tienda. */
export function clockOf(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }
  try {
    return new Intl.DateTimeFormat("es-PE", { ...options, timeZone }).format(new Date(iso))
  } catch {
    return new Intl.DateTimeFormat("es-PE", options).format(new Date(iso))
  }
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name

/**
 * De dónde salió el dato, en una línea: lo que anotó Argos («Argos lo anotó de sus pedidos · 26
 * set») o lo que corrigió una persona, que Argos no vuelve a pisar.
 */
export function factOrigin(
  fact: Pick<ProfileFact, "source" | "quote" | "at" | "byName">,
  timeZone: string,
  today = storeToday(timeZone),
): { byStore: boolean; text: string } {
  const day = shortDate(fact.at, timeZone, today)
  if (fact.source === "tienda" || fact.byName)
    return {
      byStore: true,
      text: `${fact.byName ? firstName(fact.byName) : "Alguien del equipo"} lo corrigió el ${day}. Argos no lo vuelve a pisar.`,
    }
  if (fact.source === "chat")
    return {
      byStore: false,
      text: fact.quote
        ? `Argos lo anotó del chat del ${day}: «${fact.quote}»`
        : `Argos lo anotó del chat · ${day}`,
    }
  return {
    byStore: false,
    text: `Argos lo anotó ${fact.source === "pedido" ? "de sus pedidos" : "de cómo responde"} · ${day}`,
  }
}

/** Un paso del historial: cuándo, quién y de dónde («26 set · Argos · del pedido 0147»). */
export function stepText(step: FactStep, timeZone: string, today = storeToday(timeZone)): string {
  const where =
    step.source === "tienda"
      ? "lo corrigió a mano"
      : step.source === "chat"
        ? step.quote
          ? `del chat: «${step.quote}»`
          : "del chat"
        : step.source === "pedido"
          ? step.orderNumber
            ? `del pedido ${step.orderNumber}`
            : "de sus pedidos"
          : "de cómo responde"
  return [shortDate(step.at, timeZone, today), step.byName ?? "Argos", where].join(" · ")
}

/** La insignia de «Promociones». */
export function consentBadge(state: ConsentState): {
  label: string
  variant: "success" | "destructive" | "outline"
} {
  switch (state) {
    case "si":
      return { label: "Acepta", variant: "success" }
    case "baja":
      return { label: "Pidió que no le escriban", variant: "destructive" }
    case "no":
      return { label: "Dijo que no", variant: "outline" }
    default:
      return { label: "Sin permiso todavía", variant: "outline" }
  }
}

/** De dónde sale el permiso: siempre de un mensaje de ella, con lo que dijo. */
export function consentOrigin(
  consent: CustomerProfile["consent"],
  timeZone: string,
  today = storeToday(timeZone),
): string | null {
  if (consent.state === "sin_preguntar") return null
  const verb =
    consent.state === "si" ? "Aceptó" : consent.state === "baja" ? "Pidió la baja" : "Dijo que no"
  const where = consent.at
    ? `en el chat del ${shortDate(consent.at, timeZone, today)}`
    : "en el chat"
  return `${verb} ${where}${consent.quote ? `: «${consent.quote}»` : ""}`
}

/**
 * «Por dónde»: Meta deja escribir primero solo por WhatsApp. Sin ningún chat todavía, nada.
 */
export function channelsWhere(channels: ProfileChannel[]): string | null {
  if (channels.includes("whatsapp")) return "WhatsApp"
  if (channels.length === 0) return null
  const names = channels.map((c) => PROFILE_CHANNELS[c])
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : names[0]
  return `Solo ${list}: ahí no se le puede escribir primero`
}

export const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const

/** Días de cada mes, contando el 29 de febrero: el cumpleaños no tiene año. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** «--03-14» (ISO 8601, día y mes sin año) → { day: "14", month: "3" }; vacío si no se lee. */
export function birthdayParts(raw: string): { day: string; month: string } {
  const match = /^--(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!match) return { day: "", month: "" }
  return { day: String(Number(match[2])), month: String(Number(match[1])) }
}

/** El problema del cumpleaños elegido, o null si se puede guardar. */
export function birthdayProblem(day: string, month: string): string | null {
  if (!day || !month) return "Elige el día y el mes."
  const max = MONTH_DAYS[Number(month) - 1] ?? 0
  if (Number(day) > max) return `${MONTHS[Number(month) - 1]} tiene ${max} días.`
  return null
}

/** Día y mes → «--MM-DD», como se envía. */
export function birthdayValue(day: string, month: string): string {
  return `--${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}

/**
 * Una nota del hilo cuando Sofi anota el permiso o la baja (`ConversationView.consentNotes`): lo
 * que quedó en su ficha, con la hora de la tienda.
 */
export interface ConsentNote {
  id: string
  state: "si" | "no" | "baja"
  createdAt: string
  /** El mensaje de ella que la causó (`customer_consent.message_id`). */
  messageId?: string | null
}

export function consentNoteText(
  note: ConsentNote,
  timeZone: string,
  today = storeToday(timeZone),
): string {
  const day =
    storeToday(timeZone, new Date(note.createdAt)) === today
      ? "hoy"
      : `el ${shortDate(note.createdAt, timeZone, today)}`
  const since = `Desde ${day}, ${clockOf(note.createdAt, timeZone)}`
  switch (note.state) {
    case "baja":
      return `Sofi le confirmó y anotó la baja en su ficha. ${since}, no recibe promociones.`
    case "si":
      return `Sofi anotó en su ficha que acepta promociones. ${since}, puede recibirlas.`
    default:
      return "Sofi anotó en su ficha que no quiere promociones."
  }
}

/**
 * El hilo en orden: cada nota va después de lo que Sofi le respondió al mensaje de ella que la
 * causó (`messageId`), como en el chat: ella pide, Sofi confirma y queda anotado. Sin ese mensaje
 * a la vista, va en su hora.
 */
export function threadOf<M extends { id: string; author: string; createdAt: string }>(
  messages: M[],
  notes: ConsentNote[] = [],
): ({ kind: "mensaje"; message: M } | { kind: "nota"; note: ConsentNote })[] {
  const time = (iso: string) => new Date(iso).getTime()
  const ids = new Set(messages.map((m) => m.id))
  const byMessage = new Map<string, ConsentNote[]>()
  const byTime: ConsentNote[] = []
  for (const note of [...notes].sort((a, b) => time(a.createdAt) - time(b.createdAt))) {
    if (note.messageId && ids.has(note.messageId))
      byMessage.set(note.messageId, [...(byMessage.get(note.messageId) ?? []), note])
    else byTime.push(note)
  }
  type Item = { kind: "mensaje"; message: M } | { kind: "nota"; note: ConsentNote }
  const out: Item[] = []
  let waiting: ConsentNote[] = []
  const flush = () => {
    for (const note of waiting) out.push({ kind: "nota", note })
    waiting = []
  }
  for (const message of messages) {
    // Lo que le respondieron termina cuando ella vuelve a escribir.
    if (message.author === "cliente") flush()
    while (byTime[0] && time(byTime[0].createdAt) < time(message.createdAt))
      out.push({ kind: "nota", note: byTime.shift() as ConsentNote })
    out.push({ kind: "mensaje", message })
    waiting.push(...(byMessage.get(message.id) ?? []))
  }
  flush()
  for (const note of byTime) out.push({ kind: "nota", note })
  return out
}
