import type { RegistrationConfig } from "@odentia/clinical"
import { formatMoney } from "@odentia/clinical"
import { Button, buttonVariants } from "@odentia/ui"
import { AgentMark, EmptyState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleCheck } from "lucide-react"
import type { ReactNode } from "react"
import { ACTION_LABEL, type AgentProposal } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"
import { type TaskItem, useCan, usePermission } from "../../lib/crm"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { useOrgProfile } from "../../lib/org"
import type { PatientSectionId } from "../../lib/patient-areas"
import type { PatientFull, PatientHealth, PatientSummary } from "../../lib/patients"
import { filiationGapsText, isHealthReviewPending, missingFiliation } from "../../lib/patients"
import { usePlanNextStep } from "./plan/plan-next"
import { NewPatientTaskButton } from "./new-patient-task-button"

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
 * Pendientes del paciente para el Resumen: lo que el agente dejó esperando el
 * sí del paciente, «Qué sigue» del plan (para quien no lee la clínica: quien
 * la lee lo tiene en su propia tarjeta), saldo, datos que faltan y sus tareas.
 * Para quien atiende suma lo clínico que le toca (antecedentes declarados por
 * revisar y consentimientos sin firmar). Cada bloque pide solo lo que su
 * permiso autoriza; el representante va en la cabecera.
 */
export function PatientPendingCard({
  patientId,
  detail,
  clinical,
  onTabChange,
}: {
  patientId: string
  detail: PatientFull
  /** Lo clínico ya leído por el Resumen de quien atiende (no se pide aquí). */
  clinical?: { summary?: PatientSummary; health?: PatientHealth | null }
  onTabChange: (section: PatientSectionId) => void
}) {
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const canAppointments = usePermission("appointments.read")
  const canBudgets = usePermission("budgets.read")
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
  // «Qué sigue» del plan, la misma regla del servidor que la pestaña Plan. Quien
  // lee la clínica lo tiene en su pestaña con el detalle clínico.
  const nextStepQuery = usePlanNextStep(patientId, (canAppointments || canBudgets) && !canClinical)

  const go = (section: PatientSectionId, label: string) => (
    <Button size="sm" variant="outline" onClick={() => onTabChange(section)}>
      {label}
    </Button>
  )

  const pending: Pending[] = []
  if (canClinical && clinical) {
    if (clinical.health && isHealthReviewPending(clinical.health))
      pending.push({
        id: "health-review",
        title: "Antecedentes declarados por revisar",
        detail: "El paciente o su responsable los declaró; falta la validación clínica.",
        action: go("antecedentes", "Revisar"),
      })
    for (const consent of clinical.summary?.pendingConsents ?? [])
      pending.push({
        id: `consent-${consent.id}`,
        title: `Consentimiento sin firmar: ${consent.title}`,
        detail: "Emitido y pendiente de la firma de la persona o su representante.",
        action: go("documentos", "Firmar"),
      })
  }
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
  const nextStep = nextStepQuery.data?.data
  if (nextStep && nextStep.kind !== "ninguno")
    pending.push({
      id: "plan-next",
      title: nextStep.text,
      detail: nextStep.detail ?? "Lo que sigue en su plan de tratamiento.",
      action: go("plan", "Ir al plan"),
    })
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
    const gaps = config ? missingFiliation(config, detail.patient, detail.contacts) : []
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

