import {
  buttonVariants,
  cn,
  FieldLabel,
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
  hourLabel,
  minutesToInstant,
  TimeSelect,
  useAppForm,
  useFormSurface,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"
import { z } from "zod"
import type { AgendaAppointment } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { ChoiceSelect } from "../ui/choice-select"

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

/** La última hora de la lista: un inicio a esa hora no deja fin ese día. */
const LAST_START = 23 * 60 + 45

/** «12:00» + 60 → «13:00», sin pasar de las 23:45 (la última hora de la lista). */
function addMinutes(label: string, add: number): string {
  return clockValue(Math.min(toMinutes(label) + add, LAST_START))
}

/** «Ana, Luis y Marta» o «Ana, Luis, Marta y 2 más». */
function namesSaid(names: string[]): string {
  const shown = names.slice(0, 3)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(", ")} y ${rest} más`
  if (shown.length <= 1) return shown.join("")
  return `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}`
}

const absenceSchema = z
  .object({
    reason: z.enum(["vacaciones", "permiso", "feriado", "cierre", "otro"]),
    other: z.string().max(500, "Escribe el motivo en 500 caracteres como mucho."),
    from: z.string(),
    to: z.string(),
    allDay: z.boolean(),
    fromTime: z.string(),
    toTime: z.string(),
    roomId: z.string(),
  })
  .superRefine((value, ctx) => {
    // Con horas, el fin es del mismo día: tiene que ser después del inicio.
    if (!value.allDay && toMinutes(value.toTime) <= toMinutes(value.fromTime)) {
      const start = hourLabel(toMinutes(value.fromTime))
      ctx.addIssue({
        code: "custom",
        path: ["toTime"],
        // Desde las 23:45 la lista ya no tiene una hora después.
        message:
          toMinutes(value.fromTime) >= LAST_START
            ? `Después de las ${start} no queda hora ese día: adelanta «Desde las» o marca «Todo el día».`
            : `Elige una hora después de las ${start}.`,
      })
    }
  })

type AbsenceValues = z.input<typeof absenceSchema>

/** El tramo que se cierra: de todo el día o de una hora a otra el mismo día. */
function rangeOf(value: AbsenceValues, timeZone: string) {
  const lastDay = value.allDay && value.to >= value.from ? value.to : value.from
  const startsAt = minutesToInstant(value.from, value.allDay ? 0 : toMinutes(value.fromTime), timeZone)
  const endsAt = value.allDay
    ? minutesToInstant(addDays(lastDay, 1), 0, timeZone)
    : minutesToInstant(value.from, toMinutes(value.toTime), timeZone)
  return { lastDay, startsAt, endsAt }
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

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/agenda/blocks", { method: "POST", body: JSON.stringify(body) }),
  })
  const form = useAppForm({
    defaultValues: {
      reason: reasons[0]?.id ?? "otro",
      other: "",
      from: today,
      to: today,
      allDay: true,
      fromTime: "12:00",
      toTime: "14:00",
      roomId: "",
    } as AbsenceValues,
    validators: { onSubmit: absenceSchema },
    onSubmit: async ({ value }) => {
      const chosen = reasons.find((item) => item.id === value.reason) ?? reasons[0]
      const text = value.reason === "otro" ? value.other.trim() : chosen?.label
      const { startsAt, endsAt } = rangeOf(value, timeZone)
      await save.mutateAsync({
        branchId,
        professionalUserId: who,
        roomId: value.roomId || null,
        kind: chosen?.kind ?? "bloqueo",
        reason: text || undefined,
        startsAt,
        endsAt,
      })
      toast.success(person ? "Ausencia guardada" : "Feriado o cierre guardado")
      await onSaved()
    },
  })
  const surface = useFormSurface(form, {
    // El inicio y el fin van en el cuerpo como instantes: se dicen en el campo que los fija.
    fieldMap: (field) => {
      const allDay = form.state.values.allDay
      if (field === "startsAt") return allDay ? "from" : "fromTime"
      if (field === "endsAt") return allDay ? "to" : "toTime"
      if (field === "reason") return "other"
      return undefined
    },
  })
  const values = useStore(form.store, (state) => state.values)
  const { lastDay, startsAt, endsAt } = rangeOf(values, timeZone)
  const valid = Date.parse(endsAt) > Date.parse(startsAt)

  // Citas en pie que quedan dentro: se avisa antes de guardar.
  const affectedQuery = useQuery({
    queryKey: ["agenda", "ausencia", branchId, who, values.roomId, startsAt, endsAt],
    enabled: valid,
    queryFn: () => {
      const params = new URLSearchParams({
        branchId,
        from: startsAt,
        to: endsAt,
        status: "programada,confirmada",
      })
      if (who) params.set("professionals", who)
      if (values.roomId) params.set("rooms", values.roomId)
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
  })
  const affected = (affectedQuery.data?.data ?? []).filter(
    (item) =>
      Date.parse(item.endsAt) > Date.parse(startsAt) &&
      Date.parse(item.startsAt) < Date.parse(endsAt),
  )
  const firstAffected = affected[0]

  return (
    <FormDrawer
      {...surface}
      open
      title={person ? "Nueva ausencia" : "Nuevo feriado o cierre"}
      description={
        person
          ? `Días u horas en que ${scope.name} no atiende. Esos huecos dejan de ofrecerse.`
          : `Días u horas en que ${scope.name} no atiende. Vale para todos los profesionales.`
      }
      onClose={onClose}
      submitLabel={person ? "Guardar ausencia" : "Guardar"}
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <form.AppField name="reason">
            {(field) => (
              <field.Group legend="Motivo">
                {(control) => (
                  <RadioGroup
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    className="flex flex-wrap gap-2"
                    value={field.state.value}
                    onValueChange={(next) => {
                      field.handleChange(next as ReasonId)
                      field.handleBlur()
                    }}
                  >
                    {reasons.map((option) => (
                      <FieldLabel
                        key={option.id}
                        className={cn(
                          "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
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
          </form.AppField>
          {values.reason === "otro" ? (
            <form.AppField name="other">
              {(field) => (
                <field.TextField
                  label="Motivo"
                  hideLabel
                  placeholder={person ? "Capacitación, congreso…" : "Mantenimiento, inventario…"}
                  maxLength={500}
                />
              )}
            </form.AppField>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <form.AppField
            name="from"
            listeners={{
              onChange: ({ value }) => {
                if (form.getFieldValue("to") < value) form.setFieldValue("to", value)
              },
            }}
          >
            {(field) => (
              <field.Control
                label={values.allDay ? "Desde" : "Día"}
                id="ausencia-desde"
                className={cn(!values.allDay && "col-span-2")}
              >
                {(control) => (
                  <DatePickerButton
                    id={control.id}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    className="justify-start font-normal"
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      field.handleBlur()
                    }}
                  >
                    {formatDateLong(field.state.value)}
                  </DatePickerButton>
                )}
              </field.Control>
            )}
          </form.AppField>
          {values.allDay ? (
            <form.AppField name="to">
              {(field) => (
                <field.Control label="Hasta" id="ausencia-hasta">
                  {(control) => (
                    <DatePickerButton
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      className="justify-start font-normal"
                      min={values.from}
                      align="end"
                      value={lastDay}
                      onChange={(next) => {
                        field.handleChange(next)
                        field.handleBlur()
                      }}
                    >
                      {formatDateLong(lastDay)}
                    </DatePickerButton>
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : (
            <>
              <form.AppField
                name="fromTime"
                listeners={{
                  onChange: ({ value }) => {
                    // El fin acompaña al inicio; a las 23:45 no queda hueco y lo dice «Hasta las».
                    if (toMinutes(form.getFieldValue("toTime")) <= toMinutes(value)) {
                      form.setFieldValue("toTime", addMinutes(value, 60))
                    }
                  },
                }}
              >
                {(field) => (
                  <field.Control label="Desde las" id="ausencia-inicio">
                    {(control) => (
                      <TimeSelect
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        className="w-full"
                        value={field.state.value}
                        onChange={(next) => {
                          field.handleChange(next)
                          field.handleBlur()
                        }}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
              <form.AppField name="toTime">
                {(field) => (
                  <field.Control label="Hasta las" id="ausencia-fin">
                    {(control) => (
                      <TimeSelect
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        className="w-full"
                        min={addMinutes(values.fromTime, 15)}
                        value={field.state.value}
                        onChange={(next) => {
                          field.handleChange(next)
                          field.handleBlur()
                        }}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </>
          )}
        </div>

        <form.AppField name="allDay">{(field) => <field.CheckboxField label="Todo el día" />}</form.AppField>

        {!person && rooms.length > 0 ? (
          <form.AppField name="roomId">
            {(field) => (
              <field.Control label="Qué se cierra" id="ausencia-sillon">
                {(control) => (
                  <ChoiceSelect
                    id={control.id}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onChange={(event) => {
                      field.handleChange(event.target.value)
                      field.handleBlur()
                    }}
                  >
                    <option value="">Toda la sede</option>
                    {rooms.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
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
