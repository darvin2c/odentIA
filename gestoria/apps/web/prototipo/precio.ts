import { DISTRITOS, GRATIS_DESDE, HOY, type Producto } from "./datos"

/**
 * Las reglas de precio del prototipo, las mismas de `apps/api/src/precio.ts` en palabras: el precio
 * de la variante o el del producto; la promoción vigente; el precio por cantidad; nunca bajo el
 * mínimo; lo que Sofi cede sale de un solo margen.
 */

export function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—"
  const cents = Math.round(n * 100)
  return cents % 100 ? `S/ ${(cents / 100).toFixed(2).replace(".", ",")}` : `S/ ${Math.round(n)}`
}

export const readNum = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const n = Number.parseFloat(String(v).replace(",", "."))
  return Number.isNaN(n) ? null : n
}

export const key = (color: string, size: string) => `${color}|${size}`

export function basePrice(p: Producto, color: string, size: string): number {
  return p.prices[key(color, size)] ?? p.list
}

export function promoFor(p: Producto, color: string, size: string) {
  return (
    p.promos.find(
      (x) =>
        x.pct > 0 &&
        (!x.desde || x.desde <= HOY) &&
        (!x.hasta || x.hasta >= HOY) &&
        (x.alcance === "todo" || x.alcance === `row:${color}` || x.alcance === `col:${size}`),
    ) ?? null
  )
}

/** El precio sin negociar y por qué: el más bajo entre lista, promoción y precio por cantidad. */
export function autoUnit(p: Producto, color: string, size: string, qty: number): [number, string] {
  const base = basePrice(p, color, size)
  const opts: [number, string][] = [[base, "precio de lista"]]
  const pr = promoFor(p, color, size)
  if (pr) opts.push([Math.round(base * (100 - pr.pct)) / 100, `promoción «${pr.nombre}»`])
  const tier = [...p.tiers]
    .filter((t) => t.desde <= qty && t.precio)
    .sort((a, b) => b.desde - a.desde)[0]
  if (tier) opts.push([tier.precio, `${tier.desde} o más a ${money(tier.precio)}`])
  if (p.mayor && qty >= p.mayor.desde)
    opts.push([p.mayor.precio, `por mayor, desde ${p.mayor.desde}`])
  return opts.sort((a, b) => a[0] - b[0])[0] as [number, string]
}

export const floorUnit = (p: Producto, auto: number) =>
  p.min != null && p.min < auto ? p.min : auto
export const lastCost = (p: Producto) => p.costos[0]?.costo ?? null

export function totalStock(p: Producto): number {
  return p.colors.reduce(
    (n, c) => n + p.sizes.reduce((m, z) => m + (p.stock[key(c.id, z)] ?? 0), 0),
    0,
  )
}
export function soldOut(p: Producto): number {
  return p.colors.reduce(
    (n, c) => n + p.sizes.filter((z) => (p.stock[key(c.id, z)] ?? 0) === 0).length,
    0,
  )
}

export function priceSpan(p: Producto): string {
  const ps = p.colors.flatMap((c) => p.sizes.map((z) => basePrice(p, c.id, z)))
  if (!ps.length) return money(p.list)
  const lo = Math.min(...ps)
  const hi = Math.max(...ps)
  return lo === hi ? money(lo) : `${money(lo)} a ${money(hi)}`
}

export interface Simulacion {
  color: string
  size: string
  qty: number
  auto: number
  why: string
  floor: number
  subtotal: number
  margin: number
  distrito: string
  envio: number
  gratis: boolean
  absorbe: number
  minPaid: number
  cost: number | null
  gan: number | null
}

export function simulate(
  p: Producto,
  s: { qty: number; dist: number; color?: string; size?: string },
): Simulacion {
  const color = s.color ?? p.colors[0]?.id ?? ""
  const size = s.size ?? p.sizes[Math.floor(p.sizes.length / 2)] ?? ""
  const [auto, why] = autoUnit(p, color, size, s.qty)
  const floor = floorUnit(p, auto)
  const subtotal = auto * s.qty
  const margin = Math.max(0, (auto - floor) * s.qty)
  const [distrito, envio] = DISTRITOS[s.dist] ?? DISTRITOS[0]!
  const gratis = subtotal >= GRATIS_DESDE
  const envioCobra = gratis ? 0 : envio
  const absorbe = p.ofertas.envio ? Math.min(envioCobra, margin) : 0
  const minPaid = floor * s.qty + (envioCobra - absorbe)
  const cost = lastCost(p)
  const gan = cost != null ? minPaid - envioCobra - cost * s.qty : null
  return {
    color,
    size,
    qty: s.qty,
    auto,
    why,
    floor,
    subtotal,
    margin,
    distrito,
    envio: envioCobra,
    gratis,
    absorbe,
    minPaid,
    cost,
    gan,
  }
}

/** Una propuesta de precio por cantidad que deje al menos 35 % sobre el costo. */
export function proposeTier(p: Producto) {
  const cost = lastCost(p)
  if (cost == null || !p.list) return null
  const desde = Math.max(2, (p.tiers.at(-1)?.desde ?? 1) + 1)
  const precio = Math.max(Math.ceil(cost * 1.35), Math.round(p.list * 0.85))
  if (precio >= p.list) return null
  return { desde, precio, margen: Math.round(((precio - cost) / precio) * 100) }
}
