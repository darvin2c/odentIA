// Días hábiles en Perú: de lunes a viernes, sin los feriados nacionales.
//
// Los usa el plazo del Libro de Reclamaciones (D.S. 011-2011-PCM, art. 6), que
// es una norma peruana: por eso el calendario es de Perú y no del país de una
// clínica. Las fechas son días civiles de Lima en ISO 8601 («2026-10-23»).
//
// Feriados nacionales del Código de Trabajo y sus leyes (vigentes desde 2024:
// Ley 31788 añadió el 7 de junio, el 6 de agosto y el 9 de diciembre; Ley 31822,
// el 23 de julio). Jueves y Viernes Santo salen de la fecha de Pascua, así no
// hay que escribir una lista por año. Los días no laborables que el Ejecutivo
// declara a última hora no se descuentan: el plazo nunca parece más largo de
// lo que es.

const FIXED_HOLIDAYS = new Set([
  "01-01", // Año Nuevo
  "05-01", // Día del Trabajo
  "06-07", // Batalla de Arica y Día de la Bandera
  "06-29", // San Pedro y San Pablo
  "07-23", // Día de la Fuerza Aérea del Perú
  "07-28", // Fiestas Patrias
  "07-29", // Fiestas Patrias
  "08-06", // Batalla de Junín
  "08-30", // Santa Rosa de Lima
  "10-08", // Combate de Angamos
  "11-01", // Todos los Santos
  "12-08", // Inmaculada Concepción
  "12-09", // Batalla de Ayacucho
  "12-25", // Navidad
])

const DAY_MS = 86_400_000

/** Día civil de Lima de un instante, en ISO 8601. */
export function limaDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant)
}

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Domingo de Pascua del año (algoritmo gregoriano anónimo, «Meeus/Jones/Butcher»). */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

const holyWeekCache = new Map<number, Set<string>>()

function holyWeek(year: number): Set<string> {
  let days = holyWeekCache.get(year)
  if (!days) {
    const easter = easterSunday(year).getTime()
    days = new Set([toIso(new Date(easter - 3 * DAY_MS)), toIso(new Date(easter - 2 * DAY_MS))])
    holyWeekCache.set(year, days)
  }
  return days
}

/** ¿Es día hábil en Perú? */
export function isPeruBusinessDay(iso: string): boolean {
  const date = toUtc(iso)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  if (FIXED_HOLIDAYS.has(iso.slice(5))) return false
  return !holyWeek(date.getUTCFullYear()).has(iso)
}

/** El día hábil número `count` contado desde el día siguiente a `from`. */
export function addPeruBusinessDays(from: string, count: number): string {
  let date = toUtc(from)
  let left = count
  while (left > 0) {
    date = new Date(date.getTime() + DAY_MS)
    if (isPeruBusinessDay(toIso(date))) left--
  }
  return toIso(date)
}

/** Días hábiles después de `from` y hasta `to` incluido; 0 si `to` no es posterior. */
export function peruBusinessDaysBetween(from: string, to: string): number {
  let date = toUtc(from)
  const end = toUtc(to).getTime()
  let total = 0
  while (date.getTime() < end) {
    date = new Date(date.getTime() + DAY_MS)
    if (isPeruBusinessDay(toIso(date))) total++
  }
  return total
}
