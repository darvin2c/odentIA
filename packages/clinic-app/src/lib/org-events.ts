import { getRouteApi } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { API_URL } from "./auth-client"

const orgRouteApi = getRouteApi("/_org")

export type StreamState = "connecting" | "open" | "closed"

interface Listener {
  kinds: Set<string>
  onEvent: (kind: string, data: unknown) => void
  onState: (state: StreamState) => void
}

/**
 * Una sola conexión por clínica para toda la pantalla. Antes cada pantalla y
 * algunos componentes abrían la suya (hasta cinco a la vez en la ficha); cada
 * una ocupa una conexión del navegador y otra de Postgres en la API.
 */
interface SharedStream {
  source: EventSource
  state: StreamState
  /** Se cortó: al volver a abrir se avisa `stream.reconnected`. */
  lost: boolean
  listeners: Set<Listener>
  /** Tipos con su `addEventListener` ya puesto en el EventSource. */
  kinds: Set<string>
}
const streams = new Map<string, SharedStream>()

function openStream(slug: string): SharedStream {
  const source = new EventSource(`${API_URL}/api/notifications/stream?org=${slug}`, { withCredentials: true })
  const shared: SharedStream = { source, state: "connecting", lost: false, listeners: new Set(), kinds: new Set() }
  const setState = (state: StreamState) => {
    shared.state = state
    for (const listener of shared.listeners) listener.onState(state)
  }
  source.onopen = () => {
    setState("open")
    // Solo al volver de un corte: los eventos en vivo pueden haberse perdido.
    // La primera vez no, porque cada pantalla acaba de pedir sus datos.
    if (!shared.lost) return
    shared.lost = false
    for (const listener of shared.listeners) listener.onEvent("stream.reconnected", null)
  }
  source.onerror = () => {
    shared.lost = true
    setState("closed")
  }
  return shared
}

function listen(shared: SharedStream, kind: string) {
  if (shared.kinds.has(kind)) return
  shared.kinds.add(kind)
  shared.source.addEventListener(kind, (event: MessageEvent) => {
    let data: unknown = null
    try {
      data = JSON.parse(event.data as string) as unknown
    } catch {
      // payload vacío (ping u otros)
    }
    for (const listener of shared.listeners) if (listener.kinds.has(kind)) listener.onEvent(kind, data)
  })
}

/**
 * Un `message.updated` que solo trae el acuse (entregado, leído): lo muestra el
 * hilo; Inicio, la lista de la Bandeja y el contexto no cambian. Cada mensaje
 * enviado trae dos o tres: recalcularlos en cada pestaña abierta trababa la app.
 */
export function isReceiptOnly(kind: string, data: unknown): boolean {
  return kind === "message.updated" && (data as { receipt?: unknown } | null)?.receipt === true
}

/**
 * Suscripción a /api/notifications/stream. Reconnect automático del
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
    const shared = streams.get(org.slug) ?? openStream(org.slug)
    streams.set(org.slug, shared)
    const wanted = new Set(kindsKey.split("\0").filter((kind) => kind && kind !== "stream.reconnected"))
    const listener: Listener = {
      kinds: wanted,
      onEvent: (kind, data) => callback.current(kind, data),
      onState: setState,
    }
    shared.listeners.add(listener)
    for (const kind of wanted) listen(shared, kind)
    setState(shared.state)
    return () => {
      shared.listeners.delete(listener)
      if (shared.listeners.size > 0) return
      shared.source.close()
      streams.delete(org.slug)
    }
  }, [org.slug, kindsKey])

  return state
}
