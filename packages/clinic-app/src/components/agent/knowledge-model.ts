/** Tipos y textos de «Conocimiento»: lo que entrega `/api/agent/knowledge` y cómo se dice en pantalla. */

import type { BranchHours } from "../../lib/branch-hours"

export type KnowledgeState = "borrador" | "programada" | "vigente" | "vencida"

export interface KnowledgeEntry {
  id: string
  kind: string
  title: string
  body: string
  branchId: string | null
  branchName: string | null
  status: string
  state: KnowledgeState
  validFrom: string | null
  validUntil: string | null
  askForms: string[]
  basicKey: string | null
  version: number
  updatedAt: string
  /** Lección propuesta que cambiaría esta respuesta. */
  pendingLessonId: string | null
  /** La creó o la cambió una corrección aprobada. */
  learned: { uses: number } | null
}

export interface KnowledgeRevision {
  version: number
  title: string
  body: string
  createdAt: string
}

/** Una de «Lo que solo tú sabes» (ADR 0120): lo que no está en ningún dato. */
export interface KnowledgeBasicItem {
  key: string
  question: string
  /** Cómo se nombra en una etiqueta: «Pago en cuotas». */
  label: string
  covered: boolean
  entryId: string | null
}

export interface KnowledgeBasics {
  items: KnowledgeBasicItem[]
  covered: number
  total: number
}

export interface KnowledgeGap {
  ids: string[]
  question: string
  count: number
  weekCount: number
  lastAt: string
  conversationId: string
  teamAnswer: string | null
}

/** «Lo que toma de tus datos»: lo que entrega `/api/agent/knowledge/sources` (`getAgentDataSources`). */
export interface KnowledgeSources {
  hours: BranchHours[]
  branches: { total: number; withAddress: number; withPhone: number }
  team: { professionals: number; specialties: number }
  services: { total: number; priced: number; withDuration: number }
  promotions: Array<{ name: string; endsAt: string | null }>
  paymentMethods: string[]
  emergencyPhone: boolean
  /** «Informar» encendido: apagado, no le llegan precios, promociones, equipo ni medios de pago. */
  informs: boolean
}

export const KNOWLEDGE_STATES: KnowledgeState[] = ["vigente", "borrador", "programada", "vencida"]

/** «Publicada» es lo que el agente usa hoy: publicada y dentro de su vigencia. */
export const STATE_LABEL: Record<KnowledgeState, string> = {
  vigente: "Publicada",
  programada: "Programada",
  vencida: "Vencida",
  borrador: "Borrador",
}

export const STATE_FILTER_LABEL: Record<KnowledgeState, string> = {
  vigente: "Publicadas",
  programada: "Programadas",
  vencida: "Vencidas",
  borrador: "Borradores",
}

export const STATE_VARIANT: Record<KnowledgeState, "success" | "outline" | "destructive" | "secondary"> = {
  vigente: "success",
  programada: "outline",
  vencida: "destructive",
  borrador: "secondary",
}

/** Botones compactos en escritorio, de 44 px en teléfono. */
export const TOUCH = "min-h-11 sm:min-h-8"

/**
 * Fecha de la clínica (AAAA-MM-DD) tal cual, sin pasar por la zona del
 * navegador. El año solo se dice cuando no es el actual.
 */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number)
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1)).toLocaleDateString("es", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    ...(year === new Date().getFullYear() ? {} : { year: "numeric" }),
  })
}

/** Hasta cuándo vale: lo que dice la columna de vencimiento. */
export function expiryLabel(entry: Pick<KnowledgeEntry, "state" | "validUntil">): string {
  if (!entry.validUntil) return "Sin vencimiento"
  return `${entry.state === "vencida" ? "Venció" : "Vence"} el ${dayLabel(entry.validUntil)}`
}

export function branchLabel(entry: Pick<KnowledgeEntry, "branchName">): string {
  return entry.branchName ?? "Todas las sedes"
}

function times(total: number): string {
  return total === 1 ? "1 vez" : `${total} veces`
}

/**
 * Segunda línea de una respuesta: por qué el agente no la usa, de dónde salió
 * o cómo más la piden. Nulo si no hay nada que decir.
 */
export function entrySubtitle(entry: KnowledgeEntry): string | null {
  if (entry.state === "borrador") return "Todavía no la usa: está en borrador"
  if (entry.state === "programada" && entry.validFrom) return `Todavía no la usa: vale desde el ${dayLabel(entry.validFrom)}`
  if (entry.state === "vencida") return "Ya no la usa: venció"
  if (entry.learned) {
    return `Aprendida de una corrección · ${entry.learned.uses === 0 ? "sin usar todavía" : `usada ${times(entry.learned.uses)}`}`
  }
  const [first, ...rest] = entry.askForms
  if (!first) return null
  if (rest.length === 0) return `También la piden como «${first}»`
  return `También la piden como «${first}» y ${rest.length === 1 ? "1 forma más" : `${rest.length} formas más`}`
}

/** «4 veces esta semana» solo si pasó esta semana; si no, el total sin decir cuándo. */
export function gapFrequency(gap: Pick<KnowledgeGap, "count" | "weekCount">): string {
  return gap.weekCount > 0 ? `${times(gap.weekCount)} esta semana` : times(gap.count)
}
