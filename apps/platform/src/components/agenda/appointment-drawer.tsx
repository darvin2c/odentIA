import { Button, Checkbox, cn, FieldLabel, Input, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  DetailField,
  DetailList,
  ResourceSelect,
  SCHEDULE_AGENDA_LABELS,
  type ScheduleColumn,
  ScheduleResourceChips,
  ScheduleSlotChoices,
  StatusIcon,
  statusSurfaceClass,
  statusTextClass,
  timeRangeLabel,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check } from "lucide-react"
import * as React from "react"
import type {
  AgendaAppointment,
  AgendaResources,
  AgendaServiceOption,
  AppointmentStatus,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { NewEncounterButton } from "../patient/new-encounter-button"
import { errorMessage, rangeSaid, shortName, useAgendaSlots, whenSaid } from "./shared"

export type AppointmentDrawerMode = "view" | "move" | "cancel"

type CancelReason = "paciente" | "clinica" | "otro"
const CANCEL_REASONS: Array<{ id: CancelReason; label: string }> = [
  { id: "paciente", label: "Lo pidió el paciente" },
  { id: "clinica", label: "Lo pidió la clínica" },
  { id: "otro", label: "Otro motivo" },
]

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
  team,
  waiting,
  onClose,
  onChanged,
  onRebook,
  onOfferWaitlist,
}: {
  appointment: AgendaAppointment
  initialMode?: AppointmentDrawerMode
  canWrite: boolean
  timeZone: string
  today: string
  now: string
  resources: AgendaResources
  team: ScheduleColumn[]
  /** Personas en la lista de espera de la sede. */
  waiting: number
  onClose: () => void
  onChanged: () => Promise<void>
  /** Reagendar a quien canceló o no vino: abre «Nueva cita» con la persona. */
  onRebook: (patient: { id: string; name: string }) => void
  /** Tras cancelar, abrir la lista de espera para ofrecer el hueco liberado. */
  onOfferWaitlist: () => void
}) {
  const [mode, setMode] = React.useState<AppointmentDrawerMode | "edit">(initialMode)
  const [error, setError] = React.useState("")
  const active = appointment.status === "programada" || appointment.status === "confirmada"
  const started = Date.parse(appointment.startsAt) <= Date.parse(now)

  // ----- Cancelar -----
  const [cancelReason, setCancelReason] = React.useState<CancelReason>("paciente")
  const [cancelNote, setCancelNote] = React.useState("")
  const [offerSlot, setOfferSlot] = React.useState(false)
  const offerId = React.useId()

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
      toast.success(STATUS_DONE[result.data.status])
      setError("")
      await onChanged()
      if (result.data.status === "cancelada") {
        onClose()
        if (offerSlot) onOfferWaitlist()
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
  const [moveDentist, setMoveDentist] = React.useState<string>(appointment.dentistUserId)
  const appointmentDate = zonedDateOf(appointment.startsAt, timeZone)
  const [chosen, setChosen] = React.useState<string | null>(null)
  const slots = useAgendaSlots({
    branchId: appointment.branchId,
    timeZone,
    fromDate: appointmentDate > today ? appointmentDate : today,
    dentistUserId: moveDentist,
    durationMin: Math.round(
      (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60000,
    ),
    enabled: mode === "move",
  })
  const slot = slots.slotOf(chosen)
  const move = useMutation({
    mutationFn: () => {
      if (!slot?.chairId) throw new Error("Elige un hueco.")
      return apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointment.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: appointment.version,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          dentistUserId: slot.dentistUserId,
          chairId: slot.chairId,
        }),
      })
    },
    onSuccess: async (result) => {
      toast.success(
        `Cita de ${result.data.patientName} movida ${whenSaid(result.data.startsAt, timeZone, today)}`,
      )
      setError("")
      setChosen(null)
      setMode("view")
      await onChanged()
    },
    onError: async (cause) => {
      setError(errorMessage(cause))
      setChosen(null)
      slots.refetch()
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
        <Button disabled={!slot || move.isPending} onClick={() => move.mutate()}>
          Mover cita
        </Button>
      </>
    ) : mode === "edit" ? (
      <>
        <Button variant="outline" onClick={back}>
          Volver
        </Button>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Guardar cambios
        </Button>
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
            <div className="grid gap-2">
              <span className="text-sm font-medium">Profesional</span>
              <ScheduleResourceChips
                wrap
                label="Profesional"
                resources={team}
                formatLabel={(item) => shortName(item.label)}
                value={moveDentist}
                onChange={(next) => {
                  if (!next) return
                  setMoveDentist(next)
                  setChosen(null)
                }}
              />
            </div>
            <ScheduleSlotChoices
              label="Próximos huecos"
              slots={slots.choices}
              timeZone={timeZone}
              today={today}
              loading={slots.isLoading}
              value={chosen}
              onChange={(choice) => setChosen(choice.id)}
            />
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
                <Button
                  className="h-11"
                  disabled={busy}
                  onClick={() => setStatus.mutate("confirmada")}
                >
                  <Check aria-hidden />
                  Confirmar cita
                </Button>
              ) : null}
              {canWrite && active && started ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    className="h-11"
                    disabled={busy}
                    onClick={() => setStatus.mutate("atendida")}
                  >
                    <Check aria-hidden />
                    Atendida
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 bg-card"
                    disabled={busy}
                    onClick={() => setStatus.mutate("no_asistio")}
                  >
                    No asistió
                  </Button>
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
              <DetailField label="Servicio">{appointment.serviceName ?? "Sin servicio"}</DetailField>
              <DetailField label="Profesional">{appointment.dentistName}</DetailField>
              <DetailField label="Sillón">{appointment.chairName}</DetailField>
              {appointment.reason ? (
                <DetailField label="Motivo">{appointment.reason}</DetailField>
              ) : null}
            </DetailList>

            <div className="grid gap-2">
              {canWrite && active ? (
                <Button variant="outline" className="h-11" onClick={() => setMode("move")}>
                  Reprogramar
                </Button>
              ) : null}
              {/* De la cita a la persona: la ficha conserva el contexto de quien se atiende. */}
              <Button
                variant="outline"
                className="h-11"
                render={
                  <Link to="/patients/$patientId" params={{ patientId: appointment.patientId }} />
                }
              >
                Abrir la ficha de {appointment.patientName.split(/\s+/)[0]}
              </Button>
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
          <fieldset className="grid gap-2 border-0 p-0">
            <legend className="mb-1.5 p-0 text-sm font-medium">Motivo</legend>
            {CANCEL_REASONS.map((option) => (
              <label
                key={option.id}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-sm",
                  cancelReason === option.id && "border-primary bg-primary-soft",
                )}
              >
                <input
                  type="radio"
                  name="cita-cancelar-motivo"
                  className="size-4 accent-primary"
                  checked={cancelReason === option.id}
                  onChange={() => setCancelReason(option.id)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <Input
            aria-label="Nota, si hace falta"
            placeholder="Nota, si hace falta"
            maxLength={500}
            value={cancelNote}
            onChange={(event) => setCancelNote(event.target.value)}
          />
          {waiting > 0 ? (
            <label htmlFor={offerId} className="flex cursor-pointer items-start gap-2.5 text-sm">
              <Checkbox
                id={offerId}
                className="mt-0.5"
                checked={offerSlot}
                onCheckedChange={(checked) => setOfferSlot(checked === true)}
              />
              <span className="grid">
                Ofrecer el hueco a la lista de espera
                <span className="text-xs text-muted-foreground">
                  {waiting === 1
                    ? "1 persona espera hueco en esta sede."
                    : `${waiting} personas esperan hueco en esta sede.`}
                </span>
              </span>
            </label>
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  )
}
