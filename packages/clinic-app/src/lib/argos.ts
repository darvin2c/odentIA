/**
 * Lo que la pantalla le pide al Argos de las vistas (ADR 0075): preguntar, la
 * fila del buscador, fijar en el Resumen, descargar y ver una respuesta con
 * otro periodo o sede (D8 a D16). Las frases, las cifras, el periodo y las
 * opciones para seguir las entrega el servidor; la pantalla solo las dibuja.
 * La conversación vive en el panel y no se guarda (decisiones D2 y D4).
 */
import { useSyncExternalStore } from "react"
import { ApiError, apiDownload, apiFetch, apiLines } from "./api"
import type { ReportQuery } from "./reports"

export type ArgosSentence = Array<{ text: string; strong?: boolean }>

export type ArgosCell = string | number | boolean | null

export interface ArgosTable {
  columns: Array<{ name: string; label: string; kind: "number" | "date" | "timestamp" | "boolean" | "text" }>
  /** Las filas traen también los ids que no se muestran (`paciente_id`): abren la página de la persona. */
  rows: Array<Record<string, ArgosCell>>
  /** Cada celda ya con el formato de la clínica, la misma de la frase. */
  display: Array<Record<string, string>>
  truncated: boolean
}

export interface ArgosShown {
  text: string
  sentence: ArgosSentence
  table: ArgosTable
}

/** El periodo de una respuesta: lo que dice el botón y cómo cambiarlo. */
export interface ArgosPeriod {
  /** `este_mes`, `hoy`, `2026-10`, un rango… o `a_hoy` (sin periodo). */
  value: string
  /** Qué opciones ofrece el selector (D16): de un día, de una semana o las de Reportes. */
  grain: "dia" | "semana" | "mes" | null
  /** El botón o, a hoy, el texto. */
  label: string
  compare: "no" | "anterior" | "año_anterior" | "otro"
  /** Lo que sigue a «Comparado con». */
  compareLabel: string | null
  /** El segundo periodo cuando la pregunta nombra dos (D15). */
  other: { value: string; label: string } | null
  rolling: boolean
  /** Mira hacia adelante (D26): el selector ofrece lo que viene. */
  ahead: boolean
  /** Hoy en la clínica (`AAAA-MM-DD`). */
  today: string
  /** Solo si la respuesta va por sede y hay más de una (D13); `id` null: todas. */
  branch: { id: string | null; options: Array<{ id: string; name: string }> } | null
}

/** Lo que se elige para ver una respuesta: sin valor, lo de la pregunta; `branchId: null`, todas las sedes. */
export interface ArgosChoice {
  period?: string
  other?: string
  branchId?: string | null
  /** El paciente elegido entre los que se llaman igual (D23). */
  patientId?: string
}

/** Un paciente para elegir entre los que se llaman igual: lo que lo distingue, sin datos clínicos. */
export interface ArgosPatientOption {
  id: string
  label: string
}

/** Las pantallas adonde una respuesta puede llevar («Abrir Finanzas»). */
export type ArgosScreen = "finanzas" | "pacientes" | "agenda" | "presupuestos" | "inventario" | "servicios" | "reportes" | "ninguna"

export type ArgosResult =
  | (ArgosShown & {
      kind: "respuesta"
      questionId: string
      title: string
      screen: ArgosScreen
      partial: boolean
      how: string
      missing: string | null
      query: string
      /** Cada opción con su «Así lo calculé» y su consulta: la siguiente pregunta parte de la que se ve. */
      options: Array<{ index: number; label: string; how: string; query: string; answer: ArgosShown }>
      period: ArgosPeriod
      /** De dónde sale (D21): la misma cuenta de Reportes o un cálculo de Argos. */
      source: "oficial" | "argos"
      /** Varios pacientes se llaman como el de la pregunta (D23): se elige antes de ver la respuesta. */
      choose: { message: string; options: ArgosPatientOption[] } | null
      /** Sumó un paquete de preguntas solo («Sumar solas», ADR 0085): lo dice arriba de la respuesta. */
      packAdded?: string | null
    })
  | { kind: "no_existe"; message: string; missing: string | null; closest: (ArgosShown & { query: string }) | null }
  /** `tope`: usó las preguntas del mes; `presupuesto`: la clínica llegó al suyo (ADR 0085). */
  | { kind: "ayuda" | "otro" | "apagado" | "tope" | "presupuesto" | "sin_modelo" | "no_pudo" | "tiempo" | "sin_permiso"; message: string }

/** Las preguntas a Argos del mes, como las dice el panel (tablero C3). */
export interface ArgosAllowance {
  /** Argos está encendido: apagado, no responde y el buscador no lo ofrece como si respondiera. */
  enabled: boolean
  limited: boolean
  used: number
  total: number
  remaining: number
  month: string
  lastDay: string
  packQuestions: number
  packPrice: string | null
  autoPack: boolean
  budgetReached: boolean
  /** Quien mira ve Facturación: puede sumar un paquete. */
  canAdd: boolean
}

export const ARGOS_ALLOWANCE_KEY = ["argos", "allowance"] as const

export function getArgosAllowance(): Promise<ArgosAllowance> {
  return apiFetch<{ data: ArgosAllowance }>("/api/reports/argos/allowance").then((res) => res.data)
}

/** Suma un paquete de preguntas (lo cobra la factura del mes); solo quien ve Facturación. */
export function addArgosPack(orgId: string): Promise<unknown> {
  return apiFetch("/api/account/billing/argos-pack", { method: "POST", body: JSON.stringify({ orgId }) })
}

export interface ArgosAskBody {
  text: string
  /** Desde Reportes, su periodo y su sede (D7); desde el buscador, nada. */
  screen?: ReportQuery
  /** La pregunta anterior y su consulta, para entender «¿y de esos…?» (D3). */
  previous?: { text: string; query: string } | null
  /** La fila ya la decidió el buscador. */
  routed?: boolean
}

/**
 * Pregunta y, mientras Argos trabaja, entrega cada paso (D22): «Busqué
 * «ortodoncia»: …», «Calculé lo cobrado». La respuesta llega al final.
 */
export async function askArgos(body: ArgosAskBody, onStep?: (text: string) => void): Promise<{ data: ArgosResult }> {
  let answer: { data: ArgosResult } | null = null
  let failure: ApiError | null = null
  await apiLines("/api/reports/argos", { method: "POST", body: JSON.stringify(body) }, (line) => {
    const item = line as { step?: string; data?: ArgosResult; error?: { code?: string; message?: string }; status?: number }
    if (typeof item.step === "string") onStep?.(item.step)
    else if (item.data) answer = { data: item.data }
    else if (item.error) failure = new ApiError(item.status ?? 500, item.error)
  })
  if (failure) throw failure
  if (!answer) throw new ApiError(500, {})
  return answer
}

/** «negocio»: primero «Preguntarle a Argos»; «ayuda»: primero la Ayuda; «buscar»: primero los resultados. */
export type ArgosRoute = "negocio" | "ayuda" | "buscar" | "otro"

export function routeArgos(text: string, signal?: AbortSignal): Promise<{ data: { route: ArgosRoute } }> {
  return apiFetch("/api/reports/argos/route", { method: "POST", body: JSON.stringify({ text }), ...(signal ? { signal } : {}) })
}

export function pinArgos(questionId: string, option: number | null, patientId?: string): Promise<{ data: { id: string } }> {
  return apiFetch("/api/reports/argos/pins", { method: "POST", body: JSON.stringify({ questionId, option, ...(patientId ? { patientId } : {}) }) })
}

/** La misma respuesta con otro periodo o sede (D9): la principal y las de seguir, sin el modelo ni el tope. */
export interface ArgosRerun extends ArgosShown {
  how: string
  source: "oficial" | "argos"
  options: Array<{ index: number; label: string; how: string; query: string; answer: ArgosShown }>
  period: ArgosPeriod
}

export function rerunArgos(questionId: string, choice: ArgosChoice): Promise<{ data: ArgosRerun }> {
  return apiFetch(`/api/reports/argos/${questionId}/rerun`, { method: "POST", body: JSON.stringify(choice) })
}

/** Lo que se ve de una respuesta, para pedirlo otra vez (volver a calcular, descargar). */
export function choiceOf(period: ArgosPeriod): ArgosChoice {
  if (period.value === "a_hoy") return {}
  return { period: period.value, ...(period.other ? { other: period.other.value } : {}), ...(period.branch ? { branchId: period.branch.id } : {}) }
}

/** Descarga lo que se ve: la opción, con su periodo y su sede. */
export function downloadArgos(questionId: string, option: number | null, title: string, choice: ArgosChoice = {}): Promise<void> {
  const params = new URLSearchParams()
  if (option !== null) params.set("option", String(option))
  if (choice.period) params.set("period", choice.period)
  if (choice.other) params.set("other", choice.other)
  if (choice.branchId !== undefined) params.set("branch", choice.branchId ?? "todas")
  if (choice.patientId) params.set("patient", choice.patientId)
  const query = params.toString()
  return apiDownload(`/api/reports/argos/${questionId}/csv${query ? `?${query}` : ""}`, `${title}.csv`)
}

/** Lo que el buscador o Reportes le mandan al panel de Argos. */
export const ASK_ARGOS_EVENT = "odentia:preguntar-argos"

export interface ArgosAskEvent {
  question: string
  screen?: ReportQuery
  /** Cómo se dice ese periodo y esa sede en el panel («Octubre de 2026 · Todas las sedes»). */
  screenLabel?: string
  routed?: boolean
  /** Volver a la conversación tal como quedó: no pregunta ni cambia lo de Reportes. */
  resume?: boolean
}

/** La última pregunta de la conversación abierta, para que el buscador ofrezca volver a ella. */
export interface ArgosLastQuestion {
  question: string
  at: string
}

let lastQuestion: ArgosLastQuestion | null = null
const lastListeners = new Set<() => void>()

/** Lo anota el panel de Argos: la conversación vive mientras dura la sesión (D4). */
export function setArgosLastQuestion(next: ArgosLastQuestion | null): void {
  lastQuestion = next
  for (const listener of lastListeners) listener()
}

function subscribeLastQuestion(listener: () => void): () => void {
  lastListeners.add(listener)
  return () => lastListeners.delete(listener)
}

export function useArgosLastQuestion(): ArgosLastQuestion | null {
  return useSyncExternalStore(subscribeLastQuestion, () => lastQuestion, () => null)
}

export function openArgos(detail: ArgosAskEvent): void {
  // Un cuadro después: quien lo abre desde el buscador lo cierra en el mismo
  // clic, y la columna lateral no se ofrece mientras haya un diálogo en pantalla.
  // Sin esperar, Argos salía como cajón en una ventana ancha.
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent<ArgosAskEvent>(ASK_ARGOS_EVENT, { detail })))
}

/** Adónde lleva «Abrir…» de cada pantalla. */
export const ARGOS_SCREEN_LINKS: Record<Exclude<ArgosScreen, "ninguna">, { to: string; label: string }> = {
  finanzas: { to: "/finance", label: "Abrir Finanzas" },
  pacientes: { to: "/people", label: "Abrir Pacientes" },
  agenda: { to: "/agenda", label: "Abrir Agenda" },
  presupuestos: { to: "/reports", label: "Abrir Reportes" },
  inventario: { to: "/inventory", label: "Abrir Inventario" },
  servicios: { to: "/services", label: "Abrir Servicios" },
  reportes: { to: "/reports", label: "Abrir Reportes" },
}
