/**
 * Lo de «Tu marca» que se calcula en la pantalla (lienzo «gestorIA como odentIA», tablero 10).
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
