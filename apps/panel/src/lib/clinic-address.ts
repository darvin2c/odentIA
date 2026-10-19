/**
 * Dirección de la clínica en odentIA (el subdominio, `sonrisa.odentia32.com`).
 * Sale del nombre mientras la persona no la escriba a mano (issue 106).
 */

/** Formato que acepta el servidor: minúsculas, números y guiones sueltos. */
export const CLINIC_ADDRESS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Largo de la dirección que se propone; escrita a mano admite más. */
export const SUGGESTED_ADDRESS_MAX = 30

/** Lo que dice cualquier clínica al principio de su nombre y no la distingue. */
const GENERIC_WORDS = new Set([
  "clinica",
  "clinicas",
  "consultorio",
  "consultorios",
  "centro",
  "odontologica",
  "odontologico",
  "odontologia",
  "dental",
  "dentales",
])
/** Lo que queda suelto al quitar lo genérico: «Consultorio *de la* Dra. Ruiz». */
const CONNECTORS = new Set(["de", "del", "la", "las", "el", "los", "y"])

/** Texto en minúsculas sin tildes ni signos, con guiones: «Clínica Dental» → `clinica-dental`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/** Corta en el último guion que quepa, para no dejar media palabra. */
function cutAtHyphen(slug: string, max: number): string {
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max + 1)
  const hyphen = cut.lastIndexOf("-")
  return (hyphen > 0 ? cut.slice(0, hyphen) : slug.slice(0, max)).replace(/-+$/, "")
}

/**
 * Dirección propuesta para un nombre: «Clínica Dental Sonrisa» → `sonrisa`.
 * Quita al principio las palabras genéricas (y lo que queda suelto tras ellas),
 * sin dejarla vacía: «Clínica Dental» se queda `clinica-dental`.
 */
export function addressFromName(name: string): string {
  const words = slugify(name).split("-").filter(Boolean)
  let start = 0
  let removedGeneric = false
  while (start < words.length) {
    const word = words[start] as string
    if (GENERIC_WORDS.has(word)) removedGeneric = true
    else if (!(removedGeneric && CONNECTORS.has(word))) break
    start += 1
  }
  const rest = start < words.length ? words.slice(start) : words
  return cutAtHyphen(rest.join("-"), SUGGESTED_ADDRESS_MAX)
}

/** Alternativas a una dirección ocupada, en orden: `sonrisa-2`, `sonrisa-3`… */
export function addressAlternatives(address: string, count = 8): string[] {
  const base = cutAtHyphen(address, SUGGESTED_ADDRESS_MAX - 2)
  return Array.from({ length: count }, (_, index) => `${base}-${index + 2}`)
}
