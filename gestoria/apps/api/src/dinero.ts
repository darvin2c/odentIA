/**
 * Los importes de una tienda: siempre en la unidad menor de su moneda (ISO 4217), como enteros.
 * Cuántos decimales tiene cada moneda lo dice el entorno (`Intl`): dos en PEN, cero en CLP.
 */

export function fractionDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}

/**
 * Lee un importe escrito por una persona («129», «129.90», «129,90», «S/ 129»). Sin separador
 * de miles: «1,299.00» es ambiguo y se rechaza. Devuelve la unidad menor, o null si no se lee.
 */
export function parseMoney(text: string, currency: string): number | null {
  const clean = text
    .trim()
    .replace(/^[^\d-]+/, "")
    .replace(/\s+/g, "")
  const digits = fractionDigits(currency)
  const match = /^(\d{1,9})(?:[.,](\d+))?$/.exec(clean)
  if (!match) return null
  const decimals = match[2] ?? ""
  if (decimals.length > digits) return null
  const whole = Number(match[1])
  const fraction = Number(decimals.padEnd(digits, "0") || "0")
  return whole * 10 ** digits + fraction
}

export function formatMoney(cents: number, currency: string): string {
  const digits = fractionDigits(currency)
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 10 ** digits === 0 ? 0 : digits,
  }).format(cents / 10 ** digits)
}

/**
 * El aviso del precio mínimo frente a lo que costó (tablero 14): bajo el costo, «pérdida»; a
 * menos de un 10 % por encima, «cerca». Solo avisa: guardar igual es decisión del dueño (puede
 * ser una liquidación). Sin costo registrado, no hay aviso.
 */
export type CostWarning =
  | { kind: "perdida"; costCents: number; lossCents: number }
  | { kind: "cerca"; costCents: number; marginCents: number }

export const NEAR_COST_RATIO = 0.1

export function costWarning(
  minPriceCents: number | null,
  lastCostCents: number | null,
): CostWarning | null {
  if (minPriceCents === null || lastCostCents === null) return null
  if (minPriceCents < lastCostCents)
    return { kind: "perdida", costCents: lastCostCents, lossCents: lastCostCents - minPriceCents }
  const margin = minPriceCents - lastCostCents
  if (margin <= Math.round(lastCostCents * NEAR_COST_RATIO))
    return { kind: "cerca", costCents: lastCostCents, marginCents: margin }
  return null
}
