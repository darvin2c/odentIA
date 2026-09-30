/** Helpers puros de la UI comercial (sin red ni estado global). */

/**
 * Convierte un valor `datetime-local` ("2026-09-30T14:30") a ISO UTC.
 * La entrada se interpreta en la zona local del navegador, no en UTC.
 * Devuelve null si está vacío o es inválido.
 */
export function localInputToIso(local: string): string | null {
  const value = local.trim()
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/** Convierte un ISO a valor `datetime-local` ("YYYY-MM-DDTHH:mm"). "" si ausente/inválido. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * Convierte un valor `date` ("2026-09-30") a ISO (medianoche local).
 * Devuelve null si está vacío o no tiene forma de fecha calendario.
 */
export function dateInputToIso(date: string): string | null {
  const value = date.trim()
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

/**
 * Convierte un monto escrito ("2500", "2500.50", "2500,50") a centavos enteros.
 * Devuelve null si está vacío o no es un monto no negativo.
 */
export function parseAmountToCents(raw: string): number | null {
  const value = raw.trim().replace(",", ".")
  if (!value) return null
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return null
  return Math.round(num * 100)
}

/** ¿La fecha ya pasó? null/ausente/inválido nunca vence. */
export function isOverdue(iso: string | null | undefined, now: number = Date.now()): boolean {
  if (!iso) return false
  const time = new Date(iso).getTime()
  return !Number.isNaN(time) && time < now
}

/**
 * Fecha+hora corta es-PE para vencimientos ("12/09/2026, 02:30 p. m.").
 * null/ausente/inválido → "Sin fecha" (nunca blanco). Pasado o futuro se
 * formatea igual; el vencido lo marca `isOverdue` por separado.
 */
export function formatDueAt(iso: string | null | undefined): string {
  if (!iso) return "Sin fecha"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Sin fecha"
  return date.toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
