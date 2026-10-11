import {
  Button,
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
  DatePickerButton,
  FormDrawer,
  formatDateLong,
  minutesToInstant,
  ScheduleResourceChips,
  scheduleToneAt,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"
import * as React from "react"
import type { AgendaAppointment } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { ChoiceSelect } from "../ui/choice-select"
import { errorMessage, shortName } from "./shared"

type ReasonId = "vacaciones" | "permiso" | "feriado" | "otro"

/** Motivos habituales; el tipo es el que guarda la agenda (ausencia de alguien o cierre). */
const REASONS: Array<{ id: ReasonId; label: string; kind: "ausencia" | "bloqueo" }> = [
  { id: "vacaciones", label: "Vacaciones", kind: "ausencia" },
  { id: "permiso", label: "Permiso", kind: "ausencia" },
  { id: "feriado", label: "Feriado", kind: "bloqueo" },
  { id: "otro", label: "Otro", kind: "bloqueo" },
]

function toMinutes(label: string): number {
  const [hours = 0, minutes = 0] = label.split(":").map(Number)
  return hours * 60 + minutes
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
 * Días en que no se atiende: vacaciones, un permiso, un feriado o un cierre.
 * Va de una fecha a otra en un solo paso y avisa de las citas que quedan
 * dentro, que no se cancelan solas.
 */
export function AbsenceForm({
  branchId,
  timeZone,
  today,
  professionals,
  chairs,
  onClose,
  onSaved,
}: {
  branchId: string
  timeZone: string
  today: string
  professionals: { id: string; label: string }[]
  chairs: { id: string; label: string }[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [who, setWho] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState<ReasonId>("vacaciones")
  const [other, setOther] = React.useState("")
  const [from, setFrom] = React.useState(today)
  const [to, setTo] = React.useState(today)
  const [allDay, setAllDay] = React.useState(true)
  const [fromTime, setFromTime] = React.useState("12:00")
  const [toTime, setToTime] = React.useState("14:00")
  const [chairId, setChairId] = React.useState("")
  const [error, setError] = React.useState("")
  const whoId = React.useId()
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
    queryKey: ["agenda", "ausencia", branchId, who, chairId, startsAt, endsAt],
    enabled: valid,
    queryFn: () => {
      const params = new URLSearchParams({
        branchId,
        from: startsAt,
        to: endsAt,
        status: "programada,confirmada",
      })
      if (who) params.set("professionals", who)
      if (chairId) params.set("chairs", chairId)
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
  })
  const affected = (affectedQuery.data?.data ?? []).filter(
    (item) =>
      Date.parse(item.endsAt) > Date.parse(startsAt) &&
      Date.parse(item.startsAt) < Date.parse(endsAt),
  )
  const firstAffected = affected[0]

  const chosen = REASONS.find((item) => item.id === reason) ?? REASONS[0]
  const save = useMutation({
    mutationFn: () => {
      if (!valid) throw new Error("El fin debe ser posterior al inicio.")
      const text = reason === "otro" ? other.trim() : chosen?.label
      return apiFetch("/api/agenda/blocks", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          dentistUserId: who,
          chairId: chairId || null,
          kind: chosen?.kind ?? "bloqueo",
          reason: text || undefined,
          startsAt,
          endsAt,
        }),
      })
    },
    onSuccess: async () => {
      toast.success("Ausencia guardada")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })

  return (
    <FormDrawer
      open
      title="Nueva ausencia"
      description="Días u horas en que no se atiende. Esos huecos dejan de ofrecerse."
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
      submitLabel="Guardar ausencia"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <span id={whoId} className="text-sm font-medium">
            Quién no atiende
          </span>
          <ScheduleResourceChips
            wrap
            label="Quién no atiende"
            resources={professionals.map((item, index) => ({
              id: item.id,
              label: item.label,
              tone: scheduleToneAt(index),
            }))}
            formatLabel={(item) => shortName(item.label)}
            value={who}
            allLabel="Toda la sede"
            onChange={setWho}
          />
        </div>

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
            {REASONS.map((option) => (
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
              aria-label="Motivo de la ausencia"
              placeholder="Capacitación, mantenimiento…"
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
                <Input
                  id="ausencia-inicio"
                  type="time"
                  required
                  value={fromTime}
                  onChange={(event) => setFromTime(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="ausencia-fin">Hasta las</FieldLabel>
                <Input
                  id="ausencia-fin"
                  type="time"
                  required
                  value={toTime}
                  onChange={(event) => setToTime(event.target.value)}
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

        {chairs.length > 0 ? (
          <div className="grid gap-2">
            <FieldLabel htmlFor="ausencia-sillon">Sillón (opcional)</FieldLabel>
            <ChoiceSelect
              id="ausencia-sillon"
              value={chairId}
              onChange={(event) => setChairId(event.target.value)}
            >
              <option value="">Todos los sillones</option>
              {chairs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </ChoiceSelect>
          </div>
        ) : null}

        {firstAffected ? (
          <div role="status" className="grid gap-2.5 rounded-2xl bg-warning-soft p-3.5">
            <span className="flex items-center gap-1.5 text-sm font-bold text-warning-foreground">
              <TriangleAlert aria-hidden className="size-4" />
              {affected.length === 1
                ? "1 cita queda dentro de la ausencia"
                : `${affected.length} citas quedan dentro de la ausencia`}
            </span>
            <span className="text-sm">
              {namesSaid([...new Set(affected.map((item) => item.patientName))])}. No se cancelan
              solas: hay que moverlas.
            </span>
            <Button
              variant="outline"
              className="justify-self-start bg-card"
              render={
                <Link
                  to="/agenda"
                  target="_blank"
                  search={{
                    view: "lista",
                    date: zonedDateOf(firstAffected.startsAt, timeZone),
                    who: who ?? undefined,
                    branch: branchId,
                  }}
                />
              }
            >
              Ver y reprogramar
            </Button>
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}
