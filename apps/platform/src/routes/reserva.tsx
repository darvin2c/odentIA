import { Button, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CalendarCheck, ChevronLeft, ChevronRight } from "lucide-react"
import type { RegistrationAnswers } from "@odentia/clinical"
import { useMemo, useState } from "react"
import { PatientRegistrationForm } from "../components/patient/patient-registration-form"
import { ApiError } from "../lib/api"
import {
  type BookingAppointment,
  type BookingSlot,
  fetchBookingLink,
  fetchBookingSlots,
  reserveBooking,
  startBookingRegistration,
} from "../lib/booking-link"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { fetchPublicRegistration, submitPublicRegistration } from "../lib/patient-registration"

/**
 * Página del enlace de reserva: quien recibió el enlace elige el día y la hora
 * viendo los horarios libres y reserva su cita. Es pública y personal a la
 * vez: no hay sesión, y todo lo que se puede hacer lo decide el enlace. No
 * muestra tarifas ni nada de la historia. En pantalla ancha la semana se ve
 * entera, un día por columna; en teléfono, un día a la vez. Quien aún no es
 * paciente completa sus datos entre elegir y reservar, con el mismo formulario
 * de registro de la clínica.
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
  return new Intl.DateTimeFormat("es-PE", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(instant))
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function longDay(instant: string, timeZone: string): string {
  return capital(new Intl.DateTimeFormat("es-PE", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(instant)))
}

function dayParts(instant: string, timeZone: string): { weekday: string; number: string } {
  const parts = new Intl.DateTimeFormat("es-PE", { timeZone, weekday: "long", day: "numeric" }).formatToParts(new Date(instant))
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
    <ol className="flex flex-wrap items-center gap-2" aria-label="Pasos">
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

function Heading({ clinicName, title, current, withData }: { clinicName: string; title: string; current: Step; withData: boolean }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{clinicName}</p>
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      <Steps current={current} withData={withData} />
    </header>
  )
}

/**
 * «Tus datos»: el formulario de registro de pacientes de la clínica, con sus
 * campos y su aviso de privacidad. La ficha la crea ese registro; al terminar,
 * la página reserva el horario ya elegido.
 */
function BookingRegistration({ slug, registrationToken, onRegistered }: { slug: string; registrationToken: string; onRegistered: () => void }) {
  const [submissionId] = useState(() => crypto.randomUUID())
  const [retainedDraft, setRetainedDraft] = useState<Partial<RegistrationAnswers> | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const infoQuery = useQuery({
    queryKey: ["public-registration", slug, registrationToken],
    queryFn: () => fetchPublicRegistration(slug, registrationToken),
    retry: false,
    staleTime: 30_000,
  })
  if (infoQuery.isPending) return <LoadingState message="Cargando el formulario…" />
  if (infoQuery.isError) {
    return <ErrorState title="No pudimos cargar el formulario" message="Vuelve a intentarlo en un momento." onRetry={() => void infoQuery.refetch()} />
  }
  const info = infoQuery.data.data
  return (
    <div className="flex flex-col gap-4">
      {submitError ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {submitError}
        </p>
      ) : null}
      <PatientRegistrationForm
        mode="public"
        config={info.config}
        today={info.today}
        context={{ kind: "conversation" }}
        initialValues={retainedDraft}
        onSubmit={async (draft) => {
          setSubmitError(null)
          setRetainedDraft({ ...draft.answers })
          try {
            const result = await submitPublicRegistration(slug, {
              submissionId,
              formVersion: info.config.version,
              token: registrationToken,
              entryPoint: "public_link",
              answers: draft.answers,
            })
            if (result.data.registered) onRegistered()
          } catch (error) {
            const shape = error instanceof ApiError ? error.shape : null
            if (shape?.code === "FORM_CHANGED") {
              await queryClient.invalidateQueries({ queryKey: ["public-registration", slug, registrationToken] })
              setSubmitError("El formulario cambió: revisa los campos y vuelve a enviar.")
              return
            }
            setSubmitError(shape?.message ?? "No pudimos guardar tus datos. Inténtalo de nuevo o escríbenos por el chat.")
          }
        }}
      >
        {(form) => (
          <form onSubmit={form.onSubmit} className="space-y-6">
            {form.progress}
            {form.body}
            <div className="flex flex-col gap-3">
              {form.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {form.error}
                </p>
              ) : null}
              <SubmitButton type="submit" pending={form.isSubmitting} disabled={form.submitDisabled} className="min-h-11 w-full">
                {form.submitLabel}
              </SubmitButton>
              {form.previous}
            </div>
          </form>
        )}
      </PatientRegistrationForm>
    </div>
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

function Booked({ clinicName, firstName, appointment, withData }: { clinicName: string; firstName: string | null; appointment: BookingAppointment; withData: boolean }) {
  return (
    <PageShell maxWidth="md">
      <Heading clinicName={clinicName} title="Tu cita quedó reservada" current="listo" withData={withData} />
      <div className="flex flex-col gap-6">
        <div role="status" className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft p-6 text-center">
          <CalendarCheck className="size-8 text-success" aria-hidden />
          <p className="text-lg font-semibold">{longDay(appointment.startsAt, appointment.timeZone)}</p>
          <p className="text-lg font-semibold">{timeLabel(appointment.startsAt, appointment.timeZone)}</p>
        </div>
        <dl className="flex flex-col divide-y rounded-2xl border bg-card text-sm">
          {firstName ? (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-muted-foreground">Para</dt>
              <dd>{firstName}</dd>
            </div>
          ) : null}
          {appointment.serviceName ? (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-muted-foreground">Cita</dt>
              <dd>{appointment.serviceName}</dd>
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
        <p className="text-sm text-muted-foreground">
          Te lo confirmamos también por el chat. Si necesitas cambiarla o cancelarla, escríbenos por ahí.
        </p>
      </div>
    </PageShell>
  )
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

  const [branchChoice, setBranchChoice] = useState<string | null>(null)
  const branch = view?.branches.find((item) => item.id === (branchChoice ?? view.branchId)) ?? (view?.branches.length === 1 ? view.branches[0] : undefined)
  const [dentist, setDentist] = useState<string>(ANYONE)
  const [week, setWeek] = useState(0)
  const [day, setDay] = useState<string | null>(null)
  const [chosen, setChosen] = useState<BookingSlot | null>(null)
  const [booked, setBooked] = useState<BookingAppointment | null>(null)
  // Quien aún no es paciente pasa por «Tus datos» antes de reservar.
  const [registrationToken, setRegistrationToken] = useState<string | null>(null)
  const [registered, setRegistered] = useState(false)

  // La semana que se mira: siete días desde hoy, y de ahí hacia adelante.
  const range = useMemo(() => {
    const start = new Date()
    start.setMinutes(0, 0, 0)
    const from = new Date(start.getTime() + week * WEEK_DAYS * DAY_MS)
    return { from: from.toISOString(), to: new Date(from.getTime() + WEEK_DAYS * DAY_MS).toISOString() }
  }, [week])

  const slotsQuery = useQuery({
    queryKey: ["booking-slots", slug, token ?? null, branch?.id ?? null, range.from],
    queryFn: () => fetchBookingSlots(slug ?? "", token ?? "", { branchId: branch?.id ?? "", ...range }),
    enabled: ready && view?.status === "abierto" && branch !== undefined && booked === null,
    retry: false,
  })
  const timeZone = slotsQuery.data?.data.timeZone ?? branch?.timeZone ?? "America/Lima"
  const allSlots = slotsQuery.data?.data.slots ?? []

  // Con quién: los profesionales que tienen algún horario libre esta semana.
  const dentists = useMemo(() => {
    const byId = new Map<string, string>()
    for (const slot of allSlots) byId.set(slot.dentistUserId, slot.dentistName)
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "es"))
  }, [allSlots])
  const dentistFilter = dentists.some((item) => item.id === dentist) ? dentist : ANYONE

  // Un horario por hora de inicio: sin preferencia, si varios profesionales lo tienen libre se ofrece una sola vez.
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
    return Array.from({ length: WEEK_DAYS }, (_, index) => {
      const instant = new Date(new Date(range.from).getTime() + index * DAY_MS).toISOString()
      const key = dayKey(instant, timeZone)
      return { key, instant, slots: byDay.get(key) ?? [] }
    })
  }, [allSlots, dentistFilter, range.from, timeZone])
  const activeDay = days.find((item) => item.key === day && item.slots.length > 0) ?? days.find((item) => item.slots.length > 0)

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
    onError: () => {
      // Ese horario pudo ocuparse mientras elegía: se vuelve a pedir lo libre.
      setChosen(null)
      setRegistrationToken(null)
      void queryClient.invalidateQueries({ queryKey: ["booking-slots", slug, token ?? null] })
    },
  })
  const startRegistration = useMutation({
    retry: false,
    mutationFn: () => startBookingRegistration(slug ?? "", token ?? ""),
    onSuccess: (result) => setRegistrationToken(result.data.registrationToken),
  })

  if (!ready && typeof window !== "undefined") return <Unavailable />
  if (viewQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Cargando los horarios…" />
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
  if (booked) return <Booked clinicName={view.clinicName} firstName={view.patientFirstName} appointment={booked} withData={withData} />
  if (view.status === "usado" && view.appointment) return <Booked clinicName={view.clinicName} firstName={view.patientFirstName} appointment={view.appointment} withData={false} />
  if (view.status !== "abierto") return <Unavailable />
  const needsData = view.needsRegistration && !registered

  const minutes = view.service?.durationMin ?? branch?.defaultMinutes ?? null
  const reserveError =
    reserve.error instanceof ApiError
      ? reserve.error.shape.code === "BOOKING_LINK_USED" || reserve.error.shape.code === "BOOKING_LINK_EXPIRED"
        ? (reserve.error.shape.message ?? "Este enlace ya no está disponible.")
        : "Ese horario acaba de ocuparse. Elige otro de la lista."
      : reserve.error
        ? "No pudimos reservar. Revisa tu conexión y vuelve a intentarlo."
        : null
  const morning = activeDay?.slots.filter((slot) => hourOf(slot.startsAt, timeZone) < 12) ?? []
  const afternoon = activeDay?.slots.filter((slot) => hourOf(slot.startsAt, timeZone) >= 12) ?? []
  const lastDay = new Date(new Date(range.to).getTime() - DAY_MS).toISOString()
  const withWhom = dentistFilter === ANYONE ? null : (dentists.find((item) => item.id === dentistFilter)?.name ?? null)

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

  // Paso «Tus datos»: con el horario ya elegido, la persona completa su registro y la página reserva.
  if (needsData && registrationToken !== null && chosen !== null && slug !== null) {
    return (
      <PageShell maxWidth="md">
        <Heading clinicName={view.clinicName} title="Tus datos" current="datos" withData />
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-primary-soft p-4 text-primary-soft-foreground">
            <div className="flex min-w-0 flex-col">
              <p className="font-semibold">
                {longDay(chosen.startsAt, timeZone)} · {timeLabel(chosen.startsAt, timeZone)}
              </p>
              <p className="text-sm">
                {[view.service?.name ?? "Consulta", branch ? `Sede ${branch.name}` : null, chosen.dentistName].filter(Boolean).join(" · ")}
              </p>
            </div>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setRegistrationToken(null)}>
              Cambiar horario
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Es tu primera cita con nosotros. Completa tus datos y reservamos el horario que elegiste.
          </p>
          <BookingRegistration
            slug={slug}
            registrationToken={registrationToken}
            onRegistered={() => {
              setRegistered(true)
              void queryClient.invalidateQueries({ queryKey: ["booking-link", slug, token ?? null] })
              reserve.mutate(chosen)
            }}
          />
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <div className="mx-auto w-full max-w-7xl">
        <Heading clinicName={view.clinicName} title="Elige tu cita" current="elegir" withData={withData} />

        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)_17rem] lg:items-start">
          <section aria-label="Para qué es la cita" className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-muted-foreground">Para qué es la cita</p>
              <p className="font-semibold">{view.service?.name ?? "Consulta"}</p>
              <p className="text-sm text-muted-foreground">
                {[minutes ? `${minutes} minutos` : null, view.patientFirstName ? `para ${view.patientFirstName}` : null].filter(Boolean).join(" · ")}
              </p>
            </div>
            {view.branches.length > 1 ? (
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
                        {item.name}
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
          </section>

          {branch === undefined ? (
            <p className="text-sm text-muted-foreground">Elige una sede para ver los horarios libres.</p>
          ) : (
            <section aria-label="Horarios libres" className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <p className="font-semibold">
                    {longDay(range.from, timeZone)} — {longDay(lastDay, timeZone)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {[withWhom ? `Con ${withWhom}` : "Con quien tenga libre", minutes ? `citas de ${minutes} minutos` : null].filter(Boolean).join(" · ")}
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
                <LoadingState message="Buscando horarios libres…" />
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
                  <div className="hidden grid-cols-7 gap-2 lg:grid" data-testid="semana">
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
                            <p className="rounded-xl border border-dashed p-2 text-center text-xs text-muted-foreground">Sin horarios</p>
                          ) : (
                            item.slots.map((slot) => slotButton(slot, true))
                          )}
                        </fieldset>
                      )
                    })}
                  </div>

                  {/* Teléfono: un día a la vez. */}
                  <div className="flex flex-col gap-4 lg:hidden">
                    <fieldset className="m-0 grid min-w-0 grid-cols-4 gap-2 border-0 p-0 sm:grid-cols-7" aria-label="Día">
                      {days.map((item) => {
                        const parts = dayParts(item.instant, timeZone)
                        const empty = item.slots.length === 0
                        const active = activeDay.key === item.key
                        return (
                          <Button
                            key={item.key}
                            type="button"
                            variant={active ? "default" : "outline"}
                            className="flex h-16 flex-col gap-0.5"
                            disabled={empty}
                            aria-pressed={active}
                            aria-label={`${longDay(item.instant, timeZone)}${empty ? ", sin horarios" : ""}`}
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
                  </div>
                  <p className="text-sm text-muted-foreground">Solo se muestran los horarios libres. Si alguien toma uno mientras eliges, te avisamos antes de reservar.</p>
                </>
              )}
            </section>
          )}

          <aside aria-label="Tu cita" className="flex flex-col gap-3 rounded-2xl border bg-card p-4 lg:sticky lg:top-6">
            <p className="font-semibold">Tu cita</p>
            {chosen ? (
              <div className="flex flex-col gap-0.5 rounded-xl bg-primary-soft p-3 text-primary-soft-foreground">
                <p className="font-semibold">{longDay(chosen.startsAt, timeZone)}</p>
                <p className="font-semibold">{timeLabel(chosen.startsAt, timeZone)}</p>
                <p className="text-sm">
                  {[view.service?.name ?? "Consulta", minutes ? `${minutes} minutos` : null].filter(Boolean).join(" · ")}
                </p>
                <p className="text-sm">
                  {[branch ? `Sede ${branch.name}` : null, chosen.dentistName].filter(Boolean).join(" · ")}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Elige un día y una hora para reservar.</p>
            )}
            {reserveError ? (
              <p role="alert" className="text-sm text-destructive">
                {reserveError}
              </p>
            ) : null}
            {startRegistration.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No pudimos abrir el formulario de tus datos. Inténtalo de nuevo o escríbenos por el chat.
              </p>
            ) : null}
            {needsData ? (
              <SubmitButton type="button" className="min-h-11 w-full" pending={startRegistration.isPending} disabled={chosen === null} onClick={() => startRegistration.mutate()}>
                Continuar con mis datos
              </SubmitButton>
            ) : (
              <SubmitButton type="button" className="min-h-11 w-full" pending={reserve.isPending} disabled={chosen === null} onClick={() => chosen && reserve.mutate(chosen)}>
                Reservar
              </SubmitButton>
            )}
            <p className="text-sm text-muted-foreground">
              {needsData
                ? "Es tu primera cita: después de elegir te pedimos unos datos y reservamos."
                : "Te confirmamos la cita por el chat. Para cambiarla o cancelarla, escríbenos por ahí."}
            </p>
          </aside>
        </div>
      </div>
    </PageShell>
  )
}
