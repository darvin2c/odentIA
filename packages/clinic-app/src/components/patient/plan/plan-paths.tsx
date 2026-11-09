/**
 * Los caminos de un presupuesto en el plan: cuando una pieza se puede tratar de
 * dos o tres maneras (conservar la 46 o extraerla), cada manera es una opción
 * del presupuesto y la persona elige una. Lo común va en todas las opciones y
 * las opciones nunca se suman. Lo dice el servidor en `PlanItem.path`; aquí
 * solo se agrupa para mostrarlo en la atención y en el plan por fases.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "../../../lib/api"
import { PLAN_QUERY_KEYS } from "../../../lib/budgets"
import { agreedPriceOf, type PlanItem } from "../../../lib/patients"
import { treatmentSiteLabel } from "./budget-parts"

/** Un camino: su posición (1 = el primero), su nombre si lo tiene y sus tratamientos. */
export interface PlanPath {
  position: number
  name: string | null
  /** El nombre o, sin él, los títulos de sus tratamientos («Endodoncia y corona»). */
  title: string
  items: PlanItem[]
}

/** Los caminos de un presupuesto entre los que la persona aún no elige. */
export interface PlanPathGroup {
  budgetId: string
  /** «Pieza 46», o vacío si no se sabe. */
  site: string
  toothNumber: number | null
  pathCount: number
  paths: PlanPath[]
  items: PlanItem[]
}

/** «dos», «tres»: los caminos se cuentan con palabras. */
export function pathCountWord(count: number): string {
  if (count === 2) return "dos"
  if (count === 3) return "tres"
  return String(count)
}

/** «En las dos» o «En todas» (las opciones). */
export function inAllPathsLabel(count: number): string {
  return count === 2 ? "En las dos" : "En todas"
}

/** Primera letra en minúscula, salvo siglas («PRF» queda igual). */
export function lowerFirst(text: string): string {
  if (text.length > 1 && text[1] === text[1]?.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(text[1] ?? "")) return text
  return text.charAt(0).toLocaleLowerCase("es") + text.slice(1)
}

/** «Endodoncia y corona», «Endodoncia, poste y corona». */
export function joinTitles(titles: string[]): string {
  const words = titles.map((title, index) => (index === 0 ? title : lowerFirst(title)))
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} y ${words[words.length - 1]}`
}

/** El tratamiento sigue en un camino por elegir. */
export function isOpenPath(item: PlanItem): boolean {
  return item.path != null && !item.path.chosen
}

/** Agrupa por presupuesto lo que está en un camino aún sin elegir; lo demás no entra. */
export function groupPlanPaths(items: PlanItem[]): PlanPathGroup[] {
  const byBudget = new Map<string, PlanItem[]>()
  for (const item of items) {
    if (!item.path || item.path.chosen) continue
    const rows = byBudget.get(item.path.budgetId) ?? []
    rows.push(item)
    byBudget.set(item.path.budgetId, rows)
  }
  return [...byBudget.entries()].map(([budgetId, rows]) => {
    const pathCount = Math.max(...rows.map((item) => item.path?.pathCount ?? 0), 2)
    const paths: PlanPath[] = []
    for (let position = 1; position <= pathCount; position += 1) {
      const pathItems = rows.filter((item) => item.path?.positions.includes(position))
      // El nombre es de la opción: lo trae quien está solo en ella.
      const name =
        pathItems.find((item) => item.path?.positions.length === 1 && item.path.name)?.path?.name ?? null
      paths.push({
        position,
        name,
        title: name ?? joinTitles(pathItems.map((item) => item.title)),
        items: pathItems,
      })
    }
    const sited = rows.find((item) => item.toothNumber != null) ?? rows[0]
    return {
      budgetId,
      site: sited ? treatmentSiteLabel(sited) : "",
      toothNumber: sited?.toothNumber ?? null,
      pathCount,
      paths,
      items: rows,
    }
  })
}

/** La suma de un camino, solo si todos tienen precio y en una sola moneda; si no, nula. */
export function pathTotal(items: PlanItem[]): { cents: number; currency: string } | null {
  if (items.length === 0) return null
  // Con el precio de su presupuesto, el que se cobra.
  const prices = items.map(agreedPriceOf)
  const currency = prices[0]?.currency
  if (!currency) return null
  let cents = 0
  for (const price of prices) {
    if (price.priceCents == null || price.currency !== currency) return null
    cents += price.priceCents
  }
  return { cents, currency }
}

/** A dónde va un tratamiento: otro camino, uno de los que hay o todos. */
export type PathTarget = "nuevo" | "todos" | 1 | 2 | 3

/**
 * Pone un tratamiento indicado en esta atención en un camino del presupuesto
 * en borrador. Después vuelve a leer el plan, los presupuestos y «qué sigue».
 */
export function usePlacePath({
  patientId,
  encounterId,
  beforeWrite,
  onChanged,
}: {
  patientId: string
  encounterId: string
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ planItemId, path }: { planItemId: string; path: PathTarget }) => {
      await beforeWrite()
      return apiFetch(`/api/patients/${patientId}/budgets/paths`, {
        method: "POST",
        body: JSON.stringify({ encounterId, planItemId, path }),
      })
    },
    onSuccess: async () => {
      await Promise.all(
        [...PLAN_QUERY_KEYS, "budget-send-preview"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key, patientId] }),
        ),
      )
      await onChanged()
    },
  })
}
