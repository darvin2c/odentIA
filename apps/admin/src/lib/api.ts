import type { ApiErrorShape } from "@odentia/ui-patterns"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { z } from "zod"
import { API_URL } from "./auth-client"

export class ApiError extends Error {
  constructor(
    public status: number,
    public shape: ApiErrorShape,
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
      details: z.unknown().optional(),
    })
    .optional(),
})

const ssrCookie = createIsomorphicFn()
  .server(() => getRequestHeaders().get("cookie"))
  .client(() => null)

/** Solo reenvía la cookie en SSR, nunca cabeceras de tenant o de autoridad del cliente. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof FormData)) headers.set("content-type", "application/json")
  const cookie = ssrCookie()
  if (cookie) headers.set("cookie", cookie)
  const response = await fetch(`${API_URL}${path}`, { ...init, credentials: "include", headers })
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => ({})))
    throw new ApiError(response.status, parsed.success ? (parsed.data.error ?? {}) : {})
  }
  if (response.status === 204) return undefined as T
  const envelope = envelopeSchema.parse(await response.json())
  return envelope.data as T
}
