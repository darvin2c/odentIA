/**
 * La cantidad total que se propone en una receta (OMS, «Guía de la buena
 * prescripción», WHO/DAP/94.11: la receta dice la cantidad total): unidades por
 * toma × tomas al día × días, hacia arriba. La usa el dictado (Clío): solo
 * propone, y lo que dice quien receta manda.
 *
 * Lo que se toma «si hay dolor» con frecuencia y duración dichas («cada 8 h por 3 días») propone
 * el máximo, como hacía el dictado; sin una de las dos, nada. Sin la forma farmacéutica dicha,
 * cuenta la dosis dicha con su unidad («1 tableta», «2 cápsulas»), como hacía el dictado.
 *
 * No propone nada si no se puede contar con certeza:
 * - una forma que no se cuenta por unidades (jarabe, suspensión, gotas, crema,
 *   colutorio): los frascos dependen del volumen del frasco, que no se conoce;
 * - sin días («uso continuo», «permanente») o con una frecuencia que no divide el día («cada 5 h»);
 * - la dosis por peso («15 mg/kg») o en mg que no es un múltiplo entero de la concentración.
 */

/** Las formas que se cuentan por unidades (`DOSAGE_FORMS`, y como se dicen). */
const COUNTED_FORMS =
  /^(tabletas?( recubiertas?)?|capsulas?|comprimidos?( recubiertos?)?|grageas?|sobres?)$/

/** Las unidades de una toma escritas con su número: «1 tableta», «2 cápsulas», «½ tableta», «1 sobre». */
const UNIT_WORD = "(?:tabletas?|tab|capsulas?|caps?|comprimidos?|grageas?|sobres?)"

/** «1 sobre» se cuenta aunque la forma diga otra cosa («polvo»), como hacía el dictado. */
const SACHET_DOSE = /(?<![a-z\d])(\d+|[a-z]+)\s*sobres?\b/

/** Números como se dictan o se escriben con letras: «ocho», «una», «media». */
const WORD_NUMBERS: Record<string, number> = {
  media: 0.5,
  medio: 0.5,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  catorce: 14,
  quince: 15,
  veinte: 20,
  veintiuno: 21,
  veinticuatro: 24,
  treinta: 30,
}

/** Un número escrito: «8», «1,5», «1/2», «½», «ocho»; nunca el trozo de otra palabra. */
const NUMBER = "(?<![a-z\\d])(\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|½|[a-z]+)"

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function numberOf(text: string | undefined): number | null {
  if (!text) return null
  if (text === "½") return 0.5
  const fraction = /^(\d+)\/(\d+)$/.exec(text)
  if (fraction) {
    const value = Number(fraction[1]) / Number(fraction[2])
    return Number.isFinite(value) && value > 0 ? value : null
  }
  if (/^\d/.test(text)) {
    const value = Number(text.replace(",", "."))
    return Number.isFinite(value) && value > 0 ? value : null
  }
  return WORD_NUMBERS[text] ?? null
}

/** Miligramos de «500 mg» o «1 g»; null si no es solo eso («875 mg + 125 mg», «5 %»). */
function milligramsOf(text: string): number | null {
  const found = /^(\d+(?:[.,]\d+)?)\s*(mg|g|gr)$/.exec(text)
  if (!found) return null
  const value = numberOf(found[1])
  if (value === null) return null
  return found[2] === "mg" ? value : value * 1000
}

/** Unidades por toma: con su palabra, o la dosis en mg que es un múltiplo entero de la concentración. */
function unitsPerDose(dose: string, strength: string): number | null {
  if (/\/\s*kg\b/.test(dose)) return null
  const counted = new RegExp(`${NUMBER}\\s*${UNIT_WORD}\\b`).exec(dose)
  if (counted) return numberOf(counted[1])
  const doseMg = milligramsOf(dose)
  const strengthMg = milligramsOf(strength)
  if (doseMg === null || strengthMg === null) return null
  const units = doseMg / strengthMg
  return Number.isInteger(units) && units >= 1 ? units : null
}

/** Tomas al día: «cada 8 h», «c/8 horas», «8 h» a secas, «3 veces al día», «una vez al día», «diario». */
function dosesPerDay(frequency: string): number | null {
  const every =
    new RegExp(`(?:cada|c\\/)\\s*${NUMBER}\\s*(?:h|hs|hr|hrs|horas?)\\b`).exec(frequency) ??
    new RegExp(`^${NUMBER}\\s*(?:h|hs|hr|hrs|horas?)$`).exec(frequency)
  if (every) {
    const hours = numberOf(every[1])
    return hours !== null && Number.isInteger(hours) && 24 % hours === 0 ? 24 / hours : null
  }
  const times = new RegExp(`${NUMBER}\\s+(?:veces|vez)\\s+(?:al|por|cada|x)\\s+dia\\b`).exec(
    frequency,
  )
  if (times) {
    const count = numberOf(times[1])
    return count !== null && Number.isInteger(count) ? count : null
  }
  const timesDaily = new RegExp(`${NUMBER}\\s+(?:veces|vez)\\s+diarias?\\b`).exec(frequency)
  if (timesDaily) {
    const count = numberOf(timesDaily[1])
    return count !== null && Number.isInteger(count) ? count : null
  }
  if (/^(diario|diaria|cada dia|todos los dias)$/.test(frequency)) return 1
  return null
}

/** Días: «7 días», «x 7 dias», «dos semanas». */
function daysOf(duration: string): number | null {
  const days = new RegExp(`${NUMBER}\\s*(?:dias?|d)\\b`).exec(duration)
  if (days) {
    const value = numberOf(days[1])
    return value !== null && Number.isInteger(value) ? value : null
  }
  const weeks = new RegExp(`${NUMBER}\\s*semanas?\\b`).exec(duration)
  if (weeks) {
    const value = numberOf(weeks[1])
    return value !== null && Number.isInteger(value) ? value * 7 : null
  }
  return null
}

export interface QuantityInput {
  dose: string
  frequency: string
  duration: string
  dosageForm: string
  /** La concentración («500 mg»): con ella, una dosis en mg cuenta si es un múltiplo entero. */
  strength?: string | null
}

export interface SuggestedQuantity {
  quantity: number
  perDose: number
  perDay: number
  days: number
}

/** La cantidad total que se propone; null si no se puede contar con certeza. */
export function suggestedQuantity(input: QuantityInput): SuggestedQuantity | null {
  const dose = fold(input.dose)
  const form = fold(input.dosageForm)
  // Sin forma dicha, la dosis con su unidad dice que se cuenta («1 tableta»).
  const countedDose = !form && new RegExp(`${NUMBER}\\s*${UNIT_WORD}\\b`).test(dose)
  if (!COUNTED_FORMS.test(form) && !SACHET_DOSE.test(dose) && !countedDose) return null
  const frequency = fold(input.frequency)
  const duration = fold(input.duration)
  const perDose = unitsPerDose(dose, fold(input.strength ?? ""))
  const perDay = dosesPerDay(frequency)
  const days = daysOf(duration)
  if (perDose === null || perDay === null || days === null) return null
  // Hacia arriba: media tableta tres veces al día por 5 días son 8, no 7,5.
  const quantity = Math.ceil(perDose * perDay * days - 1e-9)
  return quantity >= 1 && quantity <= 9999 ? { quantity, perDose, perDay, days } : null
}
