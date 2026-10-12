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

const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
const CURRENCY_BEFORE = String.raw`(?:S\/\.?|US\$|U\$S|\$|€|Bs\.?|PEN|USD|EUR|MXN|COP|CLP|ARS|BOB)`
const CURRENCY_AFTER = String.raw`(?:nuevos soles|soles|sol|d[oó]lares|d[oó]lar|pesos|peso|euros|euro|bolivianos|PEN|USD|EUR|MXN|COP|CLP|ARS|BOB)`
const AMOUNT = new RegExp(
  String.raw`(?<![A-Za-zÁÉÍÓÚÑáéíóúñ])${CURRENCY_BEFORE}\s?(${NUMBER})(?![\d])|(?<![\d.,/:])(${NUMBER})\s?${CURRENCY_AFTER}(?![a-záéíóúñ])`,
  "gi",
)
const ANY_NUMBER = new RegExp(String.raw`(?<![\d])(?:${NUMBER})(?![\d])`, "g")
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

/**
 * Interpretaciones en céntimos de un número escrito. Un único separador con
 * tres cifras detrás («1.200») es ambiguo entre miles y decimales: se
 * devuelven ambas lecturas para no rechazar por formato.
 */
function parseCents(raw: string): number[] {
  const text = raw.replace(/\s/g, "")
  const separators = text.replace(/\d/g, "")
  if (!separators) return [Number(text) * 100]
  const kinds = new Set(separators)
  if (kinds.size === 2) {
    const decimal = text[Math.max(text.lastIndexOf("."), text.lastIndexOf(","))]
    const thousands = decimal === "." ? "," : "."
    return [Math.round(Number(text.split(thousands).join("").replace(decimal ?? ".", ".")) * 100)]
  }
  const separator = separators[0] ?? "."
  if (separators.length > 1) return [Number(text.split(separator).join("")) * 100]
  const [whole = "", fraction = ""] = text.split(separator)
  const asDecimal = Math.round(Number(`${whole}.${fraction}`) * 100)
  if (fraction.length === 3) return [Number(`${whole}${fraction}`) * 100, asDecimal]
  return [asDecimal]
}

interface Mention<T> {
  raw: string
  value: T
}

function blank(text: string, start: number, length: number): string {
  return `${text.slice(0, start)}${" ".repeat(length)}${text.slice(start + length)}`
}

/** Importes con moneda explícita; devuelve también el texto con ellos tapados. */
function extractAmounts(text: string): { mentions: Mention<number[]>[]; rest: string } {
  const mentions: Mention<number[]>[] = []
  let rest = text
  for (const match of text.matchAll(AMOUNT)) {
    const number = match[1] ?? match[2]
    if (!number) continue
    mentions.push({ raw: match[0].trim(), value: parseCents(number) })
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
  for (const match of rest.matchAll(ANY_NUMBER)) for (const cents of parseCents(match[0])) amounts.add(cents)
  return { source: item.source, amounts, times, dates }
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
 * otros importes sustentados de la misma respuesta.
 */
export function verifyReply(
  reply: string,
  evidence: Evidence[],
  zone: { timezone: string },
  now: Date = new Date(),
): ReplyVerdict {
  const sources = evidence.filter((item) => item.text.trim()).map((item) => factsOf(item, zone.timezone))
  const checks: FactCheck[] = []
  const text = normalize(reply)

  const amounts = extractAmounts(text)
  const supportedAmounts: number[] = []
  const pendingAmounts: Mention<number[]>[] = []
  for (const mention of amounts.mentions) {
    const found = sources.find((source) => mention.value.some((cents) => source.amounts.has(cents)))
    if (found) {
      supportedAmounts.push(mention.value.find((cents) => found.amounts.has(cents)) ?? 0)
      checks.push({ kind: "precio", value: mention.raw, ok: true, source: found.source })
    } else {
      pendingAmounts.push(mention)
    }
  }
  for (const mention of pendingAmounts) {
    const summed = mention.value.some((cents) => isSumOf(cents, supportedAmounts))
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
