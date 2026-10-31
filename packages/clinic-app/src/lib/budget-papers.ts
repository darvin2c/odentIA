import { useQuery } from "@tanstack/react-query"
import { fetchBudgets } from "./budgets"
import { usePermission } from "./crm"

/**
 * Los presupuestos de Documentos: solo se piden con su permiso, y quien no lo
 * tiene no ve filas. Comparte la consulta con el Plan (`["budgets", patientId]`).
 */
export function useBudgetPapers(patientId: string) {
  const canRead = usePermission("budgets.read")
  const query = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
    enabled: canRead,
  })
  return { canRead, query, budgets: canRead ? (query.data?.data ?? []) : [] }
}
