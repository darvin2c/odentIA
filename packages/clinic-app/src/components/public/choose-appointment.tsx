import { clinicalProfileFor } from "@odentia/clinical"
import { Button, cn, ScrollArea } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PersonAvatar, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarX, Check, ChevronLeft, ChevronRight, MapPin, Users } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import { addDays, dayKey, oneSlotPerStart, windowDays, windowRange } from "../../lib/booking-days"
import {
  type BookingAppointment,
  type BookingLinkBranch,
  type BookingProfessional,
  type BookingProfessionals,
  type BookingYou,
  changeBooking,
  chooseLinkMessages,
  fetchBookingProfessionals,
  fetchBookingSlots,
  type PersonalLinkView,
  reserveBooking,
} from "../../lib/booking-link"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import {
  type BookingDataDraft,
  BookingDataForm,
  checkYou,
  emptyBookingDataDraft,
  emptyYouDraft,
  focusFirstYouError,
  PromotionsQuestion,
  type YouDraft,
  type YouErrors,
  youFieldsOf,
  youInput,
  youPromotionsId,
  YouReview,
} from "../booking-data-form"
import { capital, hourOf, longDay, timeLabel, type WeekSlot } from "./week-slots"

/**
 * Elegir la cita en «Su enlace» (ADR 0037), en tres pantallas como mucho: la
 * sede (solo si hay más de una y el enlace no la fija), con quién y cuándo
 * (profesional, día y hora en una misma pantalla) y «Revisa y reserva», el
 * único formulario: a quien aún no es paciente le pide ahí lo que la clínica
 * necesita (con lo que ya sabemos escrito) y a quien ya lo es, lo que le falta;
 * a los dos, lo que aún no aceptó o respondió. Todo se guarda con la cita.
 * Sirve para reservar (el enlace del agente), cambiar su cita y agendar lo que
 * aceptó de su presupuesto. Solo muestra lo que el servidor entrega libre:
 * quién atiende, su próximo horario y las horas de cada día; nunca calcula
 * disponibilidad.
 */
type Mode = "reservar" | "cambiar" | "tratamiento"
type Step = "sede" | "cuando" | "revisa"

/** Sin preferencia: cada hora con quien la tenga libre. */
const ANYONE = "cualquiera"
/** El enlace ya no sirve para esto: se dice con el texto del servidor. */
const LINK_ENDED = ["BOOKING_LINK_USED", "BOOKING_LINK_EXPIRED", "BOOKING_NOT_CHANGEABLE"]
/** La hora dejó de estar libre mientras elegía (otra cita, la unidad o un bloqueo). */
const SLOT_TAKEN = ["APPOINTMENT_CONFLICT", "NO_ROOM", "STALE_VERSION", "VALIDATION"]
const EXPIRED_TEXT = "Este enlace ya no sirve. Responde el mensaje y te enviamos uno nuevo."

const slotTaken = (error: unknown): boolean => error instanceof ApiError && SLOT_TAKEN.includes(error.shape.code ?? "")

/** «hoy», «mañana» o «martes, 3 de noviembre». */
function dayWords(instant: string, timeZone: string): string {
  const today = dayKey(new Date(), timeZone)
  const day = dayKey(instant, timeZone)
  if (day === today) return "hoy"
  if (day === addDays(today, 1)) return "mañana"
  return longDay(instant, timeZone).toLowerCase()
}

/** «hoy, 4:00 p. m.» */
function whenWords(instant: string, timeZone: string): string {
  return `${dayWords(instant, timeZone)}, ${timeLabel(instant, timeZone)}`
}

/** Para una tarjeta angosta: «hoy, 4:00 p. m.» o «mar 3 nov, 9:00 a. m.». */
function whenShort(instant: string, timeZone: string): string {
  const words = dayWords(instant, timeZone)
  const day =
    words === "hoy" || words === "mañana"
      ? words
      : new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "short", day: "numeric", month: "short" })
          .format(new Date(instant))
          .replace(/[.,]/g, "")
  return `${day}, ${timeLabel(instant, timeZone)}`
}

/** «24 de diciembre». */
function dateWords(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, day: "numeric", month: "long" }).format(new Date(instant))
}

/** Lo que dice un día en la fila: «Jue», «29», «oct». */
function dayParts(day: string, timeZone: string): { weekday: string; number: string; month: string } {
  // Al mediodía de la sede, para que el día no cambie al pasarlo a su zona.
  const noon = new Date(`${day}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "short", day: "numeric", month: "short" }).formatToParts(noon)
  const part = (type: Intl.DateTimeFormatPartTypes) => (parts.find((item) => item.type === type)?.value ?? "").replace(/\./g, "")
  return { weekday: capital(part("weekday")), number: part("day"), month: part("month") }
}

/** «29 oct – 4 nov». */
function rangeWords(days: string[], timeZone: string): string {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return ""
  const from = dayParts(first, timeZone)
  const to = dayParts(last, timeZone)
  return from.month === to.month ? `${from.number} – ${to.number} ${to.month}` : `${from.number} ${from.month} – ${to.number} ${to.month}`
}

/**
 * La hora que ya eligió en el chat y trae la dirección del enlace (`sede`,
 * `con`, `hora`). La página no decide si está libre: solo la busca entre los
 * horarios que entrega el servidor.
 */
export interface BookingPick {
  branchId: string
  professionalUserId: string
  startsAt: string
}

/** «La hora que elegiste (…) acaba de ocuparse…»: lo mismo si se ocupó al reservar o antes de abrir el enlace. */
function takenNotice(startsAt: string, timeZone: string): string {
  return `La hora que elegiste (${whenWords(startsAt, timeZone)}) acaba de ocuparse. Elige otra; lo demás sigue igual.`
}

/** La sede de la cita o del enlace; la de una cita que se cambia puede no estar entre las que se ofrecen. */
function branchOf(view: PersonalLinkView, branchId: string | null, current: BookingAppointment | null): BookingLinkBranch | undefined {
  const listed = view.branches.find((item) => item.id === branchId)
  if (listed || !current || current.branchId !== branchId) return listed
  return {
    id: current.branchId,
    name: current.branchName,
    address: current.branchAddress,
    directionsUrl: current.branchDirectionsUrl,
    timeZone: current.timeZone,
    defaultMinutes: current.durationMin,
  }
}

export function ChooseAppointment({
  view,
  slug,
  token,
  mode,
  current,
  planItems,
  pick,
  onBack,
  onDone,
}: {
  view: PersonalLinkView
  slug: string
  token: string
  mode: Mode
  current: BookingAppointment | null
  planItems?: Array<{ planItemId: string; title: string }>
  /** Al reservar: la hora que ya eligió en el chat, si el enlace la trae. */
  pick?: BookingPick | null
  /** Volver a lo pendiente; sin él (el enlace del agente) no hay a dónde volver. */
  onBack: (() => void) | null
  onDone: (appointment: BookingAppointment) => void
}) {
  const queryClient = useQueryClient()
  const changing = mode === "cambiar"
  const fixedBranchId = changing ? (current?.branchId ?? null) : mode === "reservar" ? (view.booking?.branchId ?? null) : null
  const branchStep = fixedBranchId === null && view.branches.length > 1
  const steps: Step[] = branchStep ? ["sede", "cuando", "revisa"] : ["cuando", "revisa"]
  // La hora del chat vale solo al reservar y en una sede que el enlace ofrece.
  const [initialPick] = useState<{ pick: BookingPick; timeZone: string } | null>(() => {
    const branch = pick && mode === "reservar" && (fixedBranchId === null || fixedBranchId === pick.branchId) ? view.branches.find((item) => item.id === pick.branchId) : undefined
    return pick && branch ? { pick, timeZone: branch.timeZone } : null
  })
  // Mientras se busca la hora del chat entre los horarios libres.
  const [pendingPick, setPendingPick] = useState(initialPick)
  const [shownStep, setStep] = useState<Step>(initialPick ? "cuando" : (steps[0] ?? "cuando"))
  // Si una pantalla deja de tener sentido (la sede, al llegar con una sola), se sigue con la que corresponde.
  const step: Step = steps.includes(shownStep) ? shownStep : (steps[0] ?? "cuando")
  const [branchId, setBranchId] = useState<string | null>(
    initialPick?.pick.branchId ?? fixedBranchId ?? (view.branches.length === 1 ? (view.branches[0]?.id ?? null) : null),
  )
  // Lo elegido: se conserva al volver atrás; cambiar la sede o con quién borra lo que deja de valer.
  const [who, setWho] = useState<string | null>(initialPick?.pick.professionalUserId ?? null)
  const [windowStart, setWindowStart] = useState<string | null>(() => {
    if (!initialPick) return null
    const chosen = dayKey(initialPick.pick.startsAt, initialPick.timeZone)
    const today = dayKey(new Date(), initialPick.timeZone)
    return chosen < today ? today : chosen
  })
  const [day, setDay] = useState<string | null>(initialPick ? dayKey(initialPick.pick.startsAt, initialPick.timeZone) : null)
  const [slot, setSlot] = useState<WeekSlot | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [jumped, setJumped] = useState<string | null>(null)
  const [registered, setRegistered] = useState(false)
  const [dataDraft, setDataDraft] = useState<BookingDataDraft>(emptyBookingDataDraft)
  // Quien ya es paciente: lo que le falta y lo que acepta, también al cambiar o agendar (novedades).
  const [youDraft, setYouDraft] = useState<YouDraft>(emptyYouDraft)
  const [youErrors, setYouErrors] = useState<YouErrors>({})
  // Su respuesta a novedades ya se guardó (al cambiar o agendar): no se vuelve a enviar si la hora falla.
  const [promotionsSaved, setPromotionsSaved] = useState(false)
  const [submissionId] = useState(() => crypto.randomUUID())
  // Una hora redonda y fija mientras la página está abierta: así lo pedido al servidor no cambia en cada pintado.
  const [now] = useState(() => {
    const start = new Date()
    start.setMinutes(0, 0, 0)
    return start
  })

  const branch = branchOf(view, branchId, current)
  const professionalsKey = (id: string) => ["booking-professionals", slug, token, mode, id] as const
  const professionals = useQuery({
    queryKey: professionalsKey(branchId ?? ""),
    queryFn: async () => (await fetchBookingProfessionals(slug, token, branchId ?? "", changing)).data,
    enabled: branchId !== null && step !== "sede",
    retry: false,
  })
  const data = professionals.data
  const timeZone = data?.timeZone ?? branch?.timeZone ?? activeOrgTimeZone()
  const today = dayKey(new Date(), timeZone)
  const people = data?.professionals ?? []
  const choosable = people.filter((person) => person.next !== null)
  // Con una sola persona que atiende, «Cualquiera» sería ella misma.
  const offersAnyone = choosable.length > 1
  const startWho = changing ? (choosable.find((person) => person.current)?.id ?? null) : null
  const effectiveWho = who ?? startWho ?? (offersAnyone ? ANYONE : (choosable[0]?.id ?? ANYONE))
  const nextOf = (id: string): string | null => (id === ANYONE ? (data?.first?.startsAt ?? null) : (people.find((person) => person.id === id)?.next?.startsAt ?? null))
  const startFor = (id: string): string => {
    const next = nextOf(id)
    const first = next ? dayKey(next, timeZone) : today
    return first < today ? today : first
  }
  const effectiveStart = windowStart ?? (data ? startFor(effectiveWho) : null)
  const untilDay = data ? dayKey(data.until, timeZone) : null
  const range = effectiveStart ? windowRange(effectiveStart, timeZone, now) : null
  const slots = useQuery({
    queryKey: ["booking-slots", slug, token, mode, branchId, range?.from ?? null, range?.to ?? null],
    queryFn: async () => (await fetchBookingSlots(slug, token, { branchId: branchId ?? "", from: range?.from ?? "", to: range?.to ?? "", changing })).data,
    enabled: branchId !== null && range !== null && step !== "sede",
    retry: false,
  })
  const shownDays = effectiveStart ? windowDays(effectiveStart) : []
  const withWho = (slots.data?.slots ?? []).filter((item) => effectiveWho === ANYONE || item.professionalUserId === effectiveWho)
  const offered = effectiveWho === ANYONE ? oneSlotPerStart(withWho) : withWho
  const byDay = new Map<string, WeekSlot[]>()
  for (const item of offered) {
    const key = dayKey(item.startsAt, timeZone)
    byDay.set(key, [...(byDay.get(key) ?? []), item])
  }
  const effectiveDay = day && byDay.has(day) ? day : (shownDays.find((item) => byDay.has(item)) ?? null)
  const hours = effectiveDay ? (byDay.get(effectiveDay) ?? []) : []

  // La hora del chat: si está entre los horarios libres de esa persona, queda elegida y se pasa a revisar;
  // si ya no, se elige otra con esa misma persona y el aviso de siempre.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se resuelve una sola vez, cuando llegan los horarios.
  useEffect(() => {
    if (!pendingPick) return
    if (professionals.isError || slots.isError || branchId === null) {
      setPendingPick(null)
      return
    }
    if (!professionals.isSuccess || !slots.isSuccess) return
    const { pick: chosen } = pendingPick
    const found = slots.data.slots.find(
      (item) => item.professionalUserId === chosen.professionalUserId && Date.parse(item.startsAt) === Date.parse(chosen.startsAt),
    )
    setPendingPick(null)
    if (found) {
      setSlot(found)
      setStep("revisa")
      return
    }
    setNotice(takenNotice(chosen.startsAt, timeZone))
    // Con esa persona si aún tiene horarios, desde su próximo día libre.
    if (!choosable.some((person) => person.id === chosen.professionalUserId)) setWho(null)
    setWindowStart(null)
    setDay(null)
  }, [pendingPick, professionals.isSuccess, professionals.isError, slots.isSuccess, slots.isError])
  const resolvingPick = pendingPick !== null

  const needsData = mode === "reservar" && !!view.booking?.needsRegistration && !registered
  // Quien ya es paciente al reservar: lo que este paso sabe pedir de lo que le falta.
  const profile = clinicalProfileFor(view.countryCode)
  const youFields = mode === "reservar" ? youFieldsOf(view.data?.missing ?? []) : []
  const asksYou = mode === "reservar" && !needsData && !registered && view.you !== null
  const asksPromotions = !needsData && !!view.pending?.promotions && !promotionsSaved
  const serviceName =
    mode === "cambiar"
      ? (current?.serviceName ?? "Consulta")
      : mode === "tratamiento"
        ? (planItems ?? []).map((item) => item.title).join(" · ") || "Tu tratamiento"
        : (view.booking?.service?.name ?? "Consulta")
  const minutes = changing ? (current?.durationMin ?? null) : mode === "reservar" ? (view.booking?.service?.durationMin ?? branch?.defaultMinutes ?? null) : (branch?.defaultMinutes ?? null)
  const chosenPerson = effectiveWho === ANYONE ? null : (people.find((person) => person.id === effectiveWho) ?? null)
  const title = changing ? "Cambia tu cita" : mode === "tratamiento" ? "Agenda tu tratamiento" : "Reserva tu cita"
  const stepName: Record<Step, string> = { sede: "Sede", cuando: "Con quién y cuándo", revisa: changing ? "Revisa el cambio" : "Revisa y reserva" }
  const stepIndex = steps.indexOf(step)

  // Al pasar de pantalla, el foco va a su título y la página vuelve arriba (nunca al abrirla).
  const stepTitle = useRef<HTMLHeadingElement>(null)
  const firstStep = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se mueve al cambiar de pantalla, no en cada pintado.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false
      return
    }
    window.scrollTo({ top: 0 })
    stepTitle.current?.focus()
  }, [step])
  const goTo = (next: Step) => setStep(next)

  const refreshAvailability = () => {
    void queryClient.invalidateQueries({ queryKey: ["booking-slots", slug, token] })
    void queryClient.invalidateQueries({ queryKey: ["booking-professionals", slug, token] })
  }
  const act = useMutation({
    retry: false,
    mutationFn: async ({ chosen, you, promotions }: { chosen: WeekSlot; you?: BookingYou; promotions?: boolean }) => {
      // Al cambiar o agendar, su respuesta a novedades se guarda antes, por «Tus mensajes».
      if (promotions !== undefined) {
        await chooseLinkMessages(slug, token, { tipo: "novedades", recibir: promotions })
        setPromotionsSaved(true)
      }
      const where = { startsAt: chosen.startsAt, professionalUserId: chosen.professionalUserId, ...(chosen.roomId ? { roomId: chosen.roomId } : {}) }
      if (changing) return changeBooking(slug, { token, ...where })
      return reserveBooking(slug, {
        token,
        branchId: branchId ?? "",
        ...where,
        ...(mode === "tratamiento" && planItems ? { planItemIds: planItems.map((item) => item.planItemId) } : {}),
        ...(you ? { you } : {}),
      })
    },
    onSuccess: (result) => onDone(result.data),
    onError: (error, { chosen }) => {
      if (!slotTaken(error)) return
      // La hora se ocupó mientras elegía: vuelve a elegir con las horas al día, y lo demás (lo escrito también) sigue igual.
      setNotice(takenNotice(chosen.startsAt, timeZone))
      setSlot(null)
      refreshAvailability()
      goTo("cuando")
    },
  })
  /** «Reservar mi cita», «Reservar» o «Cambiar mi cita»: lo que falta se dice junto al campo, sin enviar. */
  const confirm = () => {
    if (!slot || act.isPending) return
    if (asksYou) {
      const found = checkYou(youDraft, youFields, view.pending, profile)
      setYouErrors(found)
      if (focusFirstYouError(found)) return
      act.mutate({ chosen: slot, you: youInput(youDraft, youFields, view.pending, profile) })
      return
    }
    if (asksPromotions && youDraft.promotions === null) {
      const found: YouErrors = { promotions: "Elige una opción" }
      setYouErrors(found)
      focusFirstYouError(found)
      return
    }
    act.mutate({ chosen: slot, ...(asksPromotions && youDraft.promotions !== null ? { promotions: youDraft.promotions } : {}) })
  }
  const changeYou = (patch: Partial<YouDraft>, ...cleared: Array<keyof YouErrors>) => {
    setYouDraft((previous) => ({ ...previous, ...patch }))
    if (cleared.some((key) => youErrors[key])) {
      setYouErrors((previous) => {
        const next = { ...previous }
        for (const key of cleared) delete next[key]
        return next
      })
    }
  }
  const actionError =
    act.error && !slotTaken(act.error)
      ? act.error instanceof ApiError
        ? LINK_ENDED.includes(act.error.shape.code ?? "")
          ? (act.error.shape.message ?? EXPIRED_TEXT)
          : (act.error.shape.message ?? "No pudimos reservar. Vuelve a intentarlo.")
        : "No pudimos reservar. Revisa tu conexión y vuelve a intentarlo."
      : null

  const chooseBranch = (id: string) => {
    if (id !== branchId) {
      setBranchId(id)
      setWho(null)
      setWindowStart(null)
      setDay(null)
      setSlot(null)
      setJumped(null)
    }
    setNotice(null)
    goTo("cuando")
  }
  const chooseWho = (id: string) => {
    if (id === effectiveWho) return
    const start = startFor(id)
    const next = nextOf(id)
    setWho(id)
    setWindowStart(start)
    setDay(null)
    setSlot(null)
    setNotice(null)
    const person = people.find((item) => item.id === id)
    setJumped(
      next && start > (effectiveStart ?? today)
        ? `${person ? `El próximo horario de ${person.name}` : "El primer horario libre"} es el ${longDay(next, timeZone).toLowerCase()}: los días empiezan ahí.`
        : null,
    )
  }
  const moveWindow = (days: number) => {
    if (!effectiveStart) return
    const next = addDays(effectiveStart, days)
    setWindowStart(next < today ? today : next)
    setDay(null)
    setSlot(null)
    setJumped(null)
  }

  const back: { label: string; run: () => void } | null =
    step === "revisa"
      ? { label: "Atrás", run: () => goTo("cuando") }
      : step === "cuando" && branchStep
        ? { label: "Atrás", run: () => goTo("sede") }
        : onBack
          ? { label: changing ? "Conservar mi cita" : "Atrás", run: onBack }
          : null
  const continueLabel = slot ? `Continuar · ${dayWords(slot.startsAt, timeZone)}, ${timeLabel(slot.startsAt, timeZone)}` : "Elige una hora"
  const reserveLabel = changing ? "Cambiar mi cita" : mode === "reservar" ? "Reservar mi cita" : "Reservar"
  // En el teléfono el botón que avanza queda fijo abajo: el contenido deja ese espacio.
  const fixedBar = !resolvingPick && ((step === "cuando" && professionals.isSuccess && data?.first) || (step === "revisa" && !needsData))

  const summaryRows = (
    <SummaryRows
      serviceName={serviceName}
      minutes={minutes}
      forWhom={view.patientFirstName}
      branch={branch}
      onChangeBranch={branchStep ? () => goTo("sede") : null}
      who={slot?.professionalName ?? chosenPerson?.name ?? (effectiveWho === ANYONE && offersAnyone ? "Cualquiera" : null)}
      when={slot ? `${longDay(slot.startsAt, timeZone)}, ${timeLabel(slot.startsAt, timeZone)}` : effectiveDay ? `${longDay(`${effectiveDay}T12:00:00Z`, timeZone)} · hora por elegir` : null}
    />
  )

  return (
    <div className={cn("mx-auto flex w-full max-w-6xl flex-col gap-5", fixedBar && "pb-28 lg:pb-0")}>
      <header className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
        <h1 className="text-xl font-semibold lg:text-2xl">{title}</h1>
      </header>

      <nav aria-label="Pasos" className="flex flex-col gap-2">
        <div className="flex min-h-11 items-center justify-between gap-3">
          {back ? (
            <Button type="button" variant="ghost" className="-ml-2 min-h-11 px-2 text-primary" onClick={back.run}>
              <ChevronLeft aria-hidden className="size-5" />
              {back.label}
            </Button>
          ) : (
            <span />
          )}
          <p className="text-sm font-semibold text-muted-foreground lg:hidden">
            Paso {stepIndex + 1} de {steps.length} · {stepName[step]}
          </p>
        </div>
        <div aria-hidden className="grid gap-1 lg:hidden" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((item, index) => (
            <span key={item} className={cn("h-1 rounded-full", index <= stepIndex ? "bg-primary" : "bg-border")} />
          ))}
        </div>
        <ol className="hidden items-center gap-3 lg:flex">
          {steps.map((item, index) => (
            <li key={item} className="contents">
              {index > 0 ? <span aria-hidden className={cn("h-0.5 flex-1 rounded-full", index <= stepIndex ? "bg-primary" : "bg-border")} /> : null}
              {index < stepIndex ? (
                <Button type="button" variant="ghost" className="min-h-11 gap-2 px-1 text-primary" onClick={() => goTo(item)}>
                  <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
                    <Check className="size-4" />
                  </span>
                  {stepName[item]}
                </Button>
              ) : (
                <span aria-current={index === stepIndex ? "step" : undefined} className={cn("flex items-center gap-2 text-sm", index === stepIndex ? "font-semibold" : "text-muted-foreground")}>
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full text-xs font-semibold",
                      index === stepIndex ? "bg-primary text-primary-foreground" : "border border-border",
                    )}
                  >
                    {index + 1}
                  </span>
                  {stepName[item]}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      {step === "sede" ? (
        <section className="flex w-full flex-col gap-4 lg:max-w-2xl">
          <div className="flex flex-col gap-1">
            <h2 ref={stepTitle} tabIndex={-1} className="text-lg font-semibold outline-none">
              Elige la sede
            </h2>
            <p className="text-sm text-muted-foreground">{[serviceName, minutes ? `${minutes} minutos` : null].filter(Boolean).join(" · ")}</p>
          </div>
          <BranchChoices
            branches={view.branches}
            chosen={branchId}
            onChoose={chooseBranch}
            load={(id) => ({ queryKey: professionalsKey(id), queryFn: async () => (await fetchBookingProfessionals(slug, token, id, changing)).data })}
          />
          <p className="text-sm text-muted-foreground">Cada sede dice su primer horario libre. «Cómo llegar» está antes de reservar.</p>
        </section>
      ) : null}

      {step === "cuando" && resolvingPick ? <LoadingState kind="indeterminate" message="Buscando el horario que elegiste…" /> : null}

      {step === "cuando" && !resolvingPick ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <section className="flex min-w-0 flex-col gap-5 lg:rounded-2xl lg:border lg:bg-card lg:p-6">
            <h2 ref={stepTitle} tabIndex={-1} className="sr-only">
              Con quién y cuándo
            </h2>
            {changing && current ? (
              <div className="flex flex-col gap-0.5 rounded-xl bg-muted px-4 py-3">
                <p className="text-sm font-semibold text-muted-foreground">
                  Tu cita actual · {[current.serviceName, current.branchName].filter(Boolean).join(" · ")}
                </p>
                <p className="font-semibold">
                  {longDay(current.startsAt, current.timeZone)}, {timeLabel(current.startsAt, current.timeZone)}, con {current.professionalName}
                </p>
              </div>
            ) : (
              <p className="rounded-xl bg-muted px-4 py-3 text-sm lg:hidden">
                <span className="font-semibold">{serviceName}</span>
                {[minutes ? `${minutes} min` : null, branch ? branch.name : null].filter(Boolean).map((part) => ` · ${part}`)}
              </p>
            )}
            {notice ? (
              <p role="alert" className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
                {notice}
              </p>
            ) : null}
            {branchId === null ? (
              <EmptyState icon={CalendarX} title="Por ahora no se puede reservar aquí" description="Escríbenos por el chat y te ayudamos a encontrar un horario." />
            ) : professionals.isPending ? (
              <WhoLoading />
            ) : professionals.isError ? (
              <ErrorState title="No pudimos cargar los horarios" message="Revisa tu conexión y vuelve a intentarlo. Lo que ya elegiste sigue aquí." onRetry={() => void professionals.refetch()} />
            ) : !data?.first ? (
              <EmptyState
                icon={CalendarX}
                title="No quedan horarios en esta sede"
                description={`Buscamos hasta el ${dateWords(data?.until ?? new Date().toISOString(), timeZone)}. ${branchStep ? "Prueba en otra sede o escríbenos" : "Escríbenos"} por el chat y te ayudamos a encontrar uno.`}
                actionLabel={branchStep ? "Elegir otra sede" : undefined}
                onAction={branchStep ? () => goTo("sede") : undefined}
              />
            ) : (
              <>
                <WhoChoices
                  people={people}
                  offersAnyone={offersAnyone}
                  first={data.first.startsAt}
                  chosen={effectiveWho}
                  until={data.until}
                  timeZone={timeZone}
                  jumped={jumped}
                  onChoose={chooseWho}
                />
                <DayChoices
                  days={shownDays}
                  today={today}
                  untilDay={untilDay}
                  timeZone={timeZone}
                  byDay={byDay}
                  chosen={effectiveDay}
                  loading={slots.isPending}
                  failed={slots.isError}
                  onRetry={() => void slots.refetch()}
                  onMove={moveWindow}
                  onChoose={(next) => {
                    setDay(next)
                    setSlot(null)
                  }}
                />
                {effectiveDay && !slots.isPending && !slots.isError ? (
                  <HourChoices day={effectiveDay} hours={hours} chosen={slot} timeZone={timeZone} onChoose={(next) => {
                    setSlot(next)
                    setNotice(null)
                  }} />
                ) : null}
              </>
            )}
          </section>
          <aside aria-label="Tu cita" className="hidden flex-col gap-3 rounded-2xl border bg-card p-5 lg:sticky lg:top-6 lg:flex">
            <h2 className="font-semibold">Tu cita</h2>
            {summaryRows}
            <Button type="button" className="min-h-12 w-full text-base" disabled={slot === null} onClick={() => goTo("revisa")}>
              {slot ? "Continuar" : "Elige una hora"}
            </Button>
          </aside>
        </div>
      ) : null}

      {step === "revisa" && slot ? (
        <section className="flex w-full flex-col gap-4 lg:mx-auto lg:max-w-2xl">
          <h2 ref={stepTitle} tabIndex={-1} className="text-lg font-semibold outline-none">
            {stepName.revisa}
          </h2>
          {changing && current ? (
            <div className="flex flex-col gap-0.5 rounded-xl bg-muted px-4 py-3">
              <p className="text-sm font-semibold text-muted-foreground">Antes</p>
              <p>
                {longDay(current.startsAt, current.timeZone)}, {timeLabel(current.startsAt, current.timeZone)} · {current.professionalName}
              </p>
            </div>
          ) : null}
          <ChosenCard
            label={changing ? "Ahora" : mode === "tratamiento" ? "Tu tratamiento" : "Tu cita"}
            when={`${longDay(slot.startsAt, timeZone)}, ${timeLabel(slot.startsAt, timeZone)}`}
            what={[serviceName, minutes ? `${minutes} minutos` : null, slot.professionalName].filter(Boolean).join(" · ")}
            forWhom={view.patientFirstName}
            branch={branch}
            onChange={() => goTo("cuando")}
          />
          {needsData ? (
            <BookingDataForm
              slug={slug}
              token={token}
              clinicName={view.clinicName}
              submissionId={submissionId}
              draft={dataDraft}
              onDraftChange={setDataDraft}
              reserving={act.isPending}
              onRegistered={() => {
                setRegistered(true)
                void queryClient.invalidateQueries({ queryKey: ["booking-link", slug, token] })
                act.mutate({ chosen: slot })
              }}
            />
          ) : asksYou && view.you ? (
            <YouReview
              you={view.you}
              fields={youFields}
              pending={view.pending}
              draft={youDraft}
              errors={youErrors}
              onChange={changeYou}
              profile={profile}
              today={today}
              countryCode={view.countryCode}
              clinicName={view.clinicName}
              slug={slug}
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {changing
                  ? "Es la misma cita en otro horario: no se crea otra. Te escribiremos por WhatsApp sobre tu cita."
                  : mode === "tratamiento"
                    ? "Es lo que aceptaste de tu presupuesto. Ya tenemos tus datos: no te pedimos nada más. Podrás cambiarla o cancelarla desde este mismo enlace."
                    : "Ya tenemos tus datos: no te pedimos nada más. Te escribiremos por WhatsApp sobre esta cita: la confirmación, los recordatorios y los cambios."}
              </p>
              {asksPromotions ? (
                <PromotionsQuestion
                  id={youPromotionsId}
                  clinicName={view.clinicName}
                  value={youDraft.promotions}
                  error={youErrors.promotions}
                  onChange={(promotions) => changeYou({ promotions }, "promotions")}
                />
              ) : null}
            </>
          )}
          {actionError ? (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          {!needsData ? (
            <div className="hidden gap-3 lg:flex">
              <SubmitButton type="button" className="min-h-12 flex-1 text-base" pending={act.isPending} onClick={confirm}>
                {reserveLabel}
              </SubmitButton>
              {changing && onBack ? (
                <Button type="button" variant="outline" className="min-h-12" onClick={onBack}>
                  Conservar mi cita
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Teléfono: el botón que avanza, fijo abajo. */}
      {fixedBar ? (
        <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden">
          {step === "cuando" ? (
            <Button type="button" className="min-h-12 w-full text-base" disabled={slot === null} onClick={() => goTo("revisa")}>
              {continueLabel}
            </Button>
          ) : slot ? (
            <>
              <SubmitButton type="button" className="min-h-12 w-full text-base" pending={act.isPending} onClick={confirm}>
                {reserveLabel}
              </SubmitButton>
              {changing && onBack ? (
                <Button type="button" variant="outline" className="min-h-11 w-full" onClick={onBack}>
                  Conservar mi cita
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** «Elige la sede»: cada una con su primer horario libre; la que no tiene ninguno no se elige. */
function BranchChoices({
  branches,
  chosen,
  onChoose,
  load,
}: {
  branches: BookingLinkBranch[]
  chosen: string | null
  onChoose: (id: string) => void
  load: (id: string) => { queryKey: readonly unknown[]; queryFn: () => Promise<BookingProfessionals> }
}) {
  const results = useQueries({ queries: branches.map((item) => ({ ...load(item.id), retry: false })) })
  return (
    <div className="flex flex-col gap-2.5">
      {branches.map((item, index) => {
        const result = results[index]
        const found = result?.data
        const none = found !== undefined && found.first === null
        const zone = found?.timeZone ?? item.timeZone
        const detail = result?.isPending
          ? "Buscando horarios…"
          : found?.first
            ? `Primer horario libre: ${whenWords(found.first.startsAt, zone)}`
            : found
              ? `Sin horarios libres hasta el ${dateWords(found.until, zone)}`
              : null
        return (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            disabled={none}
            aria-pressed={chosen === item.id}
            className={cn(
              "h-auto min-h-17 w-full justify-start gap-3 whitespace-normal rounded-2xl border border-border bg-card px-4 py-3 text-left font-normal",
              chosen === item.id && "border-primary bg-primary-soft",
              none && "border-dashed",
            )}
            onClick={() => onChoose(item.id)}
          >
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
              <MapPin className="size-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-semibold">{item.name}</span>
              {item.address ? <span className="text-sm text-muted-foreground">{item.address}</span> : null}
              {detail ? <span className={cn("text-sm", found?.first ? "font-semibold text-primary-soft-foreground" : "text-muted-foreground")}>{detail}</span> : null}
            </span>
            {none ? null : <ChevronRight aria-hidden className="size-5 text-muted-foreground" />}
          </Button>
        )
      })}
    </div>
  )
}

function WhoLoading() {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm text-muted-foreground">
        Buscando quién atiende y sus horarios…
      </p>
      <div aria-hidden className="flex gap-2">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex h-28 w-28 shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border bg-card">
            <span className="size-10 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
            <span className="h-2.5 w-16 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** «¿Con quién?»: «Cualquiera» y cada profesional que atiende, con su próximo horario aunque no sea esta semana. */
function WhoChoices({
  people,
  offersAnyone,
  first,
  chosen,
  until,
  timeZone,
  jumped,
  onChoose,
}: {
  people: BookingProfessional[]
  offersAnyone: boolean
  first: string
  chosen: string
  until: string
  timeZone: string
  jumped: string | null
  onChoose: (id: string) => void
}) {
  const headingId = useId()
  // La ficha elegida queda a la vista aunque la fila se deslice (al volver atrás, por ejemplo).
  const row = useRef<HTMLFieldSetElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se acomoda cuando cambia quién está elegido.
  useEffect(() => {
    row.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [chosen])
  // Quien tiene la cita que se cambia va primero; después, quien tiene horarios y al final quien no.
  const ordered = [...people.filter((person) => person.current && person.next), ...people.filter((person) => !person.current && person.next), ...people.filter((person) => !person.next)]
  const without = people.filter((person) => !person.next).map((person) => person.name)
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h3 id={headingId} className="font-semibold">
        ¿Con quién?
      </h3>
      <ScrollArea horizontal className="-mx-4 lg:mx-0">
        <fieldset ref={row} aria-labelledby={headingId} className="m-0 flex min-w-0 gap-2 border-0 px-4 pb-3 lg:grid lg:grid-cols-3 lg:px-0 lg:pb-0">
          {offersAnyone ? (
            <WhoTile
              pressed={chosen === ANYONE}
              label="Cualquiera"
              detail={whenShort(first, timeZone)}
              spokenDetail={`el primer horario libre: ${whenWords(first, timeZone)}`}
              avatar={
                <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                  <Users className="size-4" />
                </span>
              }
              onClick={() => onChoose(ANYONE)}
            />
          ) : null}
          {ordered.map((person) => (
            <WhoTile
              key={person.id}
              pressed={chosen === person.id}
              disabled={person.next === null}
              label={person.name}
              detail={person.next ? (person.current ? "tiene tu cita" : whenShort(person.next.startsAt, timeZone)) : "sin horarios"}
              spokenDetail={
                person.next
                  ? `${person.current ? "tiene tu cita; " : ""}próximo horario: ${whenWords(person.next.startsAt, timeZone)}`
                  : `sin horarios libres hasta el ${dateWords(until, timeZone)}`
              }
              avatar={<PersonAvatar name={person.name} decorative className="size-8 shrink-0 text-xs" />}
              onClick={() => onChoose(person.id)}
            />
          ))}
        </fieldset>
      </ScrollArea>
      {jumped ? (
        <p role="status" className="text-sm text-primary-soft-foreground">
          {jumped}
        </p>
      ) : null}
      {without.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {without.join(", ")} {without.length === 1 ? "no tiene" : "no tienen"} horarios libres hasta el {dateWords(until, timeZone)}. Si quieres esperar, escríbenos por el chat.
        </p>
      ) : null}
    </section>
  )
}

function WhoTile({
  pressed,
  disabled = false,
  label,
  detail,
  spokenDetail,
  avatar,
  onClick,
}: {
  pressed: boolean
  disabled?: boolean
  label: string
  /** Corto, a la vista: «mar 3 nov, 9:00 a. m.». */
  detail: string
  /** Lo mismo dicho entero para el lector de pantalla: «próximo horario: martes, 3 de noviembre, 9:00 a. m.». */
  spokenDetail: string
  avatar: ReactNode
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={pressed}
      disabled={disabled}
      className={cn(
        // Compacta: avatar chico a la izquierda y dos líneas cortas; las que no caben se ven deslizando la fila.
        "h-auto min-h-12 shrink-0 justify-start gap-2 rounded-xl border border-border bg-card py-1.5 pr-3 pl-2 text-left font-normal",
        pressed && "border-primary bg-primary-soft text-primary-soft-foreground ring-1 ring-primary",
        disabled && "border-dashed",
      )}
      onClick={onClick}
    >
      {avatar}
      <span className="flex min-w-0 flex-col">
        <span className="text-sm leading-tight font-semibold">{label}</span>
        <span aria-hidden className={cn("text-xs leading-tight", pressed ? "" : "text-muted-foreground")}>
          {detail}
        </span>
        <span className="sr-only">, {spokenDetail}</span>
      </span>
    </Button>
  )
}

/** «¿Qué día?»: siete días desde el primero que se mira; los días sin horas se ven y no se eligen. */
function DayChoices({
  days,
  today,
  untilDay,
  timeZone,
  byDay,
  chosen,
  loading,
  failed,
  onRetry,
  onMove,
  onChoose,
}: {
  days: string[]
  today: string
  untilDay: string | null
  timeZone: string
  byDay: Map<string, WeekSlot[]>
  chosen: string | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  onMove: (days: number) => void
  onChoose: (day: string) => void
}) {
  const headingId = useId()
  const first = days[0] ?? today
  const last = days[days.length - 1] ?? today
  const canGoBack = first > today
  const canGoOn = untilDay === null || last < untilDay
  const empty = !loading && !failed && days.every((item) => !byDay.has(item))
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="font-semibold">
          ¿Qué día?
        </h3>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Los 7 días anteriores" disabled={!canGoBack} onClick={() => onMove(-7)}>
            <ChevronLeft aria-hidden className="size-5" />
          </Button>
          <span className="text-sm font-semibold text-muted-foreground">{rangeWords(days, timeZone)}</span>
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Los 7 días siguientes" disabled={!canGoOn} onClick={() => onMove(7)}>
            <ChevronRight aria-hidden className="size-5" />
          </Button>
        </div>
      </div>
      {failed ? (
        <ErrorState title="No pudimos cargar los horarios" message="Revisa tu conexión y vuelve a intentarlo. Lo que ya elegiste sigue aquí." onRetry={onRetry} />
      ) : (
        <fieldset aria-labelledby={headingId} aria-busy={loading} className="m-0 grid min-w-0 border-0 p-0 grid-cols-7 gap-1.5">
          {days.map((item) => {
            const parts = dayParts(item, timeZone)
            const count = byDay.get(item)?.length ?? 0
            const active = item === chosen
            const label = longDay(`${item}T12:00:00Z`, timeZone)
            return loading ? (
              <span key={item} aria-hidden className="h-17 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
            ) : (
              <Button
                key={item}
                type="button"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                aria-label={count === 0 ? `${label}, sin horarios` : `${label}, ${count === 1 ? "1 horario" : `${count} horarios`}`}
                disabled={count === 0}
                className={cn(
                  "h-17 min-w-0 flex-col gap-0 rounded-xl px-0",
                  !active && "border border-border bg-card",
                  count === 0 && "border-transparent bg-muted text-muted-foreground opacity-100",
                )}
                onClick={() => onChoose(item)}
              >
                <span className="text-xs font-semibold">{parts.weekday}</span>
                <span className="text-lg leading-tight font-bold">{parts.number}</span>
                <span className="text-[0.6875rem]">{parts.month}</span>
              </Button>
            )
          })}
        </fieldset>
      )}
      {loading ? (
        <p role="status" className="sr-only">
          Buscando horarios…
        </p>
      ) : null}
      {empty ? (
        <EmptyState
          icon={CalendarX}
          title="No quedan horarios en estos días"
          description={canGoOn ? "Mira los días siguientes o escríbenos por el chat." : "Escríbenos por el chat y te ayudamos a encontrar uno."}
          actionLabel={canGoOn ? "Ver los 7 días siguientes" : undefined}
          onAction={canGoOn ? () => onMove(7) : undefined}
        />
      ) : null}
    </section>
  )
}

/** «¿A qué hora?»: las del día elegido, por mañana y tarde. */
function HourChoices({
  day,
  hours,
  chosen,
  timeZone,
  onChoose,
}: {
  day: string
  hours: WeekSlot[]
  chosen: WeekSlot | null
  timeZone: string
  onChoose: (slot: WeekSlot) => void
}) {
  const headingId = useId()
  const groups = [
    { label: "Mañana", slots: hours.filter((item) => hourOf(item.startsAt, timeZone) < 12) },
    { label: "Tarde", slots: hours.filter((item) => hourOf(item.startsAt, timeZone) >= 12) },
  ].filter((group) => group.slots.length > 0)
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="font-semibold">
        ¿A qué hora? <span className="font-normal text-muted-foreground">· {longDay(`${day}T12:00:00Z`, timeZone)}</span>
      </h3>
      {groups.map((group) => (
        <fieldset key={group.label} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-semibold text-muted-foreground">{group.label}</legend>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {group.slots.map((item) => {
              const active = chosen?.startsAt === item.startsAt && chosen.professionalUserId === item.professionalUserId
              return (
                <Button
                  key={`${item.startsAt}-${item.professionalUserId}`}
                  type="button"
                  variant={active ? "default" : "outline"}
                  aria-pressed={active}
                  aria-label={`${longDay(item.startsAt, timeZone)}, ${timeLabel(item.startsAt, timeZone)}`}
                  className={cn("min-h-11 px-1 text-base", !active && "border border-border bg-card")}
                  onClick={() => onChoose(item)}
                >
                  {timeLabel(item.startsAt, timeZone)}
                </Button>
              )
            })}
          </div>
        </fieldset>
      ))}
      <p className="text-sm text-muted-foreground">Solo se muestran los horarios libres.</p>
    </section>
  )
}

/** «Tu cita» al lado, en pantalla ancha: se llena al elegir. */
function SummaryRows({
  serviceName,
  minutes,
  forWhom,
  branch,
  onChangeBranch,
  who,
  when,
}: {
  serviceName: string
  minutes: number | null
  forWhom: string | null
  branch: BookingLinkBranch | undefined
  onChangeBranch: (() => void) | null
  who: string | null
  when: string | null
}) {
  const row = (label: string, value: ReactNode, action?: ReactNode) => (
    <div className="flex items-start justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        {value}
      </div>
      {action}
    </div>
  )
  return (
    <div className="flex flex-col">
      {row("Qué", <span className="font-semibold">{[serviceName, minutes ? `${minutes} minutos` : null].filter(Boolean).join(" · ")}</span>)}
      {forWhom ? row("Para", <span className="font-semibold">{forWhom}</span>) : null}
      {branch
        ? row(
            "Dónde",
            <>
              <span className="font-semibold">{branch.name}</span>
              {branch.address ? <span className="text-sm text-muted-foreground">{branch.address}</span> : null}
            </>,
            onChangeBranch ? (
              <Button type="button" variant="link" className="h-auto min-h-11 shrink-0 p-0" aria-label="Cambiar la sede" onClick={onChangeBranch}>
                Cambiar
              </Button>
            ) : undefined,
          )
        : null}
      {row("Con quién", who ? <span className="font-semibold">{who}</span> : <span className="text-muted-foreground">Por elegir</span>)}
      {row("Cuándo", when ? <span className="font-semibold">{when}</span> : <span className="text-muted-foreground">Por elegir</span>)}
    </div>
  )
}

/** La cita elegida en «Revisa y reserva»: cuándo, qué, con quién y dónde, con «Cómo llegar» y «Cambiar». */
function ChosenCard({
  label,
  when,
  what,
  forWhom,
  branch,
  onChange,
}: {
  label: string
  when: string
  what: string
  forWhom: string | null
  branch: BookingLinkBranch | undefined
  onChange: () => void
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-1 rounded-2xl bg-primary-soft px-4 py-3.5 text-primary-soft-foreground">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{label}</span>
        <Button type="button" variant="link" className="-my-2 h-auto min-h-11 p-0 font-semibold text-primary-soft-foreground underline" aria-label="Cambiar con quién, el día o la hora" onClick={onChange}>
          Cambiar
        </Button>
      </div>
      <p className="text-lg font-bold text-foreground">{when}</p>
      <p className="text-sm">{what}</p>
      {forWhom ? <p className="text-sm">Para {forWhom}</p> : null}
      {branch ? <p className="text-sm">{[branch.name, branch.address].filter(Boolean).join(" · ")}</p> : null}
      {/* «Cómo llegar» debajo de la sede (issue 36), también en el teléfono. */}
      {branch?.directionsUrl ? (
        <a
          href={branch.directionsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold underline-offset-4 hover:underline"
        >
          <MapPin aria-hidden className="size-4" />
          Cómo llegar
        </a>
      ) : null}
    </section>
  )
}
