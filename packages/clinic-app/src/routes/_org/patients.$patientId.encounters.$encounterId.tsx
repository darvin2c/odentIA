import { EmptyState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ClipboardList } from "lucide-react"
import { productUi } from "../../product/product-ui"
import { ControlesPanel } from "../../components/patient/clinical-panels"
import { EncounterBreadcrumb } from "../../components/patient/encounter-breadcrumb"
import { EncounterDocumentsBlock } from "../../components/patient/encounter-documents"
import { EncounterDetailView } from "../../components/patient/encounter-detail-view"
import { EncounterEditor } from "../../components/patient/encounter-editor"
import { EncounterHandoff } from "../../components/patient/encounter-handoff"
import { EncounterLoading } from "../../components/person/person-loading"
import { apiFetch } from "../../lib/api"
import { useMemberName, usePermission } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import {
  type EncounterDetail,
  encounterStatusLabel,
  hcLabel,
  type PatientFull,
} from "../../lib/patients"

/** «lun 12 oct 2026, 3:07 a 4:07 p. m.»: el día una vez, sin repetirlo en el fin. */
function encounterWhen(start: string, end: string | null): string {
  const locale = activeOrgLocale()
  const timeZone = activeOrgTimeZone()
  const day = new Date(start).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone })
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone })
  const sameDay = end && new Date(end).toLocaleDateString(locale, { timeZone }) === new Date(start).toLocaleDateString(locale, { timeZone })
  return end && sameDay ? `${day}, ${clock(start)} a ${clock(end)}` : `${day}, ${clock(start)}`
}

export const Route = createFileRoute("/_org/patients/$patientId/encounters/$encounterId")({
  pendingComponent: EncounterLoading,
  component: EncounterPage,
})

function EncounterPage() {
  const { patientId, encounterId } = Route.useParams()
  const queryClient = useQueryClient()
  // Lo que el producto firmó con la atención (odentIA: el odontograma firmado).
  const EncounterSigned = productUi().history.EncounterSigned
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
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

  if (patientQuery.isLoading || encounterQuery.isLoading) return <EncounterLoading />
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
      {/* El título es lo que se hizo; el estado, cuándo y quién van debajo. */}
      <PageHeader
        title={detail.encounter.reason?.trim() || `Atención ${encounterStatusLabel(detail.encounter.status).toLowerCase()}`}
        subtitle={
          <>
            <EncounterBreadcrumb patientId={patientId} patientName={patient.patient.displayName} />
            <p className="min-w-0">
              {[
                `Atención ${encounterStatusLabel(detail.encounter.status).toLowerCase()}`,
                encounterWhen(detail.encounter.startedAt ?? detail.encounter.createdAt, detail.encounter.endedAt ?? null),
                memberName(detail.encounter.professionalUserId),
                `${patient.patient.displayName} · ${hcLabel(patient.patient.patientNumber)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        }
      />
      {detail.encounter.status === "finalizada" ? (
        <EncounterHandoff patientId={patientId} detail={detail} />
      ) : null}
      <EncounterDetailView patientId={patientId} detail={detail} showDocuments={false} />
      {/* Los documentos de la atención en un solo lugar: ya no se crean aquí, pero se envían e imprimen. */}
      <section aria-label="Documentos" className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Documentos</h2>
        <EncounterSigned patientId={patientId} encounterId={detail.encounter.id} />
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
