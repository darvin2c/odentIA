import type { ApiErrorShape } from "@odentia/ui-patterns"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { API_URL } from "./auth-client"
import { orgSlugFromHostname, requestHostname } from "./host"
import { apiTransport } from "./ssr-fetch"

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
  const response = await apiTransport(`${API_URL}${path}`, {
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

/**
 * Una respuesta que llega por líneas (NDJSON): cada línea se entrega a
 * `onLine` a medida que llega. Un error antes de empezar va como en `apiFetch`.
 */
export async function apiLines(path: string, init: RequestInit, onLine: (line: unknown) => void): Promise<void> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/x-ndjson", ...contextHeaders(), ...init.headers },
  })
  if (!response.ok || !response.body) {
    let shape: ApiErrorShape = {}
    try {
      const body = (await response.json()) as { error?: ApiErrorShape }
      shape = body.error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  for (;;) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) onLine(JSON.parse(line))
    if (done) break
  }
  if (pending.trim()) onLine(JSON.parse(pending))
}

/** Descarga binaria autenticada (p. ej. un DICOM para el visor). */
export async function apiFetchBytes(path: string, init?: RequestInit): Promise<ArrayBuffer> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...contextHeaders(), ...init?.headers },
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

/**
 * Descarga un archivo de la API (un CSV de Reportes) con la sesión y lo
 * guarda con el nombre que manda el servidor (`content-disposition`).
 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  await saveDownload(await fetch(`${API_URL}${path}`, { credentials: "include", headers: contextHeaders() }), fallbackName)
}

/**
 * Guarda en el teléfono o la computadora el archivo de una respuesta, con el
 * nombre que manda el servidor (`content-disposition`); un error de la API se
 * lanza como `ApiError`. Lo usan también las páginas públicas.
 */
export async function saveDownload(response: Response, fallbackName: string): Promise<void> {
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
  const disposition = response.headers.get("content-disposition") ?? ""
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await response.blob())
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.rel = "noreferrer"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Se libera después del clic: el navegador ya tomó el archivo.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
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
