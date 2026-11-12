/**
 * El cliente de una solicitud de la web o de una cuenta, para que los enlaces
 * de antes (`/waitlist?solicitud=`, `/organizations/<id>`) abran su ficha.
 * Solo lee (`GET /api/admin/clients/lookup`): una cuenta sin cliente (una demo)
 * no tiene ficha de cliente y responde null. Lo que no es «no existe» se lanza.
 */
import { z } from "zod"
import { ApiError, api } from "../../lib/api"

const lookupSchema = z.object({ clientId: z.string() })

/** Lo ya visto en esta pestaña, por un minuto: cambiar de pestaña en la ficha de una demo no vuelve a preguntar. */
const seen = new Map<string, { clientId: string | null; at: number }>()

export async function lookupClient(
  by: { request: string } | { organization: string },
): Promise<string | null> {
  const key = "request" in by ? `request:${by.request}` : `organization:${by.organization}`
  const hit = seen.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.clientId
  const params = new URLSearchParams(
    "request" in by ? { request: by.request } : { organization: by.organization },
  )
  let clientId: string | null
  try {
    clientId = lookupSchema.parse(
      await api<unknown>(`/api/admin/clients/lookup?${params}`),
    ).clientId
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 400)) throw error
    clientId = null
  }
  seen.set(key, { clientId, at: Date.now() })
  return clientId
}
