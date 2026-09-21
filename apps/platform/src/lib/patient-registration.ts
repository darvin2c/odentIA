import type { RegistrationAnswers, RegistrationConfig } from "@odentia/clinical"
import { API_URL } from "./auth-client"
import { ApiError, apiFetch } from "./api"

/** Contexto público resuelto por el servidor: genérico o conversación. */
export type PublicRegistrationContext =
  | { kind: "generic" }
  | { kind: "conversation" }

export interface PublicRegistrationInfo {
  organization: { name: string; logo: string | null }
  config: RegistrationConfig
  today: string
  context: PublicRegistrationContext
}

export interface RegistrationConfigResponse {
  data: RegistrationConfig
  meta: { today: string }
}

export interface SaveRegistrationConfigInput {
  expectedVersion: number
  enabled: boolean
  fields: RegistrationConfig["fields"]
  privacyNotice: string
}

export interface PublicSubmitInput {
  submissionId: string
  formVersion?: number
  token?: string
  entryPoint: "qr" | "public_link"
  answers: RegistrationAnswers
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

async function publicFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!response.ok) await throwPublicError(response)
  return (await response.json()) as T
}

/** Ficha pública: sin sesión ni header organizativo. */
export async function fetchPublicRegistration(
  slug: string,
  token?: string,
): Promise<{ data: PublicRegistrationInfo }> {
  const base = `${API_URL}/api/public/patient-registration/${encodeURIComponent(slug)}`
  const url = token !== undefined ? `${base}?token=${encodeURIComponent(token)}` : base
  return publicFetch<{ data: PublicRegistrationInfo }>(url)
}

/** Envío público: sin sesión ni header organizativo. */
export async function submitPublicRegistration(
  slug: string,
  input: PublicSubmitInput,
): Promise<{ data: { registered: boolean } }> {
  return publicFetch<{ data: { registered: boolean } }>(
    `${API_URL}/api/public/patient-registration/${encodeURIComponent(slug)}`,
    { method: "POST", body: JSON.stringify(input) },
  )
}

/** Configuración privada (requiere sesión de la organización). */
export async function fetchRegistrationConfig(): Promise<RegistrationConfigResponse> {
  return apiFetch<RegistrationConfigResponse>("/api/patient-registration/config")
}

export async function saveRegistrationConfig(
  input: SaveRegistrationConfigInput,
): Promise<{ data: RegistrationConfig }> {
  return apiFetch<{ data: RegistrationConfig }>("/api/patient-registration/config", {
    method: "PUT",
    body: JSON.stringify(input),
  })
}

export async function createRegistrationLink(
  contactId: string,
  conversationId: string,
): Promise<{ data: { url: string; expiresAt: string } }> {
  return apiFetch<{ data: { url: string; expiresAt: string } }>(
    `/api/contacts/${encodeURIComponent(contactId)}/registration-links`,
    { method: "POST", body: JSON.stringify({ conversationId }) },
  )
}
