/**
 * Una medicina como se dice («apixabán de cinco miligramos cada doce horas», «losartán cincuenta»),
 * en sus partes: el nombre, la dosis y cuándo. Lo dicho en palabras queda en cifras («5 mg», «cada
 * 12 h»), como lo escribe una receta. Sirve a lo que se dicta en la consulta y a lo que el paciente
 * escribe al registrarse («Eliquis 5mg c/12h»): las dos cosas terminan en la misma fila de su
 * medicación (revisión del 25 nov: «apixabán de cinco» quedaba como el nombre).
 *
 * Sin unidad dicha, la dosis es en miligramos cuando el número se dijo en palabras o con «de»
 * («apixabán de cinco», «losartán cincuenta»): así se dicen las tabletas. Un número en cifras pegado
 * al nombre sin «de» puede ser parte del nombre («omega 3»), y entonces no se separa.
 */

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
  }
  if (!seen) return null
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
const digits = (word: string | undefined) => (word && /^\d+(?:[.,]\d+)?$/.test(word) ? Number(word.replace(",", ".")) : null)
/** Un número pegado a su unidad («5mg», «100mg»). */
const glued = (word: string | undefined) => {
  const match = word ? /^(\d+(?:[.,]\d+)?)([a-zA-Z]+)$/.exec(word) : null
  const unit = match ? unitOf(match[2]) : undefined
  return match && unit ? { value: Number((match[1] ?? "").replace(",", ".")), unit } : null
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
  const words = clean.split(" ")
  const lower = words.map(plain)
  for (let index = 1; index < words.length; index++) {
    const withDe = lower[index] === "de" && index + 1 < words.length
    const at = withDe ? index + 1 : index
    let value: number | null = null
    let used = 0
    let inWords = false
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
        inWords = true
      }
    }
    if (value === null || value <= 0) continue
    unit ??= unitOf(words[at + used])
    const unitSaid = !stuck && unit !== undefined
    // Sin unidad, solo lo que se dice como una dosis («de cinco», «cincuenta»); «omega 3» es un nombre.
    if (!unit && !(withDe || inWords)) continue
    // «Una vez al día» o «dos veces» justo después del nombre es cuándo, no la dosis.
    if (!unit && /^(vez|veces)$/.test(lower[at + used] ?? "")) continue
    const name = words.slice(0, index).join(" ").replace(/[,;:]$/, "")
    const rest = words.slice(at + used + (unitSaid ? 1 : 0))
    const frequency = frequencyWords(rest)
    return {
      name,
      dose: `${written(value)} ${plural(unit ?? "mg", value)}`,
      ...(frequency ? { frequency } : {}),
    }
  }
  return { name: clean }
}

/** La medicina en una línea, como se lee: «apixabán 5 mg cada 12 h». */
export function medicineLine(parts: MedicineWords): string {
  return [parts.name, parts.dose, parts.frequency].filter(Boolean).join(" ")
}
