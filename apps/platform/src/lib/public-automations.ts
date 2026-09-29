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

/** Información mínima del enlace (nunca incluye paciente ni contacto). */
export function fetchAutomationLink(
  scope: "cita" | "baja",
  token: string,
): Promise<{ data: PublicAutomationLink }> {
  return publicFetch(`/api/public/automations/${scope}/${encodeURIComponent(token)}`)
}

/** Ejecuta la acción del enlace (confirmar, cancelar o baja). */
export function submitAutomationLink(
  scope: "cita" | "baja",
  token: string,
  action: "confirmar" | "cancelar" | "baja",
): Promise<{ data: unknown }> {
  const suffix = scope === "cita" ? `/${action}` : ""
  return publicFetch(`/api/public/automations/${scope}/${encodeURIComponent(token)}${suffix}`, {
    method: "POST",
  })
}
