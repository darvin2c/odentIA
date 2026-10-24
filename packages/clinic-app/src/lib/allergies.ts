import { allergenByCode, allergenDetail, allergenName, type AllergenEntry } from "@odentia/clinical"
import { productUi } from "../product/product-ui"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import type { Allergy } from "./patients"

/** «3 oct», en la zona de la clínica; de otro año, «3 oct 2025». */
export function allergyDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const timeZone = activeOrgTimeZone()
  const year = (value: Date) => value.toLocaleDateString("en", { year: "numeric", timeZone })
  return date.toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    ...(year(date) === year(now) ? {} : { year: "numeric" }),
    timeZone,
  })
}

/** «hace 8 meses», «hace 2 semanas», «hoy»: cuánto pasó desde la última revisión. */
export function sinceWords(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return "hoy"
  if (days < 14) return days === 1 ? "ayer" : `hace ${days} días`
  if (days < 60) return `hace ${Math.floor(days / 7)} semanas`
  // Al mes más cercano: del 20 de febrero al 20 de octubre son 8 meses, no 7.
  const months = Math.round(days / 30.44)
  if (months < 24) return `hace ${months} meses`
  return `hace ${Math.floor(months / 12)} años`
}

/**
 * Cómo se dice una alergia en pantalla (tablero 7 del lienzo de Pacientes):
 * con la sustancia elegida de la lista, su nombre en la lista; escrita a mano,
 * tal cual y «sin codificar». Las reglas (quitar, revisar, el aviso al
 * recetar) son del servidor; aquí solo las palabras.
 */
export function allergyEntry(
  allergy: Pick<Allergy, "substanceSystem" | "substanceCode">,
): AllergenEntry | null {
  // La lista del producto de la clínica: latidIA suma la medicina general (issue 229).
  return allergenByCode(allergy.substanceSystem, allergy.substanceCode, productUi().prescribing.catalog.allergens)
}

/** «Penicilinas», «Látex», o «amoxi» tal cual se escribió. */
export function allergyName(
  allergy: Pick<Allergy, "substance" | "substanceSystem" | "substanceCode">,
): string {
  const entry = allergyEntry(allergy)
  return entry ? entry.label.replace(/\s*\(grupo\)$/, "") : allergy.substance
}

/** Para una frase: «penicilinas», ««amoxi»». */
export function allergyPhrase(
  allergy: Pick<Allergy, "substance" | "substanceSystem" | "substanceCode">,
): string {
  const entry = allergyEntry(allergy)
  return entry ? allergenName(entry) : `«${allergy.substance}»`
}

export const SEVERITY_WORDS: Record<string, string> = {
  leve: "leve",
  moderada: "moderada",
  severa: "severa",
  desconocida: "no se sabe qué tan fuerte",
}

/** «Penicilinas · severa»; sin gravedad conocida, solo el nombre. */
export function allergyTitle(allergy: Allergy): string {
  const severity = allergy.severity === "desconocida" ? null : SEVERITY_WORDS[allergy.severity]
  return [allergyName(allergy), severity].filter(Boolean).join(" · ")
}

/** La línea de la lista: «medicamento · ATC J01C» o «sin codificar». */
export function allergyListDetail(entry: AllergenEntry | null): string {
  return entry ? allergenDetail(entry) : "sin codificar"
}

/** Por qué se quitó, como lo eligió quien la quitó. */
export const REMOVAL_REASON_LABELS: Record<string, string> = {
  ya_no: "Ya no es alérgica",
  otra_cosa: "Era otra cosa (malestar, efecto secundario)",
  error: "Se registró por error",
}

/** Las severas primero, después las demás en el orden en que llegaron. */
export function bySeverity(a: Allergy, b: Allergy): number {
  const rank = (allergy: Allergy) =>
    allergy.severity === "severa" ? 0 : allergy.severity === "moderada" ? 1 : 2
  return rank(a) - rank(b)
}
