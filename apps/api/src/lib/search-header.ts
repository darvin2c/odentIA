import type { MiddlewareHandler } from "hono"
import { errorBody } from "./error.js"

/** La cabecera con lo buscado (la misma de `searchOutOfPath` en la pantalla). */
export const SEARCH_HEADER = "x-odentia-q"

/**
 * Lo buscado (un nombre, un teléfono) llega en una cabecera, no en la dirección, que queda en los
 * registros del proxy (QA de la ficha del 10 nov, M4): se vuelve a poner como `q` antes de que la
 * ruta lo lea, solo dentro del proceso. Cada ruta sigue leyendo `q` como siempre.
 */
export function searchFromHeader(): MiddlewareHandler {
  return async (c, next) => {
    const sent = c.req.header(SEARCH_HEADER)
    if (sent !== undefined && c.req.method === "GET") {
      let q: string
      try {
        q = decodeURIComponent(sent)
      } catch {
        return c.json(errorBody(c, "VALIDATION", "La búsqueda no se pudo leer"), 400)
      }
      const url = new URL(c.req.url)
      url.searchParams.set("q", q)
      c.req.raw = new Request(url, c.req.raw)
      c.header("Cache-Control", "no-store")
    }
    await next()
  }
}
