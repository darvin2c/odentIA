import {
  Button,
  buttonVariants,
  cn,
  FieldLabel,
  Input,
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
  timeRangeLabel,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, MessageCircle } from "lucide-react"
import * as React from "react"
import {
  type AgendaAppointment,
  type AgendaResources,
  type AppointmentContext,
  type AppointmentStatus,
  professionalSaid,
  visitLabel,
  visitState,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { filiationGapsText, type PatientFull } from "../../lib/patients"
import { FiliacionSectionDrawer } from "../patient/filiacion-section-drawer"
import { useAttendAppointment } from "../patient/new-encounter-button"
import { WriteToPersonDialog } from "../write-to-person"
import { useAppointmentArrival } from "./arrival"
import { dayShort, errorMessage, rangeSaid, whenSaid } from "./shared"
import { useWhen, WhenFields } from "./when"
import { PersonLink } from "../person-link"
import { ServiceSelect } from "../service-select"

export type AppointmentDrawerMode = "view" | "move" | "cancel"

type CancelReason = "paciente" | "clinica" | "otro"
const CANCEL_REASONS: Array<{ id: CancelReason; label: string }> = [
  { id: "paciente", label: "Lo pidió el paciente" },
  { id: "clinica", label: "Lo pidió la clínica" },
  { id: "otro", label: "Otro motivo" },
]

/** De dónde salió una cita que no nació en una conversación. */
const SOURCE_WORDS: Record<string, string> = {
  enlace: "Enlace de reserva",
  agent: "El agente, en una conversación",
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
export function AppointmentDrawer({
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
  onRebook: (patient: { id: string; name: string }) => void
}) {
  const [mode, setMode] = React.useState<AppointmentDrawerMode | "edit">(initialMode)
  const [error, setError] = React.useState("")
  const [writing, setWriting] = React.useState(false)
  const canMessage = usePermission("conversations.write")
  const canReadChats = usePermission("conversations.read")
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
  const before = appointment.visit === "por_confirmar" || appointment.visit === "confirmada"
  /** Ya pasó su día y nadie la cerró: «Registrar la atención» o «No vino». */
  const unclosed = before && !isToday && Date.parse(appointment.endsAt) <= Date.parse(now)
  const patient = { id: appointment.patientId, name: appointment.patientName }
  const startAttention = () =>
    attend.mutate({
      patientId: appointment.patientId,
      appointment: { id: appointment.id, dentistUserId: appointment.dentistUserId, dentistName: appointment.dentistName },
    })

  // ----- Cancelar -----
  const [cancelReason, setCancelReason] = React.useState<CancelReason>("paciente")
  const [cancelNote, setCancelNote] = React.useState("")
  const reasonId = React.useId()

  const setStatus = useMutation({
    mutationFn: (status: AppointmentStatus) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}/status`, {
        method: "POST",
        body: JSON.stringify(
          status === "cancelada"
            ? { status, cancelReason, cancelNote: cancelNote.trim() || undefined }
            : { status },
        ),
      }),
    onSuccess: async (result) => {
      toast.success(STATUS_DONE[result.data.status], {
        description: result.data.notice?.queued ? "El agente le avisa y le ofrece otra fecha." : undefined,
      })
      setError("")
      await onChanged()
      if (result.data.status === "cancelada") {
        onClose()
      }
    },
    onError: (cause) => {
      const text = errorMessage(cause)
      setError(text)
      // En el diálogo de cancelar no hay dónde leer el error del panel.
      if (mode === "cancel") toast.error(text)
    },
  })

  // ----- Reprogramar -----
  // El mismo «cuándo» de Nueva cita: se abre en el día y con el profesional de la cita.
  const moving = React.useMemo(
    () => ({
      id: appointment.id,
      dentistUserId: appointment.dentistUserId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    }),
    [appointment.id, appointment.dentistUserId, appointment.startsAt, appointment.endsAt],
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
    dentistUserId: appointment.dentistUserId,
    moving,
    enabled: mode === "move",
  })
  const target = when.shown
  /** El bloque sigue donde ya está la cita: no hay nada que mover. */
  const unmoved =
    target != null &&
    target.columnId === appointment.dentistUserId &&
    Date.parse(target.start) === Date.parse(appointment.startsAt) &&
    Date.parse(target.end) === Date.parse(appointment.endsAt)
  const targetSaid = target ? whenSaid(target.start, timeZone, today) : ""
  const move = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Elige una hora libre.")
      // Sin sillón: la cita conserva el suyo o pasa a uno libre a la nueva hora.
      return apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: appointment.version,
          startsAt: target.start,
          endsAt: target.end,
          dentistUserId: target.columnId,
        }),
      })
    },
    onSuccess: async (result) => {
      toast.success(
        `Cita de ${result.data.patientName} movida ${whenSaid(result.data.startsAt, timeZone, today)}`,
        { description: result.data.notice?.queued ? "El agente le avisa la nueva fecha." : undefined },
      )
      setError("")
      setMode("view")
      await onChanged()
    },
    onError: async (cause) => {
      setError(errorMessage(cause))
      // Si alguien tomó el hueco, lo libre se vuelve a pedir.
      when.refetch()
      await onChanged()
    },
  })

  // ----- Editar detalles -----
  const [draft, setDraft] = React.useState({
    serviceId: appointment.serviceId ?? "",
    chairId: appointment.chairId,
    reason: appointment.reason ?? "",
  })
  const dirty =
    mode === "edit" &&
    (draft.serviceId !== (appointment.serviceId ?? "") ||
      draft.chairId !== appointment.chairId ||
      draft.reason !== (appointment.reason ?? ""))
  const save = useMutation({
    mutationFn: () =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: appointment.version,
          serviceId: draft.serviceId || null,
          chairId: draft.chairId,
          reason: draft.reason.trim() || null,
        }),
      }),
    onSuccess: async () => {
      toast.success("Cita actualizada")
      setError("")
      setMode("view")
      await onChanged()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })

  const busy = setStatus.isPending || move.isPending || save.isPending || arrival.isPending || attend.isPending
  const back = () => {
    setError("")
    setMode("view")
  }

  const actions =
    mode === "move" ? (
      <>
        <Button variant="outline" onClick={back}>
          Volver
        </Button>
        <SubmitButton
          disabled={!target || unmoved || when.state !== "free"}
          pending={move.isPending}
          onClick={() => move.mutate()}
        >
          {!target || unmoved
            ? "Mover cita"
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
        <SubmitButton disabled={!dirty} pending={save.isPending} onClick={() => save.mutate()}>
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
        {appointment.status !== "cancelada" ? (
          <Button variant="ghost" onClick={() => setMode("edit")}>
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
        error={error || null}
        actions={actions}
      >
        {mode === "move" ? (
          <div className="grid gap-4">
            <WhenFields when={when} />
          </div>
        ) : mode === "edit" ? (
          <div className="grid gap-4">
            {/* El de la cita se ve aunque no esté en la primera página del tarifario. */}
            <ServiceSelect
              id="cita-editar-servicio"
              label="Servicio (opcional)"
              value={draft.serviceId}
              onChange={(service) => setDraft((current) => ({ ...current, serviceId: service?.id ?? "" }))}
            />
            <ResourceSelect
              id="cita-editar-sillon"
              label="Sillón"
              options={resources.chairs.map((chair) => ({ id: chair.id, label: chair.label }))}
              value={draft.chairId}
              onChange={(chairId) =>
                setDraft((current) => ({ ...current, chairId: chairId || current.chairId }))
              }
            />
            <div className="grid gap-2">
              <FieldLabel htmlFor="cita-editar-motivo">Motivo (opcional)</FieldLabel>
              <Input
                id="cita-editar-motivo"
                value={draft.reason}
                maxLength={500}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, reason: event.target.value }))
                }
              />
            </div>
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
                  ? `En atención con ${professionalSaid(appointment.encounter.dentistName)} desde ${hourLabel(dayMinutesIn(appointment.encounter.startedAt, timeZone))}`
                  : appointment.visit === "llego" && appointment.arrivedAt
                    ? visitLabel(appointment, { now, timeZone }).replace(/^Llegó /, "Llegó a las ")
                    : visitLabel(appointment, { now, timeZone })}
              </span>
              {appointment.visit === "atendida" ? (
                <span className="text-[13px] text-muted-foreground">Sus controles quedaron hechos.</span>
              ) : null}
              {appointment.visit === "en_atencion" ? (
                <span className="text-[13px] text-muted-foreground">
                  Lo ven quienes ven la agenda; no es parte de la historia.
                </span>
              ) : null}

              {/* Antes de llegar: hoy, «Llegó»; otro día, confirmarla. */}
              {canWrite && before && isToday ? (
                <SubmitButton
                  className="h-11"
                  disabled={busy}
                  pending={arrival.isPending}
                  onClick={() => arrival.mutate({ id: appointment.id, arrived: true, patient })}
                >
                  Llegó
                </SubmitButton>
              ) : null}
              {canWrite && appointment.visit === "por_confirmar" && !started ? (
                <SubmitButton
                  className="h-11"
                  variant={isToday ? "outline" : "default"}
                  disabled={busy}
                  pending={setStatus.isPending && setStatus.variables === "confirmada"}
                  onClick={() => setStatus.mutate("confirmada")}
                >
                  {setStatus.isPending && setStatus.variables === "confirmada" ? null : (
                    <Check aria-hidden />
                  )}
                  Confirmar cita
                </SubmitButton>
              ) : null}
              {/* Ya pasó su día sin cerrarse: se registra la atención o se marca que no vino. */}
              {unclosed && canAttend ? (
                <SubmitButton className="h-11" disabled={busy} pending={attend.isPending} onClick={startAttention}>
                  Registrar la atención
                </SubmitButton>
              ) : null}
              {/* «No vino» solo cuando pasó la hora y no llegó. */}
              {canWrite && before && started ? (
                <SubmitButton
                  variant="outline"
                  className="h-11 bg-card"
                  disabled={busy}
                  pending={setStatus.isPending && setStatus.variables === "no_asistio"}
                  onClick={() => setStatus.mutate("no_asistio")}
                >
                  No vino
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
                      onClick={() => arrival.mutate({ id: appointment.id, arrived: false })}
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
                  {appointment.visit === "en_atencion" ? "Seguir la atención" : "Ver la atención"}
                </Link>
              ) : null}

              {/* No vino o cancelada: se reagenda; si llega tarde hoy, «Llegó» recupera la cita. */}
              {canWrite && appointment.visit === "no_vino" && isToday ? (
                <SubmitButton
                  className="h-11"
                  disabled={busy}
                  pending={arrival.isPending}
                  onClick={() => arrival.mutate({ id: appointment.id, arrived: true, patient })}
                >
                  Llegó
                </SubmitButton>
              ) : null}
              {canWrite && (appointment.status === "no_asistio" || appointment.status === "cancelada") ? (
                <Button variant="outline" className="h-11 bg-card" onClick={() => onRebook(patient)}>
                  Reagendar
                </Button>
              ) : null}
            </div>

            <DetailList columns={1}>
              {context?.person ? (
                <DetailField label="Teléfono">
                  {context.person.phone ? internationalText(context.person.phone) : "Sin teléfono"}
                  {context.person.relationship !== "self" ? ` · de ${context.person.name}` : ""}
                </DetailField>
              ) : null}
              {context?.missingData && context.missingData.length > 0 ? (
                <DetailField label="Datos">
                  {/* La misma regla y frase que su página: lo calcula el servidor. */}
                  <span className="flex flex-wrap items-center gap-x-2">
                    Faltan datos para atenderla: {filiationGapsText(context.missingData).toLowerCase()}
                    {/* Lo mismo que «Completar» en su Resumen: solo lo que falta, con «Enviarle su enlace». */}
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 font-semibold" onClick={() => setCompleting(true)}>
                      Completar
                    </Button>
                  </span>
                </DetailField>
              ) : null}
              <DetailField label="Servicio">{appointment.serviceName ?? "Sin servicio"}</DetailField>
              <DetailField label="Profesional">{appointment.dentistName}</DetailField>
              <DetailField label="Sillón">{appointment.chairName}</DetailField>
              {appointment.reason ? (
                <DetailField label="Motivo">{appointment.reason}</DetailField>
              ) : null}
              {context && (context.origin.conversationId || SOURCE_WORDS[context.origin.source]) ? (
                <DetailField label="Salió de">
                  <span className="flex flex-wrap items-center gap-x-2">
                    {context.origin.conversationId
                      ? `Conversación de ${channelLabel(context.origin.channel ?? "")} del ${dayShort(zonedDateOf(context.origin.at, timeZone))}`
                      : SOURCE_WORDS[context.origin.source]}
                    {context.origin.conversationId && canReadChats ? (
                      <Link
                        to="/inbox"
                        search={{ conversation: context.origin.conversationId }}
                        className="font-semibold text-primary hover:underline"
                      >
                        Ver conversación
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
        pending={setStatus.isPending}
        onClose={() => (initialMode === "cancel" ? onClose() : setMode("view"))}
        onConfirm={() => setStatus.mutate("cancelada")}
      >
        <div className="grid gap-3 text-left">
          <div className="grid gap-2">
            <span id={reasonId} className="text-sm font-medium">
              Motivo
            </span>
            <RadioGroup
              aria-labelledby={reasonId}
              value={cancelReason}
              onValueChange={(next) => setCancelReason(next as CancelReason)}
            >
              {CANCEL_REASONS.map((option) => (
                <FieldLabel
                  key={option.id}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-sm font-normal",
                    cancelReason === option.id && "border-primary bg-primary-soft",
                  )}
                >
                  <RadioGroupItem value={option.id} />
                  {option.label}
                </FieldLabel>
              ))}
            </RadioGroup>
          </div>
          <Input
            aria-label="Nota, si hace falta"
            placeholder="Nota, si hace falta"
            maxLength={500}
            value={cancelNote}
            onChange={(event) => setCancelNote(event.target.value)}
          />
        </div>
      </ConfirmDialog>
    </>
  )
}
