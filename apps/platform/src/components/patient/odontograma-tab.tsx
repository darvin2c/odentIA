import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import type { OdontogramState } from "../../lib/patients";
import { OdontogramStudio } from "../odontogram-studio";

export function OdontogramaTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const chart = useQuery({ queryKey: ["odontogram", patientId], queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`) });
  if (chart.isLoading) return <p className="text-sm text-muted-foreground">Cargando odontograma…</p>;
  if (!chart.data) return <p role="alert" className="text-sm text-destructive">{chart.error?.message ?? "No se pudo cargar el odontograma."}</p>;
  return <OdontogramStudio patientId={patientId} state={chart.data.data} onChanged={() => queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] })} />;
}
