import { API_URL } from "./auth-client"
import { ApiError } from "./api"

/** Enlace público de automatizaciones: sin sesión ni header organizativo. */
export interface PublicAutomationLink {
  purpose: "confirm" | "cancel" | "baja"
  /** Fecha/hora de la cita en zona de la sede; null en bajas. Sin datos del paciente. */
  when: string | null
  timeZone: string
  expired: boolean
  used: boolean
  /**
   * En una baja, lo que deja de recibir, con las palabras del servidor
   * (`what` completa «Dejar de recibir…»). Null en los enlaces de una cita;
   * ausente en respuestas antiguas.
   */
  stops?: { what: string; detail: string; keeps: string | null } | null
}

async function throwPublicError(response: Response): Promise<never> {
  let shape: { code?: string; message?: string; request_id?: string } = {}
  try {
    const body = (await response.json()) as { error?: typeof shape }
    shape = body.error ?? {}
  } catch {
    // respuesta no-JSON: shape vacío
  }
  throw new ApiError(response.status, shape)
}

async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!response.ok) await throwPublicError(response)
  return (await response.json()) as T
}

/** Información mínima del enlace de baja (nunca incluye paciente ni contacto). */
export function fetchAutomationLink(scope: "baja", token: string): Promise<{ data: PublicAutomationLink }> {
  return publicFetch(`/api/public/automations/${scope}/${encodeURIComponent(token)}`)
}

/** Ejecuta la baja. */
export function submitAutomationLink(scope: "baja", token: string, _action: "baja"): Promise<{ data: unknown }> {
  return publicFetch(`/api/public/automations/${scope}/${encodeURIComponent(token)}`, { method: "POST" })
}

/**
 * Confirmar o cancelar desde un correo lleva a «Su enlace» (ADR 0037): con el
 * token del correo, aún vigente, el servidor da el enlace de esa persona con
 * esa cita. `url` es nulo si la clínica no tiene dirección pública.
 */
export function personalLinkFromEmail(token: string): Promise<{ data: { token: string; url: string | null } }> {
  return publicFetch(`/api/public/automations/cita/${encodeURIComponent(token)}/enlace`, { method: "POST" })
}
