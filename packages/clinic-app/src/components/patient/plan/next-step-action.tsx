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
import { type AgendaAppointment, invalidateAppointmentQueries } from "../../../lib/agenda"
import { apiFetch } from "../../../lib/api"
import { usePersonArchived } from "../../../lib/person-archived"
import { openAppointmentAnywhere, openBookingAnywhere } from "../../agenda/schedule-host"
import { errorMessage } from "../../agenda/shared"
import { FollowUpScheduler } from "../follow-up-scheduler"
import { useBudgetFormat } from "./budget-parts"
import { BudgetNoAnswer } from "./budget-no-answer"
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
  const [open, setOpen] = useState<"respuesta" | "control" | "nocontesta" | null>(null)
  const canTask = usePermission("tasks.write")
  const [joining, setJoining] = useState(false)
  const queryClient = useQueryClient()
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
  const refresh = async () => {
    await Promise.all([
      ...PLAN_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key, patient.id] })),
      queryClient.invalidateQueries({ queryKey: ["people"] }),
      queryClient.invalidateQueries({ queryKey: ["treatment-coordination", patient.id] }),
      invalidateAppointmentQueries(queryClient),
    ])
  }
  /** Lo que lleva esa cita: suma o quita, con la versión que tiene ahora. */
  const changeAppointment = async (appointmentId: string, change: { add?: string[]; remove?: string[] }) => {
    const current = await apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointmentId}`)
    return apiFetch<{ data: AgendaAppointment & { usualMinutes: number | null; added: string[] } }>(
      `/api/appointments/${appointmentId}/plan-items`,
      { method: "POST", body: JSON.stringify({ expectedVersion: current.data.version, ...change }) },
    )
  }
  /**
   * «Sumar a su cita del 10 nov»: lo aceptado va en la cita que ya tiene, sin otra visita, con
   * «Deshacer». La cita no se alarga sola: si lo que lleva suele durar más, el aviso lo dice.
   */
  const joinAppointment = async (join: { appointmentId: string; label: string }, ids: string[]) => {
    setJoining(true)
    try {
      const result = await changeAppointment(join.appointmentId, { add: ids })
      await refresh()
      const appointment = result.data
      const usual = appointment.usualMinutes
      const minutes = Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000)
      const tooShort = !!usual && usual > minutes
      toast.success(`${join.label.replace(/^Sumar/, "Sumado")} con ${appointment.professionalName}`, {
        // La cita no se alarga sola: si lo que lleva suele durar más, se dice y el aviso se queda
        // hasta cerrarlo (segunda mesa del 9 nov: se iba solo y no se entendía «105»).
        description: tooShort
          ? `Su cita está reservada por ${minutes} minutos y con esto suele necesitar unos ${usual}. Si no alcanza, alárgala en la Agenda.`
          : undefined,
        ...(tooShort ? { duration: Number.POSITIVE_INFINITY, closeButton: true } : {}),
        action: {
          label: "Deshacer",
          onClick: () =>
            void changeAppointment(join.appointmentId, { remove: appointment.added })
              .then(async () => {
                await refresh()
                toast.success("Se quitó de su cita")
              })
              .catch((cause: unknown) => toast.error(errorMessage(cause))),
        },
      })
    } catch (cause) {
      toast.error(errorMessage(cause))
      await refresh()
    } finally {
      setJoining(false)
    }
  }
  const onClick = () => {
    if ((step.kind === "agendar" || step.kind === "continuar") && action.planItemIds?.length) {
      const followUpIds = action.followUpIds ?? (action.followUpId ? [action.followUpId] : [])
      openBookingAnywhere({
        patient,
        lockedPatient: true,
        planItemIds: action.planItemIds,
        ...(action.serviceId ? { serviceId: action.serviceId } : {}),
        // «Reservar lo aceptado y el control»: el control viene marcado en la misma cita.
        ...(followUpIds.length ? { followUpIds } : {}),
        // Lo que va después de otro tratamiento, o el control que aún no se puede hacer: desde ese día.
        ...(action.date ? { date: action.date } : {}),
        ...(action.note ? { note: action.note, notBefore: action.date } : {}),
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
  const join = action.join
  // «No contesta»: su propio botón en la fila, al lado de «¿Qué respondió?» (QA del 9 nov: dentro de
  // ese cajón había dos «Guardar» y no se sabía cuál). Anota cuándo volver a llamar, no una respuesta.
  const noAnswer = step.kind === "respuesta" && action.budgetId && canTask
  return (
    <>
      {noAnswer ? (
        <Button type="button" size={size} variant="outline" onClick={() => setOpen("nocontesta")}>
          No contesta
        </Button>
      ) : null}
      {join && action.planItemIds?.length ? (
        <Button
          type="button"
          size={size}
          variant={variant}
          disabled={joining}
          onClick={() => void joinAppointment(join, action.planItemIds ?? [])}
        >
          {join.label}
        </Button>
      ) : null}
      <Button type="button" size={size} variant={join ? "outline" : variant} onClick={onClick}>
        {action.label}
      </Button>
      {open === "respuesta" && action.budgetId ? (
        <BudgetAnswerDrawer
          patientId={patient.id}
          budgetId={action.budgetId}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === "nocontesta" && action.budgetId ? (
        <DetailDrawer
          open
          title="No contesta"
          description={`Su presupuesto sigue esperando respuesta. Queda una tarea para volver a llamar por el presupuesto de ${patient.name}.`}
          onClose={() => setOpen(null)}
        >
          <BudgetNoAnswer
            patientId={patient.id}
            budgetId={action.budgetId}
            onSaved={() => setOpen(null)}
            onCancel={() => setOpen(null)}
          />
        </DetailDrawer>
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
