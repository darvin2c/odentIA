import { useSyncExternalStore } from "react"
import { RUBROS, type RubroId } from "./datos"
import { estado, setRol, setRubro } from "./tienda"

/**
 * Las direcciones del prototipo van tras «#» (se publica como archivos sueltos):
 * `#/<rubro>/catalogo/<producto>` y `?ventas=1` para verlo como Ventas.
 */
export interface Ruta {
  rubro: RubroId
  path: string
  ventas: boolean
  q: URLSearchParams
}

function parse(): Ruta {
  const raw = location.hash.replace(/^#/, "") || "/calzado/catalogo"
  const [pathPart, query = ""] = raw.split("?")
  const parts = (pathPart ?? "").split("/").filter(Boolean)
  const rubro = (parts[0] && parts[0] in RUBROS ? parts[0] : "calzado") as RubroId
  const rest = parts[0] && parts[0] in RUBROS ? parts.slice(1) : parts
  const q = new URLSearchParams(query)
  return { rubro, path: `/${rest.join("/") || "catalogo"}`, ventas: q.get("ventas") === "1", q }
}

let actual = parse()
const subs = new Set<() => void>()
function sync() {
  actual = parse()
  const s = estado()
  if (s.rubro !== actual.rubro) setRubro(actual.rubro)
  if ((s.rol === "ventas") !== actual.ventas) setRol(actual.ventas ? "ventas" : "dueno")
  for (const f of subs) f()
}
window.addEventListener("hashchange", sync)
sync()

export function useRuta(): Ruta {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => actual,
  )
}

/** La dirección de un lugar del prototipo, conservando el rubro y el rol de ahora. */
export function href(
  path: string,
  o: { rubro?: RubroId; ventas?: boolean; extra?: string } = {},
): string {
  const r = o.rubro ?? actual.rubro
  const v = o.ventas ?? actual.ventas
  const qs = [v ? "ventas=1" : "", o.extra ?? ""].filter(Boolean).join("&")
  return `#/${r}${path}${qs ? `?${qs}` : ""}`
}

export function ir(path: string, o: Parameters<typeof href>[1] = {}) {
  location.hash = href(path, o).slice(1)
  window.scrollTo({ top: 0 })
}
