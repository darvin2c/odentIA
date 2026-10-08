import type { ApiErrorShape } from "@odentia/ui-patterns"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { API_URL } from "./auth-client"
import { orgSlugFromHostname, requestHostname } from "./host"

export class ApiError extends Error {
  shape: ApiErrorShape
  status: number

  constructor(status: number, shape: ApiErrorShape) {
    super(shape.message ?? `Error ${status}`)
    this.status = status
    this.shape = shape
  }
}

/**
 * Cookie de la petición entrante. En SSR el fetch corre en Node y no ve las del
 * navegador: la API necesita la sesión para resolver la organización.
 */
const ssrCookie = createIsomorphicFn()
  .server(() => getRequestHeaders().get("cookie"))
  .client(() => null)

/**
 * Cabeceras de contexto: el tenant del host —en SSR la cabecera del request, en
 * el navegador `location`; sin él la API no sabe de qué organización es la ruta—
 * y, en SSR, la cookie de sesión.
 */
function contextHeaders(): Record<string, string> {
  const slug = orgSlugFromHostname(requestHostname())
  const cookie = ssrCookie()
  return {
    ...(slug ? { "x-odentia-org": slug } : {}),
    ...(cookie ? { cookie } : {}),
  }
}

/** Fetch a la API con cookies de sesión y slug de tenant del host; errores en forma ApiErrorShape. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...contextHeaders(),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let shape: ApiErrorShape = {}
    try {
      const body = (await response.json()) as { error?: ApiErrorShape }
      shape = body.error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  return (await response.json()) as T
}

/** Descarga binaria autenticada (p. ej. un DICOM para el visor). */
export async function apiFetchBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: contextHeaders(),
  })
  if (!response.ok) {
    let shape: ApiErrorShape = {}
    try {
      const body = (await response.json()) as { error?: ApiErrorShape }
      shape = body.error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  return response.arrayBuffer()
}

/** POST multipart (adjuntos) con cookies de sesión y slug de tenant del host. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: contextHeaders(),
    body: form,
  })
  if (!response.ok) {
    let shape: ApiErrorShape = {}
    try {
      const body = (await response.json()) as { error?: ApiErrorShape }
      shape = body.error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  return (await response.json()) as T
}
