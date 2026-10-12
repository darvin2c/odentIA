import { Button, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CalendarCheck, ChevronLeft, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { type BookingDataDraft, BookingDataForm, emptyBookingDataDraft } from "../components/booking-data-form"
import { ApiError } from "../lib/api"
import {
  type BookingAppointment,
  type BookingSlot,
  cancelBooking,
  changeBooking,
  fetchBookingLink,
  fetchBookingSlots,
  reserveBooking,
} from "../lib/booking-link"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { activeOrgLocale, activeOrgTimeZone, setOrgLocale } from "../lib/locale"

/**
 * Página del enlace de reserva: quien recibió el enlace elige el día y la hora
 * viendo los horarios libres y reserva su cita. Es pública y personal a la
 * vez: no hay sesión, y todo lo que se puede hacer lo decide el enlace. No
 * muestra tarifas ni nada de la historia. En pantalla ancha la semana se ve
 * entera, un día por columna; en teléfono, un día a la vez y el botón que
 * avanza fijo abajo. Con la cita ya reservada, el mismo enlace la muestra y
 * deja cambiarla de horario o cancelarla. Quien aún no es
 * paciente deja sus datos esenciales entre elegir y reservar, en una sola
 * pantalla; la ficha la crea el registro de pacientes de la clínica y lo
 * demás se completa allí.
 */
export const Route = createFileRoute("/reserva")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: BookingLinkPage,
})

const DAY_MS = 86_400_000
const WEEK_DAYS = 7
/** Cuántas semanas hacia adelante se puede mirar. */
const MAX_WEEKS = 8
/** Sin preferencia de profesional: se ofrece cada hora con quien la tenga libre. */
const ANYONE = "cualquiera"

function dayKey(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant))
}

function hourOf(instant: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(instant)))
}

function timeLabel(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(instant))
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function longDay(instant: string, timeZone: string): string {
  return capital(new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(instant)))
}

function shortDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "long", day: "numeric" }).format(new Date(instant))
}

function monthName(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, month: "long" }).format(new Date(instant)).toLowerCase()
}

function dayParts(instant: string, timeZone: string): { weekday: string; number: string } {
  const parts = new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "long", day: "numeric" }).formatToParts(new Date(instant))
  return {
    weekday: capital(parts.find((part) => part.type === "weekday")?.value ?? ""),
    number: parts.find((part) => part.type === "day")?.value ?? "",
  }
}

type Step = "elegir" | "datos" | "listo"

/** Dónde va la persona en el recorrido. «Tus datos» solo existe para quien aún no es paciente. */
function Steps({ current, withData }: { current: Step; withData: boolean }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "elegir", label: "Elige día y hora" },
    ...(withData ? [{ id: "datos" as const, label: "Tus datos" }] : []),
    { id: "listo", label: "Listo" },
  ]
  return (
    <ol className="hidden flex-wrap items-center gap-2 lg:flex" aria-label="Pasos">
      {steps.map((step, index) => (
        <li
          key={step.id}
          aria-current={step.id === current ? "step" : undefined}
          className={
            step.id === current
              ? "flex min-h-8 items-center rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground"
              : "flex min-h-8 items-center rounded-full border bg-card px-3 text-sm font-medium text-muted-foreground"
          }
        >
          {index + 1} · {step.label}
        </li>
      ))}
    </ol>
  )
}

/** Cabecera de la página. En pantalla ancha los pasos van como píldoras; en teléfono, «paso 1 de 3» junto a la clínica. */
function Heading({
  clinicName,
  title,
  current,
  withData,
  progress,
  hideSteps = false,
}: {
  clinicName: string
  title: string
  current: Step
  withData: boolean
  progress?: { number: number; total: number } | null
  hideSteps?: boolean
}) {
  const total = withData ? 3 : 2
  const number = progress?.number ?? (current === "elegir" ? 1 : current === "datos" ? 2 : total)
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">
          {clinicName}
          {hideSteps ? null : (
            <span className="lg:hidden">
              {" "}
              · paso {number} de {total}
            </span>
          )}
        </p>
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      {hideSteps ? null : <Steps current={current} withData={withData} />}
    </header>
  )
}

function Unavailable() {
  return (
    <PageShell maxWidth="md">
      <EmptyState
        title="Este enlace ya no está disponible"
        description="Puede que haya vencido o que ya se haya usado. Escríbenos por el chat y te enviamos uno nuevo."
      />
    </PageShell>
  )
}

/** La cita como archivo de calendario (iCalendar, RFC 5545): lo abre el calendario del teléfono o del computador. */
function calendarFile(clinicName: string, appointment: BookingAppointment): string {
  const stamp = (instant: string | Date) => new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const text = (value: string) => value.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n")
  const where = [`Sede ${appointment.branchName}`, appointment.branchAddress].filter(Boolean).join(", ")
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//odentIA//Reserva//ES",
    "BEGIN:VEVENT",
    `UID:${stamp(appointment.startsAt)}-${crypto.randomUUID()}@odentia`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(appointment.startsAt)}`,
    `DTEND:${stamp(appointment.endsAt)}`,
    `SUMMARY:${text(`${appointment.serviceName ?? "Cita"} · ${clinicName}`)}`,
    `LOCATION:${text(where)}`,
    `DESCRIPTION:${text(`Con ${appointment.dentistName}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
}

function Booked({
  clinicName,
  firstName,
  appointment,
  withData,
  cancelling,
  cancelError,
  onChange,
  onCancel,
}: {
  clinicName: string
  firstName: string | null
  appointment: BookingAppointment
  withData: boolean
  cancelling: boolean
  cancelError: string | null
  onChange: () => void
  onCancel: () => void
}) {
  const [managing, setManaging] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const addToCalendar = () => {
    const url = URL.createObjectURL(new Blob([calendarFile(clinicName, appointment)], { type: "text/calendar;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "mi-cita.ics"
    link.click()
    URL.revokeObjectURL(url)
  }
  if (appointment.cancelled) {
    return (
      <PageShell maxWidth="md">
        <Heading clinicName={clinicName} title="Tu cita quedó cancelada" current="listo" withData={withData} />
        <EmptyState
          title={`${longDay(appointment.startsAt, appointment.timeZone)}, ${timeLabel(appointment.startsAt, appointment.timeZone)}`}
          description="Esa cita ya no está en la agenda. Si quieres otra, escríbenos por el chat y te enviamos un enlace nuevo."
        />
      </PageShell>
    )
  }
  return (
    <PageShell maxWidth="md">
      <Heading clinicName={clinicName} title="Tu cita quedó reservada" current="listo" withData={withData} />
      <div className="flex flex-col gap-6">
        <div role="status" className="flex flex-col items-center gap-1 rounded-2xl bg-success-soft p-6 text-center">
          <CalendarCheck className="mb-1 size-8 text-success" aria-hidden />
          <p className="text-lg font-semibold">
            {longDay(appointment.startsAt, appointment.timeZone)}, {timeLabel(appointment.startsAt, appointment.timeZone)}
          </p>
          <p className="text-sm">
            {[appointment.serviceName ?? "Consulta", `${appointment.durationMin} minutos`].join(" · ")}
          </p>
        </div>
        <dl className="flex flex-col divide-y rounded-2xl border bg-card text-sm">
          {firstName ? (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-muted-foreground">Para</dt>
              <dd>{firstName}</dd>
            </div>
          ) : null}
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 p-3">
            <dt className="text-muted-foreground">Con</dt>
            <dd>{appointment.dentistName}</dd>
          </div>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 p-3">
            <dt className="text-muted-foreground">Dónde</dt>
            <dd>
              Sede {appointment.branchName}
              {appointment.branchAddress ? <span className="block text-muted-foreground">{appointment.branchAddress}</span> : null}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">Te lo confirmamos también por el chat. Ya puedes volver a la conversación.</p>
        <div className="flex flex-col gap-2">
          <Button type="button" className="min-h-11 w-full" onClick={addToCalendar}>
            Agregar al calendario
          </Button>
          {appointment.canChange ? (
            <Button type="button" variant="outline" className="min-h-11 w-full" aria-expanded={managing} onClick={() => setManaging(!managing)}>
              Cambiar o cancelar
            </Button>
          ) : null}
          {managing && appointment.canChange ? (
            <div className="flex flex-col gap-2 rounded-2xl border bg-card p-3">
              <Button type="button" variant="outline" className="min-h-11 w-full" onClick={onChange}>
                Cambiar de día u hora
              </Button>
              <Button type="button" variant="outline" className="min-h-11 w-full text-destructive" onClick={() => setConfirming(true)}>
                Cancelar la cita
              </Button>
              {cancelError ? (
                <p role="alert" className="text-sm text-destructive">
                  {cancelError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title="¿Cancelar tu cita?"
        description={`${longDay(appointment.startsAt, appointment.timeZone)}, ${timeLabel(appointment.startsAt, appointment.timeZone)}. El horario queda libre para otra persona.`}
        confirmLabel="Sí, cancelar"
        cancelLabel="No, conservarla"
        variant="destructive"
        pending={cancelling}
        onClose={() => {
          if (!cancelling) setConfirming(false)
        }}
        onConfirm={onCancel}
      />
    </PageShell>
  )
}

/** El lunes de la semana que se mira, en la hora del dispositivo. */
function weekStart(offset: number): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + offset * WEEK_DAYS)
  return start
}

function BookingLinkPage() {
  const { token } = Route.useSearch()
  const queryClient = useQueryClient()
  const slug = orgSlugFromHostname(requestHostname())
  const ready = typeof window !== "undefined" && slug !== null && token !== undefined

  const viewQuery = useQuery({
    queryKey: ["booking-link", slug, token ?? null],
    queryFn: () => fetchBookingLink(slug ?? "", token ?? ""),
    enabled: ready,
    retry: false,
  })
  const view = viewQuery.data?.data
  // Página pública, sin layout de organización: el formato regional de la
  // clínica llega con el enlace y se fija antes de pintar fechas y horas.
  if (view) setOrgLocale(view.locale)

  const [branchChoice, setBranchChoice] = useState<string | null>(null)
  const [dentist, setDentist] = useState<string>(ANYONE)
  const [week, setWeek] = useState(0)
  const [day, setDay] = useState<string | null>(null)
  const [chosen, setChosen] = useState<BookingSlot | null>(null)
  const [booked, setBooked] = useState<BookingAppointment | null>(null)
  // Con la cita ya reservada, el mismo enlace sirve para elegirle otro horario.
  const [changing, setChanging] = useState(false)
  // En teléfono, la sede y el profesional se abren con «Cambiar».
  const [editing, setEditing] = useState(false)
  // Quien aún no es paciente pasa por «Tus datos» antes de reservar. Lo que
  // escribe vive aquí: no se pierde al volver a cambiar de horario.
  const [enteringData, setEnteringData] = useState(false)
  const [dataDraft, setDataDraft] = useState<BookingDataDraft>(emptyBookingDataDraft)
  const [submissionId] = useState(() => crypto.randomUUID())
  const [registered, setRegistered] = useState(false)

  const current = booked ?? view?.appointment ?? null
  const branch = changing && current
    ? (view?.branches.find((item) => item.id === current.branchId) ?? {
        id: current.branchId,
        name: current.branchName,
        address: current.branchAddress,
        timeZone: current.timeZone,
        defaultMinutes: current.durationMin,
      })
    : (view?.branches.find((item) => item.id === (branchChoice ?? view.branchId)) ?? (view?.branches.length === 1 ? view.branches[0] : undefined))

  // La semana que se mira: de lunes a domingo, sin lo que ya pasó.
  const range = useMemo(() => {
    const start = weekStart(week)
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return {
      start: start.toISOString(),
      from: new Date(Math.max(start.getTime(), now.getTime())).toISOString(),
      to: new Date(start.getTime() + WEEK_DAYS * DAY_MS).toISOString(),
    }
  }, [week])

  const slotsQuery = useQuery({
    queryKey: ["booking-slots", slug, token ?? null, branch?.id ?? null, range.from],
    queryFn: () => fetchBookingSlots(slug ?? "", token ?? "", { branchId: branch?.id ?? "", from: range.from, to: range.to }),
    enabled: ready && branch !== undefined && (changing || (view?.status === "abierto" && current === null)),
    retry: false,
  })
  const timeZone = slotsQuery.data?.data.timeZone ?? branch?.timeZone ?? activeOrgTimeZone()
  const allSlots = slotsQuery.data?.data.slots ?? []

  // Con quién: los profesionales que tienen algún horario libre esta semana.
  const dentists = useMemo(() => {
    const byId = new Map<string, string>()
    for (const slot of allSlots) byId.set(slot.dentistUserId, slot.dentistName)
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "es"))
  }, [allSlots])
  const dentistFilter = dentists.some((item) => item.id === dentist) ? dentist : ANYONE

  // Un horario por hora de inicio: sin preferencia, si varios profesionales lo tienen libre se ofrece una sola vez.
  // Se muestran los días de la semana que aún no pasaron; sábado y domingo, solo si la clínica atiende.
  const days = useMemo(() => {
    const byDay = new Map<string, BookingSlot[]>()
    const seen = new Set<string>()
    for (const slot of allSlots) {
      if (dentistFilter !== ANYONE && slot.dentistUserId !== dentistFilter) continue
      if (seen.has(slot.startsAt)) continue
      seen.add(slot.startsAt)
      const key = dayKey(slot.startsAt, timeZone)
      byDay.set(key, [...(byDay.get(key) ?? []), slot])
    }
    const today = dayKey(new Date().toISOString(), timeZone)
    return Array.from({ length: WEEK_DAYS }, (_, index) => {
      // Al mediodía, para que el día no cambie al pasarlo a la zona de la sede.
      const instant = new Date(new Date(range.start).getTime() + index * DAY_MS + DAY_MS / 2).toISOString()
      const key = dayKey(instant, timeZone)
      return { key, instant, weekend: index >= 5, slots: byDay.get(key) ?? [] }
    }).filter((item) => item.key >= today && (!item.weekend || item.slots.length > 0))
  }, [allSlots, dentistFilter, range.start, timeZone])
  const activeDay = days.find((item) => item.key === day && item.slots.length > 0) ?? days.find((item) => item.slots.length > 0)

  const refreshSlots = () => {
    // Ese horario pudo ocuparse mientras elegía: se vuelve a pedir lo libre.
    setChosen(null)
    setEnteringData(false)
    void queryClient.invalidateQueries({ queryKey: ["booking-slots", slug, token ?? null] })
  }
  const reserve = useMutation({
    retry: false,
    mutationFn: (slot: BookingSlot) =>
      reserveBooking(slug ?? "", {
        token: token ?? "",
        branchId: branch?.id ?? "",
        startsAt: slot.startsAt,
        dentistUserId: slot.dentistUserId,
        ...(slot.chairId ? { chairId: slot.chairId } : {}),
      }),
    onSuccess: (result) => setBooked(result.data),
    onError: refreshSlots,
  })
  const change = useMutation({
    retry: false,
    mutationFn: (slot: BookingSlot) =>
      changeBooking(slug ?? "", {
        token: token ?? "",
        startsAt: slot.startsAt,
        dentistUserId: slot.dentistUserId,
        ...(slot.chairId ? { chairId: slot.chairId } : {}),
      }),
    onSuccess: (result) => {
      setBooked(result.data)
      setChanging(false)
      setChosen(null)
    },
    onError: refreshSlots,
  })
  const cancel = useMutation({
    retry: false,
    mutationFn: () => cancelBooking(slug ?? "", token ?? ""),
    onSuccess: (result) => setBooked(result.data),
  })
  if (!ready && typeof window !== "undefined") return <Unavailable />
  if (viewQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message="Abriendo tu enlace…" />
      </PageShell>
    )
  }
  if (viewQuery.isError || !view) {
    if (viewQuery.error instanceof ApiError && viewQuery.error.status === 404) return <Unavailable />
    return (
      <PageShell maxWidth="md">
        <ErrorState title="No pudimos abrir el enlace" message="Revisa tu conexión y vuelve a intentarlo." onRetry={() => void viewQuery.refetch()} />
      </PageShell>
    )
  }
  const withData = view.needsRegistration || registered
  if (current && !changing) {
    return (
      <Booked
        clinicName={view.clinicName}
        firstName={view.patientFirstName}
        appointment={current}
        withData={booked !== null && withData}
        cancelling={cancel.isPending}
        cancelError={
          cancel.error instanceof ApiError
            ? (cancel.error.shape.message ?? "No pudimos cancelar la cita. Escríbenos por el chat.")
            : cancel.error
              ? "No pudimos cancelar la cita. Revisa tu conexión y vuelve a intentarlo."
              : null
        }
        onChange={() => {
          setWeek(0)
          setDay(null)
          setChosen(null)
          setDentist(ANYONE)
          setChanging(true)
        }}
        onCancel={() => cancel.mutate()}
      />
    )
  }
  if (!changing && view.status !== "abierto") return <Unavailable />
  const needsData = !changing && view.needsRegistration && !registered

  const serviceName = (changing ? current?.serviceName : view.service?.name) ?? "Consulta"
  const minutes = changing ? (current?.durationMin ?? null) : (view.service?.durationMin ?? branch?.defaultMinutes ?? null)
  const acting = changing ? change : reserve
  const actionError =
    acting.error instanceof ApiError
      ? ["BOOKING_LINK_USED", "BOOKING_LINK_EXPIRED", "BOOKING_NOT_CHANGEABLE"].includes(acting.error.shape.code ?? "")
        ? (acting.error.shape.message ?? "Este enlace ya no está disponible.")
        : "Ese horario acaba de ocuparse. Elige otro de la lista."
      : acting.error
        ? "No pudimos reservar. Revisa tu conexión y vuelve a intentarlo."
        : null
  const morning = activeDay?.slots.filter((slot) => hourOf(slot.startsAt, timeZone) < 12) ?? []
  const afternoon = activeDay?.slots.filter((slot) => hourOf(slot.startsAt, timeZone) >= 12) ?? []
  const withWhom = dentistFilter === ANYONE ? null : (dentists.find((item) => item.id === dentistFilter)?.name ?? null)
  // El título nombra la semana de calendario (de lunes a viernes, o hasta el fin de semana si se atiende),
  // aunque de la semana en curso ya no se muestren los días que pasaron.
  const monday = new Date(new Date(range.start).getTime() + DAY_MS / 2).toISOString()
  const lastShown = days[days.length - 1]
  const weekEnd = lastShown?.weekend ? lastShown.instant : new Date(new Date(monday).getTime() + 4 * DAY_MS).toISOString()
  const weekTitle = `Semana del ${dayParts(monday, timeZone).number} al ${dayParts(weekEnd, timeZone).number} de ${monthName(weekEnd, timeZone)}`
  const emptyDays = days.filter((item) => item.slots.length === 0).map((item) => longDay(item.instant, timeZone).split(" de ")[0]?.toLowerCase() ?? "")
  const chosenLabel = chosen ? `${shortDay(chosen.startsAt, timeZone)}, ${timeLabel(chosen.startsAt, timeZone)}` : null
  const steps = { number: 1, total: withData ? 3 : 2 }

  const pick = (slot: BookingSlot) => {
    setDay(dayKey(slot.startsAt, timeZone))
    setChosen(slot)
  }
  const changeWeek = (next: number) => {
    setWeek(Math.min(MAX_WEEKS, Math.max(0, next)))
    setDay(null)
    setChosen(null)
  }
  const slotButton = (slot: BookingSlot, compact: boolean) => {
    const active = chosen?.startsAt === slot.startsAt && chosen.dentistUserId === slot.dentistUserId
    return (
      <Button
        key={`${slot.startsAt}-${slot.dentistUserId}`}
        type="button"
        variant={active ? "default" : "outline"}
        className={compact ? "min-h-10 w-full px-1 text-sm" : "min-h-11"}
        aria-pressed={active}
        aria-label={`${longDay(slot.startsAt, timeZone)}, ${timeLabel(slot.startsAt, timeZone)}`}
        onClick={() => pick(slot)}
      >
        {timeLabel(slot.startsAt, timeZone)}
      </Button>
    )
  }
  /** El botón que avanza: reservar, cambiar la cita o seguir a «Tus datos». En teléfono dice el horario elegido. */
  const mainAction = (withTime: boolean) => {
    const suffix = withTime && chosenLabel ? ` ${chosenLabel}` : ""
    if (needsData) {
      return (
        <Button type="button" className="min-h-11 w-full" disabled={chosen === null} onClick={() => setEnteringData(true)}>
          Continuar con mis datos
        </Button>
      )
    }
    return (
      <SubmitButton type="button" className="min-h-11 w-full" pending={acting.isPending} disabled={chosen === null} onClick={() => chosen && acting.mutate(chosen)}>
        {changing ? `Cambiar a${suffix || " este horario"}` : `Reservar${suffix}`}
      </SubmitButton>
    )
  }
  const errors = actionError ? (
    <p role="alert" className="text-sm text-destructive">
      {actionError}
    </p>
  ) : null
  const closingNote = needsData
    ? "Es tu primera cita: después de elegir te pedimos unos datos y reservamos."
    : "Podrás cambiarla o cancelarla desde este mismo enlace."

  // Paso «Tus datos»: con el horario ya elegido, la persona deja lo esencial y la página reserva enseguida.
  // Mientras se reserva sigue a la vista; si el horario se ocupó, vuelve a elegir con sus datos ya guardados.
  if (enteringData && chosen !== null && slug !== null && token !== undefined && (needsData || (registered && reserve.isPending))) {
    return (
      <PageShell maxWidth="md">
        <Heading clinicName={view.clinicName} title="Tus datos" current="datos" withData />
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-2xl bg-primary-soft px-4 py-3 text-primary-soft-foreground">
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="font-semibold">
                {capital(shortDay(chosen.startsAt, timeZone))}, {timeLabel(chosen.startsAt, timeZone)} · {serviceName}
              </p>
              <p className="text-sm">{[branch ? `Sede ${branch.name}` : null, chosen.dentistName].filter(Boolean).join(" · ")}</p>
            </div>
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-11 shrink-0 p-0"
              aria-label="Cambiar horario"
              disabled={reserve.isPending}
              onClick={() => setEnteringData(false)}
            >
              Cambiar
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Es tu primera cita con nosotros. Solo pedimos lo necesario para reservarla; lo demás se completa en la clínica.
          </p>
          <BookingDataForm
            slug={slug}
            token={token}
            submissionId={submissionId}
            draft={dataDraft}
            onDraftChange={setDataDraft}
            reserving={reserve.isPending}
            onRegistered={() => {
              setRegistered(true)
              void queryClient.invalidateQueries({ queryKey: ["booking-link", slug, token] })
              reserve.mutate(chosen)
            }}
          />
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
      {/* En teléfono el botón que avanza queda fijo abajo: el contenido deja ese espacio. */}
      <div className="mx-auto w-full max-w-7xl pb-36 lg:pb-0">
        <Heading
          clinicName={view.clinicName}
          title={changing ? "Cambia tu cita" : "Elige tu cita"}
          current="elegir"
          withData={withData}
          progress={changing ? null : steps}
          hideSteps={changing}
        />

        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)_17rem] lg:items-start">
          <section aria-label="Para qué es la cita" className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="hidden text-sm font-semibold text-muted-foreground lg:block">Para qué es la cita</p>
                <p className="font-semibold">{serviceName}</p>
                <p className="text-sm text-muted-foreground">
                  {[
                    minutes ? `${minutes} minutos` : null,
                    branch ? `sede ${branch.name}` : null,
                    view.patientFirstName ? `para ${view.patientFirstName}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {changing && current ? (
                  <p className="text-sm text-muted-foreground">
                    Hoy la tienes el {longDay(current.startsAt, current.timeZone).toLowerCase()}, {timeLabel(current.startsAt, current.timeZone)}.
                  </p>
                ) : null}
              </div>
              <Button type="button" variant="link" className="h-auto min-h-11 shrink-0 p-0 lg:hidden" aria-expanded={editing} onClick={() => setEditing(!editing)}>
                {editing ? "Listo" : "Cambiar"}
              </Button>
            </div>
            <div className={`${editing ? "flex" : "hidden"} flex-col gap-4 lg:flex`}>
              {!changing && view.branches.length > 1 ? (
                <Field>
                  <FieldLabel htmlFor="reserva-sede">Sede</FieldLabel>
                  <Select
                    value={branch?.id ?? ""}
                    onValueChange={(value) => {
                      setBranchChoice(value)
                      setDentist(ANYONE)
                      setDay(null)
                      setChosen(null)
                    }}
                  >
                    <SelectTrigger id="reserva-sede" className="min-h-11 w-full">
                      <SelectValue placeholder="Elige una sede">{branch?.name}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {view.branches.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {[item.name, item.address].filter(Boolean).join(" · ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : branch ? (
                <div className="flex flex-col text-sm">
                  <span className="font-semibold">Sede {branch.name}</span>
                  {branch.address ? <span className="text-muted-foreground">{branch.address}</span> : null}
                </div>
              ) : null}
              {branch !== undefined && dentists.length > 0 ? (
                <Field>
                  <FieldLabel htmlFor="reserva-profesional">Profesional</FieldLabel>
                  <Select
                    value={dentistFilter}
                    onValueChange={(value) => {
                      setDentist(value ?? ANYONE)
                      setDay(null)
                      setChosen(null)
                    }}
                  >
                    <SelectTrigger id="reserva-profesional" className="min-h-11 w-full">
                      <SelectValue>{dentistFilter === ANYONE ? "Cualquier profesional" : (dentists.find((item) => item.id === dentistFilter)?.name ?? "")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANYONE}>Cualquier profesional</SelectItem>
                      {dentists.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </div>
          </section>

          {branch === undefined ? (
            <p className="text-sm text-muted-foreground">Elige una sede para ver los horarios libres.</p>
          ) : (
            <section aria-label="Horarios libres" className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <p className="font-semibold">{weekTitle}</p>
                  <p className="text-sm text-muted-foreground">
                    {[withWhom ? `Con ${withWhom}` : "Con quien tenga libre", minutes ? `horarios de ${minutes} minutos` : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="icon" className="size-11" aria-label="Semana anterior" disabled={week === 0} onClick={() => changeWeek(week - 1)}>
                    <ChevronLeft className="size-4" aria-hidden />
                  </Button>
                  <Button type="button" variant="outline" size="icon" className="size-11" aria-label="Semana siguiente" disabled={week >= MAX_WEEKS} onClick={() => changeWeek(week + 1)}>
                    <ChevronRight className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>

              {slotsQuery.isPending ? (
                <LoadingState kind="indeterminate" message="Buscando horarios libres…" />
              ) : slotsQuery.isError ? (
                <ErrorState title="No pudimos cargar los horarios" message="Vuelve a intentarlo en un momento." onRetry={() => void slotsQuery.refetch()} />
              ) : activeDay === undefined ? (
                <EmptyState
                  title="No quedan horarios esta semana"
                  description={withWhom ? "Prueba con otro profesional o mira la semana siguiente." : "Mira la semana siguiente o escríbenos por el chat y te ayudamos."}
                  actionLabel={week < MAX_WEEKS ? "Ver la semana siguiente" : undefined}
                  onAction={week < MAX_WEEKS ? () => changeWeek(week + 1) : undefined}
                />
              ) : (
                <>
                  {/* Pantalla ancha: la semana entera, un día por columna. */}
                  <div className="hidden gap-2 lg:grid" style={{ gridTemplateColumns: `repeat(${Math.max(days.length, 5)}, minmax(0, 1fr))` }} data-testid="semana">
                    {days.map((item) => {
                      const parts = dayParts(item.instant, timeZone)
                      const selected = chosen !== null && dayKey(chosen.startsAt, timeZone) === item.key
                      return (
                        <fieldset key={item.key} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" aria-label={longDay(item.instant, timeZone)}>
                          <div className={`flex flex-col items-center rounded-xl py-2 ${selected ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                            <span className="text-xs">{parts.weekday}</span>
                            <span className="text-lg font-semibold">{parts.number}</span>
                          </div>
                          {item.slots.length === 0 ? (
                            <p className="rounded-xl border border-dashed p-2 text-center text-xs text-muted-foreground">No quedan horarios</p>
                          ) : (
                            item.slots.map((slot) => slotButton(slot, true))
                          )}
                        </fieldset>
                      )
                    })}
                  </div>

                  {/* Teléfono: un día a la vez, con los días en una sola fila. */}
                  <div className="flex flex-col gap-4 lg:hidden">
                    <fieldset className="m-0 flex min-w-0 gap-2 overflow-x-auto border-0 p-0 pb-1" aria-label="Día">
                      {days.map((item) => {
                        const parts = dayParts(item.instant, timeZone)
                        const empty = item.slots.length === 0
                        const active = activeDay.key === item.key
                        return (
                          <Button
                            key={item.key}
                            type="button"
                            variant={active ? "default" : "outline"}
                            className="flex h-16 min-w-14 max-w-24 flex-1 flex-col gap-0.5 px-1"
                            disabled={empty}
                            aria-pressed={active}
                            aria-label={`${longDay(item.instant, timeZone)}${empty ? ", no quedan horarios" : ""}`}
                            onClick={() => {
                              setDay(item.key)
                              setChosen(null)
                            }}
                          >
                            <span className="text-xs">{parts.weekday.slice(0, 3)}</span>
                            <span className="text-lg font-semibold">{parts.number}</span>
                          </Button>
                        )
                      })}
                    </fieldset>
                    {emptyDays.length > 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {emptyDays.length === 1
                          ? `El ${emptyDays[0]} no quedan horarios.`
                          : `El ${emptyDays.slice(0, -1).join(", el ")} y el ${emptyDays[emptyDays.length - 1]} no quedan horarios.`}
                      </p>
                    ) : null}
                    {[
                      { label: "Mañana", slots: morning },
                      { label: "Tarde", slots: afternoon },
                    ]
                      .filter((group) => group.slots.length > 0)
                      .map((group) => (
                        <fieldset key={group.label} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                          <legend className="mb-2 p-0 text-sm font-semibold text-muted-foreground">{group.label}</legend>
                          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{group.slots.map((slot) => slotButton(slot, false))}</div>
                        </fieldset>
                      ))}
                    {chosen ? <p className="text-sm text-muted-foreground">Con {chosen.dentistName}.</p> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">Solo se muestran los horarios libres. Si alguien toma uno mientras eliges, te avisamos antes de reservar.</p>
                </>
              )}
            </section>
          )}

          <aside aria-label="Tu cita" className="hidden flex-col gap-3 rounded-2xl border bg-card p-4 lg:sticky lg:top-6 lg:flex">
            <p className="font-semibold">Tu cita</p>
            {chosen ? (
              <div className="flex flex-col gap-0.5 rounded-xl bg-primary-soft p-3 text-primary-soft-foreground">
                <p className="font-semibold">{longDay(chosen.startsAt, timeZone)}</p>
                <p className="font-semibold">{timeLabel(chosen.startsAt, timeZone)}</p>
                <p className="text-sm">{[serviceName, minutes ? `${minutes} minutos` : null].filter(Boolean).join(" · ")}</p>
                <p className="text-sm">{[branch ? `Sede ${branch.name}` : null, chosen.dentistName].filter(Boolean).join(" · ")}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Elige un día y una hora para {changing ? "cambiarla" : "reservar"}.</p>
            )}
            {view.patientFirstName && !needsData ? <p className="text-sm text-muted-foreground">Para {view.patientFirstName}. Ya tenemos tus datos: no te pedimos nada más.</p> : null}
            {errors}
            {mainAction(false)}
            {changing ? (
              <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => setChanging(false)}>
                Conservar mi cita
              </Button>
            ) : null}
            <p className="text-sm text-muted-foreground">{closingNote}</p>
          </aside>
        </div>
      </div>

      {/* Teléfono: el botón que avanza, fijo abajo y con el horario elegido. */}
      <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t bg-background p-4 lg:hidden">
        {errors}
        {mainAction(true)}
        {changing ? (
          <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => setChanging(false)}>
            Conservar mi cita
          </Button>
        ) : (
          <p className="text-center text-sm text-muted-foreground">{chosen ? closingNote : "Elige un día y una hora para reservar."}</p>
        )}
      </div>
    </PageShell>
  )
}
