import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, ClipboardList } from "lucide-react"
import type { ReactNode } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchTreatmentPlanDetail, fetchTreatmentPlans } from "../../lib/budgets"
import { timeAgo, useCanWrite } from "../../lib/crm"
import { sexLabel } from "../../lib/patient-overview"
import type { PatientFull, PatientSummary } from "../../lib/patients"
import { ageFrom, fetchPatientHealth, hasHealthInfo, isHealthReviewPending } from "../../lib/patients"
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

export type ResumenTabTarget = "plan" | "historia" | "odontograma" | "imagenes" | "antecedentes"

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
  onTabChange: (tab: ResumenTabTarget, tooth?: number) => void
}) {
  const canWrite = useCanWrite()

  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
  })

  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: summary === undefined,
  })

  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
  })

  const health = healthQuery.data?.data ?? null
  const hasInfo = hasHealthInfo(health)
  const pendingReview = isHealthReviewPending(health)

  const resolved = summary ?? summaryQuery.data?.data ?? null
  const patient = detail.patient
  const lastVisit = resolved?.lastVisit ?? null
  const plans = (plansQuery.data?.data ?? []).filter((p) => p.status === "En curso")

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
      {canWrite && healthQuery.isFetched && (pendingReview || !hasInfo) ? (
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
          <div className="font-heading text-base font-medium">Planes en curso</div>
        </div>
        <div className="flex flex-col gap-2">
          {plansQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Cargando planes…</p>
          ) : plansQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudieron cargar los planes.{" "}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void plansQuery.refetch()}
              >
                Reintentar
              </Button>
            </p>
          ) : plans.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                Sin planes en curso. Los planes se indican durante una atención.
              </p>
              <Button size="sm" variant="outline" onClick={() => onTabChange("plan")}>
                Ver planes de tratamiento
              </Button>
            </div>
          ) : (
            plans.map((entry) => (
              <PlanBrief
                key={entry.plan.id}
                patientId={patientId}
                planId={entry.plan.id}
                title={entry.plan.title}
                isLegacy={entry.plan.isLegacy}
                totalItems={entry.totalItems}
                pendingItems={entry.pendingItems}
              />
            ))
          )}
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

      <div className="flex flex-col gap-6 rounded-md bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Alergias, condiciones, medicación y entrevista se revisan en Antecedentes.
          </p>
          <Button size="sm" variant="outline" onClick={() => onTabChange("antecedentes")}>
            Ir a antecedentes
          </Button>
        </div>
      </div>
    </div>
  )
}

function PlanBrief({
  patientId,
  planId,
  title,
  isLegacy,
  totalItems,
  pendingItems,
}: {
  patientId: string
  planId: string
  title: string
  isLegacy: boolean
  totalItems: number
  pendingItems: number
}): React.JSX.Element {
  const detailQuery = useQuery({
    queryKey: ["treatment-plan", patientId, planId],
    queryFn: () => fetchTreatmentPlanDetail(patientId, planId),
  })
  const items = detailQuery.data?.data.items ?? []
  const pending = items.filter((i) => i.status === "pendiente" || i.status === "programado")
  const next = pending[0] ?? null
  const accepted = items.filter((i) => i.decision === "aceptado").length
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">
          {title}{" "}
          {isLegacy ? <span className="font-normal text-muted-foreground">(heredado)</span> : null}
        </span>
        <span className="text-muted-foreground">
          {pendingItems} de {totalItems} pendientes · {accepted} aceptados
          {next ? ` · próximo: ${next.title}` : " · sin pendientes"}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        nativeButton={false}
        render={
          <Link
            to="/patients/$patientId"
            params={{ patientId }}
            search={{ tab: "plan", planId }}
          />
        }
      >
        Abrir plan
      </Button>
    </div>
  )
}
