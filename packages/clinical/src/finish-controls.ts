/**
 * Los controles que deja un tratamiento al terminar y la espera entre sus sesiones
 * (QA del 10 nov, decisión B5): la biblioteca trae lo de la guía clínica y cada clínica
 * lo ajusta en su servicio. Antes eran reglas fijas en el código (7 días entre sesiones
 * de cualquier endodoncia y el control radiográfico al año de los conductos).
 */

/** Un control que queda al terminar el tratamiento: a los `afterDays` días, con su título. */
export interface FinishControl {
  afterDays: number
  title: string
}

/** Hasta cuántos días después de terminar (cinco años). */
export const FINISH_CONTROL_MAX_DAYS = 1825
/** La espera más larga entre sesiones que se propone. */
export const SESSION_GAP_MAX_DAYS = 120
/** Controles por servicio, como mucho. */
export const FINISH_CONTROLS_MAX = 6

/**
 * Valida y normaliza los controles de un servicio; lanza `Error` con el problema. Orden por
 * plazo y sin dos con el mismo plazo: dos controles el mismo día son el mismo control.
 */
export function parseFinishControls(raw: unknown): FinishControl[] {
  if (!Array.isArray(raw)) throw new Error("Controles al terminar: lista obligatoria")
  if (raw.length > FINISH_CONTROLS_MAX)
    throw new Error(`Controles al terminar: como mucho ${FINISH_CONTROLS_MAX}`)
  const out: FinishControl[] = []
  for (const item of raw) {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const days = row.afterDays
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > FINISH_CONTROL_MAX_DAYS
    )
      throw new Error(`Controles al terminar: el plazo va de 1 a ${FINISH_CONTROL_MAX_DAYS} días`)
    const title = typeof row.title === "string" ? row.title.trim().replace(/\s+/g, " ") : ""
    if (title.length < 3 || title.length > 120)
      throw new Error("Controles al terminar: cada uno con su nombre (3 a 120 letras)")
    // « · » separa el nombre de sus piezas en el control que queda: no va en el nombre.
    if (title.includes(" · ")) throw new Error("Controles al terminar: el nombre no lleva « · »")
    if (out.some((other) => other.afterDays === days))
      throw new Error("Controles al terminar: dos con el mismo plazo")
    out.push({ afterDays: days, title })
  }
  return out.sort((a, b) => a.afterDays - b.afterDays)
}

/** La espera entre sesiones que se escribe: 0 a 120 días, o nula para volver a la de la biblioteca. */
export function parseSessionGapDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > SESSION_GAP_MAX_DAYS)
    throw new Error(
      `Días de espera entre sesiones: un número entero de 0 a ${SESSION_GAP_MAX_DAYS}`,
    )
  return raw
}

/** «a los 30 días», «a los 6 meses», «al año», «a los 2 años». */
export function afterDaysWords(days: number): string {
  if (days % 365 === 0) return days === 365 ? "al año" : `a los ${days / 365} años`
  if (days % 30 === 0 && days >= 60) return `a los ${days / 30} meses`
  if (days === 30) return "al mes"
  if (days % 7 === 0 && days < 60) return days === 7 ? "a la semana" : `a las ${days / 7} semanas`
  return days === 1 ? "al día siguiente" : `a los ${days} días`
}

/** «una semana», «10 días»: la espera entre sesiones dicha en una frase. */
export function gapWords(days: number): string {
  if (days === 7) return "una semana"
  if (days % 7 === 0 && days <= 56) return `${days / 7} semanas`
  return days === 1 ? "un día" : `${days} días`
}

/** «46», «46 y 36», «46, 36 y 47». */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} y ${words.at(-1)}`
}

/**
 * El título de un control que nombra sus sitios (decisión B4: uno por fecha con todas las
 * piezas): «Control radiográfico de la endodoncia · pieza 46», «… · piezas 46 y 36». `places`
 * son los códigos de sitio (la pieza) y `noun` cómo se llama uno («pieza»); sin sitio, solo
 * el título.
 */
export function finishControlTitle(
  title: string,
  places: readonly string[],
  noun = "pieza",
): string {
  const unique = [...new Set(places.filter(Boolean))]
  if (unique.length === 0) return title.slice(0, 200)
  // Sin nombre común (otro producto), los sitios como se dicen: «· rodilla derecha y codo izquierdo».
  const said = noun
    ? `${title} · ${unique.length === 1 ? noun : `${noun}s`} ${joinWords(unique)}`
    : `${title} · ${joinWords(unique)}`
  return said.slice(0, 200)
}
