/**
 * Lo de «Tu marca» que se calcula en la pantalla (lienzo «gestorIA · Configuración, de nuevo»,
 * tablero 04).
 * Qué nombres del link valen lo decide el servidor (`apps/api/src/marca.ts`); aquí solo se escribe
 * como se guarda, para que nadie tenga que saber quitar una tilde.
 */

/** El color de gestorIA, el de una tienda que no eligió el suyo (`globals.css`). */
export const GESTORIA_COLOR = "#cc4604"

/** Lo que va después del nombre del link. */
export const LINK_DOMAIN = ".gestoria24.com"

/**
 * El nombre del link escrito como se guarda: minúsculas sin tildes (la ñ, n), un guion en lugar de
 * los espacios y de lo que no es letra ni número, sin guiones repetidos ni al empezar. Mientras se
 * escribe se deja el guion del final, para que se pueda seguir con la palabra siguiente.
 */
export function linkFromText(text: string, typing = false): string {
  const clean = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
  return typing ? clean : clean.replace(/-+$/, "")
}

export interface BrandView {
  storeName: string
  publicName: string | null
  brandColor: string | null
  link: string | null
  logo: { version: number } | null
  cover: { version: number } | null
}

/** Lo que el servidor dice del nombre del link mientras se escribe (`checkLinkName`). */
export type LinkCheck =
  // Cada estado aparte: así TypeScript sabe que solo «ocupado» trae sugerencia.
  | { name: string; state: "libre" }
  | { name: string; state: "tuyo" }
  | { name: string; state: "vigente" }
  | { name: string; state: "no-vale"; message: string }
  | { name: string; state: "ocupado"; message: string; suggestion: string | null }

/** Desde aquí un logo se ve nítido en el catálogo; más chico, se avisa y se deja seguir. */
export const MIN_LOGO_SIDE = 512

/** Lo que se puede soltar, elegir o pegar como logo. El SVG se pasa a imagen antes de subir. */
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]
/** La portada es una foto: sin SVG. */
export const COVER_TYPES = ["image/png", "image/jpeg", "image/webp"]
/** Lo más que pesa lo que se elige (se achica antes de subir), como en `ImageAdjust`. */
const MAX_PICK_BYTES = 20 * 1024 * 1024

/** Qué tiene mal un archivo para ser el logo o la portada, dicho a la persona; null si vale. */
export function pickProblem(file: { type: string; size: number }, kind: "logo" | "portada") {
  const types = kind === "logo" ? LOGO_TYPES : COVER_TYPES
  if (!types.includes(file.type))
    return kind === "logo"
      ? "Ese archivo no es una imagen. Usa PNG, JPG, WebP o SVG."
      : "Ese archivo no es una foto. Usa JPG, PNG o WebP."
  if (file.size > MAX_PICK_BYTES) return "Pesa más de 20 MB. Elige una más chica."
  return null
}

/**
 * Los colores para elegir con un toque: los del logo y, si el elegido no está entre ellos (el que
 * ya tenía o uno escrito), también ese, primero. Sin logo, el de gestorIA. Dos que a la vista son
 * el mismo salen una vez: se queda el primero (el elegido, o el más presente en el logo).
 */
export function colorChoices(fromLogo: string[], chosen: string): string[] {
  const base = fromLogo.length > 0 ? fromLogo : [GESTORIA_COLOR]
  const choices: string[] = []
  for (const hex of [chosen, ...base]) {
    if (choices.every((other) => colorDistance(hex, other) >= SAME_COLOR)) choices.push(hex)
  }
  return choices
}

/**
 * Hasta dónde dos colores se ven iguales en un círculo de 44 px, medido en OKLab (la distancia
 * de color perceptual de CSS Color 4): 0,02 apenas se nota de lado a lado; 0,08 es el mismo tono
 * con un poco más o menos de luz.
 */
const SAME_COLOR = 0.08

/** Distancia entre dos colores `#rrggbb` en OKLab (ΔE OK, CSS Color 4). */
function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** sRGB → OKLab (Björn Ottosson, la misma conversión de CSS Color 4). */
function oklab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16) || 0
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = linear((n >> 16) & 255)
  const g = linear((n >> 8) & 255)
  const b = linear(n & 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** Las iniciales de la tienda, para cuando no tiene logo: «Calzados Rosa» → «CR». */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join("") || "?"
  )
}
