import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Badge, Button } from "@odentia/ui";
import { EmptyState } from "@odentia/ui-patterns";
import { ArrowLeft, ClipboardList } from "lucide-react";
import { EncounterDetailView } from "../../components/patient/encounter-detail-view";
import { EncounterEditor } from "../../components/patient/encounter-editor";
import { apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import { hcLabel, type EncounterDetail, type PatientFull } from "../../lib/patients";

export const Route = createFileRoute("/_org/patients/$patientId/encounters/$encounterId")({
  component: EncounterPage,
});

function EncounterPage() {
  const { patientId, encounterId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  });
  const encounterQuery = useQuery({
    queryKey: ["encounter", patientId, encounterId],
    queryFn: () => apiFetch<{ data: EncounterDetail }>(`/api/patients/${patientId}/encounters/${encounterId}`),
  });
  const back = () => navigate({ to: "/patients/$patientId", params: { patientId }, search: { tab: "historia" } });
  const changed = () => queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] });
  const finalized = async () => {
    await Promise.all(["encounter", "patient-summary", "timeline", "plan"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key, patientId] }),
    ));
    await back();
  };

  if (patientQuery.isLoading || encounterQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando atención…</p>;
  }
  if (!patientQuery.data || !encounterQuery.data) {
    return <div className="flex flex-col gap-4">
      <Button variant="ghost" className="self-start" onClick={() => void back()}><ArrowLeft /> Volver al paciente</Button>
      <EmptyState icon={ClipboardList} title="No se pudo cargar la atención" description={encounterQuery.error?.message ?? patientQuery.error?.message ?? "La atención no existe o no tienes acceso."} />
    </div>;
  }

  const patient = patientQuery.data.data;
  const detail = encounterQuery.data.data;
  if (detail.encounter.status === "borrador" && canWrite) {
    return <EncounterEditor key={encounterId} patientId={patientId} patient={patient} detail={detail} onChanged={changed} onFinalized={finalized} onBack={back} />;
  }
  return <div className="flex flex-col gap-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-2">
        <Button variant="ghost" className="self-start" onClick={() => void back()}><ArrowLeft /> Volver al paciente</Button>
        <h1 className="text-2xl font-semibold">Atención {detail.encounter.status === "finalizada" ? "finalizada" : "en curso"}</h1>
        <p className="text-sm text-muted-foreground">{patient.displayName} · {hcLabel(patient.patient.patientNumber)}</p>
      </div>
      <Badge variant="outline">Solo lectura</Badge>
    </header>
    <EncounterDetailView patientId={patientId} detail={detail} />
  </div>;
}
