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
 * ya tenía o uno escrito), también ese, primero. Sin logo, el de gestorIA.
 */
export function colorChoices(fromLogo: string[], chosen: string): string[] {
  const base = fromLogo.length > 0 ? fromLogo : [GESTORIA_COLOR]
  return [...new Set([chosen, ...base])]
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
