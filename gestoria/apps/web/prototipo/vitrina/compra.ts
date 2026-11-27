import { useEffect, useState } from "react"
import { DISTRITOS, type Dato, GRATIS_DESDE, type Producto, type Rubro } from "../datos"
import { autoUnit, floorUnit, key, money, promoFor } from "../precio"
import type { Usado } from "../sofi"

/**
 * La compra de la prueba: el mismo carrito para la vitrina y el chat (un solo link), lo acordado con
 * Sofi con su plazo real, el pago y el pedido con su única oferta antes de que salga. Todo se calcula
 * con la ficha de ESE momento: cambiar el precio, el mínimo o el stock cambia la prueba.
 */

export interface Linea {
  id: string
  pid: string
  color: string
  size: string
  qty: number
  /** Precio fijo (lo que Sofi sumó después del pago). */
  fijo?: number
}

export interface Msg {
  who: "me" | "so" | "dia"
  text: string
  img?: string
  video?: string
  card?: "carrito" | "pedido"
  btns?: { k: string; label: string }[]
  /** Una respuesta de información: se vuelve a calcular con la ficha de ahora. */
  q?: string
  first?: boolean
}

export interface Hold {
  kind: "envio" | "descuento" | "separo"
  amount: number
  until: number
}

export interface Pedido {
  num: string
  total: number
  at: number
  method: string
  up?: { pid: string; price: number; regular: number; state: "ofrecido" | "sumado" | "pagado" | "no" }
}

export interface Compra {
  items: Linea[]
  dist: number
  hold: Hold | null
  offered: boolean
  priced: boolean
  msgs: Msg[]
  quick: string[]
  order: Pedido | null
  sheet: null | "carrito" | "pago" | "pedido"
  tab: "chat" | "vitrina"
  sel: { color: string; size: string | null }
  /** Lo que usó Sofi en su última respuesta y lo que le faltó. */
  uso: { usados: Usado[]; faltan: { label: string; target: string }[] } | null
}

export function nueva(p: Producto): Compra {
  const color = p.colors.find((c) => p.sizes.some((z) => (p.stock[key(c.id, z)] ?? 0) > 0))?.id ?? p.colors[0]?.id ?? ""
  return {
    items: [],
    dist: 0,
    hold: null,
    offered: false,
    priced: false,
    msgs: [],
    quick: [],
    order: null,
    sheet: null,
    tab: "chat",
    sel: { color, size: null },
    uso: null,
  }
}

export const HR = 3_600_000
let n = 0
export const lid = () => `l${++n}${Date.now().toString(36)}`

/** La hora como se dice aquí: «mañana a las 6:20 p. m.». */
export function cuando(ts: number, ref = Date.now()): string {
  const d = new Date(ts)
  const a = new Date(ref)
  const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86_400_000)
  const h = d.getHours()
  const m = d.getMinutes()
  const t = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "a. m." : "p. m."}`
  return `${day === 0 ? "hoy" : day === 1 ? "mañana" : `el ${d.getDate()}`} a las ${t}`
}
export function reloj(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, "0")).join(":")
}
export function useAhora(ms = 1000) {
  const [t, setT] = useState(Date.now())
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), ms)
    return () => clearInterval(i)
  }, [ms])
  return t
}

export const qtyOf = (c: Compra, pid: string) => c.items.filter((l) => l.pid === pid && !l.fijo).reduce((a, l) => a + l.qty, 0)

export function unidad(p: Producto, l: Linea, c: Compra): number {
  if (l.fijo != null) return l.fijo
  return autoUnit(p, l.color, l.size, qtyOf(c, l.pid))[0]
}

export function cuentas(all: Producto[], c: Compra, now = Date.now()) {
  const P = (id: string) => all.find((x) => x.id === id)
  const lineas = c.items.map((l) => {
    const p = P(l.pid)
    const u = p ? unidad(p, l, c) : 0
    return { l, p, u, total: u * l.qty }
  })
  const sub = lineas.reduce((a, x) => a + x.total, 0)
  const vigente = c.hold && now < c.hold.until ? c.hold : null
  const [lugar, costo] = DISTRITOS[c.dist] ?? DISTRITOS[0]!
  const gratisMonto = sub >= GRATIS_DESDE
  const envio = !c.items.length || c.order ? 0 : gratisMonto || vigente?.kind === "envio" ? 0 : costo
  const desc = vigente?.kind === "descuento" ? vigente.amount : 0
  return { lineas, sub, envio, costoEnvio: costo, lugar, desc, total: Math.max(0, sub - desc + envio), vigente, gratisMonto, falta: Math.max(0, GRATIS_DESDE - sub) }
}

/** El margen de la compra: lo que cada línea puede bajar hasta su mínimo. */
export function margen(all: Producto[], c: Compra) {
  return c.items.reduce((a, l) => {
    const p = all.find((x) => x.id === l.pid)
    if (!p || l.fijo != null) return a
    const [auto] = autoUnit(p, l.color, l.size, qtyOf(c, l.pid))
    return a + Math.max(0, auto - floorUnit(p, auto)) * l.qty
  }, 0)
}

/** La única oferta de Sofi, del mismo margen: envío gratis o soles de menos (o separar, si no hay margen). */
export function plan(p: Producto, all: Producto[], c: Compra) {
  const M = margen(all, c)
  const { costoEnvio, gratisMonto } = cuentas(all, c)
  const envio = p.ofertas.envio && !gratisMonto && costoEnvio > 0 && M >= costoEnvio
  const soles = p.ofertas.soles && M >= 5 ? Math.max(5, Math.floor(M / 2 / 5) * 5) : 0
  if (p.min == null || p.estado === "liquidacion" || (!envio && !soles)) return { kind: "separo" as const, M, envio: 0, soles: 0 }
  return { kind: "eleccion" as const, M, envio: envio ? costoEnvio : 0, soles }
}

/** La palabra para el producto: «la» zapatilla, «el» polo, «los» audífonos. */
export function art(p: Producto) {
  const n = p.name.toLowerCase()
  if (/^(audífonos|aud)/.test(n)) return "los"
  if (/^(zapatilla|sandalia|bailarina|funda|lámpara|taza|manta|bota)/.test(n)) return "la"
  return "el"
}
export const pron = (p: Producto) => ({ la: "la", el: "lo", los: "los", las: "las" })[art(p)]

/** Qué variante pide una frase: «la negra en 38». */
export function variantIn(p: Producto, text: string) {
  const t = text.toLowerCase()
  const color = p.colors.find((c) => t.includes(c.name.toLowerCase()) || t.includes(c.name.toLowerCase().replace(/a$/, "o")))
  const size = p.sizes.find((z) => z !== "Única" && new RegExp(`(^|\\D)${z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`, "i").test(text))
  return { color, size }
}

export function lineaTexto(p: Producto, l: Linea, R: Rubro) {
  const c = p.colors.find((x) => x.id === l.color)
  return `${p.name}${p.colors.length > 1 && c ? ` ${c.name}` : ""}${R.col && l.size !== "Única" ? `, ${R.col.toLowerCase()} ${l.size}` : ""}`
}

/** Lo que diría Sofi en la vitrina, junto a la foto: lo que sí hay, la promoción o cómo calza. */
export function globo(p: Producto, R: Rubro, tpl: Dato[], color: string, size: string | null) {
  const c = p.colors.find((x) => x.id === color)
  if (size) {
    const n = p.stock[key(color, size)] ?? 0
    if (n === 0) {
      const otro = p.colors.find((x) => x.id !== color && (p.stock[key(x.id, size)] ?? 0) > 0)
      if (otro) return { text: `En ${otro.name} sí hay ${size}.`, action: { label: `Ver en ${otro.name}`, color: otro.id } }
      return { text: `Se agotó la ${size}. ¿Te aviso cuando vuelva?`, action: null }
    }
    if (n <= 3) return { text: `${n === 1 ? "Queda 1" : `Quedan ${n}`} en tu ${size}${c && p.colors.length > 1 ? ` en ${c.name}` : ""}.`, action: null }
  }
  const pr = p.promos.find((x) => promoFor(p, color, x.alcance.startsWith("col:") ? x.alcance.slice(4) : size ?? "") === x)
  if (pr) return { text: `${pr.nombre}: ${pr.pct} % menos hasta el ${Number(pr.hasta.split("-")[2])}.`, action: null }
  const horma = p.datos.horma ? `Calza ${String(p.datos.horma).toLowerCase()}` : ""
  const ancho = p.datos.ancho === "Una talla más" ? "; con pie ancho, pide una talla más" : ""
  if (horma) return { text: `${horma}${ancho}.`, action: null }
  const d = tpl.find((x) => x.need && typeof p.datos[x.id] === "string" && p.datos[x.id])
  if (d) return { text: `${d.label}: ${String(p.datos[d.id]).toLowerCase()}.`, action: null }
  return { text: `Pregúntame lo que quieras de ${art(p)} ${p.name.toLowerCase()}.`, action: null }
}

export const DIST_TXT = (i: number) => {
  const [d, c] = DISTRITOS[i] ?? DISTRITOS[0]!
  return { d, c, txt: c ? money(c) : "Gratis" }
}
