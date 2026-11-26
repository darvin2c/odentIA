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
