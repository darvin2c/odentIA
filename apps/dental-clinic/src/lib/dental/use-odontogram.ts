import { withoutReplaced } from "@odentia/dental"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@odentia/clinic-app/lib/api"
import type { OdontogramEntry, OdontogramState } from "./odontogram"

/** El odontograma de la persona: su estado por pieza y su historial. */
export function useOdontogram(patientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
    enabled,
  })
}

/**
 * Los hallazgos del odontograma que siguen en pie: lo anulado no motiva nada, ni lo reemplazado por
 * uno más nuevo de la misma pieza (sería tratar el que ya no está a la vista).
 */
export function useActiveFindings(patientId: string, enabled: boolean): OdontogramEntry[] {
  const query = useOdontogram(patientId, enabled)
  return withoutReplaced((query.data?.data.history ?? []).filter((entry) => !entry.voidedAt))
}
