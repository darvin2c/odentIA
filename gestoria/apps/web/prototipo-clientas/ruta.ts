import { useSyncExternalStore } from "react"
import { RUBROS, type RubroId } from "./datos"

/**
 * Las direcciones del prototipo van tras «#» (se publica como archivos sueltos):
 * `#/<rubro>/clientes/<id>`, `#/<rubro>/argos/hara` y `?ventas=1` para verlo como Ventas.
 */
export interface Ruta {
  rubro: RubroId
  path: string
  ventas: boolean
}

function parse(): Ruta {
  const raw = location.hash.replace(/^#/, "") || "/calzado/clientes"
  const [pathPart, query = ""] = raw.split("?")
  const parts = (pathPart ?? "").split("/").filter(Boolean)
  const rubro = (parts[0] && parts[0] in RUBROS ? parts[0] : "calzado") as RubroId
  const rest = parts[0] && parts[0] in RUBROS ? parts.slice(1) : parts
  return {
    rubro,
    path: `/${rest.join("/") || "clientes"}`,
    ventas: new URLSearchParams(query).get("ventas") === "1",
  }
}

let actual = parse()
const subs = new Set<() => void>()
window.addEventListener("hashchange", () => {
  actual = parse()
  for (const f of subs) f()
})

export function useRuta(): Ruta {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => actual,
  )
}

export function href(path: string, o: { rubro?: RubroId; ventas?: boolean } = {}): string {
  const r = o.rubro ?? actual.rubro
  const v = o.ventas ?? actual.ventas
  return `#/${r}${path}${v ? "?ventas=1" : ""}`
}

export function ir(path: string, o: Parameters<typeof href>[1] = {}) {
  location.hash = href(path, o).slice(1)
  window.scrollTo({ top: 0 })
}
