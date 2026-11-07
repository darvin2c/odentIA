/**
 * Qué cambió en la revisión de un presupuesto, frente a la versión que
 * reemplaza («la corona sube de S/ 900 a S/ 1,000»). Se calcula al leer, de las
 * dos versiones: no se guarda aparte. La misma regla para la pantalla y el PDF.
 *
 * «No cambió» es mismo precio, mismo cobro (por tratamiento o por sesión),
 * mismas sesiones y misma promoción: es lo que conserva su respuesta al
 * entregarse (`carryRevisionAnswers` en servicios).
 */

/** Lo mínimo de una línea para compararla. */
export interface ChangeLine {
  planItemId: string
  optionId: string
  title: string
  priceCents: number | null
  billingMode: string
  sessionsPlanned: number | null
  promotionId: string | null
  currency: string
}

export type BudgetChange =
  | { kind: "precio"; planItemId: string; title: string; fromCents: number | null; toCents: number | null; currency: string }
  | { kind: "condiciones"; planItemId: string; title: string }
  | { kind: "nuevo"; planItemId: string; title: string }
  | { kind: "quitado"; planItemId: string; title: string }

/** Una línea por tratamiento (lo común a varias opciones está en cada una). */
function byItem<T extends ChangeLine>(lines: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const line of lines) if (!out.has(line.planItemId)) out.set(line.planItemId, line)
  return out
}

/**
 * Lo que cambió de una versión a la siguiente, en el orden de la revisión. De la
 * anterior van las líneas del camino que valía si había uno elegido; si no, todas.
 */
export function budgetChanges(previous: readonly ChangeLine[], revision: readonly ChangeLine[]): BudgetChange[] {
  const before = byItem(previous)
  const after = byItem(revision)
  const out: BudgetChange[] = []
  for (const [planItemId, line] of after) {
    const old = before.get(planItemId)
    if (!old) {
      out.push({ kind: "nuevo", planItemId, title: line.title })
      continue
    }
    if (old.priceCents !== line.priceCents || old.currency !== line.currency) {
      out.push({
        kind: "precio",
        planItemId,
        title: line.title,
        fromCents: old.priceCents,
        toCents: line.priceCents,
        currency: line.currency,
      })
      continue
    }
    if (
      old.billingMode !== line.billingMode ||
      old.sessionsPlanned !== line.sessionsPlanned ||
      old.promotionId !== line.promotionId
    ) {
      out.push({ kind: "condiciones", planItemId, title: line.title })
    }
  }
  for (const [planItemId, line] of before) {
    if (!after.has(planItemId)) out.push({ kind: "quitado", planItemId, title: line.title })
  }
  return out
}
