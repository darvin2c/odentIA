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
  DetailDrawer,
  DetailField,
  DetailList,
  internationalText,
  ResourceSelect,
  SCHEDULE_AGENDA_LABELS,
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
import type {
  AgendaAppointment,
  AgendaResources,
  AgendaServiceOption,
  AppointmentContext,
  AppointmentStatus,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { NewEncounterButton } from "../patient/new-encounter-button"
import { WriteToPersonDialog } from "../write-to-person"
import { dayShort, errorMessage, rangeSaid, whenSaid } from "./shared"
import { useWhen, WhenFields } from "./when"
import { PersonLink } from "../person-link"

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
  no_asistio: "Inasistencia registrada",
  cancelada: "Cita cancelada",
}

/**
 * Detalle de una cita: quién y cuándo arriba, su estado junto al paso que le
 * toca, y lo que se hace poco (cancelar, editar) abajo y separado.
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
  // A quién se le escribe, de dónde salió y cuándo pedirá el agente confirmar.
  const contextQuery = useQuery({
    queryKey: ["agenda-appointment", appointment.id, "context", appointment.version, appointment.status],
    queryFn: () => apiFetch<{ data: AppointmentContext }>(`/api/appointments/${appointment.id}/context`),
  })
  const context = contextQuery.data?.data
  const active = appointment.status === "programada" || appointment.status === "confirmada"
  const started = Date.parse(appointment.startsAt) <= Date.parse(now)

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
  const servicesQuery = useQuery({
    queryKey: ["services", "agenda-picker"],
    enabled: mode === "edit",
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
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

  const busy = setStatus.isPending || move.isPending || save.isPending
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
        {active ? (
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
            <ResourceSelect
              id="cita-editar-servicio"
              label="Servicio (opcional)"
              options={(servicesQuery.data?.data ?? []).map((service) => ({
                id: service.id,
                label: service.name,
              }))}
              value={draft.serviceId}
              onChange={(serviceId) => setDraft((current) => ({ ...current, serviceId }))}
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
                statusSurfaceClass(appointment.status),
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1.5 text-sm font-bold",
                  statusTextClass(appointment.status),
                )}
              >
                <StatusIcon status={appointment.status} />
                {SCHEDULE_AGENDA_LABELS[appointment.status]}
              </span>
              {canWrite && active && !started && appointment.status === "programada" ? (
                <SubmitButton
                  className="h-11"
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
              {canWrite && active && started ? (
                <div className="grid grid-cols-2 gap-2">
                  <SubmitButton
                    className="h-11"
                    disabled={busy}
                    pending={setStatus.isPending && setStatus.variables === "atendida"}
                    onClick={() => setStatus.mutate("atendida")}
                  >
                    {setStatus.isPending && setStatus.variables === "atendida" ? null : (
                      <Check aria-hidden />
                    )}
                    Atendida
                  </SubmitButton>
                  <SubmitButton
                    variant="outline"
                    className="h-11 bg-card"
                    disabled={busy}
                    pending={setStatus.isPending && setStatus.variables === "no_asistio"}
                    onClick={() => setStatus.mutate("no_asistio")}
                  >
                    No asistió
                  </SubmitButton>
                </div>
              ) : null}
              {canWrite && (appointment.status === "no_asistio" || appointment.status === "cancelada") ? (
                <Button
                  variant="outline"
                  className="h-11 bg-card"
                  onClick={() =>
                    onRebook({ id: appointment.patientId, name: appointment.patientName })
                  }
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
              {canWrite && active ? (
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
              {active ? (
                <NewEncounterButton
                  patientId={appointment.patientId}
                  appointment={{
                    id: appointment.id,
                    dentistUserId: appointment.dentistUserId,
                    reason: appointment.reason,
                    serviceName: appointment.serviceName,
                  }}
                />
              ) : null}
            </div>
          </div>
        )}
      </DetailDrawer>

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
