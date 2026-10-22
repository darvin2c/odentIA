import { getRouteApi } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { API_URL } from "./auth-client"

const orgRouteApi = getRouteApi("/_org")

export type StreamState = "connecting" | "open" | "closed"

/**
 * Suscripción SSE a /api/notifications/stream. Reconnect automático del
 * EventSource (con replay por Last-Event-ID en el servidor). `onEvent`
 * recibe el kind y típicamente invalida queries de react-query.
 */
export function useOrgEvents(
  kinds: string[],
  onEvent: (kind: string, data: unknown) => void,
): StreamState {
  const { org } = orgRouteApi.useRouteContext()
  const [state, setState] = useState<StreamState>("connecting")
  const callback = useRef(onEvent)
  callback.current = onEvent
  const kindsKey = kinds.join("\0")

  useEffect(() => {
    setState("connecting")
    const source = new EventSource(`${API_URL}/api/notifications/stream?org=${org.slug}`, {
      withCredentials: true,
    })
    source.onopen = () => {
      setState("open")
      // Los eventos solo en vivo pueden haberse perdido durante la desconexión.
      callback.current("stream.reconnected", null)
    }
    source.onerror = () => setState("closed")
    const handler = (kind: string) => (event: MessageEvent) => {
      let data: unknown = null
      try {
        data = JSON.parse(event.data as string) as unknown
      } catch {
        // payload vacío (ping u otros)
      }
      callback.current(kind, data)
    }
    for (const kind of kindsKey.split("\0").filter(kind => kind && kind !== "stream.reconnected")) {
      source.addEventListener(kind, handler(kind))
    }
    return () => source.close()
  }, [org.slug, kindsKey])

  return state
}
