import { Badge, Button } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, internationalText, LoadingState, PageShell } from "@odentia/ui-patterns"
import { Switch } from "@odentia/ui/components/switch"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CalendarCheck, ChevronLeft, FileDown } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { AppointmentBlock } from "../../components/public/appointment-block"
import { type BookingPick, ChooseAppointment } from "../../components/public/choose-appointment"
import { type BudgetAnswer, BudgetResponder } from "../../components/public/budget-responder"
import { LinkConsentStep, LinkQuestionnaireStep } from "../../components/public/link-steps"
import { PersonalDataForm } from "../../components/public/personal-data-form"
import { capital, longDay, timeLabel } from "../../components/public/week-slots"
import { ApiError } from "../../lib/api"
import {
  answerLinkBudget,
  type BookingAppointment,
  cancelBooking,
  chooseLinkMessages,
  confirmBooking,
  fetchBookingLink,
  downloadLinkCalendar,
  downloadLinkPaper,
  type MessageChoice,
  type PersonalLinkMessages,
  type PersonalLinkView,
} from "../../lib/booking-link"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { activeOrgLocale, activeOrgTimeZone, setOrgLocale } from "../../lib/locale"
import { formatPortalMoney } from "../../lib/portal"

/**
 * «Su enlace» (ADR 0037): la página personal de cada persona. Muestra lo
 * mismo que se le mandaría por su chat, una cosa a la vez: su cita, sus datos
 * por completar, el presupuesto que se le envió, el consentimiento por firmar
 * y el cuestionario. Nunca la historia ni lo guardado. Es pública y personal a
 * la vez: no hay sesión, y lo que se puede hacer lo decide el enlace. Uno por
 * persona; cada cosa deja de servir cuando ya no hace falta, y el enlace
 * entero cuando no le queda nada pendiente.
 *
 * El enlace que envía el agente para reservar lleva directo a elegir la cita
 * (`ChooseAppointment`): con quién, el día y la hora en una pantalla y, al
 * revisar, sus datos (los de quien aún no es paciente, o lo que le falta a
 * quien ya lo es). Si ya eligió la hora en el chat, el enlace la trae (`sede`,
 * `con`, `hora`). Cada enlace abre lo que dice su mensaje: reservar, sus datos
 * o, con `#mensajes`, sus mensajes.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Un instante ISO 8601 con su zona (`2026-11-03T09:00:00-05:00`). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** La hora que eligió en el chat: las tres partes juntas y bien escritas, o nada. */
function pickOf(search: { sede?: string; con?: string; hora?: string }): BookingPick | null {
  const { sede, con } = search
  // Un «+» de la zona sin codificar llega como espacio.
  const hora = search.hora?.replace(/ (\d{2}:\d{2})$/, "+$1")
  if (!sede || !con || !hora || !UUID.test(sede) || con.length > 200 || !INSTANT.test(hora) || Number.isNaN(Date.parse(hora))) return null
  return { branchId: sede, professionalUserId: con, startsAt: hora }
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export const Route = createFileRoute("/reserva")({
  validateSearch: (search: Record<string, unknown>): { token?: string; sede?: string; con?: string; hora?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    sede: text(search.sede),
    con: text(search.con),
    hora: text(search.hora),
  }),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PersonalLinkPage,
})

/** Lo que se está haciendo en la página: el resumen o una sola cosa. */
type Screen =
  | { kind: "pendiente" }
  | { kind: "elegir"; mode: "reservar" | "cambiar" | "tratamiento"; planItems?: Array<{ planItemId: string; title: string }> }
  | { kind: "datos" }
  | { kind: "presupuesto"; budgetId: string }
  | { kind: "agendar"; items: Array<{ planItemId: string; title: string }> }
  | { kind: "consentimiento"; consentId: string }
  | { kind: "cuestionario" }
  /** «Tus mensajes» (ADR 0040): llega directo con `#mensajes` («Elegir mis mensajes», el pie del correo). */
  | { kind: "mensajes" }

function Expired() {
  return (
    <PageShell maxWidth="md">
      <EmptyState title="Este enlace ya no sirve" description="Responde el mensaje y te enviamos uno nuevo." />
    </PageShell>
  )
}

function problemOf(error: unknown, fallback: string): string | null {
  if (!error) return null
  if (error instanceof ApiError) return error.shape.message ?? fallback
  return `${fallback} Revisa tu conexión y vuelve a intentarlo.`
}

function PersonalLinkPage() {
  const search = Route.useSearch()
  const { token } = search
  // La hora que eligió en el chat se lee al abrir: después manda lo que elija aquí.
  const [pick] = useState(() => pickOf(search))
  const queryClient = useQueryClient()
  const slug = orgSlugFromHostname(requestHostname())
  const ready = typeof window !== "undefined" && slug !== null && token !== undefined
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
  // Lo que se está haciendo en la página. `null` hasta que llega el enlace: entonces se abre lo que dice su
  // mensaje. «Elegir mis mensajes» (el pie del correo) lleva `#mensajes` y abre siempre «Tus mensajes».
  const [chosenScreen, setScreen] = useState<Screen | null>(() =>
    typeof window !== "undefined" && window.location.hash === "#mensajes" ? { kind: "mensajes" } : null,
  )
  // La cita recién reservada o cambiada, mientras la vista se actualiza.
  const [booked, setBooked] = useState<BookingAppointment | null>(null)
  // Ya hizo algo aquí: si eso era lo último, se le dice «listo» en vez de «ya no sirve».
  const [didSomething, setDidSomething] = useState(false)
  // Lo que acaba de pasar con su cita: el título lo dice en vez del saludo.
  const [news, setNews] = useState<"reservada" | "cambiada" | "cancelada" | "confirmada" | null>(null)
  // Recién reservada: se espera la vista al día para abrir lo que sigue.
  const [landing, setLanding] = useState(false)
  const refresh = () => {
    setDidSomething(true)
    void queryClient.invalidateQueries({ queryKey: viewKey })
  }
  const back = () => {
    setScreen({ kind: "pendiente" })
    refresh()
    window.scrollTo({ top: 0 })
  }
  /** Después de reservar: si aún falta algo de sus datos, directo a «Tus datos»; si no, «Tu cita quedó reservada». */
  const land = async (result: BookingAppointment) => {
    setBooked(result)
    setNews("reservada")
    setDidSomething(true)
    setLanding(true)
    try {
      const fresh = await queryClient.fetchQuery({ queryKey: viewKey, queryFn: fetchView, staleTime: 0 })
      const missing = fresh.data.status === "abierto" ? (fresh.data.data?.missing.length ?? 0) : 0
      setScreen(missing > 0 ? { kind: "datos" } : { kind: "pendiente" })
    } catch {
      setScreen({ kind: "pendiente" })
    } finally {
      setLanding(false)
      window.scrollTo({ top: 0 })
    }
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

  if (!ready && typeof window !== "undefined") return <Expired />
  if (viewQuery.isPending || landing) {
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message={landing ? "Abriendo tu cita…" : "Abriendo tu enlace…"} />
      </PageShell>
    )
  }
  if (viewQuery.isError || !view) {
    if (viewQuery.error instanceof ApiError && (viewQuery.error.status === 404 || viewQuery.error.shape.code === "BOOKING_LINK_EXPIRED")) return <Expired />
    return (
      <PageShell maxWidth="md">
        <ErrorState title="No pudimos abrir el enlace" message="Revisa tu conexión y vuelve a intentarlo." onRetry={() => void viewQuery.refetch()} />
      </PageShell>
    )
  }
  if (slug === null || token === undefined) return <Expired />

  const appointment = booked ?? view.appointment
  if (view.status !== "abierto") {
    if (booked && !booked.cancelled) return <BookedOnly view={view} appointment={booked} slug={slug} token={token} />
    if (booked?.cancelled) {
      return (
        <PageShell maxWidth="md">
          <EmptyState
            title="Tu cita quedó cancelada"
            description={`${longDay(booked.startsAt, booked.timeZone)}, ${timeLabel(booked.startsAt, booked.timeZone)}. Si quieres otra, escríbenos por el chat.`}
          />
        </PageShell>
      )
    }
    if (didSomething) {
      return (
        <PageShell maxWidth="md">
          <EmptyState title="Listo, no te queda nada pendiente" description="Gracias. Ya puedes volver a la conversación." />
        </PageShell>
      )
    }
    return <Expired />
  }

  const missing = view.data?.missing ?? []
  const offersBooking = !!view.booking && !appointment
  // Al abrir: reservar si el enlace lo ofrece; si no, «Tus datos» si le falta algo; si no, el resumen.
  const opened: Screen = !offersBooking && missing.length > 0 ? { kind: "datos" } : { kind: "pendiente" }
  if (chosenScreen === null) setScreen(opened)
  const screen = chosenScreen ?? opened
  const activeAppointment = appointment && !appointment.cancelled ? appointment : null
  // El mismo nombre para volver desde cada pantalla.
  const backLabel = activeAppointment ? "Ver mi cita" : "Lo pendiente"

  const one = (title: string, body: ReactNode, subtitle?: string | null) => (
    <PageShell maxWidth="md">
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </header>
        <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0" onClick={back}>
          <ChevronLeft className="size-4" aria-hidden />
          {backLabel}
        </Button>
        {body}
      </div>
    </PageShell>
  )

  if (screen.kind === "mensajes") {
    if (!view.messages) {
      return one(
        "Tus mensajes",
        <EmptyState
          title="Desde este enlace no se eligen los mensajes"
          description="Los elige quien los recibe. Si eres tú, escríbenos por el chat."
          actionLabel={backLabel}
          onAction={back}
        />,
      )
    }
    return one(`Tus mensajes · ${view.clinicName}`, <MessagesStep slug={slug} token={token} clinicName={view.clinicName} messages={view.messages} onChanged={refresh} />)
  }

  // El enlace del agente para reservar: directo a elegir día y hora (o a revisar, si ya la eligió en el chat).
  if (offersBooking) {
    return (
      <PageShell>
        <ChooseAppointment view={view} slug={slug} token={token} mode="reservar" current={null} pick={pick} onBack={null} onDone={(result) => void land(result)} />
      </PageShell>
    )
  }

  if (screen.kind === "elegir" || screen.kind === "agendar") {
    const mode = screen.kind === "agendar" ? "tratamiento" : screen.mode
    return (
      <PageShell>
        <ChooseAppointment
          view={view}
          slug={slug}
          token={token}
          mode={mode}
          current={mode === "cambiar" ? appointment : null}
          planItems={screen.kind === "agendar" ? screen.items : screen.planItems}
          onBack={back}
          onDone={(result) => {
            if (mode !== "cambiar") {
              void land(result)
              return
            }
            setBooked(result)
            setNews("cambiada")
            back()
          }}
        />
      </PageShell>
    )
  }

  if (screen.kind === "datos") {
    const healthOnly = missing.length === 0 && !!view.data?.health
    const withHealth = view.data?.health && !healthOnly
    const title = view.patientFirstName
      ? healthOnly
        ? `La salud de ${view.patientFirstName}`
        : `Los datos de ${view.patientFirstName}${withHealth ? " y su salud" : ""}`
      : healthOnly
        ? "Tu salud"
        : withHealth
          ? "Tus datos y tu salud"
          : "Tus datos"
    const when = activeAppointment
      ? `${longDay(activeAppointment.startsAt, activeAppointment.timeZone).toLowerCase()}, ${timeLabel(activeAppointment.startsAt, activeAppointment.timeZone)}`
      : null
    const line = activeAppointment
      ? `Te esperamos el ${longDay(activeAppointment.startsAt, activeAppointment.timeZone).toLowerCase()} a las ${timeLabel(activeAppointment.startsAt, activeAppointment.timeZone)}.`
      : null
    return one(
      title,
      <PersonalDataForm
        slug={slug}
        token={token}
        clinicName={view.clinicName}
        appointmentLine={line}
        backLabel={backLabel}
        onDone={() => {
          refresh()
          back()
        }}
      />,
      when ? `Para ${view.patientFirstName ? "la" : "tu"} cita del ${when}` : null,
    )
  }
  if (screen.kind === "consentimiento") {
    return one("Tu consentimiento", <LinkConsentStep slug={slug} token={token} consentId={screen.consentId} onBack={back} />)
  }
  if (screen.kind === "cuestionario") {
    return one("Antes de tu cita", <LinkQuestionnaireStep slug={slug} token={token} onBack={back} />)
  }
  if (screen.kind === "presupuesto") {
    const budget = view.budgets.find((item) => item.id === screen.budgetId)
    if (!budget) return one("Tu presupuesto", <EmptyState title="Este presupuesto ya está respondido" description="Gracias. Lo demás sigue en lo pendiente." actionLabel={backLabel} onAction={back} />)
    return one(
      `Tu presupuesto · ${view.clinicName}`,
      <BudgetStep
        slug={slug}
        token={token}
        budgetId={budget.id}
        budget={budget}
        backLabel={backLabel}
        onAnswered={(toSchedule) => {
          refresh()
          setScreen(toSchedule.length > 0 ? { kind: "agendar", items: toSchedule } : { kind: "pendiente" })
        }}
      />,
    )
  }

  // Lo pendiente: una tarjeta por cosa.
  const cancelError = problemOf(cancel.error, "No pudimos cancelar la cita.")
  const confirmError = problemOf(confirm.error, "No pudimos confirmar la cita.")
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
        <h1 className="text-xl font-semibold">{news ? `Tu cita quedó ${news}` : view.firstName ? `Hola, ${view.firstName}` : "Hola"}</h1>
        {news === "reservada" ? <p className="text-sm text-muted-foreground">Te lo confirmamos también por el chat.</p> : null}
        {view.patientFirstName ? <p className="text-sm text-muted-foreground">Lo pendiente de {view.patientFirstName}.</p> : null}
      </header>
      <div className="flex flex-col gap-4">
        {activeAppointment ? (
          <AppointmentBlock
            title="Tu cita"
            appointment={activeAppointment}
            onAddToCalendar={() => downloadLinkCalendar(slug, token)}
            canChange={activeAppointment.canChange}
            canConfirm={activeAppointment.canConfirm}
            confirming={confirm.isPending}
            cancelling={cancel.isPending}
            error={cancelError ?? confirmError}
            onChange={() => setScreen({ kind: "elegir", mode: "cambiar" })}
            onCancel={() => cancel.mutate()}
            onConfirm={() => confirm.mutate()}
          />
        ) : null}
        {appointment?.cancelled ? (
          <p role="status" className="rounded-2xl border bg-card p-4 text-sm">
            Tu cita del {longDay(appointment.startsAt, appointment.timeZone).toLowerCase()} quedó cancelada.
          </p>
        ) : null}
        {missing.length > 0 ? (
          <Block
            title={
              view.patientFirstName
                ? `Los datos de ${view.patientFirstName}${view.data?.health ? " y su salud" : ""}`
                : view.data?.health
                  ? "Tus datos y tu salud"
                  : "Tus datos"
            }
            badge={missing.length === 1 ? "Falta 1" : `Faltan ${missing.length}`}
            text={`${capital(missing.map((item) => item.label.toLowerCase()).join(", "))}${view.data?.health ? `; y ${healthAsk(view.patientFirstName)}` : ""}.`}
            action="Completar"
            onAction={() => setScreen({ kind: "datos" })}
          />
        ) : view.data?.health ? (
          // Solo queda su salud: opcional, ayuda a quien la atiende.
          <Block
            title={view.patientFirstName ? `La salud de ${view.patientFirstName}` : "Tu salud"}
            badge="Opcional"
            text={`${capital(healthAsk(view.patientFirstName))}, cuéntanoslo antes de venir.`}
            action="Responder"
            onAction={() => setScreen({ kind: "datos" })}
          />
        ) : null}
        {view.budgets.map((budget) => (
          <Block
            key={budget.id}
            title="Tu presupuesto"
            badge="Por responder"
            text={`${budget.title} · ${formatPortalMoney(budget.totalCents, budget.currency, budget.locale)}`}
            action="Ver y responder"
            onAction={() => setScreen({ kind: "presupuesto", budgetId: budget.id })}
          />
        ))}
        {view.consents.map((consent) => (
          <Block
            key={consent.id}
            title="Tu consentimiento"
            badge="Por firmar"
            text={consent.title}
            action="Leer y firmar"
            onAction={() => setScreen({ kind: "consentimiento", consentId: consent.id })}
          />
        ))}
        {view.questionnaire ? (
          <Block
            title="Antes de tu cita"
            badge="Por responder"
            text={view.questionnaire.title}
            action="Responder"
            onAction={() => setScreen({ kind: "cuestionario" })}
          />
        ) : null}
        {view.papers.length > 0 ? <Papers slug={slug} token={token} papers={view.papers} /> : null}
        {view.messages ? (
          <section aria-label="Tus mensajes" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
            <h2 className="font-semibold">Tus mensajes</h2>
            <p className="text-sm">{messagesSummary(view.messages, view.clinicName, view.you?.phone ?? null, view.pending ? !view.pending.promotions : null)}</p>
            <Button type="button" variant="outline" className="min-h-11 self-start" onClick={() => setScreen({ kind: "mensajes" })}>
              Cambiar mis mensajes
            </Button>
          </section>
        ) : null}
        <p className="text-sm text-muted-foreground">No mostramos nada de lo que ya tenemos guardado. Si te enviamos algo nuevo, aparece aquí mismo.</p>
      </div>
    </PageShell>
  )
}

/** Lo que se pregunta de su salud, de quien se atiende: de ella misma o, con su nombre, de su hijo. */
function healthAsk(patientFirstName: string | null | undefined): string {
  return patientFirstName
    ? `si ${patientFirstName} tiene alergias, alguna enfermedad o toma medicamentos`
    : "si tienes alergias, alguna enfermedad o tomas medicamentos"
}

/**
 * Lo que eligió de «Tus mensajes», dicho corto: los mensajes de sus citas y su
 * respuesta a novedades (nada si nunca respondió o no se sabe).
 */
function messagesSummary(messages: PersonalLinkMessages, clinicName: string, phone: string | null, promotionsAnswered: boolean | null): string {
  if (messages.nothing) return `Pediste no recibir ningún mensaje de ${clinicName}.`
  const parts: string[] = []
  if (messages.recordatorio) parts.push(`Te escribimos por WhatsApp${phone ? ` al ${internationalText(phone)}` : ""} sobre tus citas.`)
  if (messages.novedades) parts.push("Novedades y promociones: sí.")
  else if (promotionsAnswered) parts.push("Novedades y promociones: no.")
  return parts.length > 0 ? parts.join(" ") : `Elige qué mensajes quieres recibir de ${clinicName}.`
}

function Block({ title, badge, text, action, onAction }: { title: string; badge: string; text: string; action: string; onAction: () => void }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <Badge variant="secondary">{badge}</Badge>
      </div>
      <p className="text-sm">{text}</p>
      <Button type="button" className="min-h-11 self-start" onClick={onAction}>
        {action}
      </Button>
    </section>
  )
}

/** «16 de octubre», en el formato y la zona de la clínica. */
function paperDay(iso: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone: activeOrgTimeZone(), day: "numeric", month: "long" }).format(new Date(iso))
}

/**
 * «Tus papeles» (decisión 8): la receta y el comprobante de los últimos 30
 * días, para descargar. Pasados los 30 días se le piden a la clínica.
 */
function Papers({ slug, token, papers }: { slug: string; token: string; papers: PersonalLinkView["papers"] }) {
  const download = useMutation({
    mutationFn: (paper: PersonalLinkView["papers"][number]) => downloadLinkPaper(slug, token, paper),
  })
  const busy = download.isPending ? download.variables : null
  return (
    <section aria-label="Tus papeles" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <h2 className="font-semibold">Tus papeles</h2>
      <ul className="flex flex-col divide-y">
        {papers.map((paper) => (
          <li key={`${paper.kind}:${paper.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{paper.title}</span>
              <span className="text-sm text-muted-foreground">
                {capital(paperDay(paper.issuedAt))} · disponible hasta el {paperDay(paper.availableUntil)}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy?.id === paper.id && busy.kind === paper.kind}
              onClick={() => download.mutate(paper)}
            >
              <FileDown className="size-4" aria-hidden />
              {busy?.id === paper.id && busy.kind === paper.kind ? "Descargando…" : "Descargar"}
            </Button>
          </li>
        ))}
      </ul>
      {download.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pudimos descargar el papel. Inténtalo de nuevo o pídeselo a la clínica.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">Cada papel queda aquí 30 días. Después, pídeselo a la clínica.</p>
    </section>
  )
}

/** Los tres interruptores de «Tus mensajes» y la fila fija de los avisos (ADR 0040). */
const MESSAGE_SWITCHES: { purpose: Exclude<MessageChoice, "ninguno">; title: string; detail: (clinicName: string) => string }[] = [
  { purpose: "recordatorio", title: "Recordatorios de tus citas", detail: () => "Te avisamos un día antes y unas horas antes." },
  { purpose: "seguimiento", title: "Controles y seguimiento", detail: () => "Cuándo te toca tu control, o si faltaste a una cita." },
  { purpose: "novedades", title: "Novedades y promociones", detail: (clinicName) => `Campañas y ofertas de ${clinicName}.` },
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
    mutationFn: (input: { tipo: MessageChoice; recibir: boolean }) => chooseLinkMessages(slug, token, input),
    onSuccess: (result) => {
      setCurrent(result.data)
      setConfirmNothing(false)
      onChanged()
    },
  })
  const error = problemOf(save.error, "No pudimos guardar lo que elegiste.")
  return (
    <div className="flex flex-col gap-4">
      {current.nothing ? (
        <div role="status" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <p className="font-medium">No te enviaremos ningún mensaje de {clinicName}.</p>
          <p className="text-sm text-muted-foreground">Tampoco los avisos de tus citas: si algo cambia, te llamaremos.</p>
          <Button
            type="button"
            className="min-h-11 self-start"
            disabled={save.isPending}
            onClick={() => save.mutate({ tipo: "ninguno", recibir: true })}
          >
            {save.isPending ? "Guardando…" : "Volver a recibir mensajes"}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col divide-y rounded-2xl border bg-card">
        {MESSAGE_SWITCHES.map((item) => {
          const labelId = `${uid}-${item.purpose}`
          const on = current[item.purpose]
          return (
            <li key={item.purpose} className="flex items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p id={labelId} className="font-medium">
                  {item.title}
                </p>
                <p className="text-sm text-muted-foreground">{item.detail(clinicName)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm text-muted-foreground" aria-hidden>
                  {on ? "Encendido" : "Apagado"}
                </span>
                <Switch
                  aria-labelledby={labelId}
                  checked={on}
                  disabled={save.isPending}
                  onCheckedChange={(recibir: boolean) => save.mutate({ tipo: item.purpose, recibir })}
                />
              </div>
            </li>
          )
        })}
        <li className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Avisos de tus citas y papeles</p>
            <p className="text-sm text-muted-foreground">
              Si tu cita se reserva, cambia o se cancela, y cuando tu presupuesto o tu receta están listos. Siempre te llegan, porque
              son parte de tu atención.
            </p>
          </div>
          <span className="shrink-0 text-sm font-medium">{current.nothing ? "No" : "Siempre"}</span>
        </li>
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
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
        onConfirm={() => save.mutate({ tipo: "ninguno", recibir: false })}
      />
    </div>
  )
}

/** Recién reservada y sin nada más pendiente: la confirmación de siempre. */
function BookedOnly({ view, appointment, slug, token }: { view: PersonalLinkView; appointment: BookingAppointment; slug: string; token: string }) {
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
        <h1 className="text-xl font-semibold">Tu cita quedó reservada</h1>
      </header>
      <div className="flex flex-col gap-4">
        <div role="status" className="flex flex-col items-center gap-1 rounded-2xl bg-success-soft p-6 text-center">
          <CalendarCheck className="mb-1 size-8 text-success" aria-hidden />
          <p className="text-lg font-semibold">
            {longDay(appointment.startsAt, appointment.timeZone)}, {timeLabel(appointment.startsAt, appointment.timeZone)}
          </p>
          <p className="text-sm">{[appointment.serviceName ?? "Consulta", `${appointment.durationMin} minutos`].join(" · ")}</p>
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
          Te lo confirmamos también por el chat. Te escribiremos por WhatsApp sobre tu cita: los recordatorios y los cambios. Ya puedes volver a la conversación.
        </p>
      </div>
    </PageShell>
  )
}

/** «Ver y responder»; al aceptar algo, ofrece «Elegir horario» aquí mismo. */
function BudgetStep({
  slug,
  token,
  budgetId,
  budget,
  backLabel,
  onAnswered,
}: {
  slug: string
  token: string
  budgetId: string
  budget: PersonalLinkView["budgets"][number]
  /** El nombre de volver, el mismo de toda la página. */
  backLabel: string
  onAnswered: (toSchedule: Array<{ planItemId: string; title: string }>) => void
}) {
  const [answered, setAnswered] = useState<Array<{ planItemId: string; title: string }> | null>(null)
  const answer = useMutation({
    retry: false,
    mutationFn: (input: BudgetAnswer) => answerLinkBudget(slug, token, budgetId, input),
    onSuccess: (result) => setAnswered(result.data.toSchedule),
  })
  if (answered) {
    if (answered.length === 0) {
      return (
        <div role="status" className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft p-6 text-center">
          <p className="text-lg font-semibold">Gracias, recibimos tu respuesta</p>
          <p className="text-sm">Si cambias de opinión, escríbenos por el chat.</p>
          <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={() => onAnswered([])}>
            {backLabel}
          </Button>
        </div>
      )
    }
    const what = answered.length === 1 ? (answered[0]?.title.toLowerCase() ?? "tu tratamiento") : `tus ${answered.length} tratamientos`
    return (
      <div role="status" className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft p-6 text-center">
        <p className="text-lg font-semibold">¡Listo! ¿Reservamos {what}?</p>
        <p className="text-sm">Elige tu horario aquí mismo.</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button type="button" className="min-h-11" onClick={() => onAnswered(answered)}>
            Elegir horario
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onAnswered([])}>
            Después
          </Button>
        </div>
      </div>
    )
  }
  return <BudgetResponder budget={budget} pending={answer.isPending} error={problemOf(answer.error, "No pudimos guardar tu respuesta.")} onAnswer={(input) => answer.mutate(input)} />
}
