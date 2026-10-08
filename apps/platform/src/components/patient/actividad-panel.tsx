import { CONTACT_RELATIONSHIP_LABELS } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQueries, useQuery } from "@tanstack/react-query"
import { History } from "lucide-react"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { formatDateTime } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { activityKindLabel, fetchCrmActivityPage } from "../../lib/crm-workspace"
import {
  APPOINTMENT_STATUS_LABELS,
  usePatientAppointments,
} from "../../lib/patient-appointments"
import type { PatientSectionId } from "../../lib/patient-areas"
import type { PatientFull, TimelineItem, TimelineType } from "../../lib/patients"
import { type ActivityEntry, type ActivitySource, mergeActivity } from "../../lib/person-activity"

const CLINICAL_LABELS: Record<TimelineType, string> = {
  encounter: "Atención",
  note: "Nota clínica",
  anamnesis: "Antecedentes",
  document: "Documento",
  odontogram: "Odontograma",
  plan: "Tratamiento",
  budget: "Presupuesto",
  follow_up: "Control",
  prescription: "Receta",
}

const SOURCE_FILTERS: Array<{ id: ActivityEntry["source"] | "todo"; label: string }> = [
  { id: "todo", label: "Todo" },
  { id: "comercial", label: "Conversaciones y seguimiento" },
  { id: "cita", label: "Citas" },
  { id: "clinica", label: "Clínica" },
]

/**
 * Una sola línea de tiempo de la persona: lo conversado con cada interlocutor,
 * sus citas y, para quien puede leerla, su historia clínica. Cada fuente se pide
 * solo con el permiso que la autoriza; el detalle completo sigue en su sección.
 */
export function ActividadPanel({
  patientId,
  detail,
  onSection,
}: {
  patientId: string
  detail: PatientFull
  onSection: (section: PatientSectionId) => void
}) {
  const canAppointments = usePermission("appointments.read")
  const canClinical = usePermission("clinical.read")
  const canCrm = usePermission("crm.read")
  const [filter, setFilter] = useState<ActivityEntry["source"] | "todo">("todo")

  const appointments = usePatientAppointments(patientId, canAppointments)
  const timeline = useQuery({
    queryKey: ["timeline", patientId, "actividad"],
    queryFn: () =>
      apiFetch<{ data: TimelineItem[]; nextCursor: string | null }>(
        `/api/patients/${patientId}/timeline`,
      ),
    enabled: canClinical,
    retry: false,
  })
  const commercial = useQueries({
    queries: detail.contacts.map((link) => ({
      queryKey: ["crm-activity", link.contactId, "persona"],
      queryFn: () => fetchCrmActivityPage(link.contactId, null, 30),
      enabled: canCrm,
      retry: false,
    })),
  })

  const pending =
    (canAppointments && appointments.isPending) ||
    (canClinical && timeline.isPending) ||
    (canCrm && commercial.some((query) => query.isPending))
  if (pending) return <LoadingState message="Cargando actividad…" />

  const sources: ActivitySource[] = []
  const failed: string[] = []
  if (canAppointments) {
    if (appointments.isError) failed.push("citas")
    else
      sources.push({
        hasMore: false,
        entries: (appointments.data?.data ?? []).map(
          (appointment): ActivityEntry => ({
            key: `cita-${appointment.id}`,
            at: appointment.startsAt,
            source: "cita",
            label: "Cita",
            title: appointment.serviceName ?? appointment.reason ?? "Cita",
            detail: appointment.dentistName,
            who: null,
            status: APPOINTMENT_STATUS_LABELS[appointment.status],
          }),
        ),
      })
  }
  if (canClinical) {
    if (timeline.isError) failed.push("historia clínica")
    else
      sources.push({
        hasMore: timeline.data?.nextCursor != null,
        entries: (timeline.data?.data ?? []).map(
          (item): ActivityEntry => ({
            key: `clinica-${item.type}-${item.id}`,
            at: item.createdAt,
            source: "clinica",
            label: CLINICAL_LABELS[item.type],
            title: item.title,
            detail: null,
            who: null,
            status: null,
          }),
        ),
      })
  }
  if (canCrm) {
    commercial.forEach((query, index) => {
      const link = detail.contacts[index]
      if (!link) return
      if (query.isError) {
        failed.push(`actividad de ${link.displayName}`)
        return
      }
      const relationship = CONTACT_RELATIONSHIP_LABELS[link.relationship] ?? link.relationship
      sources.push({
        hasMore: query.data?.nextCursor != null,
        entries: (query.data?.data ?? []).map(
          (item): ActivityEntry => ({
            key: `comercial-${link.contactId}-${item.id}`,
            at: item.at,
            source: "comercial",
            label: item.channel
              ? `${activityKindLabel(item.kind)} · ${channelLabel(item.channel)}`
              : activityKindLabel(item.kind),
            title: item.title,
            detail: item.body,
            who: `${item.actorName ?? link.displayName} · ${link.displayName} (${relationship})`,
            status: item.status,
          }),
        ),
      })
    })
  }

  const merged = mergeActivity(sources)
  const visible = merged.entries.filter((entry) => filter === "todo" || entry.source === filter)
  const available = SOURCE_FILTERS.filter(
    (item) =>
      item.id === "todo" ||
      (item.id === "cita" && canAppointments) ||
      (item.id === "clinica" && canClinical) ||
      (item.id === "comercial" && canCrm),
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {available.length > 2 ? (
        <fieldset className="flex min-w-0 flex-wrap gap-2">
          <legend className="sr-only">Filtrar actividad</legend>
          {available.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={filter === item.id ? "default" : "outline"}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </fieldset>
      ) : null}

      {failed.length > 0 ? (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm"
        >
          No se pudo cargar: {failed.join(", ")}. La actividad mostrada está incompleta.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          icon={History}
          title="Sin actividad"
          description="Aquí aparecerán las conversaciones, citas y atenciones de esta persona."
        />
      ) : (
        <ol className="flex flex-col divide-y elevated rounded-xl border bg-card px-6">
          {visible.map((entry) => (
            <li
              key={entry.key}
              className="flex flex-col gap-x-4 gap-y-1 py-3 text-sm sm:flex-row sm:items-start"
            >
              <time
                dateTime={entry.at}
                className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground sm:w-44"
              >
                {formatDateTime(entry.at)}
              </time>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.label}</span>
                  {entry.status ? <Badge variant="outline">{entry.status}</Badge> : null}
                </span>
                <span className="break-words">{entry.title}</span>
                {entry.detail ? (
                  <span className="line-clamp-3 break-words text-muted-foreground">
                    {entry.detail}
                  </span>
                ) : null}
                {entry.who ? (
                  <span className="text-xs text-muted-foreground">{entry.who}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          {merged.completeSince
            ? `Actividad completa desde el ${formatDateTime(merged.completeSince)}. Lo anterior está en cada sección:`
            : "Detalle completo en cada sección:"}
        </span>
        {canClinical ? (
          <Button size="sm" variant="outline" onClick={() => onSection("historia")}>
            Historia clínica
          </Button>
        ) : null}
        {canCrm ? (
          <Button size="sm" variant="outline" onClick={() => onSection("seguimiento")}>
            Seguimiento
          </Button>
        ) : null}
        {canAppointments ? (
          <Button size="sm" variant="outline" onClick={() => onSection("citas")}>
            Citas
          </Button>
        ) : null}
      </div>
    </div>
  )
}
