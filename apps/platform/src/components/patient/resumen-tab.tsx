import type { RegistrationConfig } from "@odentia/clinical"
import { formatMoney } from "@odentia/clinical"
import { Button, buttonVariants } from "@odentia/ui"
import { AgentMark, EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleCheck } from "lucide-react"
import type { ReactNode } from "react"
import { ACTION_LABEL, type AgentProposal } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { planDecisionLabel } from "../../lib/budgets"
import { fetchFollowUps, formatDate, NEXT_ACTION_LABELS } from "../../lib/clinical-journey"
import { type TaskItem, timeAgo, useCan, usePermission } from "../../lib/crm"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { useOrgProfile } from "../../lib/org"
import type { PatientSectionId } from "../../lib/patient-areas"
import type { PatientFull, PatientSummary } from "../../lib/patients"
import {
  fetchPatientHealth,
  filiationGapsText,
  hasHealthInfo,
  isHealthReviewPending,
  missingFiliation,
  planStatusLabel,
} from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { useTreatmentCoordination } from "./coordinacion-panel"
import { NewPatientTaskButton } from "./new-patient-task-button"
import { ClinicalAlertsCard, OpenEncounterCard, RecentImagesCard } from "./resumen-clinico"

interface Pending {
  id: string
  title: string
  detail: string
  action: ReactNode
  /** Lo propone el agente: se distingue con su identidad visual. */
  agent?: boolean
}

export function SummaryCard({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function PendingList({ pending }: { pending: Pending[] }) {
  if (pending.length === 0)
    return (
      <EmptyState
        icon={CircleCheck}
        title="Sin pendientes"
        description="No hay nada que requiera tu acción sobre esta persona ahora."
      />
    )
  return (
    <ul className="flex flex-col divide-y">
      {pending.map((item) => (
        <li
          key={item.id}
          className={`flex flex-wrap items-center justify-between gap-3 py-3 ${
            item.agent
              ? "my-2 rounded-lg border border-agent-border bg-agent-soft px-3"
              : "first:pt-0 last:pb-0"
          }`}
        >
          {item.agent ? <AgentMark size="sm" /> : null}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{item.title}</p>
            <p className="text-sm text-muted-foreground">{item.detail}</p>
          </div>
          {item.action}
        </li>
      ))}
    </ul>
  )
}

/**
 * Pendientes del paciente que no son clínicos, para el Resumen: lo que el
 * agente dejó esperando el sí del paciente, controles por reservar, saldo,
 * datos que faltan y sus tareas. Cada bloque pide solo lo que su permiso
 * autoriza; lo clínico vive en la pestaña Clínica y el representante, en la
 * cabecera.
 */
export function PatientPendingCard({
  patientId,
  detail,
  onTabChange,
}: {
  patientId: string
  detail: PatientFull
  onTabChange: (section: PatientSectionId) => void
}) {
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const canAppointments = usePermission("appointments.read")
  const canPatients = usePermission("patients.read")
  const canEditPatient = usePermission("patients.write")
  const canDecide = usePermission("agent.decide")
  const canReadAgent = usePermission("agent.read")
  const canTasks = usePermission("tasks.read")
  const can = useCan()
  const canConfig = can("crm.read") || can("settings.read")

  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const money = (cents: number, currency: string): string =>
    orgLocale ? formatMoney(cents, currency, orgLocale) : "…"
  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canFinance,
  })
  const proposalsQuery = useQuery({
    queryKey: ["agent-proposals", "propuesta", "patient", patientId],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>(
        `/api/agent/proposals?status=propuesta&patientId=${patientId}`,
      ),
    enabled: canDecide || canReadAgent,
    retry: false,
  })
  const tasksQuery = useQuery({
    queryKey: ["patient-tasks", patientId],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=open&patientId=${patientId}`),
    enabled: canTasks && canPatients,
    retry: false,
  })
  const configQuery = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: () =>
      apiFetch<{ data: RegistrationConfig; meta: { today: string } }>(
        "/api/patient-registration/config",
      ),
    enabled: canEditPatient && canConfig,
    retry: false,
  })
  // Quien lee la clínica tiene estos pendientes con su detalle en su pestaña.
  const coordinationQuery = useTreatmentCoordination(patientId, canAppointments && !canClinical)

  const go = (section: PatientSectionId, label: string) => (
    <Button size="sm" variant="outline" onClick={() => onTabChange(section)}>
      {label}
    </Button>
  )

  const pending: Pending[] = []
  for (const proposal of proposalsQuery.data?.data ?? [])
    pending.push({
      id: `proposal-${proposal.id}`,
      agent: true,
      title: `El agente propone: ${ACTION_LABEL[proposal.action] ?? proposal.action}`,
      detail:
        proposal.context.afterSummary || proposal.reason || "Espera la confirmación del paciente.",
      action: (
        <Link
          to="/agent/pendientes"
          search={{ status: undefined, conversationId: proposal.conversationId }}
          className={buttonVariants({ size: "sm" })}
        >
          Revisar
        </Link>
      ),
    })
  const coordination = coordinationQuery.data?.data
  if (coordination) {
    const toBook = coordination.followUps.filter(
      (control) =>
        control.status === "pendiente" &&
        control.appointment?.status !== "programada" &&
        control.appointment?.status !== "confirmada",
    )
    if (toBook.length > 0)
      pending.push({
        id: "coordination-follow-ups",
        title:
          toBook.length === 1
            ? `Control por reservar: ${toBook[0].title}`
            : `${toBook.length} controles por reservar`,
        detail: `Corresponde el ${formatDate(toBook[0].dueAt)}.`,
        action: go("coordinacion", "Reservar"),
      })
    if (coordination.budgetsAwaitingDecision.length > 0)
      pending.push({
        id: "coordination-budgets",
        title:
          coordination.budgetsAwaitingDecision.length === 1
            ? `Presupuesto «${coordination.budgetsAwaitingDecision[0].title}» sin decisión`
            : `${coordination.budgetsAwaitingDecision.length} presupuestos sin decisión`,
        detail: "Presentado y pendiente de respuesta de quien decide.",
        action: go("coordinacion", "Hacer seguimiento"),
      })
  }
  for (const balance of accountQuery.data?.data.byCurrency ?? []) {
    if (balance.porCobrar > 0)
      pending.push({
        id: `balance-${balance.currency}`,
        title: `Saldo por cobrar de ${money(balance.porCobrar, balance.currency)}`,
        detail:
          balance.aFavor > 0
            ? `Hay un anticipo disponible de ${money(balance.aFavor, balance.currency)}.`
            : "Cargos emitidos sin pago aplicado.",
        action: go("cuenta", "Ir a cobros"),
      })
  }
  if (canEditPatient) {
    const config = configQuery.data?.data
    const gaps = config ? missingFiliation(config, detail.patient) : []
    // Una ficha creada con lo mínimo (al reservar o desde el enlace) queda además
    // con la identidad por revisar: se dice en el mismo pendiente.
    const review = detail.patient.identityNeedsReview ? "Confirma apellidos y nombres." : ""
    if (gaps.length > 0 || review)
      pending.push({
        id: "filiacion",
        title: gaps.length > 0 ? "Faltan datos que la clínica pide" : "Identidad por revisar",
        detail: [
          gaps.length > 0
            ? `${filiationGapsText(gaps).charAt(0).toUpperCase()}${filiationGapsText(gaps).slice(1)}.`
            : "",
          review,
        ]
          .filter(Boolean)
          .join(" "),
        action: go("filiacion", "Completar"),
      })
    if (!detail.contacts.some((link) => link.phone || link.email))
      pending.push({
        id: "contacts",
        title: "Sin datos de contacto",
        detail: "Ni la persona ni quienes hablan por ella tienen teléfono o correo registrados.",
        action: go("filiacion", "Completar"),
      })
  }
  for (const task of tasksQuery.data?.data ?? [])
    pending.push({
      id: `task-${task.id}`,
      title: `Tarea: ${task.title}`,
      detail: task.dueAt ? `Vence el ${formatDate(task.dueAt)}.` : "Sin fecha límite.",
      action: (
        <Link
          to="/tasks"
          search={{ task: task.id }}
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          Ver tarea
        </Link>
      ),
    })

  return (
    <SummaryCard title="Pendientes" action={<NewPatientTaskButton patientId={patientId} />}>
      <PendingList pending={pending} />
    </SummaryCard>
  )
}

/**
 * Resumen clínico, la primera sección de la pestaña Clínica: la atención en
 * curso, las alertas, lo clínico pendiente, los tratamientos, las imágenes
 * recientes y la última atención. Abrir esta pestaña es una lectura clínica
 * (el resumen deja su traza en la bitácora); abrir la página no lo es.
 */
export function ClinicalSummaryTab({
  patientId,
  onTabChange,
}: {
  patientId: string
  onTabChange: (section: PatientSectionId, tooth?: number, itemId?: string) => void
}) {
  const canClinical = usePermission("clinical.read")
  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled: canClinical,
  })
  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canClinical,
  })
  const followUpsQuery = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: canClinical,
  })

  const resolved = summaryQuery.data?.data ?? null
  if (resolved == null) {
    if (summaryQuery.isError)
      return (
        <QueryErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
      )
    return <LoadingState message="Cargando resumen clínico…" />
  }

  const go = (section: PatientSectionId, label: string) => (
    <Button size="sm" variant="outline" onClick={() => onTabChange(section)}>
      {label}
    </Button>
  )
  const pending: Pending[] = []
  const health = healthQuery.data?.data ?? null
  if (healthQuery.isSuccess) {
    if (isHealthReviewPending(health))
      pending.push({
        id: "health-review",
        title: "Antecedentes declarados por revisar",
        detail: "El paciente o su responsable los declaró; falta la validación clínica.",
        action: go("antecedentes", "Revisar"),
      })
    else if (!hasHealthInfo(health))
      pending.push({
        id: "health-empty",
        title: "Sin antecedentes registrados",
        detail: "Alergias, condiciones, medicación y entrevista se registran en un solo guardado.",
        action: go("antecedentes", "Registrar"),
      })
  }
  if (resolved.openEncounterId && !resolved.openEncounter)
    pending.push({
      id: "open-encounter",
      title: "Atención en borrador",
      detail: "Hay una atención iniciada sin finalizar.",
      action: (
        <Link
          to="/patients/$patientId/encounters/$encounterId"
          params={{ patientId, encounterId: resolved.openEncounterId }}
          className={buttonVariants({ size: "sm" })}
        >
          Continuar
        </Link>
      ),
    })
  for (const consent of resolved.pendingConsents ?? [])
    pending.push({
      id: `consent-${consent.id}`,
      title: `Consentimiento sin firmar: ${consent.title}`,
      detail: "Emitido y pendiente de la firma del paciente o su representante.",
      action: go("consentimientos", "Firmar"),
    })
  if (resolved.proposedBudgets.length > 0)
    pending.push({
      id: "budgets",
      title:
        resolved.proposedBudgets.length === 1
          ? `Presupuesto «${resolved.proposedBudgets[0].title}» sin decisión`
          : `${resolved.proposedBudgets.length} presupuestos sin decisión`,
      detail: "Presentado y pendiente de respuesta de quien decide.",
      action: go("plan", "Ver presupuestos"),
    })
  const unscheduled = (followUpsQuery.data?.data ?? []).filter((row) => row.status === "pendiente")
  if (unscheduled.length > 0)
    pending.push({
      id: "follow-ups",
      title:
        unscheduled.length === 1
          ? `Control por programar: ${unscheduled[0].title}`
          : `${unscheduled.length} controles por programar`,
      detail: `Vence el ${formatDate(unscheduled[0].dueAt)}.`,
      action: go("controles", "Programar"),
    })
  if (resolved.planPending.count > 0)
    pending.push({
      id: "plan-pending",
      title: `${resolved.planPending.count} tratamiento(s) aceptado(s) por ejecutar`,
      detail: "Aceptados por el paciente y aún sin realizar.",
      action: go("recorrido", "Ver tratamientos"),
    })

  const lastVisit = resolved.lastVisit ?? null
  const journeys = resolved.treatmentJourneys ?? []

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {resolved.openEncounter ? (
        <OpenEncounterCard patientId={patientId} encounter={resolved.openEncounter} />
      ) : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {healthQuery.isSuccess ? (
            <ClinicalAlertsCard health={health} action={go("antecedentes", "Antecedentes")} />
          ) : null}
          <SummaryCard title="Pendiente en la clínica">
            <PendingList pending={pending} />
          </SummaryCard>
          <SummaryCard
            title="Tratamientos y seguimiento"
            action={journeys.length > 0 ? go("odontograma", "Ver odontograma") : undefined}
          >
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
                        {row.nextAction
                          ? NEXT_ACTION_LABELS[row.nextAction]
                          : "Sin acción pendiente"}{" "}
                        · decisión {planDecisionLabel(row.decision)} · ejecución{" "}
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
          </SummaryCard>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <RecentImagesCard
            patientId={patientId}
            documents={resolved.recentDocuments ?? []}
            onOpen={(section) => onTabChange(section)}
          />
          <SummaryCard title="Última atención">
            {lastVisit ? (
              <div className="flex flex-col gap-2 text-sm">
                <p className="font-medium">
                  {lastVisit.reason || "Atención finalizada"}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {timeAgo(lastVisit.finalizedAt ?? "")}
                  </span>
                </p>
                {lastVisit.evolution ? (
                  <p className="whitespace-pre-wrap">
                    {lastVisit.evolution.length > 280
                      ? `${lastVisit.evolution.slice(0, 280)}…`
                      : lastVisit.evolution}
                  </p>
                ) : null}
                <div>
                  <Link
                    to="/patients/$patientId/encounters/$encounterId"
                    params={{ patientId, encounterId: lastVisit.encounterId }}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Abrir esta atención
                  </Link>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sin atenciones registradas. La atención se inicia desde la cabecera de la página.
              </p>
            )}
          </SummaryCard>
        </div>
      </div>
    </div>
  )
}
