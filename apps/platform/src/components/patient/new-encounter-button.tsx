import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, toast } from "@odentia/ui";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import type { Encounter, PatientSummary } from "../../lib/patients";

export function NewEncounterButton({ patientId, openEncounterId }: { patientId: string; openEncounterId?: string | null }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const open = (id: string) => window.location.assign(`/patients/${patientId}/encounters/${id}`);
  const create = useMutation({
    mutationFn: async () => {
      try {
        const result = await apiFetch<{ data: Encounter }>(`/api/patients/${patientId}/encounters`, { method: "POST", body: "{}" });
        return result.data.id;
      } catch (error) {
        if (error instanceof ApiError && error.shape.code === "DRAFT_OPEN") {
          const result = await apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`);
          if (result.data.openEncounterId) return result.data.openEncounterId;
        }
        throw error;
      }
    },
    onSuccess: (id) => {
      void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] });
      open(id);
    },
    onError: (error) => toast.error(error.message),
  });
  if (!canWrite) return null;
  return <Button disabled={create.isPending} onClick={() => openEncounterId ? open(openEncounterId) : create.mutate()}>{create.isPending ? "Abriendo atención…" : "Nueva atención"}</Button>;
}
