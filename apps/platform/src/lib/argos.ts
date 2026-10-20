/**
 * Lo que la pantalla le pide al Argos de las vistas (ADR 0073): preguntar, la
 * fila del buscador, fijar en el Resumen y descargar. Las frases, las cifras y
 * las opciones para seguir las entrega el servidor; la pantalla solo las dibuja.
 * La conversación vive en el panel y no se guarda (decisiones D2 y D4).
 */
import { apiDownload, apiFetch } from "./api"
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
      options: Array<{ index: number; label: string; answer: ArgosShown }>
    })
  | { kind: "no_existe"; message: string; missing: string | null; closest: (ArgosShown & { query: string }) | null }
  | { kind: "ayuda" | "otro" | "apagado" | "tope" | "sin_modelo" | "no_pudo" | "tiempo" | "sin_permiso"; message: string }

export interface ArgosAskBody {
  text: string
  /** Desde Reportes, su periodo y su sede (D7); desde el buscador, nada. */
  screen?: ReportQuery
  /** La pregunta anterior y su consulta, para entender «¿y de esos…?» (D3). */
  previous?: { text: string; query: string } | null
  /** La fila ya la decidió el buscador. */
  routed?: boolean
}

export function askArgos(body: ArgosAskBody): Promise<{ data: ArgosResult }> {
  return apiFetch("/api/reports/argos", { method: "POST", body: JSON.stringify(body) })
}

/** «negocio»: primero «Preguntarle a Argos»; «ayuda»: primero la Ayuda; «buscar»: primero los resultados. */
export type ArgosRoute = "negocio" | "ayuda" | "buscar" | "otro"

export function routeArgos(text: string, signal?: AbortSignal): Promise<{ data: { route: ArgosRoute } }> {
  return apiFetch("/api/reports/argos/route", { method: "POST", body: JSON.stringify({ text }), ...(signal ? { signal } : {}) })
}

export function pinArgos(questionId: string, option: number | null): Promise<{ data: { id: string } }> {
  return apiFetch("/api/reports/argos/pins", { method: "POST", body: JSON.stringify({ questionId, option }) })
}

export function downloadArgos(questionId: string, option: number | null, title: string): Promise<void> {
  return apiDownload(`/api/reports/argos/${questionId}/csv${option === null ? "" : `?option=${option}`}`, `${title}.csv`)
}

/** Lo que el buscador o Reportes le mandan al panel de Argos. */
export const ASK_ARGOS_EVENT = "odentia:preguntar-argos"

export interface ArgosAskEvent {
  question: string
  screen?: ReportQuery
  routed?: boolean
}

export function openArgos(detail: ArgosAskEvent): void {
  window.dispatchEvent(new CustomEvent<ArgosAskEvent>(ASK_ARGOS_EVENT, { detail }))
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
