/**
 * El botón de «Qué sigue» hace lo que dice donde se pulsa (lienzo «Paciente:
 * cada acción en su sitio»): «Reservar cita» abre «Nueva cita» con lo
 * aceptado ya puesto, «¿Qué respondió?» abre la respuesta del presupuesto y el
 * control abre su reserva. Es el mismo botón en la lista de Pacientes, el
 * Resumen y el Plan; nadie sale de donde estaba.
 */
import { Button, toast } from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ComponentProps, useEffect, useState } from "react"
import {
  BUDGET_ANSWERABLE_STATUSES,
  budgetNumberLabel,
  fetchBudgetDetail,
  PLAN_QUERY_KEYS,
  type PlanNextStep,
} from "../../../lib/budgets"
import {
  fetchFollowUps,
  fetchTreatmentCoordination,
  type SchedulableControl,
} from "../../../lib/clinical-journey"
import { usePermission } from "../../../lib/crm"
import { usePersonArchived } from "../../../lib/person-archived"
import { openAppointmentAnywhere, openBookingAnywhere } from "../../agenda/schedule-host"
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
  const archived = usePersonArchived()
  const action = step.action
  if (!action || archived) return null
  if (step.kind === "enviar" && action.budgetId)
    return (
      <BudgetSendButton
        patientId={patient.id}
        budgetId={action.budgetId}
        showRecipient={false}
        size={size}
        variant={variant}
        reviewable
      />
    )
  const onClick = () => {
    if ((step.kind === "agendar" || step.kind === "continuar") && action.planItemIds?.length) {
      openBookingAnywhere({
        patient,
        lockedPatient: true,
        planItemIds: action.planItemIds,
        ...(action.serviceId ? { serviceId: action.serviceId } : {}),
        // «Reservar lo aceptado y el control»: el control viene marcado en la misma cita.
        ...(action.followUpId ? { followUpIds: [action.followUpId] } : {}),
      })
    } else if (step.kind === "respuesta" && action.budgetId) {
      setOpen("respuesta")
    } else if ((step.kind === "control" || step.kind === "cerrar") && action.appointmentId) {
      // «¿Vino?»: la cita se abre con «Registrar la atención» y «No vino».
      openAppointmentAnywhere(action.appointmentId)
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
        <BudgetAnswerDrawer
          patientId={patient.id}
          budgetId={action.budgetId}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === "control" && action.followUpId ? (
        <ScheduleControl
          patientId={patient.id}
          followUpId={action.followUpId}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  )
}

/**
 * «¿Qué respondió?» (o «Anotar su respuesta», en la atención) en un solo cajón:
 * qué responde, cada tratamiento y quién decide, sin pasar por otro bloque. Al
 * guardar se cierra y «Qué sigue» se pone al día. Con `inPerson`, el presupuesto
 * que se le acaba de mostrar queda entregado al anotar, sin enviarle nada.
 */
export function BudgetAnswerDrawer({
  patientId,
  budgetId,
  inPerson = false,
  onClose,
}: {
  patientId: string
  budgetId: string
  inPerson?: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const format = useBudgetFormat()
  const canDecide = usePermission("budgets.decide")
  const canSend = usePermission("budgets.send")
  const query = useQuery({
    queryKey: ["budget", patientId, budgetId],
    queryFn: () => fetchBudgetDetail(patientId, budgetId),
  })
  const budget = query.data?.data ?? null
  const runWrite = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation()
    // Se cierra sin esperar la lectura nueva: el cajón no alcanza a decir que ya respondió.
    void Promise.all([
      ...PLAN_QUERY_KEYS.map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, patientId] }),
      ),
      queryClient.invalidateQueries({ queryKey: ["people"] }),
    ])
    return result
  }
  if (query.isError)
    return (
      <DetailDrawer
        open
        title="Presupuesto"
        error="No se pudo leer el presupuesto. Ciérralo y vuelve a intentarlo."
        onClose={onClose}
      >
        {null}
      </DetailDrawer>
    )
  if (!budget)
    return (
      <DetailDrawer open title="Presupuesto" isLoading onClose={onClose}>
        {null}
      </DetailDrawer>
    )
  // Ya respondió (por su enlace, el chat u otra pantalla) o no se puede anotar: se dice, no se abre vacío.
  const answerable =
    BUDGET_ANSWERABLE_STATUSES.includes(budget.status) || (inPerson && budget.status === "borrador")
  if (!answerable || !canDecide || (budget.status === "borrador" && !canSend))
    return (
      <DetailDrawer open title={budgetNumberLabel(budget.budgetNumber)} description={budget.stateText} onClose={onClose}>
        <p className="text-sm text-muted-foreground">
          {!answerable
            ? "Este presupuesto ya no espera respuesta: su estado está arriba."
            : "Tu rol no anota la respuesta de este presupuesto."}
        </p>
      </DetailDrawer>
    )
  return (
    <BudgetResponse
      patientId={patientId}
      budget={budget}
      money={format.money}
      formatDay={(iso) => format.day(iso)}
      runWrite={runWrite}
      direct
      inPerson={inPerson}
      onClose={onClose}
    />
  )
}

/**
 * «Anotar su respuesta» del presupuesto que se le muestra en la atención: abre el
 * cajón de su respuesta sin imprimir ni enviar. Pide entregar y anotar respuestas.
 * La revisión de un presupuesto ya respondido se entrega antes, y se dice ahí.
 */
export function AnswerInPersonButton({
  patientId,
  budgetId,
  beforeOpen,
  onOpen,
  size = "sm",
  variant = "outline",
}: {
  patientId: string
  budgetId: string
  /** Lo escrito en la atención se guarda antes de abrir. */
  beforeOpen?: () => Promise<void>
  /** Quien muestra el botón abre el cajón (desde un diálogo que se cierra al abrirlo). */
  onOpen?: () => void
  size?: ComponentProps<typeof Button>["size"]
  variant?: ComponentProps<typeof Button>["variant"]
}): React.JSX.Element | null {
  const canDecide = usePermission("budgets.decide")
  const canSend = usePermission("budgets.send")
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const query = useQuery({
    queryKey: ["budget", patientId, budgetId],
    queryFn: () => fetchBudgetDetail(patientId, budgetId),
    enabled: canDecide && canSend,
  })
  if (!canDecide || !canSend) return null
  const budget = query.data?.data
  // Entregar es de quien lo preparó (el servidor lo exige): el de un colega se anota después de entregado.
  if (budget && budget.canChange === false) return null
  if (budget?.supersedesBudgetId)
    return (
      <p className="basis-full text-sm text-muted-foreground">
        Es una revisión: entrégala (imprímela o envíala) y después anota qué respondió.
      </p>
    )
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className="min-h-11 sm:min-h-8"
        disabled={opening}
        onClick={async () => {
          setOpening(true)
          try {
            await beforeOpen?.()
            if (onOpen) onOpen()
            else setOpen(true)
          } catch {
            // Lo escrito no se guardó: la atención ya lo dice junto a su campo.
          } finally {
            setOpening(false)
          }
        }}
      >
        Anotar su respuesta
      </Button>
      {open ? (
        <BudgetAnswerDrawer patientId={patientId} budgetId={budgetId} inPerson onClose={() => setOpen(false)} />
      ) : null}
    </>
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
  const list = clinical ? clinicalList : coordination
  // Otro lo reservó o lo canceló entre tanto: el botón lo dice, en vez de no hacer nada.
  useEffect(() => {
    if (control || list.isFetching) return
    if (list.isError) toast.error("No se pudo abrir el control. Inténtalo de nuevo.")
    else if (list.isSuccess) toast.error("Ese control ya no está por reservar.")
    else return
    onClose()
  }, [control, list.isFetching, list.isError, list.isSuccess, onClose])
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
