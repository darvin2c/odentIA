import {
  buttonVariants,
  Checkbox,
  cn,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import {
  addDays,
  clockValue,
  DatePickerButton,
  FormDrawer,
  formatDateLong,
  minutesToInstant,
  TimeSelect,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"
import * as React from "react"
import type { AgendaAppointment } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { ChoiceSelect } from "../ui/choice-select"
import { errorMessage } from "./shared"

type ReasonId = "vacaciones" | "permiso" | "feriado" | "cierre" | "otro"
type Reason = { id: ReasonId; label: string; kind: "ausencia" | "bloqueo" }

/** Motivos habituales de una persona; el tipo es el que guarda la agenda. */
const PERSON_REASONS: Reason[] = [
  { id: "vacaciones", label: "Vacaciones", kind: "ausencia" },
  { id: "permiso", label: "Permiso", kind: "ausencia" },
  { id: "otro", label: "Otro", kind: "ausencia" },
]
/** Motivos habituales de la sede entera o de una unidad dental. */
const BRANCH_REASONS: Reason[] = [
  { id: "feriado", label: "Feriado", kind: "bloqueo" },
  { id: "cierre", label: "Cierre", kind: "bloqueo" },
  { id: "otro", label: "Otro", kind: "bloqueo" },
]

/** De quién es: de un profesional (vacaciones, permisos) o de la sede (feriados, cierres). */
export type AbsenceScope =
  | { kind: "person"; professionalUserId: string; name: string }
  | { kind: "branch"; name: string }

function toMinutes(label: string): number {
  const [hours = 0, minutes = 0] = label.split(":").map(Number)
  return hours * 60 + minutes
}

/** «12:00» + 60 → «13:00», sin pasar de las 23:45 (la última hora de la lista). */
function addMinutes(label: string, add: number): string {
  return clockValue(Math.min(toMinutes(label) + add, 23 * 60 + 45))
}

/** «Ana, Luis y Marta» o «Ana, Luis, Marta y 2 más». */
function namesSaid(names: string[]): string {
  const shown = names.slice(0, 3)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(", ")} y ${rest} más`
  if (shown.length <= 1) return shown.join("")
  return `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}`
}

/**
 * Días en que no se atiende: las vacaciones o el permiso de un profesional, o
 * un feriado o cierre de la sede. Va de una fecha a otra en un solo paso y
 * avisa de las citas que quedan dentro, que no se cancelan solas.
 */
export function AbsenceForm({
  branchId,
  timeZone,
  today,
  scope,
  rooms,
  onClose,
  onSaved,
}: {
  branchId: string
  timeZone: string
  today: string
  scope: AbsenceScope
  /** Unidades dentales de la sede: un cierre puede ser de una sola (mantenimiento). */
  rooms: { id: string; label: string }[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const person = scope.kind === "person"
  const who = person ? scope.professionalUserId : null
  const reasons = person ? PERSON_REASONS : BRANCH_REASONS
  const [reason, setReason] = React.useState<ReasonId>(reasons[0]?.id ?? "otro")
  const [other, setOther] = React.useState("")
  const [from, setFrom] = React.useState(today)
  const [to, setTo] = React.useState(today)
  const [allDay, setAllDay] = React.useState(true)
  const [fromTime, setFromTime] = React.useState("12:00")
  const [toTime, setToTime] = React.useState("14:00")
  const [roomId, setRoomId] = React.useState("")
  const [error, setError] = React.useState("")
  const reasonId = React.useId()
  const allDayId = React.useId()

  const lastDay = allDay && to >= from ? to : from
  const startsAt = minutesToInstant(from, allDay ? 0 : toMinutes(fromTime), timeZone)
  const endsAt = allDay
    ? minutesToInstant(addDays(lastDay, 1), 0, timeZone)
    : minutesToInstant(from, toMinutes(toTime), timeZone)
  const valid = Date.parse(endsAt) > Date.parse(startsAt)

  // Citas en pie que quedan dentro: se avisa antes de guardar.
  const affectedQuery = useQuery({
    queryKey: ["agenda", "ausencia", branchId, who, roomId, startsAt, endsAt],
    enabled: valid,
    queryFn: () => {
      const params = new URLSearchParams({
        branchId,
        from: startsAt,
        to: endsAt,
        status: "programada,confirmada",
      })
      if (who) params.set("professionals", who)
      if (roomId) params.set("rooms", roomId)
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
  })
  const affected = (affectedQuery.data?.data ?? []).filter(
    (item) =>
      Date.parse(item.endsAt) > Date.parse(startsAt) &&
      Date.parse(item.startsAt) < Date.parse(endsAt),
  )
  const firstAffected = affected[0]

  const chosen = reasons.find((item) => item.id === reason) ?? reasons[0]
  const save = useMutation({
    mutationFn: () => {
      if (!valid) throw new Error("El fin debe ser posterior al inicio.")
      const text = reason === "otro" ? other.trim() : chosen?.label
      return apiFetch("/api/agenda/blocks", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          professionalUserId: who,
          roomId: roomId || null,
          kind: chosen?.kind ?? "bloqueo",
          reason: text || undefined,
          startsAt,
          endsAt,
        }),
      })
    },
    onSuccess: async () => {
      toast.success(person ? "Ausencia guardada" : "Feriado o cierre guardado")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })

  return (
    <FormDrawer
      open
      title={person ? "Nueva ausencia" : "Nuevo feriado o cierre"}
      description={
        person
          ? `Días u horas en que ${scope.name} no atiende. Esos huecos dejan de ofrecerse.`
          : `Días u horas en que ${scope.name} no atiende. Vale para todos los profesionales.`
      }
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty
      error={error || null}
      submitDisabled={!valid}
      submitLabel={person ? "Guardar ausencia" : "Guardar"}
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <span id={reasonId} className="text-sm font-medium">
            Motivo
          </span>
          <RadioGroup
            aria-labelledby={reasonId}
            className="flex flex-wrap gap-2"
            value={reason}
            onValueChange={(next) => setReason(next as ReasonId)}
          >
            {reasons.map((option) => (
              <FieldLabel
                key={option.id}
                className={cn(
                  "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
                  reason === option.id && "border-primary bg-primary-soft",
                )}
              >
                <RadioGroupItem value={option.id} />
                {option.label}
              </FieldLabel>
            ))}
          </RadioGroup>
          {reason === "otro" ? (
            <Input
              aria-label="Motivo"
              placeholder={person ? "Capacitación, congreso…" : "Mantenimiento, inventario…"}
              maxLength={500}
              value={other}
              onChange={(event) => setOther(event.target.value)}
            />
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className={cn("grid gap-2", !allDay && "col-span-2")}>
            <FieldLabel htmlFor="ausencia-desde">{allDay ? "Desde" : "Día"}</FieldLabel>
            <DatePickerButton
              id="ausencia-desde"
              className="justify-start font-normal"
              value={from}
              onChange={(next) => {
                setFrom(next)
                if (to < next) setTo(next)
              }}
            >
              {formatDateLong(from)}
            </DatePickerButton>
          </div>
          {allDay ? (
            <div className="grid gap-2">
              <FieldLabel htmlFor="ausencia-hasta">Hasta</FieldLabel>
              <DatePickerButton
                id="ausencia-hasta"
                className="justify-start font-normal"
                min={from}
                align="end"
                value={lastDay}
                onChange={setTo}
              >
                {formatDateLong(lastDay)}
              </DatePickerButton>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <FieldLabel htmlFor="ausencia-inicio">Desde las</FieldLabel>
                <TimeSelect
                  id="ausencia-inicio"
                  className="w-full"
                  value={fromTime}
                  onChange={(next) => {
                    setFromTime(next)
                    if (toMinutes(toTime) <= toMinutes(next)) setToTime(addMinutes(next, 60))
                  }}
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="ausencia-fin">Hasta las</FieldLabel>
                <TimeSelect
                  id="ausencia-fin"
                  className="w-full"
                  min={addMinutes(fromTime, 15)}
                  value={toTime}
                  onChange={setToTime}
                />
              </div>
            </>
          )}
        </div>

        <FieldLabel htmlFor={allDayId} className="flex cursor-pointer items-center gap-2.5 font-normal">
          <Checkbox
            id={allDayId}
            checked={allDay}
            onCheckedChange={(checked) => setAllDay(checked === true)}
          />
          Todo el día
        </FieldLabel>

        {!person && rooms.length > 0 ? (
          <div className="grid gap-2">
            <FieldLabel htmlFor="ausencia-sillon">Qué se cierra</FieldLabel>
            <ChoiceSelect
              id="ausencia-sillon"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <option value="">Toda la sede</option>
              {rooms.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </ChoiceSelect>
          </div>
        ) : null}

        {firstAffected ? (
          <div role="status" className="grid gap-2.5 rounded-2xl bg-warning-soft p-3.5">
            <span className="flex items-center gap-1.5 text-sm font-bold text-warning">
              <TriangleAlert aria-hidden className="size-4" />
              {affected.length === 1
                ? `1 cita queda dentro ${person ? "de la ausencia" : "del cierre"}`
                : `${affected.length} citas quedan dentro ${person ? "de la ausencia" : "del cierre"}`}
            </span>
            <span className="text-sm">
              {namesSaid([...new Set(affected.map((item) => item.patientName))])}. No se cancelan
              solas: hay que moverlas.
            </span>
            <Link
              to="/agenda"
              target="_blank"
              search={{
                view: "lista",
                date: zonedDateOf(firstAffected.startsAt, timeZone),
                who: who ?? undefined,
                branch: branchId,
              }}
              className={cn(buttonVariants({ variant: "outline" }), "justify-self-start bg-card")}
            >
              Ver y reprogramar
            </Link>
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}
