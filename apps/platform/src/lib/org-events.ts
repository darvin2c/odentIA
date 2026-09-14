import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { API_URL } from "./auth-client";

const orgRouteApi = getRouteApi("/_org");

export type StreamState = "connecting" | "open" | "closed";

/**
 * Suscripción SSE a /api/notifications/stream. Reconnect automático del
 * EventSource (con replay por Last-Event-ID en el servidor). `onEvent`
 * recibe el kind y típicamente invalida queries de react-query.
 */
export function useOrgEvents(kinds: string[], onEvent: (kind: string, data: unknown) => void): StreamState {
  const { org } = orgRouteApi.useRouteContext();
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/notifications/stream?org=${org.slug}`, {
      withCredentials: true,
    });
    source.onopen = () => setState("open");
    source.onerror = () => setState("closed");
    const handler = (kind: string) => (event: MessageEvent) => {
      let data: unknown = null;
      try {
        data = JSON.parse(event.data as string) as unknown;
      } catch {
        // payload vacío (ping u otros)
      }
      onEvent(kind, data);
    };
    for (const kind of kinds) {
      source.addEventListener(kind, handler(kind));
    }
    return () => source.close();
    // onEvent estable vía ref del caller si hace falta; kinds fijos por página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.slug]);

  return state;
}
