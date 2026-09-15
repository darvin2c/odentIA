import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import type { PatientSummary } from "../../lib/patients";
import { NewEncounterButton } from "./new-encounter-button";
import { QuickNoteDrawer } from "./quick-note-drawer";
import { Timeline } from "./timeline";

export interface HistoriaTabProps {
  patientId: string;
  initialTooth?: number;
  onOdontogramSelect: (tooth: number) => void;
}

export function HistoriaTab({ patientId, initialTooth, onOdontogramSelect }: HistoriaTabProps) {
  const summary = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2">
        <QuickNoteDrawer patientId={patientId} />
        <NewEncounterButton patientId={patientId} openEncounterId={summary.data?.data.openEncounterId} />
      </div>
      <Timeline patientId={patientId} initialTooth={initialTooth} onOdontogramSelect={onOdontogramSelect} />
    </div>
  );
}
