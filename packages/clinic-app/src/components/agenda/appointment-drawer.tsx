import {
  Button,
  buttonVariants,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  dayMinutesIn,
  DetailDrawer,
  DetailField,
  DetailList,
  hourLabel,
  internationalText,
  ResourceSelect,
  type ScheduleColumn,
  StatusIcon,
  statusSurfaceClass,
  statusTextClass,
  SubmitButton,
  submitErrorMessage,
  submitForm,
  timeRangeLabel,
  useAppForm,
  useFormSubmitError,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, MessageCircle } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  type AgendaAppointment,
  type AgendaResources,
  type AppointmentContext,
  type AppointmentStatus,
  appointmentSessionsText,
  appointmentShortWords,
  doneForWords,
  professionalSaid,
  visitLabel,
  visitState,
  stepBeforeArrival,
} from "../../lib/agenda"
import { useReceptionName, withReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { fetchPlanNextSteps } from "../../lib/budgets"
import { appointmentWhat } from "../../lib/patient-appointments"
import { attendWord } from "../../lib/patient-overview"
import { filiationGapsText, type PatientFull } from "../../lib/patients"
import { FiliacionSectionDrawer } from "../patient/filiacion-section-drawer"
import { FreedAppointmentButtons } from "../patient/freed-appointments"
import { CoordinationControls } from "../patient/plan/plan-coordination"
import { useAttendAppointment } from "../patient/new-encounter-button"
import { WriteToPersonDialog } from "../write-to-person"
import { announceVisitStatus, undoCame, useAppointmentArrival } from "./arrival"
import { TestAppointmentDrawer } from "./test-appointment-drawer"
import { dayShort, rangeSaid, whenSaid } from "./shared"
import { EMPTY_WHEN, exceptionFlags, useWhen, WHEN_FIELD_MAP, WhenFields } from "./when"
import { PersonLink } from "../person-link"
import { PhoneWhatsAppNote } from "../person/phone-whatsapp"
import { ServiceSelect } from "../service-select"
import { appWords, upperFirst } from "../../lib/product-words"

export type AppointmentDrawerMode = "view" | "move" | "cancel"

type CancelReason = "paciente" | "clinica" | "otro"
/** Cómo confirmó la persona, cuando lo anota el equipo. */
type ConfirmVia = "telefono" | "en_persona" | "mensaje"
const CONFIRM_VIAS: ReadonlyArray<{ via: ConfirmVia; label: string }> = [
  { via: "telefono", label: "Confirmó por teléfono" },
  { via: "en_persona", label: "Confirmó en persona" },
  { via: "mensaje", label: "Confirmó por mensaje" },
]
const CANCEL_REASONS: Array<{ id: CancelReason; label: string }> = [
  { id: "paciente", label: "Lo pidió el paciente" },
  { id: "clinica", label: "Lo pidió la clínica" },
  { id: "otro", label: "Otro motivo" },
]

/** De dónde salió una cita que no nació en una conversación. */
const SOURCE_WORDS: Record<string, string> = {
  enlace: "Enlace de reserva",
  // «Sofi» se cambia por el nombre de la clínica al mostrarlo.
  agent: "Sofi, en una conversación",
  portal: "Portal del paciente",
}

const STATUS_DONE: Record<AppointmentStatus, string> = {
  programada: "Cita por confirmar",
  confirmada: "Cita confirmada",
  atendida: "Cita atendida",
  no_asistio: "Marcada como «No vino»",
  cancelada: "Cita cancelada",
}

/**
 * Detalle de una cita: quién y cuándo arriba, su estado junto al paso que le
 * toca, y lo que se hace poco (cancelar, editar) abajo y separado. El estado
 * va en cuatro momentos (tablero 7): antes de llegar («Llegó»), llegó
 * («Atender», «Deshacer»), en atención (con quién y desde cuándo) y atendida
 * («Ver la atención»). «Atendida» no se pone a mano: la pone el cierre.
 */
type AppointmentDrawerProps = React.ComponentProps<typeof RealAppointmentDrawer>

/** La cita de prueba tiene su propio cajón (ADR 0094): nadie llega a ella ni se atiende. */
export function AppointmentDrawer(props: AppointmentDrawerProps) {
  if (props.appointment.test) {
    return (
      <TestAppointmentDrawer
        appointment={props.appointment}
        timeZone={props.timeZone}
        today={props.today}
        onClose={props.onClose}
        onChanged={props.onChanged}
      />
    )
  }
  return <RealAppointmentDrawer {...props} />
}

function RealAppointmentDrawer({
  appointment,
  initialMode = "view",
  canWrite,
  timeZone,
  today,
  now,
  resources,
  toneOf,
  onClose,
  onChanged,
  onRebook,
}: {
  appointment: AgendaAppointment
  initialMode?: AppointmentDrawerMode
  canWrite: boolean
  timeZone: string
  today: string
  now: string
  resources: AgendaResources
  /** El color de cada profesional, el mismo que en la rejilla. */
  toneOf: (id: string) => ScheduleColumn["tone"]
  onClose: () => void
  onChanged: () => Promise<void>
  /** Reagendar a quien canceló o no vino: abre «Nueva cita» con la persona. */
  /** Reservar otra: con el servicio y el profesional de esta, si se pasan. */
  onRebook: (patient: { id: string; name: string }, from?: { serviceId?: string | null; professionalUserId?: string | null }) => void
}) {
  const [mode, setMode] = React.useState<AppointmentDrawerMode | "edit">(initialMode)
  // Abierto desde el menú para cancelar: «Volver» cierra. Si de ahí se fue a reprogramar, ya
  // pasó por el detalle, y «Volver» vuelve a él.
  const openedToCancel = React.useRef(initialMode === "cancel")
  // El rechazo de una acción del cajón (confirmar, «No vino»); los formularios dicen el suyo.
  const [actionError, setActionError] = React.useState("")
  const [writing, setWriting] = React.useState(false)
  const canMessage = usePermission("conversations.write")
  const canReadChats = usePermission("conversations.read")
  const receptionName = useReceptionName()
  const canAttend = usePermission("clinical.write")
  const canReadClinical = usePermission("clinical.read")
  // El cajón ya muestra «Deshacer» junto a la llegada: el aviso no lo repite.
  const arrival = useAppointmentArrival({ onRebook, undoInToast: false })
  const [completing, setCompleting] = React.useState(false)
  const patientQuery = useQuery({
    queryKey: ["patient", appointment.patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${appointment.patientId}`),
    enabled: completing,
  })
  const attend = useAttendAppointment()
  // A quién se le escribe, de dónde salió y cuándo pedirá el agente confirmar.
  const contextQuery = useQuery({
    queryKey: ["agenda-appointment", appointment.id, "context", appointment.version, appointment.status],
    queryFn: () => apiFetch<{ data: AppointmentContext }>(`/api/appointments/${appointment.id}/context`),
  })
  const context = contextQuery.data?.data
  const active = appointment.status === "programada" || appointment.status === "confirmada"
  const started = Date.parse(appointment.startsAt) <= Date.parse(now)
  const isToday = zonedDateOf(appointment.startsAt, timeZone) === today
  /** Aún no llega: por confirmar o confirmada, sin llegada ni atención. */
  // También la que quedó sin cerrar: se puede reprogramar o cancelar (llamó y viene otro día).
  const before = appointment.visit === "por_confirmar" || appointment.visit === "confirmada" || appointment.visit === "sin_cerrar"
  /**
   * Ya pasó su hora y nadie la cerró, igual que la lista: hoy, «Llegó» (llegó tarde),
   * «Registrar la atención» o «No vino»; otro día, «Vino», «Registrar la atención» o «No vino».
   */
  const step = stepBeforeArrival(appointment, now, isToday)
  const unclosed = step === "cerrar" || step === "tarde"
  /** «Vino» la dejó atendida y nadie registró qué se hizo: se puede deshacer o registrar. */
  const cameUnrecorded = appointment.visit === "atendida" && !appointment.encounter && Boolean(context?.came)
  const patient = { id: appointment.patientId, name: appointment.patientName }
  const startAttention = () =>
    attend.mutate({
      patientId: appointment.patientId,
      appointment: {
        id: appointment.id,
        professionalUserId: appointment.professionalUserId,
        professionalName: appointment.professionalName,
        pastVisit: step === "cerrar" || (cameUnrecorded && !isToday),
      },
    })

  // ----- Cancelar -----
  const setStatus = useMutation({
    mutationFn: (input: {
      status: AppointmentStatus
      cancelReason?: CancelReason
      cancelNote?: string
      via?: ConfirmVia
    }) =>
      // «Vino»: la cita pasada queda atendida sin abrir otra atención (decisión B1 del 10 nov).
      input.status === "atendida"
        ? apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}/came`, {
            method: "POST",
            body: JSON.stringify({ expectedVersion: appointment.version }),
          })
        : apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}/status`, {
            method: "POST",
            // La versión que se ve: un cajón abierto antes no revive una cita que otro canceló.
            body: JSON.stringify({ ...input, expectedVersion: appointment.version }),
          }),
    onSuccess: async (result) => {
      if (
        result.data.status === "confirmada" ||
        result.data.status === "no_asistio" ||
        result.data.status === "atendida"
      )
        announceVisitStatus(result.data, { onUndone: () => void onChanged() })
      else
        toast.success(STATUS_DONE[result.data.status], {
          description: result.data.notice?.queued ? "El agente le avisa y le ofrece otra fecha." : undefined,
          // Cancelada: se ofrece otro día con lo mismo (servicio y profesional), sin volver a elegirlo.
          ...(result.data.status === "cancelada" && canWrite
            ? {
                action: {
                  label: "Reservar otro día",
                  onClick: () =>
                    onRebook(
                      { id: appointment.patientId, name: appointment.patientName },
                      { serviceId: appointment.serviceId, professionalUserId: appointment.professionalUserId },
                    ),
                },
              }
            : {}),
        })
      setActionError("")
      await onChanged()
      if (result.data.status === "cancelada") {
        onClose()
      }
    },
  })
  const undoVino = useMutation({
    mutationFn: () => undoCame(appointment.id),
    onSuccess: async (result) => {
      toast.success(`Se deshizo «Vino» de ${result.data.patientName}`)
      setActionError("")
      await onChanged()
    },
    onError: (cause) => setActionError(submitErrorMessage(cause)),
  })
  /** Confirmar o «No vino»: si falla, se dice en el cajón. */
  const changeStatus = (status: AppointmentStatus) =>
    setStatus.mutate({ status }, { onError: (cause) => setActionError(submitErrorMessage(cause)) })

  // El motivo de cancelar es un formulario: su error se dice en el diálogo, no detrás de él.
  const cancelForm = useAppForm({
    defaultValues: { cancelReason: "paciente" as CancelReason, cancelNote: "" },
    validators: {
      onSubmit: z.object({
        cancelReason: z.enum(["paciente", "clinica", "otro"], { error: "Elige el motivo." }),
        cancelNote: z.string().max(500, "Escribe la nota en 500 caracteres o menos."),
      }),
    },
    onSubmit: async ({ value }) => {
      await setStatus.mutateAsync({
        status: "cancelada",
        cancelReason: value.cancelReason,
        cancelNote: value.cancelNote.trim() || undefined,
      })
    },
  })
  const cancelError = useFormSubmitError(cancelForm)
  const cancelling = useStore(cancelForm.store, (state) => state.isSubmitting)

  // ----- Reprogramar -----
  // El mismo «cuándo» de Nueva cita: se abre en el día y con el profesional de la cita.
  const moving = React.useMemo(
    () => ({
      id: appointment.id,
      professionalUserId: appointment.professionalUserId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    }),
    [appointment.id, appointment.professionalUserId, appointment.startsAt, appointment.endsAt],
  )
  const when = useWhen({
    branchId: appointment.branchId,
    timeZone,
    today,
    now,
    toneOf,
    duration: Math.round(
      (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60000,
    ),
    date: zonedDateOf(appointment.startsAt, timeZone),
    professionalUserId: appointment.professionalUserId,
    moving,
    enabled: mode === "move",
  })
  const target = when.shown
  /** El bloque sigue donde ya está la cita: no hay nada que mover. */
  const unmoved =
    target != null &&
    target.columnId === appointment.professionalUserId &&
    Date.parse(target.start) === Date.parse(appointment.startsAt) &&
    Date.parse(target.end) === Date.parse(appointment.endsAt)
  const targetSaid = target ? whenSaid(target.start, timeZone, today) : ""
  // Confirmó otro día: al cambiarla de día vuelve a «por confirmar», salvo que ya lo haya dicho.
  const [stillConfirmed, setStillConfirmed] = React.useState(false)
  const asksConfirmed =
    appointment.status === "confirmada" &&
    target != null &&
    zonedDateOf(target.start, timeZone) !== zonedDateOf(appointment.startsAt, timeZone)
  // La marca vale para el día que se eligió: con otro día se pregunta de nuevo. Y aparece a la
  // vista, junto al botón: queda debajo de las horas.
  const targetDay = target ? zonedDateOf(target.start, timeZone) : ""
  const confirmedRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => setStillConfirmed(false), [targetDay, asksConfirmed])
  // Con cada hora elegida (y su aviso, si lo trae) la casilla vuelve a quedar a la vista.
  const targetStart = target?.start ?? ""
  const targetState = when.state
  React.useEffect(() => {
    if (asksConfirmed) confirmedRef.current?.scrollIntoView({ block: "nearest" })
  }, [targetStart, targetState, asksConfirmed])
  const move = useMutation({
    // Sin unidad dental: la cita conserva la suya o pasa a una libre a la nueva hora.
    mutationFn: (range: { start: string; end: string; columnId: string }) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: appointment.version,
          startsAt: range.start,
          endsAt: range.end,
          professionalUserId: range.columnId,
          ...exceptionFlags(when.exception),
          ...(asksConfirmed && stillConfirmed ? { stillConfirmed: true } : {}),
        }),
      }),
  })
  const moveRoot = React.useRef<HTMLDivElement>(null)
  const moveForm = useAppForm({
    defaultValues: { when: EMPTY_WHEN },
    onSubmit: async () => {
      // El «cuándo» ya validó que hay una hora libre distinta de la de ahora.
      if (!when.shown) return
      try {
        const result = await move.mutateAsync(when.shown)
        toast.success(
          `Cita de ${result.data.patientName} movida ${whenSaid(result.data.startsAt, timeZone, today)}`,
          {
            description:
              [
                result.data.unconfirmed ? "Cambió de día: vuelve a «por confirmar»." : "",
                result.data.notice?.queued ? "El agente le avisa la nueva fecha." : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
          },
        )
        setStillConfirmed(false)
        setMode("view")
        await onChanged()
      } catch (cause) {
        // Si alguien tomó el hueco, lo libre se vuelve a pedir.
        when.refetch()
        await onChanged()
        throw cause
      }
    },
  })
  const moveError = useFormSubmitError(moveForm)
  const movingNow = useStore(moveForm.store, (state) => state.isSubmitting)

  // ----- Editar detalles -----
  const detailsOf = (item: AgendaAppointment) => ({
    serviceId: item.serviceId ?? "",
    roomId: item.roomId,
    reason: item.reason ?? "",
  })
  const save = useMutation({
    mutationFn: (value: ReturnType<typeof detailsOf>) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: appointment.version,
          serviceId: value.serviceId || null,
          roomId: value.roomId,
          reason: value.reason.trim() || null,
        }),
      }),
  })
  const editRoot = React.useRef<HTMLDivElement>(null)
  const editForm = useAppForm({
    defaultValues: detailsOf(appointment),
    validators: {
      onSubmit: z.object({
        serviceId: z.string(),
        roomId: z.string(),
        reason: z.string().max(500, "Escribe el motivo en 500 caracteres o menos."),
      }),
    },
    onSubmit: async ({ value }) => {
      // Sin cambios no hay nada que guardar: se vuelve al detalle.
      if (editForm.state.isDirty) {
        await save.mutateAsync(value)
        toast.success("Cita actualizada")
        await onChanged()
      }
      setMode("view")
    },
  })
  const editError = useFormSubmitError(editForm)
  const savingDetails = useStore(editForm.store, (state) => state.isSubmitting)
  const dirty = useStore(editForm.store, (state) => mode === "edit" && state.isDirty)

  const busy = setStatus.isPending || movingNow || savingDetails || arrival.isPending || attend.isPending || undoVino.isPending
  const back = () => {
    setActionError("")
    moveForm.reset()
    setStillConfirmed(false)
    setMode("view")
  }
  const error = mode === "move" ? moveError : mode === "edit" ? editError : actionError || null

  const actions =
    mode === "move" ? (
      <>
        <Button variant="outline" onClick={back}>
          Volver
        </Button>
        <SubmitButton
          disabled={busy}
          pending={movingNow}
          onClick={() => void submitForm(moveForm, { fieldMap: WHEN_FIELD_MAP, root: moveRoot.current })}
        >
          {!target || unmoved
            ? "Mover cita"
            : when.state === "outside"
              ? "Mover fuera de horario"
              : when.state === "taken"
                ? "Mover igual"
            : targetSaid.startsWith("el ")
              ? `Mover al ${targetSaid.slice(3)}`
              : `Mover a ${targetSaid}`}
        </SubmitButton>
      </>
    ) : mode === "edit" ? (
      <>
        <Button variant="outline" onClick={back}>
          Volver
        </Button>
        <SubmitButton
          disabled={busy}
          pending={savingDetails}
          onClick={() => void submitForm(editForm, { root: editRoot.current })}
        >
          Guardar cambios
        </SubmitButton>
      </>
    ) : canWrite ? (
      <>
        {/* Lo que deshace la cita va aparte, lejos del paso habitual. */}
        {before ? (
          <Button
            variant="ghost"
            className="order-first mr-auto text-destructive hover:text-destructive"
            onClick={() => setMode("cancel")}
          >
            Cancelar cita
          </Button>
        ) : null}
        {/* Lo atendido, cancelado o que no vino ya es historia: sus detalles no se reescriben. */}
        {active ? (
          <Button
            variant="ghost"
            onClick={() => {
              // Se edita lo que la cita tiene ahora, no un borrador viejo.
              editForm.reset(detailsOf(appointment))
              setMode("edit")
            }}
          >
            Editar detalles
          </Button>
        ) : null}
      </>
    ) : undefined

  return (
    <>
      <DetailDrawer
        open={mode !== "cancel"}
        title={appointment.patientName}
        description={rangeSaid(appointment.startsAt, appointment.endsAt, timeZone, today)}
        onClose={onClose}
        isDirty={dirty}
        isSubmitting={busy}
        error={error}
        actions={actions}
      >
        {mode === "move" ? (
          <div ref={moveRoot} className="grid gap-4">
            <WhenFields form={moveForm} fields="when" when={when} />
            {asksConfirmed ? (
              <div ref={confirmedRef} data-draft-ignore className="grid gap-1.5">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="cita-mover-ya-confirmo"
                    checked={stillConfirmed}
                    onCheckedChange={(checked) => setStillConfirmed(checked === true)}
                    aria-describedby="cita-mover-ya-confirmo-ayuda"
                  />
                  <FieldLabel htmlFor="cita-mover-ya-confirmo" className="font-normal">
                    Ya confirmó conmigo el día nuevo
                  </FieldLabel>
                </div>
                <p id="cita-mover-ya-confirmo-ayuda" className="text-sm text-muted-foreground">
                  {appointment.patientName} había confirmado otro día. Sin marcar, la cita vuelve a «por confirmar» y se le
                  pide confirmar la fecha nueva.
                </p>
              </div>
            ) : null}
          </div>
        ) : mode === "edit" ? (
          <div ref={editRoot} className="grid gap-4">
            {/* El de la cita se ve aunque no esté en la primera página del tarifario. */}
            <editForm.AppField name="serviceId">
              {(field) => (
                <field.Control id="cita-editar-servicio" label="Servicio (opcional)">
                  {(control) => (
                    <ServiceSelect
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      placeholder="Buscar servicio (opcional)…"
                      value={field.state.value}
                      onChange={(service) => field.handleChange(service?.id ?? "")}
                    />
                  )}
                </field.Control>
              )}
            </editForm.AppField>
            <editForm.AppField name="roomId">
              {(field) => (
                <field.Control id="cita-editar-sillon" label={upperFirst(appWords().room.one)}>
                  {(control) => (
                    <ResourceSelect
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      placeholder={`Buscar ${appWords().room.one.toLocaleLowerCase("es")}…`}
                      options={resources.rooms.map((room) => ({ id: room.id, label: room.label }))}
                      value={field.state.value}
                      onChange={(roomId) => field.handleChange(roomId || field.state.value)}
                    />
                  )}
                </field.Control>
              )}
            </editForm.AppField>
            <editForm.AppField name="reason">
              {(field) => <field.TextField id="cita-editar-motivo" label="Motivo (opcional)" maxLength={500} />}
            </editForm.AppField>
          </div>
        ) : (
          <div className="grid gap-4">
            <div
              className={cn(
                "grid gap-2.5 rounded-2xl p-3.5",
                statusSurfaceClass(visitState(appointment.visit)),
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1.5 text-sm font-bold",
                  statusTextClass(visitState(appointment.visit)),
                )}
              >
                <StatusIcon status={visitState(appointment.visit)} />
                {appointment.visit === "en_atencion" && appointment.encounter
                  ? `En atención con ${professionalSaid(appointment.encounter.professionalName)} desde ${hourLabel(dayMinutesIn(appointment.encounter.startedAt, timeZone))}`
                  : appointment.visit === "llego" && appointment.arrivedAt
                    ? visitLabel(appointment, { now, timeZone }).replace(/^Llegó /, "Llegó a las ")
                    : unclosed
                      ? // Un solo nombre para la cita que pasó sin cerrarse, en toda la aplicación.
                        step === "tarde"
                        ? "Sin cerrar · su hora ya pasó: si llegó tarde, «Llegó»"
                        : "Sin cerrar · falta decir si vino"
                      : cameUnrecorded
                        ? "Atendida · sin su atención registrada"
                        : visitLabel(appointment, { now, timeZone })}
              </span>
              {/* Lo que queda por reservar, no una frase fija: un control indicado hoy sigue pendiente. */}
              {appointment.visit === "atendida" ? (
                <CoordinationControls patientId={appointment.patientId} branchId={appointment.branchId} pendingOnly />
              ) : null}
              {appointment.visit === "en_atencion" ? (
                <span className="text-[13px] text-muted-foreground">
                  Lo ven quienes ven la agenda; no es parte de la historia.
                </span>
              ) : null}
              {/* «Vino» sin atención: quién lo marcó y cuándo (no hay hora de llegada que mostrar). */}
              {cameUnrecorded && context?.came ? (
                <span className="text-[13px] text-muted-foreground">
                  «Vino» lo marcó {context.came.byName ?? "alguien del equipo"} {whenSaid(context.came.at, timeZone, today)}.
                  Lo que se hizo lo registra {appointment.professionalName}.
                </span>
              ) : null}

              {/* Para lo que ya se terminó: se dice y se ofrece usarla o liberarla (QA del 10 nov, M1). */}
              {active && appointment.doneFor && !appointment.encounter ? (
                <DoneForNotice appointment={appointment} canWrite={canWrite} />
              ) : null}
              {/* Antes de llegar: hoy, «Llegó»; otro día, confirmarla. Hoy, ya pasada su hora, también
                  «Llegó»: quien llega tarde no pasa por «No vino» (mesa del 10 nov, decisión 2). */}
              {canWrite && isToday && ((before && !unclosed) || step === "tarde") ? (
                <SubmitButton
                  className="h-11"
                  disabled={busy}
                  pending={arrival.isPending}
                  onClick={() => arrival.mutate({ id: appointment.id, arrived: true, patient, version: appointment.version })}
                >
                  Llegó
                </SubmitButton>
              ) : null}
              {/* Para lo que ya se terminó no se confirma: primero usarla o liberarla (QA antes de entregar). */}
              {canWrite && appointment.visit === "por_confirmar" && !started && !appointment.doneFor ? (
                // Se anota cómo confirmó: queda en la actividad de la cita.
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button className="h-11" variant={isToday ? "outline" : "default"} disabled={busy} />}
                  >
                    <Check aria-hidden />
                    {setStatus.isPending && setStatus.variables?.status === "confirmada" ? "Confirmando…" : "Confirmar cita"}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {CONFIRM_VIAS.map((option) => (
                      <DropdownMenuItem
                        key={option.via}
                        onClick={() =>
                          setStatus.mutate(
                            { status: "confirmada", via: option.via },
                            { onError: (cause) => setActionError(submitErrorMessage(cause)) },
                          )
                        }
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {/* Ya pasó su hora sin cerrarse: se registra la atención o se marca que no vino. */}
              {(unclosed || cameUnrecorded) && canAttend ? (
                <SubmitButton
                  className="h-11"
                  variant={step === "tarde" && canWrite ? "outline" : "default"}
                  disabled={busy}
                  pending={attend.isPending}
                  onClick={startAttention}
                >
                  Registrar la atención
                </SubmitButton>
              ) : null}
              {/* «No vino» solo cuando pasó la hora y no llegó. */}
              {canWrite && before && started && !appointment.arrivedAt ? (
                <SubmitButton
                  variant="outline"
                  className="h-11 bg-card"
                  disabled={busy}
                  pending={setStatus.isPending && setStatus.variables?.status === "no_asistio"}
                  onClick={() => changeStatus("no_asistio")}
                >
                  No vino
                </SubmitButton>
              ) : null}
              {/* Otro día, «Vino» sin abrir otra atención: vino a pagar, a recoger algo, o ya lo
                  atendieron (B1). Hoy no: quien llegó tarde se marca con «Llegó». */}
              {step === "cerrar" && canWrite ? (
                <SubmitButton
                  variant="outline"
                  className="h-11 bg-card"
                  disabled={busy}
                  pending={setStatus.isPending && setStatus.variables?.status === "atendida"}
                  onClick={() => changeStatus("atendida")}
                >
                  Vino
                </SubmitButton>
              ) : null}
              {step === "cerrar" && canWrite ? (
                <p className="text-sm text-muted-foreground">
                  «Vino» la deja atendida sin abrir otra atención; lo que se le hizo lo registra{" "}
                  {canAttend ? "quien la atendió" : appointment.professionalName}, a quien le aparece en «Te espera».
                </p>
              ) : null}
              {/* Cerrada con «Vino» y sin registrar: se deshace mientras nadie registre su atención. */}
              {cameUnrecorded && canWrite ? (
                <SubmitButton
                  variant="outline"
                  className="h-11 bg-card"
                  disabled={busy}
                  pending={undoVino.isPending}
                  onClick={() => undoVino.mutate()}
                >
                  Deshacer «Vino»
                </SubmitButton>
              ) : null}

              {/* Llegó: «Atender» para quien atiende y «Deshacer» mientras no empiece la atención. */}
              {appointment.visit === "llego" ? (
                <div className={cn("grid gap-2", canAttend && canWrite && "grid-cols-[1fr_auto]")}>
                  {canAttend ? (
                    <SubmitButton className="h-11" disabled={busy} pending={attend.isPending} onClick={startAttention}>
                      Atender
                    </SubmitButton>
                  ) : null}
                  {canWrite ? (
                    <SubmitButton
                      variant="outline"
                      className="h-11 bg-card"
                      disabled={busy}
                      pending={arrival.isPending}
                      onClick={() => arrival.mutate({ id: appointment.id, arrived: false, version: appointment.version })}
                    >
                      Deshacer
                    </SubmitButton>
                  ) : null}
                </div>
              ) : null}

              {/* En atención o atendida: la atención, para quien lee la historia. */}
              {appointment.encounter && (appointment.visit === "en_atencion" || appointment.visit === "atendida") && canReadClinical ? (
                <Link
                  to="/patients/$patientId/encounters/$encounterId"
                  params={{ patientId: appointment.patientId, encounterId: appointment.encounter.id }}
                  className={cn(buttonVariants({ variant: "outline" }), "h-11 bg-card")}
                >
                  {appointment.visit === "en_atencion" ? "Continuar la atención" : "Ver la atención"}
                </Link>
              ) : null}

              {/* No vino o cancelada: se reagenda; si llega tarde hoy, «Llegó» recupera la cita. */}
              {/* «No vino» por error en otro día: si sí vino, «Vino» la corrige (sin abrir otra atención). */}
              {canWrite && appointment.visit === "no_vino" && !isToday ? (
                <SubmitButton
                  variant="outline"
                  className="h-11 bg-card"
                  disabled={busy}
                  pending={setStatus.isPending && setStatus.variables?.status === "atendida"}
                  onClick={() => changeStatus("atendida")}
                >
                  Sí vino
                </SubmitButton>
              ) : null}
              {canWrite && appointment.visit === "no_vino" && isToday ? (
                <SubmitButton
                  className="h-11"
                  disabled={busy}
                  pending={arrival.isPending}
                  onClick={() => arrival.mutate({ id: appointment.id, arrived: true, patient, version: appointment.version })}
                >
                  Llegó
                </SubmitButton>
              ) : null}
              {canWrite && (appointment.status === "no_asistio" || appointment.status === "cancelada") ? (
                <Button
                  variant="outline"
                  className="h-11 bg-card"
                  onClick={() => onRebook(patient, { serviceId: appointment.serviceId, professionalUserId: appointment.professionalUserId })}
                >
                  Reagendar
                </Button>
              ) : null}
            </div>

            <DetailList columns={1}>
              {context?.person ? (
                <DetailField label="Teléfono">
                  {context.person.phone ? internationalText(context.person.phone) : "Sin teléfono"}
                  {context.person.relationship !== "self" ? ` · de ${context.person.name}` : ""}
                  {context.person.phone ? (
                    <PhoneWhatsAppNote contactId={context.person.contactId} value={context.person.whatsapp} />
                  ) : null}
                </DetailField>
              ) : null}
              {context?.missingData && context.missingData.length > 0 ? (
                <DetailField label="Datos">
                  {/* La misma regla y frase que su página: lo calcula el servidor. */}
                  <span className="flex flex-wrap items-center gap-x-2">
                    Faltan datos para {attendWord(context.patientSex)}: {filiationGapsText(context.missingData).toLowerCase()}
                    {/* Lo mismo que «Completar» en su Resumen: solo lo que falta, con «Enviarle su enlace». */}
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 font-semibold" onClick={() => setCompleting(true)}>
                      Completar
                    </Button>
                  </span>
                </DetailField>
              ) : null}
              <DetailField label="Servicio">
                {appointmentWhat({ ...appointment, reason: null }) ?? "Sin servicio"}
                {/* Lo sumado que no cabe en lo reservado: se dice aquí, con «Reprogramar» al pie (QA del 10 nov, M3). */}
                {appointmentShortWords(appointment) ? (
                  <span className="block text-sm font-semibold text-warning">
                    {appointmentShortWords(appointment)}.
                  </span>
                ) : null}
              </DetailField>
              {/* Lo que viene a hacer de un tratamiento de varias sesiones: «Endodoncia · sesión 2 de 2». */}
              {appointment.sessions?.length ? (
                <DetailField label={appointment.sessions.length === 1 ? "Sesión" : "Sesiones"}>
                  {appointmentSessionsText(appointment.sessions, appointment.serviceName)}
                </DetailField>
              ) : null}
              <DetailField label="Profesional">{appointment.professionalName}</DetailField>
              <DetailField label={upperFirst(appWords().room.one)}>{appointment.roomName}</DetailField>
              {appointment.reason ? (
                <DetailField label="Motivo">{appointment.reason}</DetailField>
              ) : null}
              {context && (context.origin.conversationId || SOURCE_WORDS[context.origin.source]) ? (
                <DetailField label="Salió de">
                  <span className="flex flex-wrap items-center gap-x-2">
                    {context.origin.conversationId
                      ? `Conversación de ${channelLabel(context.origin.channel ?? "")} del ${dayShort(zonedDateOf(context.origin.at, timeZone))}`
                      : withReceptionName(SOURCE_WORDS[context.origin.source] ?? "", receptionName)}
                    {context.origin.conversationId && canReadChats ? (
                      <Link
                        to="/inbox"
                        search={{ conversation: context.origin.conversationId }}
                        className="font-semibold text-primary hover:underline"
                      >
                        Ver la conversación
                      </Link>
                    ) : null}
                  </span>
                </DetailField>
              ) : null}
              {active && context?.confirmation ? (
                <DetailField label="Confirmación">
                  {context.confirmation.askAt
                    ? `El agente le pedirá confirmar ${whenSaid(context.confirmation.askAt, timeZone, today)}`
                    : context.confirmation.askedAt
                      ? `El agente se lo pidió ${whenSaid(context.confirmation.askedAt, timeZone, today)} y aún no confirma`
                      : null}
                </DetailField>
              ) : null}
            </DetailList>

            <div className="grid gap-2">
              {canMessage && context?.person ? (
                <Button variant="outline" className="h-11" onClick={() => setWriting(true)}>
                  <MessageCircle aria-hidden />
                  Escribirle
                </Button>
              ) : null}
              {canWrite && before ? (
                <Button variant="outline" className="h-11" onClick={() => setMode("move")}>
                  Reprogramar
                </Button>
              ) : null}
              {/* De la cita a la página de la persona: la misma desde todas partes (ADR 0029). */}
              <PersonLink
                patientId={appointment.patientId}
                contactId={context?.person?.relationship === "self" ? context.person.contactId : null}
                className={cn(buttonVariants({ variant: "outline" }), "h-11")}
              >
                Abrir la ficha de {appointment.patientName.split(/\s+/)[0]}
              </PersonLink>
            </div>
          </div>
        )}
      </DetailDrawer>

      {completing && patientQuery.data ? (
        <FiliacionSectionDrawer
          patient={patientQuery.data.data.patient}
          section="completar"
          missing={patientQuery.data.data.missingData ?? []}
          open
          onClose={() => {
            setCompleting(false)
            void contextQuery.refetch()
          }}
        />
      ) : null}

      <WriteToPersonDialog
        open={writing}
        onClose={() => setWriting(false)}
        people={context?.person ? [{ contactId: context.person.contactId, displayName: context.person.name }] : []}
      />

      <ConfirmDialog
        open={mode === "cancel"}
        title="Cancelar cita"
        description={`Se cancelará la cita de ${appointment.patientName}. El hueco de ${timeRangeLabel(appointment.startsAt, appointment.endsAt, timeZone)} queda libre para otra persona.`}
        confirmLabel="Cancelar cita"
        cancelLabel="Volver"
        variant="destructive"
        pending={cancelling}
        error={cancelError}
        onClose={() => (openedToCancel.current ? onClose() : setMode("view"))}
        onConfirm={() => void submitForm(cancelForm)}
      >
        <div className="grid gap-3 text-left">
          <cancelForm.AppField name="cancelReason">
            {(field) => (
              <field.Group legend="Motivo">
                {(control) => (
                  <RadioGroup
                    id={control.id}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onValueChange={(next) => field.handleChange(next as CancelReason)}
                  >
                    {CANCEL_REASONS.map((option) => (
                      <FieldLabel
                        key={option.id}
                        className={cn(
                          "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-sm font-normal",
                          field.state.value === option.id && "border-primary bg-primary-soft",
                        )}
                      >
                        <RadioGroupItem value={option.id} />
                        {option.label}
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                )}
              </field.Group>
            )}
          </cancelForm.AppField>
          <cancelForm.AppField name="cancelNote">
            {(field) => (
              <field.TextField
                label="Nota, si hace falta"
                hideLabel
                placeholder="Nota, si hace falta"
                maxLength={500}
              />
            )}
          </cancelForm.AppField>
          {/* Propuesta UX 5: si lo pidió el paciente, quizá quiere otro día. Mover conserva el servicio
              y el profesional, y no deja una cita cancelada. */}
          <cancelForm.Subscribe selector={(state) => state.values.cancelReason}>
            {(reason) =>
              reason === "paciente" && canWrite && before ? (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  ¿Quiere otro día?
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-8"
                    disabled={cancelling}
                    onClick={() => {
                      openedToCancel.current = false
                      setMode("move")
                    }}
                  >
                    Reprogramar
                  </Button>
                </p>
              ) : null
            }
          </cancelForm.Subscribe>
        </div>
      </ConfirmDialog>
    </>
  )
}

/** «Era para la corona, que ya se terminó»: con «Usarla para…» y «Liberarla», como «Qué sigue». */
function DoneForNotice({
  appointment,
  canWrite,
}: {
  appointment: AgendaAppointment
  canWrite: boolean
}): React.JSX.Element {
  const steps = useQuery({
    queryKey: ["plan-next", appointment.patientId, "lista"],
    queryFn: () => fetchPlanNextSteps(appointment.patientId),
    enabled: canWrite,
  })
  const step = steps.data?.data.find(
    (row) => row.kind === "sin_objeto" && row.action?.appointmentId === appointment.id,
  )
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
      <p>
        Esta cita {doneForWords(appointment)}: no tiene nada que hacer.
        {canWrite ? "" : " Recepción la verá para usarla o liberarla."}
      </p>
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <FreedAppointmentButtons
            appointmentId={appointment.id}
            version={appointment.version}
            startsAt={appointment.startsAt}
            reuse={step?.action?.reuse ?? null}
          />
        </div>
      ) : null}
    </div>
  )
}
