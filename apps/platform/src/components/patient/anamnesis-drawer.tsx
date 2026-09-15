import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormDrawer } from "@odentia/ui-patterns";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { timeAgo, useCanWrite } from "../../lib/crm";
import type { AnamnesisAnswers } from "../../lib/patients";
import { RegistrationAnamnesisStep, sanitizeAnswers } from "./registration-anamnesis-step";

interface LatestAnamnesis {
  version: number;
  createdAt: string;
  answers: AnamnesisAnswers;
}

/** Drawer controlado para crear una nueva versión de anamnesis desde las últimas respuestas. */
export function AnamnesisDrawer({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const latestQuery = useQuery({
    queryKey: ["patient-anamnesis", patientId],
    queryFn: () => apiFetch<{ data: LatestAnamnesis }>(`/api/patients/${patientId}/anamnesis`),
    retry: false,
    enabled: open,
  });

  const latest = latestQuery.data?.data ?? null;
  const [value, setValue] = useState<AnamnesisAnswers>({});
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    if (open && latest) setValue({ ...(latest.answers as Record<string, unknown>) } as AnamnesisAnswers);
    if (open && !latest) setValue({});
  }, [open, latest?.version]);

  const saveMutation = useMutation({
    mutationFn: (answers: AnamnesisAnswers) =>
      apiFetch(`/api/patients/${patientId}/anamnesis`, {
        method: "POST",
        body: JSON.stringify({ answers: sanitizeAnswers(answers) }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["patient-anamnesis", patientId] });
      void queryClient.invalidateQueries({ queryKey: ["patient-anamnesis-history", patientId] });
      void queryClient.invalidateQueries({ queryKey: ["timeline", patientId] });
      void queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
      onOpenChange(false);
    },
  });

  return (
    <FormDrawer
      open={open}
      onClose={() => !saveMutation.isPending && onOpenChange(false)}
      title={latest ? `Nueva anamnesis (actual: v${latest.version})` : "Primera anamnesis"}
      description={
        latest
          ? `Se crea una nueva versión a partir de la v${latest.version} (${timeAgo(latest.createdAt)}).`
          : "Aún no hay anamnesis registradas para este paciente."
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (!saveMutation.isPending) saveMutation.mutate(value);
      }}
      isSubmitting={saveMutation.isPending}
      isLoading={latestQuery.isLoading}
      submitDisabled={!canWrite}
      submitLabel="Guardar anamnesis"
      error={
        saveMutation.isError
          ? saveMutation.error instanceof ApiError
            ? (saveMutation.error.shape.message ?? `Error ${saveMutation.error.status}`)
            : "No se pudo guardar la anamnesis."
          : latestQuery.isError
            ? "No se pudo cargar la anamnesis previa; se creará la primera versión."
            : null
      }
      className="sm:max-w-2xl"
    >
      <RegistrationAnamnesisStep
        value={value}
        onChange={setValue}
        consent={consent}
        onConsentChange={setConsent}
        showConsent={false}
      />
    </FormDrawer>
  );
}
