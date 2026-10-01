import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, ClipboardList } from "lucide-react"
import type { ReactNode } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { planDecisionLabel } from "../../lib/budgets"
import {
  fetchFollowUps,
  fetchPatientAccount,
  followUpAppointmentLabel,
  formatDate,
  NEXT_ACTION_LABELS,
} from "../../lib/clinical-journey"
import { timeAgo, usePermission } from "../../lib/crm"
import { sexLabel } from "../../lib/patient-overview"
import type { OdontogramState, PatientFull, PatientSummary } from "../../lib/patients"
import {
  ageFrom,
  fetchPatientHealth,
  hasHealthInfo,
  isHealthReviewPending,
  planStatusLabel,
} from "../../lib/patients"
import { formatMoney } from "../../lib/services"
import { OdontogramStudio } from "../odontogram-studio"
import { PatientContactSection } from "./patient-contact-section"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  )
}

const missing = <span className="text-muted-foreground">No registrado</span>

export type ResumenTabTarget =
  | "plan"
  | "historia"
  | "odontograma"
  | "imagenes"
  | "antecedentes"
  | "recorrido"
  | "controles"
  | "recetas"
  | "cuenta"
  | "responsables"

/** Resumen breve de lectura: última atención, planes activos y filiación extendida. Sin formularios. */
export function ResumenTab({
  patientId,
  detail,
  summary,
  onTabChange,
}: {
  patientId: string
  detail: PatientFull
  summary?: PatientSummary
  onTabChange: (tab: ResumenTabTarget, tooth?: number, itemId?: string) => void
}) {
  const canRead = usePermission("clinical.read")

  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled: canRead,
  })

  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canRead && summary === undefined,
  })

  const dentalQuery = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
    enabled: canRead,
  })

  const followUpsQuery = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: canRead,
  })

  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount(patientId),
    enabled: canRead,
  })

  const health = healthQuery.data?.data ?? null
  const hasInfo = hasHealthInfo(health)
  const pendingReview = isHealthReviewPending(health)

  const resolved = summary ?? summaryQuery.data?.data ?? null
  const patient = detail.patient
  const lastVisit = resolved?.lastVisit ?? null
  const journeys = resolved?.treatmentJourneys ?? []
  const pendingFollowUps = (followUpsQuery.data?.data ?? []).filter(
    (row) => row.status === "pendiente" || row.status === "programado",
  )
  const balances = accountQuery.data?.data.byCurrency ?? []

  if (summaryQuery.isPending && resolved == null) return <LoadingState />
  if (summaryQuery.isError && resolved == null) {
    return (
      <ErrorState
        error={summaryQuery.error instanceof ApiError ? summaryQuery.error.shape : null}
        onRetry={() => void summaryQuery.refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {canRead && healthQuery.isFetched && (pendingReview || !hasInfo) ? (
        <div className="flex flex-col gap-6 rounded-md border border-primary/40 bg-primary/5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <ClipboardList className="mt-0.5 size-4 text-primary" aria-hidden="true" />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">
                  {pendingReview
                    ? "Información declarada pendiente de revisión."
                    : "Este paciente aún no tiene antecedentes registrados."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {pendingReview
                    ? "Lo declarado por el paciente/responsable está visible en alertas. Revísalo antes de confirmar."
                    : "Registra alergias, condiciones, medicación y entrevista en un solo guardado."}
                </p>
              </div>
            </div>
            <Button type="button" onClick={() => onTabChange("antecedentes")}>
              {pendingReview ? "Revisar información declarada" : "Registrar antecedentes"}
            </Button>
          </div>
        </div>
      ) : null}
      <section className="rounded-md bg-card p-4">
        <h2 className="font-heading text-lg font-medium">Situación clínica</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Selecciona una pieza para consultar sus hallazgos, notas, tratamientos e imágenes.
        </p>
        {dentalQuery.isPending ? (
          <LoadingState />
        ) : dentalQuery.isError ? (
          <ErrorState onRetry={() => void dentalQuery.refetch()} />
        ) : (
          dentalQuery.data && (
            <OdontogramStudio
              patientId={patientId}
              state={dentalQuery.data.data}
              compact
              readOnly
              onChanged={() => dentalQuery.refetch().then(() => {})}
            />
          )
        )}
      </section>

      <div className="flex flex-col gap-6 rounded-md bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Última atención</div>
        </div>
        <div className="flex flex-col gap-2">
          {lastVisit ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                {lastVisit.reason || "Atención finalizada"}{" "}
                <span className="font-normal text-muted-foreground">
                  · {timeAgo(lastVisit.finalizedAt ?? "")}
                </span>
              </p>
              {lastVisit.evolution ? (
                <p className="whitespace-pre-wrap text-sm">
                  {lastVisit.evolution.length > 280
                    ? `${lastVisit.evolution.slice(0, 280)}…`
                    : lastVisit.evolution}
                </p>
              ) : null}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to="/patients/$patientId/encounters/$encounterId"
                      params={{ patientId, encounterId: lastVisit.encounterId }}
                    />
                  }
                >
                  Abrir esta atención
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                Sin atenciones registradas para este paciente.
              </p>
              <p className="text-xs text-muted-foreground">
                La atención se inicia desde la cabecera de la ficha.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-6 rounded-md bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Tratamientos y seguimiento</div>
          <p className="text-sm text-muted-foreground">
            Decisiones pendientes, trabajo en curso y próximos controles.
          </p>
        </div>
        {journeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin tratamientos indicados. Se indican durante una atención abierta.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {journeys.slice(0, 6).map((row) => (
              <li
                key={row.item.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {row.item.toothNumber ? `Pieza ${row.item.toothNumber} · ` : "General · "}
                    {row.item.title}
                  </span>
                  <span className="text-muted-foreground">
                    {row.nextAction ? NEXT_ACTION_LABELS[row.nextAction] : "Sin acción pendiente"} ·
                    decisión {planDecisionLabel(row.decision)} · ejecución{" "}
                    {planStatusLabel(row.clinicalStatus)}
                    {row.nextFollowUp ? ` · control ${formatDate(row.nextFollowUp.dueAt)}` : ""}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onTabChange("recorrido", undefined, row.item.id)}
                >
                  Ver detalle
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-6 rounded-md bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="font-heading text-base font-medium">Controles pendientes</div>
            {followUpsQuery.isPending ? (
              <p>Cargando controles…</p>
            ) : followUpsQuery.isError ? (
              <p role="alert">No se pudieron cargar los controles.</p>
            ) : pendingFollowUps.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin controles pendientes.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {pendingFollowUps.map((control) => (
                  <li key={control.id} className="text-sm">
                    <p className="font-medium">
                      {control.title} · {formatDate(control.dueAt)}
                    </p>
                    <p>{control.instructions || "Sin instrucciones adicionales."}</p>
                    <p className="text-muted-foreground">
                      {control.kind === "mantenimiento"
                        ? "Mantenimiento preventivo"
                        : (journeys.find((row) => row.item.id === control.planItemId)?.item.title ??
                          "Control de tratamiento")}{" "}
                      · {planStatusLabel(control.status)}
                    </p>
                    <p className="text-muted-foreground">{followUpAppointmentLabel(control)}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onTabChange("controles")}
          >
            Ver controles
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-6 rounded-md bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="font-heading text-base font-medium">Cuenta</div>
            {balances.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin movimientos económicos: aceptar una propuesta no genera cargos.
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {balances.map((balance) => (
                  <div key={balance.currency}>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Por cobrar ({balance.currency})
                    </dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatMoney(balance.outstandingCents, balance.currency)}
                    </dd>
                    <dd className="text-xs text-muted-foreground">
                      anticipo disponible{" "}
                      {formatMoney(balance.availableCreditCents, balance.currency)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => onTabChange("cuenta")}>
            Gestionar cuenta
          </Button>
        </div>
      </div>

      <PatientContactSection detail={detail} />
      <Collapsible>
        <div className="flex flex-col gap-6 rounded-md bg-card p-6">
          <div className="flex flex-col gap-1.5 pb-3">
            <CollapsibleTrigger className="text-base font-semibold">
              <span className="flex items-center gap-1">
                Filiación extendida <ChevronDown aria-hidden className="size-4" />
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div>
              <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Nombre completo">{detail.patient.displayName}</Field>
                <Field label="Documento">
                  {patient.docType && patient.docNumber
                    ? `${patient.docType} ${patient.docNumber}`
                    : (patient.docNumber ?? missing)}
                </Field>
                <Field label="Nacimiento / edad">
                  {patient.birthDate
                    ? `${patient.birthDate}${ageFrom(patient.birthDate) ? ` · ${ageFrom(patient.birthDate)} años` : ""}`
                    : missing}
                </Field>
                <Field label="Sexo">{patient.sex ? sexLabel(patient.sex) : missing}</Field>
                <Field label="Teléfono">{patient.phone ?? missing}</Field>
                <Field label="Correo">{patient.email ?? missing}</Field>
                <Field label="Dirección">{patient.address ?? missing}</Field>
                <Field label="Seguro">
                  {patient.insuranceType
                    ? `${patient.insuranceType}${patient.insuranceDetail ? ` · ${patient.insuranceDetail}` : ""}`
                    : missing}
                </Field>
                <Field label="Contacto de emergencia">
                  {patient.emergencyContactName
                    ? `${patient.emergencyContactName}${patient.emergencyContactPhone ? ` · ${patient.emergencyContactPhone}` : ""}`
                    : missing}
                </Field>
                <Field label="Consentimiento de datos">
                  {typeof patient.dataConsentAt === "string"
                    ? `Registrado el ${new Date(patient.dataConsentAt).toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric" })}`
                    : "No registrado"}
                </Field>
                <Field label="Origen / referencia">{patient.referralSource ?? missing}</Field>
              </dl>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}
