/**
 * El botón de «Qué sigue» hace lo que dice donde se pulsa (lienzo «Paciente:
 * cada acción en su sitio»): «Reservar cita» abre «Nueva cita» con lo
 * aceptado ya puesto, «¿Qué respondió?» abre la respuesta del presupuesto y el
 * control abre su reserva. Es el mismo botón en la lista de Pacientes, el
 * Resumen y el Plan; nadie sale de donde estaba.
 */
import { Button, buttonVariants } from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ComponentProps, useState } from "react"
import { budgetNumberLabel, fetchBudgetDetail, PLAN_QUERY_KEYS, type PlanNextStep } from "../../../lib/budgets"
import { fetchFollowUps, fetchTreatmentCoordination, type SchedulableControl } from "../../../lib/clinical-journey"
import { usePermission } from "../../../lib/crm"
import { openBookingAnywhere } from "../../agenda/schedule-host"
import { FollowUpScheduler } from "../follow-up-scheduler"
import { useBudgetFormat } from "./budget-parts"
import { BudgetResponse } from "./budget-response"
import { BudgetSendButton } from "./budget-send"

type Step = Pick<PlanNextStep, "kind" | "action">

export function NextStepButton({
  patient,
  step,
  size = "default",
  variant = "default",
}: {
  patient: { id: string; name: string }
  step: Step
  size?: ComponentProps<typeof Button>["size"]
  variant?: ComponentProps<typeof Button>["variant"]
}): React.JSX.Element | null {
  const [open, setOpen] = useState<"respuesta" | "control" | null>(null)
  const action = step.action
  if (!action) return null
  if (step.kind === "enviar" && action.budgetId)
    return <BudgetSendButton patientId={patient.id} budgetId={action.budgetId} showRecipient={false} size={size} variant={variant} />
  const onClick = () => {
    if ((step.kind === "agendar" || step.kind === "continuar") && action.planItemIds?.length) {
      openBookingAnywhere({
        patient,
        lockedPatient: true,
        planItemIds: action.planItemIds,
        ...(action.serviceId ? { serviceId: action.serviceId } : {}),
      })
    } else if (step.kind === "respuesta" && action.budgetId) {
      setOpen("respuesta")
    } else if (step.kind === "control" && action.followUpId) {
      setOpen("control")
    }
  }
  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={onClick}>
        {action.label}
      </Button>
      {open === "respuesta" && action.budgetId ? (
        <BudgetAnswerDrawer patientId={patient.id} budgetId={action.budgetId} onClose={() => setOpen(null)} />
      ) : null}
      {open === "control" && action.followUpId ? (
        <ScheduleControl patientId={patient.id} followUpId={action.followUpId} onClose={() => setOpen(null)} />
      ) : null}
    </>
  )
}

/**
 * «¿Qué respondió?» al lado: el mismo bloque de la tarjeta del presupuesto, sin
 * cambios. Al anotar la respuesta se cierra y «Qué sigue» se pone al día.
 */
export function BudgetAnswerDrawer({
  patientId,
  budgetId,
  onClose,
}: {
  patientId: string
  budgetId: string
  onClose: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const format = useBudgetFormat()
  const query = useQuery({
    queryKey: ["budget", patientId, budgetId],
    queryFn: () => fetchBudgetDetail(patientId, budgetId),
  })
  const budget = query.data?.data ?? null
  const runWrite = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation()
    await Promise.all([
      ...PLAN_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })),
      queryClient.invalidateQueries({ queryKey: ["people"] }),
    ])
    onClose()
    return result
  }
  // El bloque ya se titula «¿Qué respondió?»: el cajón dice de qué presupuesto se trata.
  const description = budget
    ? [budget.presentedAt ? format.day(budget.presentedAt) : null, format.money(budget.totalCents, budget.currency)]
        .filter(Boolean)
        .join(" · ")
    : undefined
  return (
    <DetailDrawer
      open
      title={budget ? budgetNumberLabel(budget.budgetNumber) : "Presupuesto"}
      description={description}
      isLoading={query.isPending}
      error={query.isError ? "No se pudo leer el presupuesto. Ciérralo y vuelve a intentarlo." : null}
      onClose={onClose}
      actions={
        <Link
          to="/patients/$patientId"
          params={{ patientId }}
          search={{ tab: "plan", budgetId }}
          className={buttonVariants({ variant: "ghost" })}
          onClick={onClose}
        >
          Ver el presupuesto en Plan
        </Link>
      }
    >
      {budget ? (
        <BudgetResponse
          patientId={patientId}
          budget={budget}
          money={format.money}
          formatDay={(iso) => format.day(iso)}
          runWrite={runWrite}
        />
      ) : null}
    </DetailDrawer>
  )
}

/**
 * Reservar un control desde «Qué sigue»: la vía clínica para quien escribe en la
 * historia y la de coordinación para recepción, la misma operación de siempre.
 */
export function ScheduleControl({
  patientId,
  followUpId,
  onClose,
}: {
  patientId: string
  followUpId: string
  onClose: () => void
}): React.JSX.Element | null {
  const clinical = usePermission("clinical.write")
  const clinicalList = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: clinical,
  })
  const coordination = useQuery({
    queryKey: ["treatment-coordination", patientId],
    queryFn: () => fetchTreatmentCoordination(patientId),
    enabled: !clinical,
  })
  const control: SchedulableControl | null = clinical
    ? (clinicalList.data?.data.find((row) => row.id === followUpId) ?? null)
    : (coordination.data?.data.followUps.find((row) => row.id === followUpId) ?? null)
  if (!control) return null
  return (
    <FollowUpScheduler
      patientId={patientId}
      control={control}
      scope={clinical ? "clinical" : "coordination"}
      onClose={onClose}
    />
  )
}
