import type { ApiErrorShape } from "@odentia/ui-patterns"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { z } from "zod"
import { API_URL } from "./auth-client"

export class ApiError extends Error {
  constructor(
    public status: number,
    public shape: ApiErrorShape,
    /**
     * Lo demás que trae el error, tal como llega (por ejemplo `duplicates` de
     * un 409 `CLIENT_MAYBE_DUPLICATE` o `outreachId` de un 502 `SEND_UNKNOWN`):
     * quien lo usa lo valida con su esquema.
     */
    public details: Record<string, unknown> = {},
  ) {
    super(shape.message ?? `Error ${status}`)
  }
}

const envelopeSchema = z.object({ data: z.unknown() })
const errorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      request_id: z.string().optional(),
      fields: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
})

const ssrCookie = createIsomorphicFn()
  .server(() => getRequestHeaders().get("cookie"))
  .client(() => null)

/**
 * Lo buscado (un nombre, un correo, un teléfono) no viaja en la dirección, que queda en los
 * registros del proxy: va en la cabecera que la API vuelve a leer como `q` (QA de la ficha del
 * 10 nov, M4; la misma regla que `searchOutOfPath` del panel).
 */
function searchOutOfPath(path: string, method?: string): { path: string; q: string | null } {
  if ((method && method.toUpperCase() !== "GET") || !path.includes("?")) return { path, q: null }
  const at = path.indexOf("?")
  const params = new URLSearchParams(path.slice(at + 1))
  const q = params.get("q")
  if (q === null) return { path, q: null }
  params.delete("q")
  const rest = params.toString()
  return { path: `${path.slice(0, at)}${rest ? `?${rest}` : ""}`, q }
}

/** Solo reenvía la cookie en SSR, nunca cabeceras de tenant o de autoridad del cliente. */
export async function api<T>(rawPath: string, init?: RequestInit): Promise<T> {
  const { path, q } = searchOutOfPath(rawPath, init?.method)
  const headers = new Headers(init?.headers)
  if (q !== null) headers.set("x-odentia-q", encodeURIComponent(q))
  if (!(init?.body instanceof FormData)) headers.set("content-type", "application/json")
  const cookie = ssrCookie()
  if (cookie) headers.set("cookie", cookie)
  const response = await fetch(`${API_URL}${path}`, { ...init, credentials: "include", headers })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}))
    const parsed = errorSchema.safeParse(body)
    const shape = parsed.success ? (parsed.data.error ?? {}) : {}
    const raw = (body as { error?: unknown } | null)?.error
    const details =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    // A mitad de trabajo la API puede volver a pedir el código (otro país, la
    // marca venció): se lleva a ponerlo, no a «Algo salió mal» (ADR 0090).
    if (
      shape.code === "MFA_REQUIRED" &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/security"
    ) {
      window.location.assign("/security")
    }
    throw new ApiError(response.status, shape, details)
  }
  if (response.status === 204) return undefined as T
  const envelope = envelopeSchema.parse(await response.json())
  return envelope.data as T
}
