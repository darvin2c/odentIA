/**
 * Lo que la IA del prototipo «ve» en una foto: los colores que más pesan en el centro (donde suele
 * estar el producto). Corre en el navegador, sobre la misma foto, sin servidor.
 */

export const isHex = (h: string) => /^#[0-9a-f]{6}$/i.test(h)
export const hexToRgb = (h: string): [number, number, number] => {
  const n = Number.parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
export const dist = (a: string, b: string) => {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return Math.sqrt((r1 - r2) ** 2 * 0.3 + (g1 - g2) ** 2 * 0.59 + (b1 - b2) ** 2 * 0.11)
}
/** Claro u oscuro, para escribir encima. */
export const isLight = (h: string) => {
  const [r, g, b] = hexToRgb(h)
  return r * 0.299 + g * 0.587 + b * 0.114 > 160
}

const cache = new Map<string, Promise<string[]>>()

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => res(img)
    img.onerror = rej
    img.src = src
  })
}

/** Hasta `n` colores distintos, del que más pesa al que menos, tomados del centro de la foto. */
export function palette(src: string, n = 5): Promise<string[]> {
  const k = `${src}|${n}`
  const hit = cache.get(k)
  if (hit) return hit
  const job = load(src)
    .then((img) => {
      const S = 56
      const c = document.createElement("canvas")
      c.width = S
      c.height = S
      const ctx = c.getContext("2d", { willReadFrequently: true })
      if (!ctx) return []
      ctx.drawImage(img, 0, 0, S, S)
      const { data } = ctx.getImageData(0, 0, S, S)
      const buckets = new Map<string, { n: number; r: number; g: number; b: number }>()
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          // El centro pesa más: el producto suele estar ahí y el fondo en los bordes.
          const dx = (x - S / 2) / (S / 2)
          const dy = (y - S / 2) / (S / 2)
          const w = Math.max(0.15, 1 - Math.sqrt(dx * dx + dy * dy))
          const i = (y * S + x) * 4
          const r = data[i]!
          const g = data[i + 1]!
          const b = data[i + 2]!
          const key = `${r >> 4},${g >> 4},${b >> 4}`
          const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
          e.n += w
          e.r += r * w
          e.g += g * w
          e.b += b * w
          buckets.set(key, e)
        }
      const sorted = [...buckets.values()]
        .sort((a, b) => b.n - a.n)
        .map((e) => toHex(e.r / e.n, e.g / e.n, e.b / e.n))
      const out: string[] = []
      for (const h of sorted) {
        if (out.every((o) => dist(o, h) > 34)) out.push(h)
        if (out.length >= n) break
      }
      return out
    })
    .catch(() => [])
  cache.set(k, job)
  return job
}

/** El color de la paleta de una foto más cercano a alguno de los del producto. */
export async function nearestOf(
  src: string,
  colors: { id: string; hex: string }[],
): Promise<string | undefined> {
  const pal = await palette(src, 3)
  let best: { id: string; d: number } | undefined
  for (const h of pal)
    for (const c of colors) {
      const d = dist(h, c.hex)
      if (!best || d < best.d) best = { id: c.id, d }
    }
  return best?.id
}
