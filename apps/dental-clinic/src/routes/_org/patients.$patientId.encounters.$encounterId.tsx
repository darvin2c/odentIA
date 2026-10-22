import { Badge } from "@odentia/ui"
import { EmptyState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ClipboardList } from "lucide-react"
import { SignedOdontogramFact } from "../../components/dental/odontogram-assessments"
import { ControlesPanel } from "../../components/patient/clinical-panels"
import { EncounterBreadcrumb } from "../../components/patient/encounter-breadcrumb"
import { EncounterDocumentsBlock } from "../../components/patient/encounter-documents"
import { EncounterDetailView } from "../../components/patient/encounter-detail-view"
import { EncounterEditor } from "../../components/patient/encounter-editor"
import { EncounterHandoff } from "../../components/patient/encounter-handoff"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import {
  type EncounterDetail,
  encounterStatusLabel,
  hcLabel,
  type PatientFull,
} from "../../lib/patients"

export const Route = createFileRoute("/_org/patients/$patientId/encounters/$encounterId")({
  component: EncounterPage,
})

function EncounterPage() {
  const { patientId, encounterId } = Route.useParams()
  const queryClient = useQueryClient()
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  // Con lo clínico (condiciones, medicación y salud declarada): es una lectura clínica y deja su traza.
  const patientQuery = useQuery({
    queryKey: ["patient", patientId, "clinical"],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}?clinical=1`),
    enabled: canRead,
  })
  const encounterQuery = useQuery({
    queryKey: ["encounter", patientId, encounterId],
    queryFn: () =>
      apiFetch<{ data: EncounterDetail }>(`/api/patients/${patientId}/encounters/${encounterId}`),
    enabled: canRead,
  })
  const changed = () =>
    queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] })
  const finalized = async (_hasCharges: boolean) => {
    // Al finalizar se permanece en la atención, ya de solo lectura: su bloque de
    // cierre y relevo muestra qué recibe cada rol (cobro, control, seguimiento).
    await Promise.all(
      [
        "encounter",
        "patient-summary",
        "open-encounter",
        "timeline",
        "plan-items",
        "patient-account",
        "follow-ups",
        "prescriptions",
        "consents",
        "treatment-coordination",
        // Al firmar queda armado el presupuesto con lo indicado (ADR 0034).
        "budgets",
        "plan-next",
        "treatment-plans",
      ].map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })),
    )
  }

  if (patientQuery.isLoading || encounterQuery.isLoading) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Cargando atención…</p>
      </PageShell>
    )
  }
  if (!patientQuery.data || !encounterQuery.data) {
    return (
      <PageShell className="flex flex-col gap-4">
        <EncounterBreadcrumb
          patientId={patientId}
          patientName={patientQuery.data?.data.patient.displayName}
        />
        <EmptyState
          icon={ClipboardList}
          title="No se pudo cargar la atención"
          description={
            encounterQuery.error?.message ??
            patientQuery.error?.message ??
            "La atención no existe o no tienes acceso."
          }
        />
      </PageShell>
    )
  }

  const patient = patientQuery.data.data
  const detail = encounterQuery.data.data
  if (detail.encounter.status === "borrador" && canWrite) {
    return (
      <PageShell className="flex flex-col gap-4">
        <EncounterEditor
          key={encounterId}
          patientId={patientId}
          patient={patient}
          detail={detail}
          onChanged={changed}
          onFinalized={finalized}
        />
      </PageShell>
    )
  }
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={`Atención ${encounterStatusLabel(detail.encounter.status).toLowerCase()}`}
        subtitle={
          <>
            <EncounterBreadcrumb patientId={patientId} patientName={patient.patient.displayName} />
            <p className="min-w-0">{`${patient.patient.displayName} · ${hcLabel(patient.patient.patientNumber)}`}</p>
            <Badge variant="outline">Solo lectura</Badge>
          </>
        }
      />
      {detail.encounter.status === "finalizada" ? (
        <EncounterHandoff patientId={patientId} detail={detail} />
      ) : null}
      <EncounterDetailView patientId={patientId} detail={detail} />
      {/* Los documentos de la atención en un solo lugar: ya no se crean aquí, pero se envían e imprimen. */}
      <section aria-label="Documentos" className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Documentos</h2>
        <SignedOdontogramFact patientId={patientId} encounterId={detail.encounter.id} />
        <EncounterDocumentsBlock
          patientId={patientId}
          encounterId={detail.encounter.id}
          patient={patient}
          detail={detail}
          encounters={[]}
          attentionItems={detail.plannedItems}
          disabled
          beforeWrite={async () => {}}
          onChanged={changed}
          onPendingChange={() => {}}
        />
      </section>
      <ControlesPanel
        patientId={patientId}
        encounterId={detail.encounter.id}
        encounterOnly
        allowCreate={false}
        items={detail.plannedItems}
      />
    </PageShell>
  )
}
