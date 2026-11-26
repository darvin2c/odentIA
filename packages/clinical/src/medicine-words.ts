/**
 * Una medicina como se dice («apixabán de cinco miligramos cada doce horas», «losartán cincuenta»),
 * en sus partes: el nombre, la dosis y cuándo. Lo dicho en palabras queda en cifras («5 mg», «cada
 * 12 h»), como lo escribe una receta. Sirve a lo que se dicta en la consulta y a lo que el paciente
 * escribe al registrarse («Eliquis 5mg c/12h»): las dos cosas terminan en la misma fila de su
 * medicación (revisión del 25 nov: «apixabán de cinco» quedaba como el nombre).
 *
 * Solo se separa lo que es claro, y nunca se inventa: la dosis con su unidad dicha («cinco miligramos»,
 * «5 mg», «dos puffs»). Sin unidad («apixabán de cinco», «losartán cincuenta», «omega tres») todo queda
 * como el nombre, porque la unidad depende de la medicina. Tampoco se parte si antes del número viene
 * un tiempo («cada doce horas»), si lo que sigue a la dosis no es cuándo se toma («con hidroclorotiazida
 * 12,5 mg»), ni si el nombre junta dos medicinas («enalapril y amlodipino»).
 */

import type { DoseUnit, MedicationFrequency } from "./catalogs.js"

export interface MedicineWords {
  name: string
  dose?: string
  frequency?: string
}

const plain = (word: string) => word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

const UNITS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29,
}
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 }
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
}

/** Un número dicho en palabras desde `start` («ochocientos cincuenta», «cuarenta y seis»): su valor y cuántas palabras usó. */
function wordNumber(words: readonly string[], start: number): { value: number; used: number } | null {
  let value = 0
  let index = start
  let seen = false
  if (words[index] === "mil") {
    value = 1000
    index++
    seen = true
  }
  const hundred = HUNDREDS[words[index] ?? ""]
  if (hundred !== undefined) {
    value += hundred
    index++
    seen = true
    // «Cien» va solo («aspirina de cien una vez al día»); «ciento uno», con lo que sigue.
    if (words[index - 1] === "cien") return { value, used: index - start }
  }
  const ten = TENS[words[index] ?? ""]
  if (ten !== undefined) {
    value += ten
    index++
    seen = true
    if (words[index] === "y" && UNITS[words[index + 1] ?? ""] !== undefined && (UNITS[words[index + 1] ?? ""] ?? 10) < 10) {
      value += UNITS[words[index + 1] ?? ""] ?? 0
      index += 2
    }
  } else if (UNITS[words[index] ?? ""] !== undefined) {
    value += UNITS[words[index] ?? ""] ?? 0
    index++
    seen = true
  } else if (words[index] === "cero" && !seen) {
    index++
    seen = true
  }
  if (!seen) return null
  // «Cero coma cinco», «dos punto cinco»: con decimales.
  if ((words[index] === "coma" || words[index] === "punto") && !String(value).includes(".")) {
    const decimals = wordNumber(words, index + 1)
    if (decimals && decimals.value < 100 && Number.isInteger(decimals.value)) {
      value += decimals.value / 10 ** String(decimals.value).length
      index += 1 + decimals.used
    }
  }
  // «Cincuenta mil», «dos mil»: los miles van después.
  if (words[index] === "mil" && value > 0 && value < 1000) {
    value *= 1000
    index++
    const rest = wordNumber(words, index)
    if (rest && rest.value < 1000) {
      value += rest.value
      index += rest.used
    }
  }
  // «Y medio»: media tableta, medio miligramo.
  if (words[index] === "y" && (words[index + 1] === "medio" || words[index + 1] === "media")) {
    value += 0.5
    index += 2
  }
  return { value, used: index - start }
}

/** La unidad dicha y cómo se escribe. */
const UNIT_OF: ReadonlyArray<[RegExp, string]> = [
  [/^(mg|miligramos?)$/, "mg"],
  [/^(mcg|ug|microgramos?)$/, "mcg"],
  [/^(g|gr|gramos?)$/, "g"],
  [/^(ml|mililitros?|cc)$/, "mL"],
  [/^(ui|unidades?)$/, "UI"],
  [/^(puffs?|inhalaciones?)$/, "puff"],
  [/^gotas?$/, "gotas"],
  [/^(tabletas?|pastillas?|comprimidos?)$/, "tableta"],
  [/^(capsulas?)$/, "cápsula"],
]
const unitOf = (word: string | undefined) => (word ? UNIT_OF.find(([pattern]) => pattern.test(plain(word)))?.[1] : undefined)

/** Un número en cifras («5», «850», «0,5»). */
const digits = (word: string | undefined) => {
  if (!word) return null
  // «1.000», «50,000»: miles, no decimales.
  if (/^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(word)) return Number(word.replace(/[.,]/g, ""))
  return /^\d+(?:[.,]\d+)?$/.test(word) ? Number(word.replace(",", ".")) : null
}
/** Un número pegado a su unidad («5mg», «100mg»). */
const glued = (word: string | undefined) => {
  const match = word ? /^(\d+(?:[.,]\d+)*)([a-zA-Z]+)$/.exec(word) : null
  const unit = match ? unitOf(match[2]) : undefined
  const value = match ? digits(match[1]) : null
  return match && unit && value !== null ? { value, unit } : null
}

const written = (value: number) => String(value).replace(".", ",")
const plural = (unit: string, value: number) => (value === 1 || ["mg", "mcg", "g", "mL", "UI"].includes(unit) ? unit : unit === "puff" ? "puffs" : unit === "cápsula" ? "cápsulas" : unit === "tableta" ? "tabletas" : unit)

/** Lo que sigue a la dosis, con los números en cifras: «cada doce horas» → «cada 12 h». */
function frequencyWords(words: readonly string[]): string {
  const out: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? ""
    const said = plain(word)
    const number = wordNumber(words.map(plain), index)
    if (number && !(said === "una" || said === "un" || said === "uno") ) {
      out.push(written(number.value))
      index += number.used - 1
      continue
    }
    if (said === "una" || said === "un" || said === "uno") {
      out.push("1")
      continue
    }
    out.push(word)
  }
  return out
    .join(" ")
    .replace(/\b(\d+) horas?\b/gi, "$1 h")
    .replace(/^(?:y|,)\s+/, "")
    .trim()
}

/**
 * Las partes de una medicina dicha o escrita. Sin dosis que reconocer, todo es el nombre.
 */
export function medicineWords(said: string): MedicineWords {
  const clean = said.trim().replace(/\s+/g, " ")
  const whole = { name: clean }
  const words = clean.split(" ")
  const lower = words.map(plain)
  for (let index = 1; index < words.length; index++) {
    // Antes de la dosis, un tiempo o cuándo la toma («cada doce horas», «desde hace dos años»): no se parte.
    if (BEFORE_DOSE_STOP.test(lower[index] ?? "")) return whole
    const withDe = lower[index] === "de" && index + 1 < words.length
    const at = withDe ? index + 1 : index
    let value: number | null = null
    let used = 0
    let unit: string | undefined
    const stuck = glued(words[at])
    if (stuck) {
      value = stuck.value
      unit = stuck.unit
      used = 1
    } else if (digits(words[at]) !== null) {
      value = digits(words[at])
      used = 1
    } else {
      const number = wordNumber(lower, at)
      if (number) {
        value = number.value
        used = number.used
      }
    }
    // Las palabras antes del primer número son el nombre.
    if (value === null) continue
    unit ??= unitOf(words[at + used])
    // El primer número es la dosis solo con su unidad dicha; si no, todo es el nombre («omega 3»,
    // «losartán cincuenta», «metformina de quinientos dos al día»).
    if (!unit || value <= 0) return whole
    const name = words.slice(0, index).join(" ").replace(/[,;:]$/, "")
    // Dos medicinas en una línea («enalapril y amlodipino de 5 mg»): no se adivina de cuál es la dosis.
    if (/(^| )(y|e)( |$)|,/.test(plain(name))) return whole
    const rest = words.slice(at + used + (stuck ? 0 : 1))
    // Lo que sigue tiene que ser cuándo se toma, sin otra dosis («con hidroclorotiazida 12,5 mg»).
    if (rest.length && (!frequencyStart(rest.map(plain)) || rest.some((word) => glued(word) || unitOf(word)))) return whole
    const frequency = frequencyWords(rest)
    return { name, dose: `${written(value)} ${plural(unit, value)}`, ...(frequency ? { frequency } : {}) }
  }
  return whole
}

/** Lo que, antes de una dosis, dice que lo que sigue no es la dosis: un tiempo o cuándo la toma. */
const BEFORE_DOSE_STOP = /^(cada|desde|hace|por|durante|al|todos|todas|diari[oa]|antes|despues|cuando|veces|vez|c\/.*)$/
const TIME_WORD = /^(horas?|h|dias?|semanas?|mes|meses|anos?|minutos?)$/
/** ¿Así empieza cuándo se toma? «cada…», «al día», «dos veces…», «en la noche», «c/12h». */
function frequencyStart(words: readonly string[]): boolean {
  const first = words[0] ?? ""
  if (/^(cada|al|por|en|todos|todas|diari[oa]|antes|despues|x|c\/.*|interdiario|semanal|mensual|segun)$/.test(first)) return true
  const number = wordNumber(words, 0) ?? (digits(words[0]) !== null ? { value: digits(words[0]) ?? 0, used: 1 } : null)
  return !!number && /^(vez|veces)$/.test(words[number.used] ?? "")
}

/** La medicina en una línea, como se lee: «apixabán 5 mg cada 12 h». */
export function medicineLine(parts: MedicineWords): string {
  return [parts.name, parts.dose, parts.frequency].filter(Boolean).join(" ")
}

/**
 * El nombre de una medicina sin la dosis del final, para saber si dos filas son la misma: «Losartán 50»,
 * «losartán cincuenta» y «losartán 50 mg» son «losartán». Solo para comparar: lo guardado no cambia.
 */
export function medicineName(said: string): string {
  const words = medicineWords(said).name.split(" ")
  const lower = words.map(plain)
  let end = words.length
  while (end > 1) {
    const last = lower[end - 1] ?? ""
    const isNumber = digits(last) !== null || glued(last) !== null || (wordNumber([last], 0) !== null && last !== "y") || last === "mil"
    if (isNumber || unitOf(last) || last === "de") end--
    else break
  }
  return words.slice(0, end).join(" ")
}

const UNIT_CODE: Record<string, DoseUnit> = { mg: "mg", g: "g", mcg: "ug", mL: "mL", UI: "[iU]", tableta: "{tbl}", "cápsula": "{cap}", gotas: "{drop}", puff: "{puff}" }

/**
 * La dosis separada («5 mg», «0,5 mg», «2 puffs») como la guarda su fila: número y unidad de la lista.
 * `null` si no es eso exactamente: se guarda como texto.
 */
export function structuredDose(dose: string): { doseValue: number; doseUnit: DoseUnit } | null {
  const parts = medicineWords(`x ${dose.trim()}`)
  if (parts.name !== "x" || !parts.dose || parts.frequency) return null
  const [number, unit] = parts.dose.split(" ")
  const value = Number((number ?? "").replace(",", "."))
  const code = UNIT_CODE[unit === "puffs" ? "puff" : unit === "tabletas" ? "tableta" : unit === "cápsulas" ? "cápsula" : (unit ?? "")]
  return Number.isFinite(value) && value > 0 && code ? { doseValue: value, doseUnit: code } : null
}

/** Cada cuánto, en la lista de la fila: «cada 12 h», «2 veces al día» → `cada_12_h`. `null` si no calza. */
export function frequencyCodeOf(frequency: string): MedicationFrequency | null {
  const said = plain(frequency).replace(/\s+/g, " ").trim()
  if (/^cada (8|ocho) (h|horas?)$/.test(said) || /^(3|tres) veces al dia$/.test(said)) return "cada_8_h"
  if (/^cada (12|doce) (h|horas?)$/.test(said) || /^(2|dos) veces al dia$/.test(said)) return "cada_12_h"
  if (/^cada (24|veinticuatro) (h|horas?)$/.test(said) || /^(1|una) vez al dia$/.test(said)) return "cada_24_h"
  if (/^(segun necesidad|si hay dolor|si duele|condicional)$/.test(said)) return "segun_necesidad"
  return null
}

/** Cómo se dice cada unidad, para saber si se dijo. */
const UNIT_SAID: Record<string, RegExp> = {
  mg: /^(mg|miligramos?)$/,
  mcg: /^(mcg|ug|microgramos?)$/,
  g: /^(g|gr|gramos?)$/,
  mL: /^(ml|mililitros?|cc)$/,
  UI: /^(ui|unidades?)$/,
  puff: /^(puffs?|inhalacion(es)?)$/,
  puffs: /^(puffs?|inhalacion(es)?)$/,
  gotas: /^gotas?$/,
  tableta: /^(tabletas?|pastillas?|comprimidos?)$/,
  tabletas: /^(tabletas?|pastillas?|comprimidos?)$/,
  "cápsula": /^capsulas?$/,
  "cápsulas": /^capsulas?$/,
}

/**
 * La dosis que propuso Clío, con lo que de verdad se dijo: en cifras («cincuenta» → «50») y con la
 * unidad solo si se dijo junto a ese número (QA del 26 nov: «losartán cincuenta» llegaba como «50 mg»).
 * Vacía si el número no se dijo.
 */
export function groundedDose(dose: string, said: string): string {
  const parts = medicineWords(`x ${dose.trim()}`)
  const heard = plain(said)
  const words = plain(dose).split(/\s+/)
  const number = digits(words[0]) ?? glued(words[0])?.value ?? wordNumber(words, 0)?.value ?? null
  if (number === null) return dose.trim()
  const unitWord = parts.dose?.split(" ")[1]
  // La unidad tiene que ir con ese número en lo dicho («cinco miligramos», «5 mg»), no con otro.
  const pattern = unitWord ? UNIT_SAID[unitWord] : undefined
  const tokens = heard.replace(/(\d)([a-z])/g, "$1 $2").split(/[^a-z0-9.,ñ]+/).filter(Boolean)
  let numberSaid = false
  let unitSaid = false
  for (let index = 0; index < tokens.length && !unitSaid; index++) {
    const at = digits(tokens[index]) !== null ? { value: digits(tokens[index]), used: 1 } : wordNumber(tokens, index)
    if (!at || at.value !== number) continue
    numberSaid = true
    unitSaid = !!pattern && pattern.test(tokens[index + at.used] ?? "")
  }
  // Un número que no se dijo no es una dosis de lo dicho: no se propone.
  if (!numberSaid) return ""
  return unitSaid && parts.dose ? parts.dose : written(number)
}

/**
 * La dosis y cada cuánto de una medicina, leídas de la frase dicha junto a su nombre: «tomo apixabán de
 * cinco miligramos cada doce horas y losartán…» → 5 mg · cada 12 h (QA del 26 nov: Clío pone en su
 * clase solo «apixabán», y lo que dijo de la dosis se perdía). El tramo va desde el nombre hasta el
 * siguiente «y», coma o punto; con las mismas reglas de `medicineWords`, y nada si no es claro.
 */
export function doseFromSaid(name: string, said: string): Pick<MedicineWords, "dose" | "frequency"> {
  const head = plain(name).split(/\s+/)[0] ?? ""
  if (head.length < 4) return {}
  const words = said.trim().split(/\s+/)
  const start = words.findIndex((word) => plain(word).replace(/[^a-z0-9ñ]/g, "").startsWith(head.slice(0, 5)))
  if (start < 0) return {}
  const piece: string[] = []
  for (let index = start; index < words.length; index++) {
    const word = words[index] ?? ""
    const next = plain(words[index + 1] ?? "")
    if (index > start && plain(word) === "y" && next !== "medio" && next !== "media") break
    piece.push(word.replace(/[.,;]+$/, ""))
    if (/[.,;]$/.test(word)) break
  }
  const parts = medicineWords(piece.join(" "))
  return parts.dose ? { dose: parts.dose, ...(parts.frequency ? { frequency: parts.frequency } : {}) } : {}
}
