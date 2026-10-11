import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FieldLabel,
  Input,
  toast,
} from "@odentia/ui"
import {
  addDays,
  DatePickerButton,
  dayMinutesIn,
  dayRangeOf,
  FormDrawer,
  formatDateLong,
  formatSpan,
  hourLabel,
  minutesToInstant,
  normalizeCountry,
  PhoneInput,
  ResourceSelect,
  type ResourceSelectOption,
  type ScheduleAvailability,
  type ScheduleColumn,
  ScheduleDayStrip,
  type SchedulePreview,
  ScheduleRangePicker,
  type ScheduleRangeValue,
  ScheduleResourceChips,
  scheduleRangeState,
  weekDates,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CalendarDays, ChevronDown } from "lucide-react"
import * as React from "react"
import type { AgendaAppointment, AgendaAvailability, AgendaServiceOption } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { errorMessage, rangeSaid, shortName, whenSaid } from "./shared"

/** Con qué se abre «Nueva cita»: nada, un hueco tocado en la rejilla o un paciente. */
export interface BookingSeed {
  patient?: { id: string; name: string }
  /** El paciente viene de un caso o de su ficha: no se cambia aquí. */
  lockedPatient?: boolean
  conversationId?: string
  dentistUserId?: string | null
  /** Instante del hueco ya elegido. */
  startsAt?: string
  /** Día en que se abre el selector. */
  date?: string
}

/** El bloque se mueve de cuarto en cuarto de hora, como en la rejilla. */
const SNAP_MS = 15 * 60000

/** Duraciones que ofrece el menú, la vía para cambiarla sin arrastrar. */
const DURATIONS = [15, 30, 45, 60, 90, 120]

const minutesBetween = (start: string, end: string) =>
  Math.round((Date.parse(end) - Date.parse(start)) / 60000)

/**
 * Nueva cita: a quién y cuándo. El «cuándo» se elige sobre las horas del día:
 * lo blanco está libre, y el bloque se arrastra y se estira. El sillón lo pone
 * la agenda. Quien aún no es paciente se registra aquí mismo con lo mínimo.
 */
export function BookingDrawer({
  seed,
  branchId,
  timeZone,
  today,
  now,
  defaultMinutes,
  toneOf,
  onPreview,
  onClose,
  onSaved,
}: {
  seed: BookingSeed
  branchId: string
  timeZone: string
  today: string
  now: string
  /** Lo que dura una cita regular en la sede (sin servicio). */
  defaultMinutes: number
  toneOf: (id: string) => ScheduleColumn["tone"]
  /** La rejilla de la agenda deja ver lo elegido antes de reservar. */
  onPreview: (preview: SchedulePreview | null) => void
  onClose: () => void
  onSaved: (appointment: AgendaAppointment) => Promise<void>
}) {
  // ----- A quién -----
  const [patientId, setPatientId] = React.useState(seed.patient?.id ?? "")
  const [patientQuery, setPatientQuery] = React.useState("")
  const [registering, setRegistering] = React.useState(false)
  const [newPatient, setNewPatient] = React.useState({ givenNames: "", surname: "" })
  const [newPhone, setNewPhone] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<{ id: string; name: string } | null>(null)
  const submissionId = React.useRef(crypto.randomUUID())
  const queryClient = useQueryClient()
  // Registrar a alguien pide su propio permiso: sin él solo se elige entre quienes ya existen.
  const canRegister = usePermission("patients.write")
  const [registerFailed, setRegisterFailed] = React.useState(false)
  const profile = useOrgProfile()

  const patientsQuery = useQuery({
    queryKey: ["patients", "agenda-picker", patientQuery],
    enabled: !seed.lockedPatient,
    queryFn: () =>
      apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients?q=${encodeURIComponent(patientQuery)}&limit=20`,
      ),
    placeholderData: (previous) => previous,
  })
  const patientOptions = React.useMemo((): ResourceSelectOption[] => {
    const options = (patientsQuery.data?.data ?? []).map((patient) => ({
      id: patient.id,
      label: patient.displayName,
    }))
    // Quien abrió el formulario, se eligió o se acaba de registrar se conserva aunque la búsqueda no lo devuelva.
    for (const known of [seed.patient, created]) {
      if (known && !options.some((option) => option.id === known.id)) {
        options.unshift({ id: known.id, label: known.name })
      }
    }
    return options
  }, [patientsQuery.data, seed.patient, created])
  const newName = `${newPatient.givenNames.trim()} ${newPatient.surname.trim()}`.trim()
  const patientName = registering
    ? newName || undefined
    : patientOptions.find((option) => option.id === patientId)?.label

  // Antes de registrar a alguien, se mira si ya existe con ese nombre o teléfono.
  const duplicatesQuery = useQuery({
    queryKey: ["patients", "duplicates", newName, newPhone],
    enabled: registering && newName.length >= 3,
    queryFn: () => {
      const params = new URLSearchParams({ displayName: newName })
      if (newPhone) params.set("phone", newPhone)
      return apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients/duplicates?${params}`,
      )
    },
  })
  const duplicates = registering ? (duplicatesQuery.data?.data ?? []) : []

  // ----- Qué -----
  const [serviceId, setServiceId] = React.useState("")
  const [reason, setReason] = React.useState("")
  const servicesQuery = useQuery({
    queryKey: ["services", "agenda-picker"],
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
  })
  const service = (servicesQuery.data?.data ?? []).find((item) => item.id === serviceId)
  const duration = service?.durationMin ?? defaultMinutes

  // ----- Cuándo -----
  const [dentistFilter, setDentistFilter] = React.useState<string | null>(
    seed.dentistUserId ?? null,
  )
  const [date, setDate] = React.useState(seed.date && seed.date > today ? seed.date : today)
  const [value, setValue] = React.useState<ScheduleRangeValue | null>(() =>
    seed.startsAt && seed.dentistUserId
      ? {
          columnId: seed.dentistUserId,
          start: seed.startsAt,
          end: new Date(Date.parse(seed.startsAt) + defaultMinutes * 60000).toISOString(),
        }
      : null,
  )
  const week = React.useMemo(() => weekDates(date), [date])
  const from = minutesToInstant(week[0] ?? date, 0, timeZone)
  const to = minutesToInstant(addDays(week[6] ?? date, 1), 0, timeZone)
  const availabilityQuery = useQuery({
    queryKey: ["agenda-availability", branchId, from, to],
    queryFn: () =>
      apiFetch<{ data: AgendaAvailability }>(
        `/api/agenda/availability?branchId=${branchId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    placeholderData: (previous) => previous,
  })
  const availability = availabilityQuery.data?.data
  const team = React.useMemo(
    (): ScheduleColumn[] =>
      (availability?.professionals ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        tone: toneOf(item.id),
      })),
    [availability, toneOf],
  )
  const lanes = React.useMemo(
    () => (dentistFilter ? team.filter((item) => item.id === dentistFilter) : team),
    [team, dentistFilter],
  )
  const free = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.free ?? []).map((item) => ({
        columnId: item.dentistUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )
  const open = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.open ?? []).map((item) => ({
        columnId: item.dentistUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )

  /** Primer hueco del día donde cabe la cita entre quienes se están viendo; si no cabe entera, el primero que haya. */
  const firstFit = React.useCallback(
    (day: string, columns: ScheduleColumn[], minutes: number): ScheduleRangeValue | null => {
      const ids = new Set(columns.map((item) => item.id))
      const sameDay = free
        .filter((item) => ids.has(item.columnId) && dayRangeOf(item.start, item.end, day, timeZone))
        // Lo libre de hoy empieza «ahora»: el bloque arranca en el siguiente cuarto de hora.
        .map((item) => ({
          columnId: item.columnId,
          start: Math.ceil(Date.parse(item.start) / SNAP_MS) * SNAP_MS,
          end: Date.parse(item.end),
        }))
        .filter((item) => item.end - item.start >= SNAP_MS)
        .sort((a, b) => a.start - b.start)
      const pick = sameDay.find((item) => item.end - item.start >= minutes * 60000) ?? sameDay[0]
      if (!pick) return null
      return {
        columnId: pick.columnId,
        start: new Date(pick.start).toISOString(),
        end: new Date(Math.min(pick.start + minutes * 60000, pick.end)).toISOString(),
      }
    },
    [free, timeZone],
  )
  // Mientras la persona no haya movido el bloque, se propone el primer hueco de lo que mira.
  const touched = React.useRef(Boolean(seed.startsAt && seed.dentistUserId))
  const seedPending = React.useRef(touched.current)
  const autoDate = React.useRef(!touched.current)
  React.useEffect(() => {
    if (!availability) return
    if (seedPending.current) {
      // El hueco tocado en la rejilla puede ser más corto que una cita regular: el bloque toma el hueco.
      seedPending.current = false
      setValue((current) => {
        if (!current) return current
        const room = free.find(
          (item) =>
            item.columnId === current.columnId &&
            item.start <= current.start &&
            item.end > current.start,
        )
        return room && room.end < current.end ? { ...current, end: room.end } : current
      })
      return
    }
    if (touched.current) return
    const fit = firstFit(date, lanes, duration)
    if (!fit && autoDate.current && date === today) {
      // Al abrir, si ese día ya no queda nada, se va al próximo día con hueco.
      autoDate.current = false
      const ids = new Set(lanes.map((item) => item.id))
      const next = availability.professionals
        .flatMap((item) => (ids.has(item.id) && item.nextFree ? [item.nextFree.startsAt] : []))
        .sort()[0]
      const nextDate = next ? zonedDateOf(next, timeZone) : date
      if (nextDate !== date) {
        setDate(nextDate)
        return
      }
    }
    autoDate.current = false
    setValue(fit)
  }, [availability, free, date, lanes, duration, firstFit, timeZone, today])

  const choose = (next: ScheduleRangeValue | null) => {
    touched.current = true
    setValue(next)
  }
  const goToDate = (next: string) => {
    touched.current = false
    setDate(next)
  }
  const setDuration = (minutes: number) => {
    if (!value) return
    choose({
      ...value,
      end: new Date(Date.parse(value.start) + minutes * 60000).toISOString(),
    })
  }
  // El bloque de otro día o de alguien que ya no se mira deja de valer.
  const shown =
    value &&
    zonedDateOf(value.start, timeZone) === date &&
    lanes.some((item) => item.id === value.columnId)
      ? value
      : null
  const state = shown ? scheduleRangeState(shown, { free, open, timeZone }) : null
  const professional = team.find((item) => item.id === shown?.columnId)
  const chosenMinutes = shown ? minutesBetween(shown.start, shown.end) : duration

  React.useEffect(() => {
    onPreview(
      shown
        ? {
            columnId: shown.columnId,
            start: shown.start,
            end: shown.end,
            title: patientName ?? "Nueva cita",
          }
        : null,
    )
  }, [shown, patientName, onPreview])
  React.useEffect(() => () => onPreview(null), [onPreview])

  // ----- Reservar -----
  const [error, setError] = React.useState("")
  const [urgent, setUrgent] = React.useState(false)
  const save = useMutation({
    mutationFn: async (input: { range: ScheduleRangeValue; outsideSchedule?: boolean }) => {
      let id = patientId
      if (registering) {
        if (!newPatient.givenNames.trim() || !newPatient.surname.trim()) {
          throw new Error("Escribe los nombres y los apellidos.")
        }
        // El mismo registro de pacientes de siempre, con lo mínimo: el resto de la ficha se completa después.
        const registered = await apiFetch<{ data: { id: string; displayName: string } }>(
          "/api/patients",
          {
            method: "POST",
            body: JSON.stringify({
              submissionId: submissionId.current,
              registeredBranchId: branchId,
              answers: {
                demographics: {
                  displayName: newName,
                  givenNames: newPatient.givenNames.trim(),
                  paternalSurname: newPatient.surname.trim(),
                  ...(newPhone ? { phone: newPhone } : {}),
                },
                respondent: "staff",
                privacyAccepted: false,
              },
            }),
          },
        ).catch((cause) => {
          // La clínica puede exigir más datos de los que caben aquí: se dice y se ofrece el registro completo.
          setRegisterFailed(true)
          throw new Error(`No se pudo registrar a ${newName}: ${errorMessage(cause)}`)
        })
        id = registered.data.id
        // Las búsquedas de pacientes ya hechas dejaron de valer.
        void queryClient.invalidateQueries({ queryKey: ["patients"] })
        // Si la reserva fallara después, la persona ya está registrada: no se crea dos veces.
        setCreated({ id, name: registered.data.displayName })
        setPatientId(id)
        setRegistering(false)
      }
      if (!id) throw new Error("Elige un paciente.")
      return apiFetch<{ data: AgendaAppointment }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId: id,
          dentistUserId: input.range.columnId,
          serviceId: serviceId || undefined,
          startsAt: input.range.start,
          endsAt: input.range.end,
          reason: reason.trim() || undefined,
          conversationId: seed.conversationId,
          source: seed.conversationId ? "conversacion" : "recepcion",
          outsideSchedule: input.outsideSchedule,
        }),
      })
    },
    onSuccess: async (result) => {
      toast.success(`Cita reservada ${whenSaid(result.data.startsAt, timeZone, today)}`)
      await onSaved(result.data)
    },
    onError: (cause) => {
      setUrgent(false)
      setError(errorMessage(cause))
      // Si alguien tomó el hueco, lo libre se vuelve a pedir.
      void availabilityQuery.refetch()
    },
  })

  const hasPatient = registering
    ? Boolean(newPatient.givenNames.trim() && newPatient.surname.trim())
    : Boolean(patientId)
  const nextFree = availability?.professionals.find((item) => item.id === shown?.columnId)?.nextFree
  const hoursThatDay = shown
    ? open
        .filter((item) => item.columnId === shown.columnId)
        .flatMap((item) => {
          const range = dayRangeOf(item.start, item.end, date, timeZone)
          return range ? [`${hourLabel(range.startMinutes)} a ${hourLabel(range.endMinutes)}`] : []
        })
    : []

  const submitLabel = !shown
    ? "Reservar cita"
    : registering
      ? // El día ya se lee justo encima: el botón tiene que caber junto a «Cancelar».
        `Registrar y reservar a las ${hourLabel(dayMinutesIn(shown.start, timeZone))}`
      : `Reservar ${whenSaid(shown.start, timeZone, today)}`

  return (
    <>
      <FormDrawer
        open
        title="Nueva cita"
        description="Elige a quién y cuándo. El sillón se asigna con el hueco."
        onClose={onClose}
        onSubmit={(event) => {
          event.preventDefault()
          setError("")
          if (!shown) return
          // Fuera del horario no se reserva sin más: se pregunta si es una urgencia.
          if (state === "outside") setUrgent(true)
          else save.mutate({ range: shown })
        }}
        isSubmitting={save.isPending}
        isDirty={Boolean((hasPatient && !seed.lockedPatient) || reason)}
        error={error || null}
        submitDisabled={!hasPatient || !shown || state === "taken"}
        submitLabel={submitLabel}
      >
        <div className="grid gap-4">
          {seed.lockedPatient && seed.patient ? (
            <div>
              <FieldLabel>Paciente del caso</FieldLabel>
              <p className="text-sm font-medium">{seed.patient.name}</p>
            </div>
          ) : registering ? (
            <div className="grid gap-3 rounded-2xl border bg-muted/40 p-3.5">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm font-bold">Paciente nuevo</span>
                <Button variant="ghost" size="sm" onClick={() => setRegistering(false)}>
                  Buscar uno que ya existe
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="cita-nuevo-nombres">Nombres</FieldLabel>
                  <Input
                    id="cita-nuevo-nombres"
                    maxLength={100}
                    value={newPatient.givenNames}
                    onChange={(event) =>
                      setNewPatient((current) => ({ ...current, givenNames: event.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="cita-nuevo-apellidos">Apellidos</FieldLabel>
                  <Input
                    id="cita-nuevo-apellidos"
                    maxLength={100}
                    value={newPatient.surname}
                    onChange={(event) =>
                      setNewPatient((current) => ({ ...current, surname: event.target.value }))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="cita-nuevo-telefono">Teléfono</FieldLabel>
                <PhoneInput
                  id="cita-nuevo-telefono"
                  value={newPhone}
                  defaultCountry={normalizeCountry(profile.data?.countryCode)}
                  onChange={(next) => setNewPhone(next)}
                />
              </div>
              {duplicates.length > 0 ? (
                <div
                  role="status"
                  className="grid gap-1.5 rounded-xl bg-warning-soft p-2.5 text-sm"
                >
                  <span className="font-semibold text-warning-foreground">
                    Puede que ya esté registrada:
                  </span>
                  {duplicates.slice(0, 3).map((match) => (
                    <Button
                      key={match.id}
                      variant="outline"
                      size="sm"
                      className="justify-start bg-card"
                      onClick={() => {
                        setCreated({ id: match.id, name: match.displayName })
                        setPatientId(match.id)
                        setRegistering(false)
                      }}
                    >
                      Usar a {match.displayName}
                    </Button>
                  ))}
                </div>
              ) : null}
              {registerFailed ? (
                <p className="text-sm">
                  Si la clínica pide más datos para registrar,{" "}
                  <Link
                    to="/patients"
                    target="_blank"
                    className="font-semibold text-primary underline"
                  >
                    regístrala en Pacientes
                  </Link>{" "}
                  y vuelve para elegirla aquí.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Con esto basta para la cita. El documento y el resto de la ficha se completan
                  cuando venga.
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-1.5">
              <ResourceSelect
                id="cita-paciente"
                label="Paciente"
                options={patientOptions}
                value={patientId}
                onChange={(next) => {
                  // El nombre de quien se eligió se guarda: la búsqueda siguiente puede no traerlo.
                  const option = patientOptions.find((item) => item.id === next)
                  if (option) setCreated({ id: option.id, name: option.label })
                  setPatientId(next)
                }}
                onQueryChange={setPatientQuery}
              />
              {canRegister ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2.5 justify-self-start text-primary"
                  onClick={() => {
                    // Lo que ya se tecleó al buscar sirve de punto de partida.
                    const [first = "", ...rest] = patientQuery.trim().split(/\s+/)
                    setNewPatient({ givenNames: first, surname: rest.join(" ") })
                    setRegistering(true)
                  }}
                >
                  Registrar paciente nuevo
                </Button>
              ) : null}
            </div>
          )}

          <ResourceSelect
            id="cita-servicio"
            label="Servicio (opcional)"
            options={(servicesQuery.data?.data ?? []).map((item) => ({
              id: item.id,
              label: item.name,
              detail: item.durationMin ? `${item.durationMin} min` : undefined,
            }))}
            value={serviceId}
            onChange={(next) => {
              setServiceId(next)
              // Con servicio, el bloque toma lo que dura el servicio.
              const minutes =
                (servicesQuery.data?.data ?? []).find((item) => item.id === next)?.durationMin ??
                defaultMinutes
              if (value) {
                setValue({
                  ...value,
                  end: new Date(Date.parse(value.start) + minutes * 60000).toISOString(),
                })
              }
            }}
          />

          <div className="grid gap-2">
            <span className="text-sm font-medium">Profesional</span>
            <ScheduleResourceChips
              wrap
              label="Profesional"
              resources={team}
              formatLabel={(item) => shortName(item.label)}
              value={dentistFilter}
              allLabel="Cualquiera"
              onChange={(next) => {
                touched.current = false
                setDentistFilter(next)
              }}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-medium">Cuándo</span>
              <DatePickerButton
                size="sm"
                align="end"
                min={today}
                value={date}
                onChange={goToDate}
                aria-label="Ir a otra fecha"
              >
                <CalendarDays aria-hidden />
                <span className="first-letter:uppercase">
                  {formatDateLong(date).split(" ").slice(-1)[0]}
                </span>
              </DatePickerButton>
            </div>
            <ScheduleDayStrip
              dates={week.slice(0, 6).includes(date) ? week.slice(0, 6) : week}
              value={date}
              today={today}
              onChange={goToDate}
              onPrevious={() => goToDate(addDays(date, -7) < today ? today : addDays(date, -7))}
              onNext={() => goToDate(addDays(date, 7))}
            />
            {team.length === 0 && availability ? (
              <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                Ningún profesional tiene horario en esta sede. Configúralo en Ajustes, Horarios y
                bloqueos, para poder reservar.
              </p>
            ) : (
              <ScheduleRangePicker
                label={`Horas del ${formatDateLong(date).toLocaleLowerCase("es")}`}
                lanes={lanes}
                date={date}
                timeZone={timeZone}
                free={free}
                open={open}
                value={shown}
                onChange={choose}
                defaultMinutes={duration}
                now={now}
              />
            )}
            {shown ? (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-bold">
                    {rangeSaid(shown.start, shown.end, timeZone, today)}
                  </span>{" "}
                  <span className="text-muted-foreground">con {professional?.label}</span>
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Dura ${formatSpan(chosenMinutes)}. Cambiar la duración`}
                      />
                    }
                  >
                    {formatSpan(chosenMinutes)}
                    <ChevronDown aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {DURATIONS.map((minutes) => (
                      <DropdownMenuItem key={minutes} onClick={() => setDuration(minutes)}>
                        {formatSpan(minutes)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {availabilityQuery.isLoading || availabilityQuery.isPlaceholderData
                  ? "Buscando horas libres…"
                  : "No queda nada libre este día. Prueba otro día u otro profesional."}
              </p>
            )}
            {state === "taken" ? (
              <p role="alert" className="text-sm text-destructive">
                A esa hora {professional?.label} ya está ocupado. Mueve el bloque a una zona blanca.
              </p>
            ) : state === "outside" ? (
              <p className="text-sm text-warning-foreground">
                Esa hora queda fuera del horario de {professional?.label}.
              </p>
            ) : null}
            {availabilityQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudo consultar la disponibilidad.{" "}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void availabilityQuery.refetch()}
                >
                  Reintentar
                </Button>
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <FieldLabel htmlFor="cita-motivo">Motivo (opcional)</FieldLabel>
            <Input
              id="cita-motivo"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
      </FormDrawer>

      <Dialog open={urgent} onOpenChange={(next) => (next ? undefined : setUrgent(false))}>
        <DialogContent showCloseButton={false} className="gap-3.5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{professional?.label} no atiende a esa hora</DialogTitle>
            <DialogDescription>
              {hoursThatDay.length > 0
                ? `Ese día atiende de ${hoursThatDay.join(" y de ")}`
                : "Ese día no atiende"}
              {shown
                ? ` y quieres reservar a las ${hourLabel(dayMinutesIn(shown.start, timeZone))}.`
                : "."}
              {nextFree
                ? ` Su próximo hueco es ${whenSaid(nextFree.startsAt, timeZone, today)}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {nextFree && shown ? (
              <Button
                className="h-11"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    range: {
                      columnId: shown.columnId,
                      start: nextFree.startsAt,
                      end: new Date(
                        Math.min(
                          Date.parse(nextFree.startsAt) + chosenMinutes * 60000,
                          Date.parse(
                            free.find(
                              (item) =>
                                item.columnId === shown.columnId &&
                                item.start === nextFree.startsAt,
                            )?.end ?? nextFree.endsAt,
                          ),
                        ),
                      ).toISOString(),
                    },
                  })
                }
              >
                Reservar {whenSaid(nextFree.startsAt, timeZone, today)}
              </Button>
            ) : null}
            <Button variant="outline" className="h-11" onClick={() => setUrgent(false)}>
              Ver otros huecos
            </Button>
          </div>
          <div className="flex items-center gap-2 border-t pt-3">
            <span className="flex-1 text-sm text-muted-foreground">¿Es una urgencia?</span>
            <Button
              variant="ghost"
              className="text-warning-foreground"
              disabled={save.isPending}
              onClick={() => shown && save.mutate({ range: shown, outsideSchedule: true })}
            >
              Reservar igual a las {shown ? hourLabel(dayMinutesIn(shown.start, timeZone)) : ""}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
