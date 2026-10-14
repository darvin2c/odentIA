/**
 * Comprobación de datos antes de enviar: los precios, fechas y horas de una
 * respuesta deben estar en lo que el agente consultó o recibió en el turno.
 * Es determinista (sin modelo) y conservadora a propósito: solo mira datos con
 * forma inequívoca. No prueba que la respuesta sea correcta; impide que salga
 * un dato concreto que no figura en ninguna fuente.
 */

export interface Evidence {
  /** Nombre legible de la fuente, tal como lo verá el equipo. */
  source: string
  text: string
}

export type FactKind = "precio" | "hora" | "fecha"

export interface FactCheck {
  kind: FactKind
  /** El dato tal como aparece en la respuesta. */
  value: string
  ok: boolean
  /** Fuente donde se encontró; nulo si no está en lo consultado. */
  source: string | null
}

export interface ReplyVerdict {
  ok: boolean
  checks: FactCheck[]
  unsupported: FactCheck[]
}

/** Suma de otros importes de la propia respuesta que sí están sustentados. */
export const SOURCE_SUM = "Suma de importes consultados"
/** El día de la semana se comprueba con el calendario, no con una fuente. */
export const SOURCE_CALENDAR = "Calendario"

/**
 * Decimales que se conservan al leer un número: tres, la unidad menor más
 * pequeña de las monedas ISO 4217 de uso corriente (KWD, BHD, TND). Con dos no
 * se distinguía un importe en dinares de otro parecido.
 */
const READ_DIGITS = 3
const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,${READ_DIGITS}})?`
const ANY_NUMBER = new RegExp(String.raw`(?<![\d])(?:${NUMBER})(?![\d])`, "g")

/**
 * Cómo se reconoce que un número es dinero. No hay una lista de monedas
 * escrita a mano: los códigos son los ISO 4217 que conoce ICU, los signos son
 * los monetarios de Unicode y lo propio de un país (su símbolo, el nombre de
 * su moneda) sale de la moneda de la clínica (`clinicMarks`).
 */
const ISO_CODES = Intl.supportedValuesOf("currency")
  .filter((code) => /^[A-Z]{3}$/.test(code))
  .join("|")
/** $, €, ₡, ₲… con las letras que los acompañan al escribirlos (US$, R$, RD$, U$S, $U). */
const SIGN_BEFORE = String.raw`[A-Za-z]{0,3}\p{Sc}[A-Za-z]?`
const SIGN_AFTER = String.raw`\p{Sc}`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

/**
 * Patrón que acepta el texto con o sin mayúsculas y tildes, letra a letra. El
 * patrón completo no lleva `i`: un código ISO solo vale en mayúsculas («gel 2»
 * o «si ves 2» no son lari ni bolívares).
 */
function loose(text: string): string {
  return [...text]
    .map((char) => {
      const bare = char.normalize("NFD").replace(/[̀-ͯ]/g, "") || char
      const forms = new Set([char.toLowerCase(), char.toUpperCase(), bare.toLowerCase(), bare.toUpperCase()])
      return forms.size === 1 ? escapeRegExp(char) : `[${[...forms].map(escapeRegExp).join("")}]`
    })
    .join("")
}

/** Nombres que comparten las monedas de muchos países; el de la moneda de la clínica lo da ICU. */
const SHARED_NAMES = ["dólares", "dólar", "pesos", "peso", "euros", "euro"].map(loose).join("|")

/**
 * Cómo escribe ICU la moneda de la clínica: su símbolo en el formato de la
 * clínica (S/, Q, Bs, RD$…), a qué lado del número va, y su nombre en español
 * (soles, quetzales, bolivianos…), que es el idioma de las respuestas.
 */
function clinicMarks(currency: string | null | undefined, locale: string | null | undefined) {
  const before = new Set<string>()
  const symbolAfter = new Set<string>()
  const names = new Set<string>()
  const code = currency?.trim().toUpperCase() ?? ""
  // Moneda o formato que ICU no reconoce: quedan los códigos, los signos y los nombres compartidos.
  const partsOf = (format: string, currencyDisplay: "symbol" | "narrowSymbol" | "name", count: number) => {
    try {
      return new Intl.NumberFormat(format, { style: "currency", currency: code, currencyDisplay }).formatToParts(count)
    } catch {
      return []
    }
  }
  // «XXX» es el código ISO de «sin moneda»: no tiene símbolo ni nombre que buscar.
  if (!/^[A-Z]{3}$/.test(code) || code === "XXX" || !partsOf("es", "name", 1).length) {
    return { before, symbolAfter, names }
  }
  // Su propio código vale también en minúsculas («150 pen»).
  before.add(loose(code))
  names.add(loose(code))
  for (const currencyDisplay of ["symbol", "narrowSymbol"] as const) {
    const parts = partsOf(locale?.trim() || "es", currencyDisplay, 1)
    const at = parts.findIndex((part) => part.type === "currency")
    // Una abreviatura vale con o sin su punto final: «S/» y «S/.», «Bs» y «Bs.».
    const symbol = parts[at]?.value.trim().replace(/\.$/, "")
    if (!symbol) continue
    const pattern = `${loose(symbol)}\\.?`
    before.add(pattern)
    if (at > parts.findIndex((part) => part.type === "integer")) symbolAfter.add(pattern)
  }
  for (const count of [2, 1]) {
    const name = partsOf("es", "name", count).find((part) => part.type === "currency")?.value
    // «soles peruanos» → «soles»; «nuevo dólar taiwanés» → «dólar».
    const word = name?.split(/\s+/).find((part) => part && !/^nuev[oa]s?$/i.test(part))
    if (word) names.add(loose(word))
  }
  return { before, symbolAfter, names }
}

const AMOUNT_PATTERNS = new Map<string, RegExp>()

/** Un importe con su moneda, delante o detrás del número, para la moneda y el formato de la clínica. */
function amountPattern(currency: string | null | undefined, locale: string | null | undefined): RegExp {
  const key = `${currency ?? ""}|${locale ?? ""}`
  const cached = AMOUNT_PATTERNS.get(key)
  if (cached) return cached
  const clinic = clinicMarks(currency, locale)
  const before = [SIGN_BEFORE, ISO_CODES, ...clinic.before].join("|")
  // Un símbolo seguido de otro número pertenece a ese número («150 $480»).
  const symbolAfter = `(?:${[SIGN_AFTER, ...clinic.symbolAfter].join("|")})(?!\\s?\\d)`
  // «480 nuevos soles», «100 nuevos pesos»: el adjetivo no cambia de qué se habla.
  const names = `(?:${loose("nuev")}[oOaA][sS]?\\s)?(?:${[SHARED_NAMES, ...clinic.names].join("|")})`
  const after = [symbolAfter, ISO_CODES, names].join("|")
  const pattern = new RegExp(
    String.raw`(?<!\p{L})(?:${before})\s?(${NUMBER})(?![\d])|(?<![\d.,/:])(${NUMBER})\s?(?:${after})(?!\p{L})`,
    "gu",
  )
  AMOUNT_PATTERNS.set(key, pattern)
  return pattern
}
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g
const ZONE_NAME = /\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, set: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12,
}
const WEEKDAYS: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
}
const WEEKDAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
const WEEKDAY = String.raw`(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)`
const MONTH = String.raw`(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)`
const DATE_WORDS = new RegExp(
  String.raw`(?:\b${WEEKDAY},?\s+)?(?<![\d/])(\d{1,2})\s+(?:de\s+)?${MONTH}\b\.?(?:\s+(?:de|del)\s+(\d{4}))?`,
  "gi",
)
const DATE_NUMERIC_YEAR = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g
const DATE_NUMERIC_CUED = new RegExp(
  String.raw`\b(?:el|del|al|d[ií]a|fecha|${WEEKDAY})\s+(\d{1,2})\/(\d{1,2})(?![\d/])`,
  "gi",
)
const DATE_ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g
const DATE_WEEKDAY_DAY = new RegExp(String.raw`\b${WEEKDAY}\s+(\d{1,2})(?![\d/:.,]|\s+(?:de\s+)?[a-z])`, "gi")

const MERIDIEM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)`
const TIME_CLOCK = new RegExp(
  String.raw`(?<![\d:.,/])(\d{1,2})(?::|h)([0-5]\d)(?::[0-5]\d)?(?:\s?${MERIDIEM}(?![a-z]))?(?![\d])`,
  "gi",
)
const TIME_MERIDIEM = new RegExp(String.raw`(?<![\d:.,/])(1[0-2]|0?[1-9])\s?${MERIDIEM}(?![a-z])`, "gi")
const TIME_WORDS =
  /\ba las? (\d{1,2})(?: y (media|cuarto)| en punto)?(?: de la (ma[ñn]ana|tarde|noche|madrugada))?(?![\d:.,/]|\s*(?:semanas?|d[ií]as?|mes(?:es)?|a[ñn]os?|horas?|minutos?|personas?|sesiones|citas|veces|cuotas)\b)/gi

function normalize(text: string): string {
  return text.replace(/[\u00a0\u202f\u2009]/g, " ")
}

function plain(word: string): string {
  return word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/** Parte entera y fracción escritas, como entero exacto a `READ_DIGITS` decimales (sin coma flotante). */
function fixed(whole: string, fraction = ""): number {
  return Number(`${whole}${fraction.padEnd(READ_DIGITS, "0").slice(0, READ_DIGITS)}`)
}

/**
 * Lecturas de un número escrito, como entero a `READ_DIGITS` decimales. No es
 * la unidad menor de ninguna moneda: la respuesta y las fuentes se leen igual
 * y solo se comparan entre sí, así que no se asume cuántos decimales tiene
 * cada importe. Un único separador con tres cifras detrás («1.200») es ambiguo
 * entre miles y decimales: se devuelven ambas lecturas para no rechazar por
 * formato.
 */
function readAmount(raw: string): number[] {
  const text = raw.replace(/\s/g, "")
  const separators = text.replace(/\d/g, "")
  if (!separators) return [fixed(text)]
  const kinds = new Set(separators)
  if (kinds.size === 2) {
    // Con dos separadores distintos, el último es el decimal.
    const at = Math.max(text.lastIndexOf("."), text.lastIndexOf(","))
    return [fixed(text.slice(0, at).replace(/[.,]/g, ""), text.slice(at + 1))]
  }
  const separator = separators[0] ?? "."
  if (separators.length > 1) return [fixed(text.split(separator).join(""))]
  const [whole = "", fraction = ""] = text.split(separator)
  const asDecimal = fixed(whole, fraction)
  if (fraction.length === 3) return [fixed(`${whole}${fraction}`), asDecimal]
  return [asDecimal]
}

interface Mention<T> {
  /** Dónde empieza en el texto. */
  index?: number
  raw: string
  value: T
}

/**
 * Un importe anunciado como mínimo («desde S/ 2 500», «a partir de…»): el
 * precio final sale de la evaluación y nunca se dice como si fuera el precio.
 */
const MINIMUM_CUE = /(?:desde|a partir de|minimo de|como minimo)\s*[^\d\s]{0,4}\s*$/
const CUE_WINDOW = 24

/** ¿Lo que precede a la posición anuncia un mínimo? */
function cuedAsMinimum(text: string, index: number): boolean {
  return MINIMUM_CUE.test(plain(text.slice(Math.max(0, index - CUE_WINDOW), index)))
}

function blank(text: string, start: number, length: number): string {
  return `${text.slice(0, start)}${" ".repeat(length)}${text.slice(start + length)}`
}

/** Importes con moneda explícita; devuelve también el texto con ellos tapados. */
function extractAmounts(text: string, pattern: RegExp): { mentions: Mention<number[]>[]; rest: string } {
  const mentions: Mention<number[]>[] = []
  let rest = text
  for (const match of text.matchAll(pattern)) {
    const number = match[1] ?? match[2]
    if (!number) continue
    mentions.push({ raw: match[0].trim(), value: readAmount(number), index: match.index })
    rest = blank(rest, match.index, match[0].length)
  }
  return { mentions, rest }
}

function to24(hour: number, meridiem: string | undefined): number[] {
  if (hour > 23) return []
  if (!meridiem) return hour === 0 || hour > 12 ? [hour] : hour === 12 ? [12, 0] : [hour, hour + 12]
  const pm = plain(meridiem).startsWith("p")
  if (hour > 12) return [hour]
  if (hour === 12) return [pm ? 12 : 0]
  return [pm ? hour + 12 : hour]
}

/** Horas de reloj como minutos del día; una hora sin a. m./p. m. admite ambas lecturas. */
function extractTimes(text: string): { mentions: Mention<number[]>[]; rest: string } {
  const mentions: Mention<number[]>[] = []
  let rest = text
  const take = (match: RegExpMatchArray, hours: number[], minutes: number) => {
    if (!hours.length) return
    mentions.push({ raw: match[0].trim(), value: hours.map((hour) => hour * 60 + minutes) })
    rest = blank(rest, match.index ?? 0, match[0].length)
  }
  for (const match of text.matchAll(TIME_CLOCK)) take(match, to24(Number(match[1]), match[3]), Number(match[2]))
  for (const match of rest.matchAll(TIME_MERIDIEM)) take(match, to24(Number(match[1]), match[2]), 0)
  for (const match of rest.matchAll(TIME_WORDS)) {
    const hour = Number(match[1])
    const minutes = match[2] ? (plain(match[2]) === "media" ? 30 : 15) : 0
    const period = match[3] ? plain(match[3]) : null
    const hours =
      hour > 23
        ? []
        : period === "tarde" || period === "noche"
          ? [hour < 12 ? hour + 12 : hour]
          : period
            ? [hour === 12 ? 0 : hour]
            : to24(hour, undefined)
    take(match, hours, minutes)
  }
  return { mentions, rest }
}

interface DateValue {
  day: number
  month: number | null
  year: number | null
  weekday: number | null
}

function validDay(day: number, month: number | null): boolean {
  return day >= 1 && day <= 31 && (month === null || (month >= 1 && month <= 12))
}

function extractDates(text: string, cuedOnly: boolean): Mention<DateValue>[] {
  const mentions: Mention<DateValue>[] = []
  let rest = text
  const take = (match: RegExpMatchArray, value: DateValue) => {
    if (!validDay(value.day, value.month)) return
    mentions.push({ raw: match[0].trim(), value })
    rest = blank(rest, match.index ?? 0, match[0].length)
  }
  for (const match of text.matchAll(DATE_WORDS)) {
    take(match, {
      weekday: match[1] ? (WEEKDAYS[plain(match[1])] ?? null) : null,
      day: Number(match[2]),
      month: MONTHS[plain(match[3] ?? "")] ?? null,
      year: match[4] ? Number(match[4]) : null,
    })
  }
  for (const match of rest.matchAll(DATE_NUMERIC_YEAR)) {
    const year = Number(match[3])
    take(match, { weekday: null, day: Number(match[1]), month: Number(match[2]), year: year < 100 ? 2000 + year : year })
  }
  for (const match of rest.matchAll(DATE_ISO)) {
    take(match, { weekday: null, day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) })
  }
  for (const match of rest.matchAll(DATE_NUMERIC_CUED)) {
    take(match, {
      weekday: match[1] ? (WEEKDAYS[plain(match[1])] ?? null) : null,
      day: Number(match[2]),
      month: Number(match[3]),
      year: null,
    })
  }
  if (!cuedOnly) {
    // En las fuentes una fecha corta vale aunque no lleve palabra delante.
    for (const match of rest.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
      take(match, { weekday: null, day: Number(match[1]), month: Number(match[2]), year: null })
    }
  }
  for (const match of rest.matchAll(DATE_WEEKDAY_DAY)) {
    take(match, { weekday: WEEKDAYS[plain(match[1] ?? "")] ?? null, day: Number(match[2]), month: null, year: null })
  }
  return mentions
}

function zonedParts(date: Date, timeZone: string): { day: number; month: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date)
    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value)
    return { day: pick("day"), month: pick("month"), minutes: pick("hour") * 60 + pick("minute") }
  } catch {
    return null
  }
}

interface SourceFacts {
  source: string
  amounts: Set<number>
  /** Importes que la fuente da como precio y no solo como mínimo. */
  exact: Set<number>
  times: Set<number>
  /** Claves `día-mes` y, para fechas sin mes, `día-*`. */
  dates: Set<string>
}

/**
 * Identificadores internos (sedes, servicios, pacientes, propuestas): sus
 * cifras no son importes, horas ni fechas. Sin taparlos, un precio inventado
 * pasaría la comprobación con solo coincidir con un trozo de un id.
 */
const INTERNAL_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function factsOf(item: Evidence, timeZone: string): SourceFacts {
  const text = normalize(item.text).replace(INTERNAL_ID, (id) => " ".repeat(id.length))
  const amounts = new Set<number>()
  const exact = new Set<number>()
  const times = new Set<number>()
  const dates = new Set<string>()
  const zones = new Set<string>([timeZone, ...(text.match(ZONE_NAME) ?? [])])
  let rest = text
  for (const match of text.matchAll(ISO_INSTANT)) {
    const instant = new Date(match[0])
    if (!Number.isNaN(instant.getTime())) {
      for (const zone of zones) {
        const parts = zonedParts(instant, zone)
        if (!parts) continue
        times.add(parts.minutes)
        dates.add(`${parts.day}-${parts.month}`)
        dates.add(`${parts.day}-*`)
      }
    }
    rest = blank(rest, match.index, match[0].length)
  }
  for (const mention of extractDates(rest, false)) {
    const { day, month } = mention.value
    dates.add(`${day}-*`)
    if (month !== null) {
      dates.add(`${day}-${month}`)
      // Fecha numérica sin contexto: admite el orden mes/día de otras configuraciones regionales.
      if (mention.raw.includes("/") && day <= 12) dates.add(`${month}-${day}`)
    }
  }
  for (const mention of extractTimes(rest).mentions) for (const value of mention.value) times.add(value)
  for (const match of rest.matchAll(ANY_NUMBER)) {
    const minimum = cuedAsMinimum(rest, match.index)
    for (const reading of readAmount(match[0])) {
      amounts.add(reading)
      if (!minimum) exact.add(reading)
    }
  }
  return { source: item.source, amounts, exact, times, dates }
}

/** ¿Algún subconjunto de dos o más importes suma exactamente el objetivo? */
function isSumOf(target: number, parts: number[]): boolean {
  const pool = parts.filter((value) => value > 0 && value < target).slice(0, 8)
  const search = (index: number, total: number, used: number): boolean => {
    if (total === target) return used >= 2
    if (total > target || index >= pool.length) return false
    return search(index + 1, total + (pool[index] ?? 0), used + 1) || search(index + 1, total, used)
  }
  return search(0, 0, 0)
}

function weekdayOf(day: number, month: number, year: number | null, now: Date): number | null {
  const candidate = (y: number) => {
    const date = new Date(Date.UTC(y, month - 1, day))
    return date.getUTCMonth() === month - 1 ? date : null
  }
  if (year !== null) return candidate(year)?.getUTCDay() ?? null
  // Sin año: la fecha más próxima a hoy (una cita pasada reciente o la siguiente).
  const options = [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]
    .map(candidate)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))
  return options[0]?.getUTCDay() ?? null
}

/**
 * Comprueba la respuesta contra las fuentes del turno. Un dato cuenta como
 * sustentado si figura en alguna fuente; un importe, además, si es la suma de
 * otros importes sustentados de la misma respuesta. Con la moneda y el formato
 * de la clínica (`zone.currency`, `zone.locale`) se reconocen también su
 * símbolo y su nombre; sin ellos, solo códigos ISO, signos monetarios y los
 * nombres compartidos.
 */
export function verifyReply(
  reply: string,
  evidence: Evidence[],
  zone: { timezone: string; currency?: string | null; locale?: string | null },
  now: Date = new Date(),
): ReplyVerdict {
  // Lo consultado en el turno llega después de lo fijo del prompt y es lo más
  // específico (un hueco de agenda antes que el horario de la sede): se mira primero.
  const sources = evidence
    .filter((item) => item.text.trim())
    .map((item) => factsOf(item, zone.timezone))
    .reverse()
  const checks: FactCheck[] = []
  const text = normalize(reply)

  const amounts = extractAmounts(text, amountPattern(zone.currency, zone.locale))
  const supportedAmounts: number[] = []
  const pendingAmounts: Mention<number[]>[] = []
  for (const mention of amounts.mentions) {
    const found = sources.find((source) => mention.value.some((reading) => source.amounts.has(reading)))
    if (found) {
      const reading = mention.value.find((value) => found.amounts.has(value)) ?? 0
      // Un mínimo («desde») dicho como precio final no sale: el precio lo define la evaluación.
      const onlyMinimum = !sources.some((source) => source.exact.has(reading))
      if (onlyMinimum && !cuedAsMinimum(text, mention.index ?? 0)) {
        checks.push({ kind: "precio", value: `${mention.raw} (es un mínimo: dilo con «desde»)`, ok: false, source: found.source })
        continue
      }
      supportedAmounts.push(reading)
      checks.push({ kind: "precio", value: mention.raw, ok: true, source: found.source })
    } else {
      pendingAmounts.push(mention)
    }
  }
  for (const mention of pendingAmounts) {
    const summed = mention.value.some((reading) => isSumOf(reading, supportedAmounts))
    checks.push({ kind: "precio", value: mention.raw, ok: summed, source: summed ? SOURCE_SUM : null })
  }

  // Los instantes ISO no se escriben a una persona; si aparecen, se leen como fecha y hora.
  let rest = amounts.rest
  const dates = extractDates(rest, true)
  for (const mention of dates) rest = rest.replace(mention.raw, " ".repeat(mention.raw.length))
  for (const mention of dates) {
    const { day, month, year, weekday } = mention.value
    const key = month === null ? `${day}-*` : `${day}-${month}`
    const found = sources.find((source) => source.dates.has(key))
    if (!found) {
      checks.push({ kind: "fecha", value: mention.raw, ok: false, source: null })
      continue
    }
    const actual = month !== null && weekday !== null ? weekdayOf(day, month, year, now) : null
    if (actual !== null && actual !== weekday) {
      checks.push({
        kind: "fecha",
        value: `${mention.raw} (ese día es ${WEEKDAY_NAMES[actual] ?? ""})`,
        ok: false,
        source: SOURCE_CALENDAR,
      })
      continue
    }
    checks.push({ kind: "fecha", value: mention.raw, ok: true, source: found.source })
  }

  for (const mention of extractTimes(rest).mentions) {
    const found = sources.find((source) => mention.value.some((minutes) => source.times.has(minutes)))
    checks.push({ kind: "hora", value: mention.raw, ok: Boolean(found), source: found?.source ?? null })
  }

  const unsupported = checks.filter((check) => !check.ok)
  return { ok: unsupported.length === 0, checks, unsupported }
}

/** Texto que recibe el modelo cuando su respuesta no sale por un dato sin sustento. */
export function describeUnsupported(verdict: ReplyVerdict): string {
  const label: Record<FactKind, string> = { precio: "precio", hora: "hora", fecha: "fecha" }
  return verdict.unsupported.map((check) => `${label[check.kind]} «${check.value}»`).join(", ")
}
