import { formatLocale } from "../locale.js"
import { normalizeSearchText } from "../text.js"

/**
 * Núcleo de zona horaria. El formato canónico es el identificador IANA
 * (`America/Lima`), el mismo que guardan `organization.timezone` y
 * `branch.timezone` (`branch` en `null` = hereda la de la organización).
 *
 * Todo sale del runtime (`Intl`): la lista de zonas, el desfase, la etiqueta
 * GMT y las zonas de un país. No mantenemos una tabla de husos propia: donde
 * existe estándar se usa el estándar, y el estándar en zona horaria se mueve
 * (DST, cambios de reglas), así que una tabla en el repo envejecería mal.
 */

export interface TimeZoneInfo {
  /** Identificador IANA canónico. */
  timeZone: string
  /** Ciudad legible: `America/Argentina/Buenos_Aires` → `Buenos Aires`. */
  city: string
  /** Primer segmento del identificador: `America`, `Europe`, `Asia`… */
  region: string
  /** Desfase respecto a UTC en minutos para la fecha de referencia. */
  offsetMinutes: number
  /** Etiqueta del desfase que da el runtime: `GMT-5`, `GMT+5:30`, `GMT`. */
  offsetLabel: string
}

/** Zona con el texto de búsqueda ya normalizado. */
export interface TimeZoneOption extends TimeZoneInfo {
  search: string
}

export interface TimeZoneMeta extends TimeZoneInfo {
  /** Hora local en esa zona para la fecha de referencia, `HH:mm`. */
  localTime: string
}


/** Caché de identificadores ya interpretados (incluye los inválidos). */
const canonical = new Map<string, string | undefined>()

/**
 * Identificador canónico de una zona, o `undefined` si el texto no es una zona
 * válida. Acepta alias y mayúsculas (`US/Pacific` → `America/Los_Angeles`) para
 * que un dato heredado se muestre bien y no quede como si no existiera.
 */
export function canonicalTimeZone(value: string | null | undefined): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (canonical.has(text)) return canonical.get(text)
  let resolved: string | undefined
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: text }).resolvedOptions().timeZone
  } catch {
    // `Intl` lanza RangeError con cualquier texto que no sea una zona IANA.
    resolved = undefined
  }
  canonical.set(text, resolved)
  return resolved
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  })
}

/** Zona con su desfase en la fecha de referencia; `undefined` si no es válida. */
export function timeZoneInfo(
  value: string | null | undefined,
  reference: Date = new Date(),
): TimeZoneInfo | undefined {
  const timeZone = canonicalTimeZone(value)
  if (!timeZone) return undefined

  const parts = formatterFor(timeZone).formatToParts(reference)
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value)
  // El desfase se deduce de comparar la hora local de la zona leída como si
  // fuera UTC contra el instante real: sin parsear el texto "GMT-5", que sí
  // depende de la locale.
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  )
  const [region, ...rest] = timeZone.split("/")

  return {
    timeZone,
    city: (rest.length ? rest[rest.length - 1] : region).replaceAll("_", " "),
    region,
    offsetMinutes: Math.round((asUtc - reference.getTime()) / 60_000),
    offsetLabel: parts.find((item) => item.type === "timeZoneName")?.value ?? "",
  }
}

// Orden alfabético con el formato regional vigente, leído al ordenar (y no a
// nivel de módulo); un comparador por formato.
const collators = new Map<string, Intl.Collator>()
const collator = {
  compare(a: string, b: string): number {
    const locale = formatLocale()
    let found = collators.get(locale ?? "")
    if (!found) {
      found = new Intl.Collator(locale, { sensitivity: "base" })
      collators.set(locale ?? "", found)
    }
    return found.compare(a, b)
  },
}

/**
 * Zona lista para el selector: la lectura de `timeZoneInfo` más el texto de
 * búsqueda normalizado (ciudad + identificador + desfase). `undefined` si el
 * texto no es una zona válida.
 */
export function timeZoneOption(
  value: string | null | undefined,
  reference: Date = new Date(),
): TimeZoneOption | undefined {
  const info = timeZoneInfo(value, reference)
  if (!info) return undefined
  return {
    ...info,
    search: normalizeSearchText(
      // Con barras y con espacios: `asia/tokyo` y `asia tokyo` encuentran igual.
      `${info.city} ${info.timeZone} ${info.timeZone.replaceAll("/", " ")} ${info.offsetLabel}`,
    ),
  }
}

let table: { day: string; options: TimeZoneOption[] } | null = null

/**
 * Las zonas canónicas del runtime (418 hoy), de oeste a este, con el texto de
 * búsqueda ya calculado. La tabla se arma una vez por día: los desfases solo
 * cambian en un salto de DST, y el selector no necesita precisión de minuto.
 */
export function timeZoneOptions(reference: Date = new Date()): TimeZoneOption[] {
  const day = reference.toISOString().slice(0, 10)
  if (table?.day === day) return table.options

  const options = Intl.supportedValuesOf("timeZone")
    .map((zone) => timeZoneOption(zone, reference))
    .filter((option): option is TimeZoneOption => option !== undefined)
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || collator.compare(a.city, b.city))

  table = { day, options }
  return options
}

/**
 * Zonas que el runtime atribuye a un país (`Intl.Locale.timeZones`). Para Perú
 * devuelve `America/Lima`; para países con varias, todas. Se canonicalizan y
 * deduplican porque la lista del runtime trae algunos alias.
 */
export function zonesForCountry(countryCode: string | null | undefined): string[] {
  const code = countryCode?.trim().toUpperCase()
  if (code?.length !== 2) return []
  if (typeof Intl.Locale !== "function") return []
  try {
    const locale = new Intl.Locale(`und-${code}`)
    const zones = (locale as Intl.Locale & { timeZones?: readonly string[] }).timeZones
    if (!zones?.length) return []
    const unique = new Set<string>()
    for (const zone of zones) {
      const canonicalZone = canonicalTimeZone(zone)
      if (canonicalZone) unique.add(canonicalZone)
    }
    return [...unique].sort((a, b) => collator.compare(a, b))
  } catch {
    // Región desconocida: sin sugerencias, no es un error del formulario.
    return []
  }
}

/** Zona del navegador, canonicalizada. */
export function detectedTimeZone(): string | undefined {
  return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
}

/** Hora local `HH:mm` de una zona en la fecha de referencia. */
export function localTimeIn(
  value: string | null | undefined,
  reference: Date = new Date(),
): string {
  const timeZone = canonicalTimeZone(value)
  if (!timeZone) return ""
  return new Intl.DateTimeFormat(formatLocale(), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(reference)
}

/** Lectura completa de una zona, para la pantalla que la muestra. */
export function timeZoneMeta(
  value: string | null | undefined,
  reference: Date = new Date(),
): TimeZoneMeta | undefined {
  const info = timeZoneInfo(value, reference)
  if (!info) return undefined
  return { ...info, localTime: localTimeIn(info.timeZone, reference) }
}
