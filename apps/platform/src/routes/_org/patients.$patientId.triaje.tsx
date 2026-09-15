import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button, toast } from "@odentia/ui";
import { PageHeader, SubmitButton } from "@odentia/ui-patterns";
import { Info } from "lucide-react";
import { useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import type { AnamnesisAnswers } from "../../lib/patients";
import {
  RegistrationAnamnesisStep,
  sanitizeAnswers,
} from "../../components/patient/registration-anamnesis-step";
import {
  RegistrationHealthStep,
  type PatientHealthValues,
} from "../../components/patient/registration-health-step";

export const Route = createFileRoute("/_org/patients/$patientId/triaje")({
  component: TriajePage,
});

const emptyHealth: PatientHealthValues = { allergies: [], conditions: [], medications: [] };

function validateHealth(health: PatientHealthValues): string | null {
  if (health.allergies.some((a) => !a.substance.trim())) {
    return "Cada alergia necesita la sustancia";
  }
  if (health.conditions.some((c) => !c.name.trim())) {
    return "Cada condición necesita el nombre";
  }
  if (health.medications.some((m) => !m.name.trim())) {
    return "Cada medicamento necesita el nombre";
  }
  return null;
}

function TriajePage() {
  const { patientId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [health, setHealth] = useState<PatientHealthValues>(emptyHealth);
  const [answers, setAnswers] = useState<AnamnesisAnswers>({});
  const [consent, setConsent] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const allergiesQuery = useQuery({
    queryKey: ["patient-allergies", patientId],
    queryFn: () => apiFetch<{ data: unknown[] }>(`/api/patients/${patientId}/allergies`),
  });
  const conditionsQuery = useQuery({
    queryKey: ["patient-conditions", patientId],
    queryFn: () => apiFetch<{ data: unknown[] }>(`/api/patients/${patientId}/conditions`),
  });
  const medicationsQuery = useQuery({
    queryKey: ["patient-medications", patientId],
    queryFn: () => apiFetch<{ data: unknown[] }>(`/api/patients/${patientId}/medications`),
  });
  const anamnesisQuery = useQuery({
    queryKey: ["patient-anamnesis", patientId],
    queryFn: () =>
      apiFetch<{ data: { version: number; createdAt: string; answers: AnamnesisAnswers } }>(
        `/api/patients/${patientId}/anamnesis`,
      ),
    retry: false,
  });

  const hasExisting =
    (allergiesQuery.data?.data.length ?? 0) > 0 ||
    (conditionsQuery.data?.data.length ?? 0) > 0 ||
    (medicationsQuery.data?.data.length ?? 0) > 0 ||
    anamnesisQuery.data != null;
  const hasAnamnesis = anamnesisQuery.data != null;

  async function save(): Promise<void> {
    if (pending) return;
    const msg = validateHealth(health);
    if (msg) {
      setHealthError(msg);
      return;
    }
    setHealthError(null);
    setPending(true);
    const failures: string[] = [];
    try {
      for (const allergy of health.allergies) {
        try {
          await apiFetch(`/api/patients/${patientId}/allergies`, {
            method: "POST",
            body: JSON.stringify({
              substance: allergy.substance.trim(),
              ...(allergy.reaction?.trim() ? { reaction: allergy.reaction.trim() } : {}),
              ...(allergy.severity ? { severity: allergy.severity } : {}),
            }),
          });
        } catch {
          failures.push(`alergia "${allergy.substance.trim()}"`);
        }
      }
      for (const condition of health.conditions) {
        try {
          await apiFetch(`/api/patients/${patientId}/conditions`, {
            method: "POST",
            body: JSON.stringify({
              name: condition.name.trim(),
              ...(condition.status ? { status: condition.status } : {}),
              ...(condition.startDate?.trim() ? { startDate: condition.startDate.trim() } : {}),
              ...(condition.notes?.trim() ? { notes: condition.notes.trim() } : {}),
            }),
          });
        } catch {
          failures.push(`condición "${condition.name.trim()}"`);
        }
      }
      for (const medication of health.medications) {
        try {
          await apiFetch(`/api/patients/${patientId}/medications`, {
            method: "POST",
            body: JSON.stringify({
              name: medication.name.trim(),
              ...(medication.dose?.trim() ? { dose: medication.dose.trim() } : {}),
              ...(medication.frequency?.trim() ? { frequency: medication.frequency.trim() } : {}),
              ...(medication.notes?.trim() ? { notes: medication.notes.trim() } : {}),
            }),
          });
        } catch {
          failures.push(`medicamento "${medication.name.trim()}"`);
        }
      }
      const cleanedAnswers = sanitizeAnswers(answers);
      if (Object.keys(cleanedAnswers).length > 0 && !hasAnamnesis) {
        try {
          await apiFetch(`/api/patients/${patientId}/anamnesis`, {
            method: "POST",
            body: JSON.stringify({ answers: cleanedAnswers }),
          });
        } catch {
          failures.push("anamnesis");
        }
      }
      if (consent) {
        try {
          await apiFetch(`/api/patients/${patientId}`, {
            method: "PATCH",
            body: JSON.stringify({ dataConsent: true }),
          });
        } catch {
          failures.push("consentimiento de datos");
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["patients"] });
      await queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
      await queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
      await queryClient.invalidateQueries({ queryKey: ["patient-conditions", patientId] });
      await queryClient.invalidateQueries({ queryKey: ["patient-medications", patientId] });
      await queryClient.invalidateQueries({ queryKey: ["patient-anamnesis", patientId] });
      if (failures.length > 0) {
        toast.error(
          `Triaje guardado, pero no se guardó: ${failures.join(", ")}. Complétalo en el perfil.`,
        );
      } else {
        toast.success("Triaje guardado");
      }
      await navigate({ to: "/patients/$patientId", params: { patientId } });
    } catch (err) {
      toast.error(err instanceof ApiError ? (err.shape.message ?? err.message) : "No se pudo guardar el triaje");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Triaje inicial"
        subtitle="Alergias, condiciones, medicación y anamnesis del paciente."
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void navigate({ to: "/patients/$patientId", params: { patientId } })}
          >
            Ir al perfil
          </Button>
        }
      />
      {hasExisting ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            Este paciente ya tiene datos de triaje; lo que guardes se agrega como filas nuevas.
          </p>
        </div>
      ) : null}
      {healthError ? (
        <p role="alert" className="text-sm text-destructive">
          {healthError}
        </p>
      ) : null}
      <RegistrationHealthStep
        value={health}
        onChange={(next) => {
          setHealth(next);
          setHealthError(null);
        }}
      />
      <RegistrationAnamnesisStep
        value={answers}
        onChange={setAnswers}
        consent={consent}
        onConsentChange={setConsent}
        showConsent
      />
      <div className="flex justify-end">
        <SubmitButton type="button" pending={pending} onClick={() => void save()}>
          Guardar triaje
        </SubmitButton>
      </div>
    </div>
  );
}
