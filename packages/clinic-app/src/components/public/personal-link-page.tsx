import { Badge, Button } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageShell,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Navigate, useNavigate } from "@tanstack/react-router"
import {
  CalendarCheck,
  CalendarX,
  ChevronLeft,
  CircleCheck,
  Clock,
  Link2Off,
  MailCheck,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  answerLinkBudget,
  type BookingAppointment,
  cancelBooking,
  chooseLinkMessages,
  confirmBooking,
  downloadLinkCalendar,
  fetchBookingLink,
  type MessageChoice,
  type PersonalLinkMessages,
  type PersonalLinkResend,
  type PersonalLinkView,
  type PersonalLinkWhen,
  resendPersonalLink,
} from "../../lib/booking-link"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { useHydrated } from "../../lib/hydrated"
import { activeOrgTimeZone, setOrgLocale } from "../../lib/locale"
import { portalTotalsText } from "../../lib/portal"
import { appWords } from "../../lib/product-words"
import { AppointmentBlock } from "./appointment-block"
import { type BudgetAnswer, BudgetResponder } from "./budget-responder"
import { type BookingPick, ChooseAppointment, type ChooseMode } from "./choose-appointment"
import { LinkConsentStep, LinkQuestionnaireStep } from "./link-steps"
import { PersonalDataForm } from "./personal-data-form"
import { capital, longDay, timeLabel } from "./week-slots"

/**
 * «Su enlace» (ADR 0037 y 0165, «Un enlace por cosa»): la página de cada
 * persona sin sesión. `/pendientes` es «Tus pendientes», una tarjeta por cosa
 * que hacer (su cita, sus datos, el presupuesto, el consentimiento, el
 * cuestionario y sus mensajes; nunca un papel), y cada mensaje abre directo lo
 * suyo con `?abre=`. `/reserva` es solo «Elige tu cita»: si el enlace ya no
 * ofrece reservar, lleva a `/pendientes` con el mismo token. Lo que se puede
 * hacer lo decide el servidor (`/api/public/booking`): la página no tiene reglas
 * propias de quién decide ni de qué se firma.
 */

/** Lo que abre cada mensaje (`?abre=`), y el cuestionario, que se abre desde la lista. */
export const PERSONAL_LINK_OPENS = [
  "firma",
  "presupuesto",
  "cita",
  "datos",
  "mensajes",
  "cuestionario",
] as const
export type PersonalLinkOpens = (typeof PERSONAL_LINK_OPENS)[number]

export interface PersonalLinkSearch {
  token?: string
  abre?: PersonalLinkOpens
  /** Cuál consentimiento o presupuesto (desde la lista o el mensaje); sin él, el último enviado. */
  id?: string
  /** La hora que eligió en el chat (`/reserva`). */
  sede?: string
  con?: string
  hora?: string
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Un instante ISO 8601 con su zona (`2026-11-03T09:00:00-05:00`). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

export function validatePersonalLinkSearch(search: Record<string, unknown>): PersonalLinkSearch {
  const abre = text(search.abre)
  const id = text(search.id)
  return {
    token: typeof search.token === "string" ? search.token : undefined,
    abre: PERSONAL_LINK_OPENS.find((item) => item === abre),
    id: id && UUID.test(id) ? id : undefined,
    sede: text(search.sede),
    con: text(search.con),
    hora: text(search.hora),
  }
}

export const personalLinkHead = () => ({
  meta: [
    { name: "robots", content: "noindex" },
    { name: "referrer", content: "no-referrer" },
  ],
})

/** La hora que eligió en el chat: las tres partes juntas y bien escritas, o nada. */
function pickOf(search: PersonalLinkSearch): BookingPick | null {
  const { sede, con } = search
  // Un «+» de la zona sin codificar llega como espacio.
  const hora = search.hora?.replace(/ (\d{2}:\d{2})$/, "+$1")
  if (
    !sede ||
    !con ||
    !hora ||
    !UUID.test(sede) ||
    con.length > 200 ||
    !INSTANT.test(hora) ||
    Number.isNaN(Date.parse(hora))
  )
    return null
  return { branchId: sede, professionalUserId: con, startsAt: hora }
}

type News = "reservada" | "cambiada" | "cancelada" | "confirmada"

/**
 * Lo que acaba de pasar al reservar en `/reserva`, para decirlo al llegar a
 * `/pendientes`: vive en la memoria de la página, no en la dirección, así que al
 * recargar no se repite.
 */
const landed = new Map<string, { news: News; appointment: BookingAppointment }>()

function problemOf(error: unknown, fallback: string): string | null {
  if (!error) return null
  if (error instanceof ApiError) return error.shape.message ?? fallback
  return `${fallback} Revisa tu conexión y vuelve a intentarlo.`
}

function whenText(when: PersonalLinkWhen): string {
  return `${longDay(when.startsAt, when.timeZone).toLowerCase()}, ${timeLabel(when.startsAt, when.timeZone)}`
}

/** Cierra la frase sin repetir el punto de «a. m.». */
function withPeriod(text: string): string {
  return text.endsWith(".") ? text : `${text}.`
}

/** «De Mateo · para su cita del jueves…», o «Para tu cita del jueves…». */
function contextLine(view: PersonalLinkView, when: PersonalLinkWhen | null): string | null {
  const whose = view.patientFirstName ? `De ${view.patientFirstName}` : null
  const cita = when
    ? `${view.patientFirstName ? "para su cita" : "para tu cita"} del ${whenText(when)}`
    : null
  if (whose && cita) return `${whose} · ${cita}`
  return whose ?? (cita ? capital(cita) : null)
}

/** B2: solo se dice por dónde se le confirma si de verdad sale por ahí. */
function confirmWords(via: PersonalLinkView["confirmVia"]): string {
  if (via === "whatsapp") return " Te lo confirmamos también por WhatsApp."
  if (via === "correo") return " Te lo confirmamos también por correo."
  if (via === "chat") return " Te lo confirmamos también por el chat."
  return ""
}

/** Lo que se dice de su salud, de quien se atiende: de ella misma o, con su nombre, de su hijo. */
function healthAsk(patientFirstName: string | null | undefined): string {
  return patientFirstName
    ? `si ${patientFirstName} tiene alergias, alguna enfermedad o toma medicamentos`
    : "si tienes alergias, alguna enfermedad o tomas medicamentos"
}

/** Una cosa por hacer: su tarjeta en la lista y su botón en «lo que sigue». */
export interface PendingItem {
  key: string
  abre: PersonalLinkOpens
  id?: string
  title: string
  text: string
  detail?: string | null
  badge: string
  action: string
  /** Lo que dice el botón en «lo que sigue», al terminar otra cosa. */
  next: string
  /** El inicio de su cita: así se sabe qué es de la misma cita. */
  at: string | null
}

/**
 * Lo que sigue al terminar algo: lo que falta de esa misma cita (`next`, el primero
 * es el botón principal) y si hay algo más fuera de ella (`more`: «Ver tus pendientes»).
 * Si esa cita sigue «Por confirmar», confirmarla va primero: abre la cita, donde se
 * confirma con el mismo botón de siempre.
 */
export function whatFollows(view: PersonalLinkView, done: { key: string; at: string | null }): { next: PendingItem[]; more: boolean } {
  const rest = pendingItems(view).filter((item) => item.key !== done.key)
  const sameAppointment = done.at ? rest.filter((item) => item.at === done.at) : []
  const appointment = view.appointment
  const confirm: PendingItem[] =
    done.at && done.key !== "cita" && appointment && !appointment.cancelled && appointment.canConfirm && appointment.startsAt === done.at
      ? [
          {
            key: "cita",
            abre: "cita",
            title: view.patientFirstName ? `La cita de ${view.patientFirstName}` : "Tu cita",
            text: capital(whenText(appointment)),
            badge: "Por confirmar",
            action: "Confirmar",
            next: view.patientFirstName ? `Confirmar la cita de ${view.patientFirstName}` : "Confirmar tu cita",
            at: appointment.startsAt,
          },
        ]
      : []
  return {
    next: [...confirm, ...sameAppointment],
    more: rest.some((item) => !sameAppointment.includes(item)) || view.toSchedule.length > 0,
  }
}

export function pendingItems(view: PersonalLinkView): PendingItem[] {
  const name = view.patientFirstName
  const cita = view.appointment && !view.appointment.cancelled ? view.appointment.startsAt : null
  const items: PendingItem[] = []
  const missing = view.data?.missing ?? []
  if (missing.length > 0) {
    items.push({
      key: "datos",
      abre: "datos",
      title: name
        ? `Los datos de ${name}${view.data?.health ? " y su salud" : ""}`
        : view.data?.health
          ? "Tus datos y tu salud"
          : "Tus datos",
      badge: missing.length === 1 ? "Falta 1" : `Faltan ${missing.length}`,
      text: `${capital(missing.map((item) => item.label.toLowerCase()).join(", "))}${view.data?.health ? `; y ${healthAsk(name)}` : ""}.`,
      action: "Completar",
      next: name ? `Completar los datos de ${name}` : "Completar tus datos",
      at: cita,
    })
  } else if (view.data?.health) {
    // Solo queda su salud: opcional, ayuda a quien la atiende.
    items.push({
      key: "datos",
      abre: "datos",
      title: name ? `La salud de ${name}` : "Tu salud",
      badge: "Opcional",
      text: `${capital(healthAsk(name))}, cuéntanoslo antes de venir.`,
      action: "Responder",
      next: name ? `Contarnos de la salud de ${name}` : "Contarnos de tu salud",
      at: cita,
    })
  }
  for (const consent of view.consents) {
    items.push({
      key: `firma:${consent.id}`,
      abre: "firma",
      id: consent.id,
      title: name ? `Consentimiento de ${name}` : "Tu consentimiento",
      badge: consent.signable || consent.why === "sin-documento" ? "Por firmar" : "Para leer",
      // U6: lo que se consiente y para qué cita, solo aquí, detrás del enlace.
      text:
        consent.procedureRef && consent.procedureRef !== consent.title
          ? `${consent.title} · ${consent.procedureRef}`
          : consent.title,
      detail: [
        consent.appointment ? `${name ? "Para su cita" : "Para tu cita"} del ${withPeriod(whenText(consent.appointment))}` : null,
        consent.signable ? null : consent.why === "sin-documento" ? "Primero completa tus datos." : "Lo firmas en la cita.",
      ]
        .filter(Boolean)
        .join(" ") || null,
      action: consent.signable ? "Leer y firmar" : "Leer",
      next: consent.signable ? `Leer y firmar: ${consent.title}` : `Leer: ${consent.title}`,
      at: consent.appointment?.startsAt ?? cita,
    })
  }
  if (view.questionnaire) {
    items.push({
      key: "cuestionario",
      abre: "cuestionario",
      title: name ? `Antes de la cita de ${name}` : "Antes de tu cita",
      badge: "Por responder",
      text: view.questionnaire.title,
      action: "Responder",
      next: `Responder: ${view.questionnaire.title}`,
      at: cita,
    })
  }
  for (const budget of view.budgets) {
    items.push({
      key: `presupuesto:${budget.id}`,
      abre: "presupuesto",
      id: budget.id,
      title: name ? `El presupuesto de ${name}` : "Tu presupuesto",
      badge: "Por responder",
      text: `${budget.title} · ${portalTotalsText(budget, budget)}`,
      action: "Ver y responder",
      next: "Ver y responder tu presupuesto",
      at: null,
    })
  }
  return items
}

/** Lo que eligió de «Tus mensajes», dicho corto; por dónde le llegan, solo si de verdad salen por ahí (B2). */
function messagesSummary(view: PersonalLinkView, messages: PersonalLinkMessages): string {
  if (messages.nothing) return `Pediste no recibir ningún mensaje de ${view.clinicName}.`
  const parts: string[] = []
  if (messages.recordatorio) {
    const phone = view.you?.phone ?? null
    parts.push(
      view.remindersVia === "whatsapp"
        ? `Te escribimos por WhatsApp${phone ? ` al ${phone}` : ""} sobre tus citas.`
        : view.remindersVia === "correo"
          ? "Te escribimos por correo sobre tus citas."
          : "Recordatorios de tus citas: sí.",
    )
  }
  if (messages.novedades) parts.push("Novedades y promociones: sí.")
  else if (view.pending && !view.pending.promotions) parts.push("Novedades y promociones: no.")
  return parts.length > 0
    ? parts.join(" ")
    : `Elige qué mensajes quieres recibir de ${view.clinicName}.`
}

/** Un enlace a otra pantalla de la misma página: con el mismo token, y «atrás» del teléfono sirve. */
function screenLink(token: string, to: { abre?: PersonalLinkOpens; id?: string } = {}) {
  return (
    <Link
      to="/pendientes"
      search={{ token, ...(to.abre ? { abre: to.abre } : {}), ...(to.id ? { id: to.id } : {}) }}
    />
  )
}

function Block({ item, token }: { item: PendingItem; token: string }) {
  return (
    <section aria-label={item.title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 font-semibold break-words">{item.title}</h2>
        <Badge variant="secondary">{item.badge}</Badge>
      </div>
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="break-words">{item.text}</p>
        {item.detail ? <p className="text-muted-foreground">{item.detail}</p> : null}
      </div>
      <Button
        className="min-h-11 self-start"
        render={screenLink(token, { abre: item.abre, id: item.id })}
      >
        {item.action}
      </Button>
    </section>
  )
}

/**
 * Al terminar algo: la confirmación grande, con el foco en ella y la página
 * arriba; después lo que falta de esa misma cita, el primero como botón
 * principal, y «Ver tus pendientes» solo si hay más fuera de esa cita.
 */
function ActionDone({
  title,
  text,
  next,
  more,
  token,
  forWhom,
  appointmentLink,
}: {
  title: string
  text: string
  next: PendingItem[]
  more: boolean
  token: string
  forWhom: string | null
  /** Sin nada más: «Ver tu cita», si tiene una. */
  appointmentLink: boolean
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    window.scrollTo({ top: 0 })
    heading.current?.focus()
  }, [])
  return (
    <div className="flex flex-col gap-4">
      <div
        role="status"
        className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft px-5 py-8 text-center"
      >
        <CircleCheck className="size-10 text-success" aria-hidden />
        <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold text-balance outline-none">
          {title}
        </h2>
        <p className="text-sm text-pretty">{text}</p>
      </div>
      {next.length > 0 ? (
        <section
          aria-label={forWhom ? `También para la cita de ${forWhom}` : "También para tu cita"}
          className="flex flex-col gap-2"
        >
          <h3 className="text-sm font-semibold text-muted-foreground">
            {forWhom ? `También para la cita de ${forWhom}` : "También para tu cita"}
          </h3>
          {next.map((item, index) => (
            <Button
              key={item.key}
              variant={index === 0 ? "default" : "outline"}
              className="h-auto min-h-11 w-full justify-start py-2 text-left whitespace-normal"
              render={screenLink(token, { abre: item.abre, id: item.id })}
            >
              {item.next}
            </Button>
          ))}
        </section>
      ) : !more ? (
        <p className="text-center text-sm text-muted-foreground">
          {forWhom
            ? `No te queda nada pendiente para la cita de ${forWhom}.`
            : "No te queda nada pendiente para tu cita."}
        </p>
      ) : null}
      {more ? (
        <Button variant="outline" className="min-h-11 w-full" render={screenLink(token)}>
          Ver tus pendientes
        </Button>
      ) : next.length === 0 && appointmentLink ? (
        <Button
          variant="outline"
          className="min-h-11 w-full"
          render={screenLink(token, { abre: "cita" })}
        >
          {forWhom ? `Ver la cita de ${forWhom}` : "Ver tu cita"}
        </Button>
      ) : null}
    </div>
  )
}

/** Lo que acaba de terminar: sus palabras y de qué cita era. */
interface Done {
  key: string
  /** El título de la pantalla en que lo hizo: «Consentimiento de Mateo». */
  screen: string
  title: string
  text: string
  at: string | null
}

type Flow = {
  mode: Exclude<ChooseMode, "reservar">
  planItems?: Array<{ planItemId: string; title: string }>
}

export function PersonalLinkPage({
  entry,
  search,
}: {
  entry: "reserva" | "pendientes"
  search: PersonalLinkSearch
}) {
  const { token } = search
  // La hora que eligió en el chat se lee al abrir: después manda lo que elija aquí.
  const [pick] = useState(() => pickOf(search))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const slug = orgSlugFromHostname(requestHostname())
  // Hasta hidratar se pinta lo mismo que en el servidor («Abriendo tu enlace…»), sin decidir nada (#418).
  const hydrated = useHydrated()
  const ready = hydrated && slug !== null && token !== undefined
  const viewKey = ["booking-link", slug, token ?? null]
  const fetchView = () => fetchBookingLink(slug ?? "", token ?? "")
  const viewQuery = useQuery({
    queryKey: viewKey,
    queryFn: fetchView,
    enabled: ready,
    retry: false,
  })
  const view = viewQuery.data?.data
  // Página pública, sin layout de organización: el formato regional y el país
  // de la clínica llegan con el enlace y se fijan antes de pintar fechas y horas.
  if (view) setOrgLocale(view.locale, undefined, view.countryCode)
  // Los enlaces de antes llegaban a «Tus mensajes» con `#mensajes`: siguen abriendo ahí.
  const [legacyMessages] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#mensajes",
  )
  const abre = search.abre ?? (legacyMessages ? "mensajes" : undefined)
  const [arrived] = useState(() => (token ? (landed.get(token) ?? null) : null))
  const [news, setNews] = useState<News | null>(arrived?.news ?? null)
  // La cita recién reservada o cambiada, mientras la vista se actualiza.
  const [booked, setBooked] = useState<BookingAppointment | null>(arrived?.appointment ?? null)
  // Ya hizo algo aquí: si eso era lo último, se le dice «listo» en vez de «ya no sirve».
  const [didSomething, setDidSomething] = useState(arrived !== null)
  const [landing, setLanding] = useState(false)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  // Otra pantalla de la página (otro `abre`): lo de la anterior ya no vale.
  const screenKey = `${abre ?? ""}:${search.id ?? ""}`
  const [shownKey, setShownKey] = useState(screenKey)
  if (shownKey !== screenKey) {
    setShownKey(screenKey)
    setFlow(null)
    setDone(null)
  }
  // Al pasar de pantalla la página vuelve arriba (nunca al abrirla); «Listo» lleva además el foco.
  const firstScreen = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se mueve al cambiar de pantalla, no en cada pintado.
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false
      return
    }
    window.scrollTo({ top: 0 })
  }, [screenKey, flow])
  useEffect(() => {
    if (token) landed.delete(token)
  }, [token])

  const refresh = () => {
    setDidSomething(true)
    void queryClient.invalidateQueries({ queryKey: viewKey })
  }
  const toList = () => {
    setFlow(null)
    setDone(null)
    void navigate({ to: "/pendientes", search: { token } })
  }
  /** Reservó en «Elige tu cita»: a «Tus datos» si aún le falta algo; si no, a sus pendientes, que lo dicen arriba. */
  const land = async (result: BookingAppointment) => {
    setBooked(result)
    setNews("reservada")
    setDidSomething(true)
    setLanding(true)
    let missing = 0
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: viewKey,
        queryFn: fetchView,
        staleTime: 0,
      })
      missing = fresh.data.status === "abierto" ? (fresh.data.data?.missing.length ?? 0) : 0
    } catch {
      missing = 0
    }
    setLanding(false)
    if (token) landed.set(token, { news: "reservada", appointment: result })
    void navigate({
      to: "/pendientes",
      search: { token, ...(missing > 0 ? { abre: "datos" as const } : {}) },
      replace: true,
    })
  }

  const cancel = useMutation({
    retry: false,
    mutationFn: () => cancelBooking(slug ?? "", token ?? ""),
    onSuccess: (result) => {
      setBooked(result.data)
      setNews("cancelada")
      refresh()
    },
  })
  const confirm = useMutation({
    retry: false,
    mutationFn: () => confirmBooking(slug ?? "", token ?? ""),
    onSuccess: (result) => {
      setBooked(result.data)
      setNews("confirmada")
      refresh()
    },
  })

  if (!ready && hydrated)
    return <Closed view={null} slug={slug} token={token ?? null} didSomething={false} />
  if (viewQuery.isPending || landing) {
    return (
      <PageShell maxWidth="md">
        <LoadingState
          kind="indeterminate"
          message={landing ? "Abriendo tu cita…" : "Abriendo tu enlace…"}
        />
      </PageShell>
    )
  }
  if (viewQuery.isError || !view) {
    if (
      viewQuery.error instanceof ApiError &&
      (viewQuery.error.status === 404 || viewQuery.error.shape.code === "BOOKING_LINK_EXPIRED")
    ) {
      return <Closed view={null} slug={slug} token={token ?? null} didSomething={false} />
    }
    return (
      <PageShell maxWidth="md">
        <ErrorState
          title="No pudimos abrir el enlace"
          message="Revisa tu conexión y vuelve a intentarlo."
          onRetry={() => void viewQuery.refetch()}
        />
      </PageShell>
    )
  }
  if (slug === null || token === undefined)
    return <Closed view={null} slug={slug} token={token ?? null} didSomething={false} />

  const appointment = booked ?? view.appointment
  if (view.status !== "abierto") {
    if (booked && !booked.cancelled)
      return <BookedOnly view={view} appointment={booked} slug={slug} token={token} />
    if (booked?.cancelled) {
      return (
        <PageShell maxWidth="md">
          <EmptyState
            icon={CalendarX}
            title="Tu cita quedó cancelada"
            description={`${capital(whenText(booked))}. Si quieres otra, escríbenos por el chat.`}
          />
        </PageShell>
      )
    }
    return <Closed view={view} slug={slug} token={token} didSomething={didSomething} />
  }

  const offersBooking = !!view.booking && !appointment
  // `/reserva` es «Elige tu cita»; si el enlace ya no ofrece reservar, lo suyo está en sus pendientes.
  if (entry === "reserva" && !offersBooking) {
    return (
      <Navigate
        to="/pendientes"
        search={{
          token,
          ...(legacyMessages ? { abre: "mensajes" as const } : {}),
          ...(search.sede ? { sede: search.sede } : {}),
          ...(search.con ? { con: search.con } : {}),
          ...(search.hora ? { hora: search.hora } : {}),
        }}
        replace
      />
    )
  }
  if (entry === "reserva") {
    return (
      <PageShell>
        <ChooseAppointment
          view={view}
          slug={slug}
          token={token}
          mode="reservar"
          current={null}
          pick={pick}
          onBack={null}
          onDone={(result) => void land(result)}
        />
      </PageShell>
    )
  }

  const activeAppointment = appointment && !appointment.cancelled ? appointment : null
  const items = pendingItems(view)
  const name = view.patientFirstName

  if (flow) {
    return (
      <PageShell>
        <ChooseAppointment
          view={view}
          slug={slug}
          token={token}
          mode={flow.mode}
          current={flow.mode === "cambiar" ? appointment : null}
          planItems={flow.planItems}
          onBack={() => setFlow(null)}
          onDone={(result) => {
            refresh()
            if (flow.mode === "cambiar") {
              setBooked(result)
              setNews("cambiada")
              toList()
              return
            }
            // Otra cita o lo aceptado: «Listo» con la cita nueva y lo que sigue; la de siempre no cambia.
            setFlow(null)
            setDone({
              key: `cita:${result.startsAt}`,
              screen: name ? `La cita de ${name}` : "Tu cita",
              title:
                flow.mode === "otra"
                  ? "Listo, reservaste otra cita"
                  : "Listo, tu cita quedó reservada",
              text: `${capital(whenText(result))}, con ${result.professionalName}.${confirmWords(view.confirmVia)}`,
              at: result.startsAt,
            })
          }}
        />
      </PageShell>
    )
  }

  /** La cabecera de siempre: la clínica, «‹ Tus pendientes» como enlace real, el título y de quién y para qué cita es. */
  const one = (
    title: string,
    body: ReactNode,
    when: PersonalLinkWhen | null = activeAppointment,
  ) => (
    <PageShell maxWidth="md">
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
            <Link
              to="/pendientes"
              search={{ token }}
              className="-mr-1 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              <ChevronLeft className="size-4" aria-hidden />
              Tus pendientes
            </Link>
          </div>
          <h1 className="text-xl font-semibold text-balance break-words">{title}</h1>
          {contextLine(view, when) ? (
            <p className="text-sm text-muted-foreground">{contextLine(view, when)}</p>
          ) : null}
        </header>
        {body}
      </div>
    </PageShell>
  )

  /** «Listo» y lo que sigue de esa cita, dentro de la misma cabecera. */
  if (done) {
    const { next, more } = whatFollows(view, done)
    return one(
      done.screen,
      <ActionDone
        title={done.title}
        text={done.text}
        next={next}
        more={more}
        token={token}
        forWhom={name}
        appointmentLink={!!activeAppointment}
      />,
      done.at && activeAppointment && activeAppointment.startsAt === done.at
        ? activeAppointment
        : null,
    )
  }

  const empty = (title: string, description: string) => (
    <EmptyState
      icon={CircleCheck}
      title={title}
      description={description}
      actionLabel={items.length > 0 ? "Ver tus pendientes" : undefined}
      onAction={items.length > 0 ? toList : undefined}
    />
  )
  const clinician = appWords().clinician.one

  if (abre === "mensajes") {
    if (!view.messages) {
      return one(
        "Tus mensajes",
        <EmptyState
          title="Desde este enlace no se eligen los mensajes"
          description="Los elige quien los recibe. Si eres tú, escríbenos por el chat."
          actionLabel="Ver tus pendientes"
          onAction={toList}
        />,
        null,
      )
    }
    return one(
      "Tus mensajes",
      <MessagesStep
        slug={slug}
        token={token}
        clinicName={view.clinicName}
        messages={view.messages}
        onChanged={refresh}
      />,
      null,
    )
  }

  if (abre === "firma") {
    const consent = search.id
      ? view.consents.find((item) => item.id === search.id)
      : view.consents[0]
    if (!consent) {
      return one(
        name ? `Consentimiento de ${name}` : "Tu consentimiento",
        empty(
          search.id || view.consents.length === 0
            ? "No tienes este consentimiento por firmar"
            : "No tienes consentimientos por firmar",
          `Si ya lo firmaste, tu ${clinician} lo revisa contigo en la cita.`,
        ),
      )
    }
    const title = name
      ? `Consentimiento de ${name}`
      : consent.signable
        ? "Firma tu consentimiento"
        : "Tu consentimiento"
    return one(
      title,
      <>
        <LinkConsentStep
          key={consent.id}
          slug={slug}
          token={token}
          consentId={consent.id}
          completeData={screenLink(token, { abre: "datos" })}
          onSigned={() => {
            refresh()
            setDone({
              key: `firma:${consent.id}`,
              screen: title,
              title: "Listo, firmaste",
              text: `Tu firma ya llegó a ${view.clinicName}. Tu ${clinician} lo revisa contigo ${name ? `en la cita de ${name}` : "en la cita"}, antes de empezar. Si quieres cambiar algo, díselo ahí.${confirmWords(view.confirmVia)}`,
              at: consent.appointment?.startsAt ?? activeAppointment?.startsAt ?? null,
            })
          }}
        />
        {consent.signable ? null : (
          // Leyó sin firmar: al final de la hoja, el camino a lo demás.
          <Button variant="outline" className="min-h-11 w-full" render={screenLink(token)}>
            Ver tus pendientes
          </Button>
        )}
      </>,
      // La hoja ya dice «Para la cita del…» (U6): la cabecera no lo repite.
      consent.appointment ? null : activeAppointment,
    )
  }

  if (abre === "datos") {
    const missing = view.data?.missing ?? []
    const healthOnly = missing.length === 0 && !!view.data?.health
    const withHealth = !!view.data?.health && !healthOnly
    const title = name
      ? healthOnly
        ? `La salud de ${name}`
        : `Los datos de ${name}${withHealth ? " y su salud" : ""}`
      : healthOnly
        ? "Tu salud"
        : withHealth
          ? "Tus datos y tu salud"
          : "Tus datos"
    if (!view.data)
      return one(
        title,
        empty("Tus datos ya están en la clínica", "No te falta nada por completar."),
      )
    return one(
      title,
      <>
        {news === "reservada" && activeAppointment ? (
          <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm font-semibold">
            Tu cita quedó reservada para el {whenText(activeAppointment)}. Ahora, lo que nos falta
            de ti.
          </p>
        ) : null}
        <PersonalDataForm
          slug={slug}
          token={token}
          clinicName={view.clinicName}
          onSent={(words) => {
            refresh()
            setDone({
              key: "datos",
              screen: title,
              ...words,
              at: activeAppointment?.startsAt ?? null,
            })
          }}
        />
      </>,
    )
  }

  if (abre === "cuestionario") {
    const title = name ? `Antes de la cita de ${name}` : "Antes de tu cita"
    if (!view.questionnaire)
      return one(
        title,
        empty(
          "No tienes preguntas por responder",
          "Si ya respondiste, la clínica tiene tus respuestas.",
        ),
      )
    return one(
      title,
      <LinkQuestionnaireStep
        slug={slug}
        token={token}
        onSent={() => {
          refresh()
          setDone({
            key: "cuestionario",
            screen: title,
            title: "Gracias, recibimos tus respuestas",
            text: `Tu ${clinician} las revisa contigo en la cita.`,
            at: activeAppointment?.startsAt ?? null,
          })
        }}
      />,
    )
  }

  if (abre === "presupuesto") {
    const title = name ? `El presupuesto de ${name}` : "Tu presupuesto"
    const budget = search.id ? view.budgets.find((item) => item.id === search.id) : view.budgets[0]
    if (!budget)
      return one(
        title,
        empty(
          "Este presupuesto ya está respondido",
          "Gracias. Si cambias de opinión, escríbenos por el chat.",
        ),
        null,
      )
    const answered = (toSchedule: Array<{ planItemId: string; title: string }>, later: boolean) => {
      refresh()
      if (toSchedule.length > 0 && !later) {
        setFlow({ mode: "tratamiento", planItems: toSchedule })
        return
      }
      setDone({
        key: `presupuesto:${budget.id}`,
        screen: title,
        title: "Gracias, recibimos tu respuesta",
        text: later
          ? "Lo que aceptaste queda en tus pendientes para que elijas el horario cuando quieras. Aceptar no es pagar: pagas en la clínica."
          : "Si cambias de opinión, escríbenos por el chat.",
        at: null,
      })
    }
    return one(
      title,
      <BudgetStep
        slug={slug}
        token={token}
        budgetId={budget.id}
        budget={budget}
        onAnswered={answered}
      />,
      null,
    )
  }

  const cancelError = problemOf(cancel.error, "No pudimos cancelar la cita.")
  const confirmError = problemOf(confirm.error, "No pudimos confirmar la cita.")
  const appointmentTitle = name ? `La cita de ${name}` : "Tu cita"
  const appointmentCard = activeAppointment ? (
    <AppointmentBlock
      title={appointmentTitle}
      appointment={activeAppointment}
      onAddToCalendar={() => downloadLinkCalendar(slug, token)}
      canChange={activeAppointment.canChange}
      canConfirm={activeAppointment.canConfirm}
      confirming={confirm.isPending}
      cancelling={cancel.isPending}
      error={cancelError ?? confirmError}
      onChange={() => setFlow({ mode: "cambiar" })}
      onCancel={() => cancel.mutate()}
      onConfirm={() => confirm.mutate()}
    >
      {view.another ? (
        view.another.allowed ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            onClick={() => setFlow({ mode: "otra" })}
          >
            Reservar otra
          </Button>
        ) : (
          // Sin el número: nombraría citas que esta página no muestra.
          <p className="text-sm text-muted-foreground">
            {name ? `${name} ya tiene` : "Ya tienes"} el máximo de citas por venir que se reservan
            desde aquí. Para otra, escríbenos por el chat.
          </p>
        )
      ) : null}
    </AppointmentBlock>
  ) : null

  if (abre === "cita") {
    if (!appointmentCard) {
      return one(
        appointmentTitle,
        <EmptyState
          icon={CalendarX}
          title={
            appointment?.cancelled
              ? `${name ? "Su" : "Tu"} cita del ${whenText(appointment)} quedó cancelada`
              : "No hay una cita por venir"
          }
          description="Si quieres una, escríbenos por el chat."
          actionLabel={items.length > 0 ? "Ver tus pendientes" : undefined}
          onAction={items.length > 0 ? toList : undefined}
        />,
        null,
      )
    }
    return one(
      news ? `${name ? "Su" : "Tu"} cita quedó ${news}` : appointmentTitle,
      <>
        {news === "cancelada" || (news && confirmWords(view.confirmVia)) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {news === "cancelada"
              ? "Si quieres otra, escríbenos por el chat."
              : confirmWords(view.confirmVia).trim()}
          </p>
        ) : null}
        {appointmentCard}
      </>,
      null,
    )
  }

  // «Tus pendientes»: una tarjeta por cosa que hacer; nunca un papel ni la historia.
  const nothingToDo =
    !activeAppointment && items.length === 0 && view.toSchedule.length === 0 && !offersBooking
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
        <h1 className="text-xl font-semibold">
          {news ? `${name ? "Su" : "Tu"} cita quedó ${news}` : "Tus pendientes"}
        </h1>
        {news && news !== "cancelada" && confirmWords(view.confirmVia) ? (
          <p className="text-sm text-muted-foreground">{confirmWords(view.confirmVia).trim()}</p>
        ) : null}
        {name ? <p className="text-sm text-muted-foreground">De {name}</p> : null}
      </header>
      <div className="flex flex-col gap-4">
        {appointmentCard}
        {appointment?.cancelled ? (
          <p role="status" className="rounded-2xl border bg-card p-4 text-sm">
            {name ? "Su" : "Tu"} cita del {whenText(appointment)} quedó cancelada.
          </p>
        ) : null}
        {offersBooking ? (
          <section
            aria-label="Elige tu cita"
            className="flex flex-col gap-3 rounded-2xl border bg-card p-4"
          >
            <h2 className="font-semibold">Elige tu cita</h2>
            <p className="text-sm">
              {view.booking?.service?.name ?? "Consulta"}: el día y la hora que te queden mejor.
            </p>
            <Button
              className="min-h-11 self-start"
              render={
                <Link
                  to="/reserva"
                  search={{
                    token,
                    ...(search.sede ? { sede: search.sede } : {}),
                    ...(search.con ? { con: search.con } : {}),
                    ...(search.hora ? { hora: search.hora } : {}),
                  }}
                />
              }
            >
              Elegir horario
            </Button>
          </section>
        ) : null}
        {items.map((item) => (
          <Block key={item.key} item={item} token={token} />
        ))}
        {view.toSchedule.length > 0 ? (
          // M3: lo que aceptó de su presupuesto y aún no tiene cita.
          <section
            aria-label="Lo que aceptaste, por agendar"
            className="flex flex-col gap-3 rounded-2xl border bg-card p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">Lo que aceptaste, por agendar</h2>
              <Badge variant="secondary">Sin cita</Badge>
            </div>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
              {view.toSchedule.map((item) => (
                <li key={item.planItemId} className="break-words">
                  {item.title}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              className="min-h-11 self-start"
              onClick={() => setFlow({ mode: "tratamiento", planItems: view.toSchedule })}
            >
              Elegir horario
            </Button>
          </section>
        ) : null}
        {nothingToDo ? (
          <EmptyState
            icon={CircleCheck}
            title="No te queda nada pendiente"
            description="Gracias. Si necesitas algo, escríbenos por el chat."
          />
        ) : null}
        {view.messages ? (
          <section
            aria-label="Tus mensajes"
            className="flex flex-col gap-3 rounded-2xl border bg-card p-4"
          >
            <h2 className="font-semibold">Tus mensajes</h2>
            <p className="text-sm">{messagesSummary(view, view.messages)}</p>
            <Button
              variant="outline"
              className="min-h-11 self-start"
              render={screenLink(token, { abre: "mensajes" })}
            >
              Cambiar mis mensajes
            </Button>
          </section>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Aquí está lo que tienes por hacer con la clínica. Tus recetas, órdenes y comprobantes te
          llegan en PDF por tu chat o tu correo.
        </p>
      </div>
    </PageShell>
  )
}

/**
 * El enlace ya no sirve, dicho como es (acta 8): ya no le queda nada, venció
 * (con «Enviarme uno nuevo» si se puede), ya se le envió uno hoy, pasó su cita
 * o la clínica lo quitó. Ninguno nombra el procedimiento ni datos clínicos.
 */
function Closed({
  view,
  slug,
  token,
  didSomething,
}: {
  view: PersonalLinkView | null
  slug: string | null
  token: string | null
  didSomething: boolean
}) {
  const closed = view?.closed ?? null
  const shell = (content: ReactNode) => <PageShell maxWidth="md">{content}</PageShell>
  if (didSomething || closed?.reason === "hecho") {
    return shell(
      <EmptyState
        icon={CircleCheck}
        title={didSomething ? "Listo, no te queda nada pendiente" : "No te queda nada pendiente"}
        description="Gracias. Ya puedes volver a la conversación."
      />,
    )
  }
  if (closed?.reason === "cita-pasada" && closed.appointment) {
    return shell(
      <EmptyState
        icon={CalendarX}
        title={`${view?.patientFirstName ? "Su" : "Tu"} cita del ${whenText(closed.appointment)} ya pasó`}
        description="Si quieres otra, escríbenos por el chat y te ayudamos."
      />,
    )
  }
  if (closed?.reason === "vencido" && closed.resend && slug && token) {
    return shell(<Resend slug={slug} token={token} offer={closed.resend} />)
  }
  if (closed?.reason === "vencido") {
    return shell(
      <EmptyState
        icon={Clock}
        title="Este enlace venció"
        description="No perdiste nada: escríbenos por el chat y te enviamos uno nuevo."
      />,
    )
  }
  if (closed?.reason === "quitado") {
    return shell(
      <EmptyState
        icon={Link2Off}
        title="Este enlace ya no sirve"
        description="Si te llegó uno más nuevo, usa ese. Si no, escríbenos por el chat."
      />,
    )
  }
  return shell(
    <EmptyState
      icon={Link2Off}
      title="Este enlace ya no sirve"
      description="Responde el mensaje y te enviamos uno nuevo."
    />,
  )
}

/** «por WhatsApp al •••701» o «por correo a e•••@gmail.com». */
function viaWords(offer: PersonalLinkResend): string {
  if (offer.channel === "correo") return `por correo${offer.to ? ` a ${offer.to}` : ""}`
  return `por WhatsApp${offer.to ? ` al ${offer.to}` : ""}`
}

/**
 * «Enviarme uno nuevo»: dice por dónde le llegará antes de tocar, se deshabilita
 * mientras envía y, al terminar, «Te lo enviamos» (salió de aquí, no que llegó).
 * Con el tope del día no hay botón: dice cuándo salió el que ya se le envió.
 */
function Resend({
  slug,
  token,
  offer,
}: {
  slug: string
  token: string
  offer: PersonalLinkResend
}) {
  const send = useMutation({ retry: false, mutationFn: () => resendPersonalLink(slug, token) })
  const sent = send.data?.data ?? null
  const limit = send.error instanceof ApiError && send.error.shape.code === "LINK_RESEND_LIMIT"
  const sentAt = sent?.sentAt ?? offer.sentAt
  if (sent || offer.sentAt || limit) {
    // En la zona de la clínica, como todo lo demás de la página.
    const zone = activeOrgTimeZone()
    const day = sentAt ? longDay(sentAt, zone) : null
    const today = day === null || day === longDay(new Date().toISOString(), zone)
    const when = sentAt
      ? `${today ? "hoy" : `el ${day?.toLowerCase()}`} a las ${timeLabel(sentAt, zone)}`
      : "hoy"
    const where = sent ?? offer
    return (
      <div role="status">
        <EmptyState
          icon={MailCheck}
          title={sent ? "Te lo enviamos" : `Ya te enviamos uno nuevo ${when}`}
          description={
            sent
              ? `Te lo enviamos ${viaWords(where)}. Si en unos minutos no te llega, escríbenos por el chat.`
              : `Búscalo ${where.channel === "correo" ? "en tu correo" : "en tu WhatsApp"} o escríbenos por el chat.`
          }
        />
      </div>
    )
  }
  return (
    <EmptyState
      icon={Clock}
      title="Este enlace venció"
      description={`No perdiste nada. Pide uno nuevo y te lo enviamos ${viaWords(offer)}.`}
    >
      <div className="flex flex-col items-center gap-2">
        <SubmitButton
          type="button"
          className="min-h-11"
          pending={send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Enviando…" : "Enviarme uno nuevo"}
        </SubmitButton>
        {send.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {problemOf(send.error, "No pudimos enviarlo.")}
          </p>
        ) : null}
      </div>
    </EmptyState>
  )
}

/** Los tres interruptores de «Tus mensajes» y la fila fija de los avisos (ADR 0040). */
const MESSAGE_SWITCHES: {
  purpose: Exclude<MessageChoice, "ninguno">
  title: string
  detail: (clinicName: string) => string
}[] = [
  {
    purpose: "recordatorio",
    title: "Recordatorios de tus citas",
    detail: () => "Te avisamos un día antes y unas horas antes.",
  },
  {
    purpose: "seguimiento",
    title: "Controles y seguimiento",
    detail: () => "Cuándo te toca tu control, o si faltaste a una cita.",
  },
  {
    purpose: "novedades",
    title: "Novedades y promociones",
    detail: (clinicName) => `Campañas y ofertas de ${clinicName}.`,
  },
]

function MessagesStep({
  slug,
  token,
  clinicName,
  messages,
  onChanged,
}: {
  slug: string
  token: string
  clinicName: string
  messages: PersonalLinkMessages
  onChanged: () => void
}) {
  const uid = useId()
  const [current, setCurrent] = useState(messages)
  const [confirmNothing, setConfirmNothing] = useState(false)
  const save = useMutation({
    retry: false,
    mutationFn: (input: { tipo: MessageChoice; recibir: boolean }) =>
      chooseLinkMessages(slug, token, input),
    onSuccess: (result) => {
      setCurrent(result.data)
      setConfirmNothing(false)
      onChanged()
    },
  })
  const error = problemOf(save.error, "No pudimos guardar lo que elegiste.")
  // El error se dice donde se tocó: en su interruptor, en «Volver a recibir» o en la confirmación de «ninguno».
  const failed = save.isError ? save.variables : undefined
  return (
    <div className="flex flex-col gap-4">
      {current.nothing ? (
        <div role="status" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <p className="font-medium">No te enviaremos ningún mensaje de {clinicName}.</p>
          <p className="text-sm text-muted-foreground">
            Tampoco los avisos de tus citas: si algo cambia, te llamaremos.
          </p>
          <Button
            type="button"
            className="min-h-11 self-start"
            disabled={save.isPending}
            onClick={() => save.mutate({ tipo: "ninguno", recibir: true })}
          >
            {save.isPending ? "Guardando…" : "Volver a recibir mensajes"}
          </Button>
          {failed?.tipo === "ninguno" && failed.recibir ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col divide-y rounded-2xl border bg-card">
        {MESSAGE_SWITCHES.map((item) => {
          const labelId = `${uid}-${item.purpose}`
          const errorId = `${labelId}-error`
          const itemError = failed?.tipo === item.purpose ? error : null
          const on = current[item.purpose]
          return (
            <li key={item.purpose} className="flex items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p id={labelId} className="font-medium">
                  {item.title}
                </p>
                <p className="text-sm text-muted-foreground">{item.detail(clinicName)}</p>
                {itemError ? (
                  <p id={errorId} role="alert" className="text-sm text-destructive">
                    {itemError}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm text-muted-foreground" aria-hidden>
                  {on ? "Encendido" : "Apagado"}
                </span>
                <Switch
                  aria-labelledby={labelId}
                  aria-invalid={itemError ? true : undefined}
                  aria-describedby={itemError ? errorId : undefined}
                  checked={on}
                  disabled={save.isPending}
                  onCheckedChange={(recibir: boolean) =>
                    save.mutate({ tipo: item.purpose, recibir })
                  }
                />
              </div>
            </li>
          )
        })}
        <li className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Avisos de tus citas y papeles</p>
            <p className="text-sm text-muted-foreground">
              Si tu cita se reserva, cambia o se cancela, y cuando tu presupuesto o tu receta están
              listos. Siempre te llegan, porque son parte de tu atención.
            </p>
          </div>
          <span className="shrink-0 text-sm font-medium">{current.nothing ? "No" : "Siempre"}</span>
        </li>
      </ul>
      {!current.nothing ? (
        <Button
          type="button"
          variant="link"
          className="h-auto min-h-11 self-start p-0 text-destructive"
          disabled={save.isPending}
          onClick={() => setConfirmNothing(true)}
        >
          No quiero ningún mensaje de {clinicName}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmNothing}
        onClose={() => setConfirmNothing(false)}
        title={`¿No quieres ningún mensaje de ${clinicName}?`}
        description="Tampoco te llegarán los avisos de tus citas y papeles. Si tu cita cambia, te llamaremos."
        confirmLabel="Sí, no quiero ninguno"
        pending={save.isPending}
        error={failed?.tipo === "ninguno" && !failed.recibir ? error : null}
        onConfirm={() => save.mutate({ tipo: "ninguno", recibir: false })}
      />
    </div>
  )
}

/** Recién reservada y sin nada más pendiente: la confirmación de siempre. */
function BookedOnly({
  view,
  appointment,
  slug,
  token,
}: {
  view: PersonalLinkView
  appointment: BookingAppointment
  slug: string
  token: string
}) {
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
        <h1 className="text-xl font-semibold">Tu cita quedó reservada</h1>
      </header>
      <div className="flex flex-col gap-4">
        <div
          role="status"
          className="flex flex-col items-center gap-1 rounded-2xl bg-success-soft p-6 text-center"
        >
          <CalendarCheck className="mb-1 size-8 text-success" aria-hidden />
          <p className="text-lg font-semibold">
            {longDay(appointment.startsAt, appointment.timeZone)},{" "}
            {timeLabel(appointment.startsAt, appointment.timeZone)}
          </p>
          <p className="text-sm">
            {[appointment.serviceName ?? "Consulta", `${appointment.durationMin} minutos`].join(
              " · ",
            )}
          </p>
        </div>
        <AppointmentBlock
          title="Tu cita"
          appointment={appointment}
          onAddToCalendar={() => downloadLinkCalendar(slug, token)}
          canChange={false}
          canConfirm={false}
          confirming={false}
          cancelling={false}
          error={null}
          onChange={() => {}}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
        <p className="text-sm text-muted-foreground">
          {`${confirmWords(view.confirmVia).trim()}${view.remindersVia === "whatsapp" ? " Te escribiremos por WhatsApp sobre tu cita: los recordatorios y los cambios." : view.remindersVia === "correo" ? " Te escribiremos por correo sobre tu cita: los recordatorios y los cambios." : ""} Ya puedes volver a la conversación.`.trim()}
        </p>
      </div>
    </PageShell>
  )
}

/** «Ver y responder»; al aceptar algo, ofrece «Elegir horario» aquí mismo o «Después». */
function BudgetStep({
  slug,
  token,
  budgetId,
  budget,
  onAnswered,
}: {
  slug: string
  token: string
  budgetId: string
  budget: PersonalLinkView["budgets"][number]
  /** `later`: aceptó algo y lo agenda después. */
  onAnswered: (toSchedule: Array<{ planItemId: string; title: string }>, later: boolean) => void
}) {
  const [answered, setAnswered] = useState<Array<{ planItemId: string; title: string }> | null>(
    null,
  )
  const prompt = useRef<HTMLParagraphElement>(null)
  const answer = useMutation({
    retry: false,
    mutationFn: (input: BudgetAnswer) => answerLinkBudget(slug, token, budgetId, input),
    onSuccess: (result) => {
      if (result.data.toSchedule.length === 0) {
        onAnswered([], false)
        return
      }
      setAnswered(result.data.toSchedule)
    },
  })
  useEffect(() => {
    if (!answered) return
    window.scrollTo({ top: 0 })
    prompt.current?.focus()
  }, [answered])
  if (answered) {
    const what =
      answered.length === 1
        ? (answered[0]?.title.toLowerCase() ?? "tu tratamiento")
        : `tus ${answered.length} tratamientos`
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft p-6 text-center"
      >
        <CircleCheck className="size-10 text-success" aria-hidden />
        <p ref={prompt} tabIndex={-1} className="text-lg font-semibold outline-none">
          ¡Listo! ¿Reservamos {what}?
        </p>
        <p className="text-sm">
          Elige tu horario aquí mismo. Aceptar no es pagar: pagas en la clínica.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button type="button" className="min-h-11" onClick={() => onAnswered(answered, false)}>
            Elegir horario
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onAnswered(answered, true)}
          >
            Después
          </Button>
        </div>
      </div>
    )
  }
  return (
    <BudgetResponder
      budget={budget}
      pending={answer.isPending}
      error={problemOf(answer.error, "No pudimos guardar tu respuesta.")}
      onAnswer={(input) => answer.mutate(input)}
    />
  )
}
