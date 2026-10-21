import { Badge, Button, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { Switch } from "@odentia/ui/components/switch"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CalendarCheck, ChevronLeft, FileDown, MapPin } from "lucide-react"
import { useId, useState } from "react"
import { type BookingDataDraft, BookingDataForm, emptyBookingDataDraft } from "../components/booking-data-form"
import { AppointmentBlock } from "../components/public/appointment-block"
import { type BudgetAnswer, BudgetResponder } from "../components/public/budget-responder"
import { LinkConsentStep, LinkQuestionnaireStep } from "../components/public/link-steps"
import { PersonalDataForm } from "../components/public/personal-data-form"
import { capital, DentistSelect, longDay, shortDay, timeLabel, useWeekSlots, type WeekSlot, WeekSlotsGrid } from "../components/public/week-slots"
import { ApiError } from "../lib/api"
import {
  answerLinkBudget,
  type BookingAppointment,
  type BookingLinkBranch,
  cancelBooking,
  changeBooking,
  chooseLinkMessages,
  confirmBooking,
  fetchBookingLink,
  fetchBookingSlots,
  downloadLinkPaper,
  type MessageChoice,
  type PersonalLinkMessages,
  type PersonalLinkView,
  reserveBooking,
} from "../lib/booking-link"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { activeOrgLocale, activeOrgTimeZone, setOrgLocale } from "../lib/locale"
import { formatPortalMoney } from "../lib/portal"

/**
 * «Su enlace» (ADR 0037): la página personal de cada persona. Muestra lo
 * mismo que se le mandaría por su chat, una cosa a la vez: su cita, sus datos
 * por completar, el presupuesto que se le envió, el consentimiento por firmar
 * y el cuestionario. Nunca la historia ni lo guardado. Es pública y personal a
 * la vez: no hay sesión, y lo que se puede hacer lo decide el enlace. Uno por
 * persona; cada cosa deja de servir cuando ya no hace falta, y el enlace
 * entero cuando no le queda nada pendiente.
 *
 * El enlace que envía el agente para reservar sigue igual: elegir día y hora
 * en la semana de horarios y, si aún no es paciente, dejar sus datos.
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

const EXPIRED_TEXT = "Este enlace ya no sirve. Responde el mensaje y te enviamos uno nuevo."

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
  const { token } = Route.useSearch()
  const queryClient = useQueryClient()
  const slug = orgSlugFromHostname(requestHostname())
  const ready = typeof window !== "undefined" && slug !== null && token !== undefined
  const viewKey = ["booking-link", slug, token ?? null]
  const viewQuery = useQuery({
    queryKey: viewKey,
    queryFn: () => fetchBookingLink(slug ?? "", token ?? ""),
    enabled: ready,
    retry: false,
  })
  const view = viewQuery.data?.data
  // Página pública, sin layout de organización: el formato regional y el país
  // de la clínica llegan con el enlace y se fijan antes de pintar fechas y horas.
  if (view) setOrgLocale(view.locale, undefined, view.countryCode)
  const [screen, setScreen] = useState<Screen>(() =>
    typeof window !== "undefined" && window.location.hash === "#mensajes" ? { kind: "mensajes" } : { kind: "pendiente" },
  )
  // La cita recién reservada o cambiada, mientras la vista se actualiza.
  const [booked, setBooked] = useState<BookingAppointment | null>(null)
  // Ya hizo algo aquí: si eso era lo último, se le dice «listo» en vez de «ya no sirve».
  const [didSomething, setDidSomething] = useState(false)
  // Lo que acaba de pasar con su cita: el título lo dice en vez del saludo.
  const [news, setNews] = useState<"reservada" | "cambiada" | "cancelada" | "confirmada" | null>(null)
  const refresh = () => {
    setDidSomething(true)
    void queryClient.invalidateQueries({ queryKey: viewKey })
  }
  const back = () => {
    setScreen({ kind: "pendiente" })
    refresh()
    window.scrollTo({ top: 0 })
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
  if (viewQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message="Abriendo tu enlace…" />
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

  // El enlace del agente para reservar: directo a elegir día y hora.
  if (view.booking && !appointment) {
    return (
      <ChooseSlot
        view={view}
        slug={slug}
        token={token}
        mode="reservar"
        current={null}
        onBack={null}
        onDone={(result) => {
          setBooked(result)
          setNews("reservada")
          refresh()
        }}
      />
    )
  }

  if (screen.kind === "elegir" || screen.kind === "agendar") {
    const mode = screen.kind === "agendar" ? "tratamiento" : screen.mode
    return (
      <ChooseSlot
        view={view}
        slug={slug}
        token={token}
        mode={mode}
        current={mode === "cambiar" ? appointment : null}
        planItems={screen.kind === "agendar" ? screen.items : screen.planItems}
        onBack={back}
        onDone={(result) => {
          setBooked(result)
          setNews(mode === "cambiar" ? "cambiada" : "reservada")
          back()
        }}
      />
    )
  }

  const one = (title: string, body: React.ReactNode) => (
    <PageShell maxWidth="md">
      <div className="flex flex-col gap-4">
        <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0" onClick={back}>
          <ChevronLeft className="size-4" aria-hidden />
          Lo pendiente
        </Button>
        <header className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
          <h1 className="text-xl font-semibold">{title}</h1>
        </header>
        {body}
      </div>
    </PageShell>
  )

  if (screen.kind === "datos") {
    const withHealth = view.data?.health ? " y su salud" : ""
    const line = appointment && !appointment.cancelled ? `Te esperamos el ${longDay(appointment.startsAt, appointment.timeZone).toLowerCase()} a las ${timeLabel(appointment.startsAt, appointment.timeZone)}.` : null
    return one(
      view.patientFirstName ? `Los datos de ${view.patientFirstName}${withHealth}` : view.data?.health ? "Tus datos y tu salud" : "Tus datos",
      <PersonalDataForm
        slug={slug}
        token={token}
        clinicName={view.clinicName}
        appointmentLine={line}
        onDone={() => {
          refresh()
          back()
        }}
      />,
    )
  }
  if (screen.kind === "consentimiento") {
    return one("Tu consentimiento", <LinkConsentStep slug={slug} token={token} consentId={screen.consentId} onBack={back} />)
  }
  if (screen.kind === "cuestionario") {
    return one("Antes de tu cita", <LinkQuestionnaireStep slug={slug} token={token} onBack={back} />)
  }
  if (screen.kind === "mensajes") {
    if (!view.messages) {
      return one(
        "Tus mensajes",
        <EmptyState
          title="Desde este enlace no se eligen los mensajes"
          description="Los elige quien los recibe. Si eres tú, escríbenos por el chat."
          actionLabel="Volver a lo pendiente"
          onAction={back}
        />,
      )
    }
    return one(`Tus mensajes · ${view.clinicName}`, <MessagesStep slug={slug} token={token} messages={view.messages} onChanged={refresh} />)
  }
  if (screen.kind === "presupuesto") {
    const budget = view.budgets.find((item) => item.id === screen.budgetId)
    if (!budget) return one("Tu presupuesto", <EmptyState title="Este presupuesto ya está respondido" description="Gracias. Lo demás sigue en lo pendiente." actionLabel="Volver a lo pendiente" onAction={back} />)
    return one(
      `Tu presupuesto · ${view.clinicName}`,
      <BudgetStep
        slug={slug}
        token={token}
        budgetId={budget.id}
        budget={budget}
        onAnswered={(toSchedule) => {
          refresh()
          setScreen(toSchedule.length > 0 ? { kind: "agendar", items: toSchedule } : { kind: "pendiente" })
        }}
      />,
    )
  }

  // Lo pendiente: una tarjeta por cosa.
  const missing = view.data?.missing ?? []
  const cancelError = problemOf(cancel.error, "No pudimos cancelar la cita.")
  const confirmError = problemOf(confirm.error, "No pudimos confirmar la cita.")
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
        <h1 className="text-xl font-semibold">{news ? `Tu cita quedó ${news}` : view.firstName ? `Hola, ${view.firstName}` : "Hola"}</h1>
        {view.patientFirstName ? <p className="text-sm text-muted-foreground">Lo pendiente de {view.patientFirstName}.</p> : null}
      </header>
      <div className="flex flex-col gap-4">
        {appointment && !appointment.cancelled ? (
          <AppointmentBlock
            title="Tu cita"
            clinicName={view.clinicName}
            appointment={appointment}
            calendarKey={`${slug}:${token}`}
            canChange={appointment.canChange}
            canConfirm={appointment.canConfirm}
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
            text={`${capital(missing.map((item) => item.label.toLowerCase()).join(", "))}${view.data?.health ? "; y si tienes alergias, alguna enfermedad o tomas medicamentos" : ""}.`}
            action="Completar"
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
            <p className="text-sm">
              {view.messages.nothing
                ? "Pediste no recibir ningún mensaje de la clínica."
                : "Elige qué mensajes quieres recibir de la clínica."}
            </p>
            <Button type="button" variant="outline" className="min-h-11 self-start" onClick={() => setScreen({ kind: "mensajes" })}>
              Elegir mis mensajes
            </Button>
          </section>
        ) : null}
        <p className="text-sm text-muted-foreground">No mostramos nada de lo que ya tenemos guardado. Si te enviamos algo nuevo, aparece aquí mismo.</p>
      </div>
    </PageShell>
  )
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
const MESSAGE_SWITCHES: { purpose: Exclude<MessageChoice, "ninguno">; title: string; detail: string }[] = [
  { purpose: "recordatorio", title: "Recordatorios de tus citas", detail: "Te avisamos un día antes y unas horas antes." },
  { purpose: "seguimiento", title: "Controles y seguimiento", detail: "Cuándo te toca tu control, o si faltaste a una cita." },
  { purpose: "novedades", title: "Novedades y promociones", detail: "Campañas y ofertas de la clínica." },
]

function MessagesStep({
  slug,
  token,
  messages,
  onChanged,
}: {
  slug: string
  token: string
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
          <p className="font-medium">No te enviaremos ningún mensaje de la clínica.</p>
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
                <p className="text-sm text-muted-foreground">{item.detail}</p>
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
          No quiero ningún mensaje de la clínica
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmNothing}
        onClose={() => setConfirmNothing(false)}
        title="¿No quieres ningún mensaje de la clínica?"
        description="Tampoco te llegarán los avisos de tus citas y papeles. Si tu cita cambia, la clínica te llamará."
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
          clinicName={view.clinicName}
          appointment={appointment}
          calendarKey={`${slug}:${token}`}
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
          Te lo confirmamos también por el chat. Te avisaremos por WhatsApp sobre tus citas. Ya puedes volver a la conversación.
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
  onAnswered,
}: {
  slug: string
  token: string
  budgetId: string
  budget: PersonalLinkView["budgets"][number]
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
            Volver a lo pendiente
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

/**
 * Elegir día y hora: reservar (el enlace del agente), cambiar la cita o
 * agendar lo que aceptó de su presupuesto. Quien aún no es paciente deja sus
 * datos esenciales entre elegir y reservar, en una sola pantalla.
 */
function ChooseSlot({
  view,
  slug,
  token,
  mode,
  current,
  planItems,
  onBack,
  onDone,
}: {
  view: PersonalLinkView
  slug: string
  token: string
  mode: "reservar" | "cambiar" | "tratamiento"
  current: BookingAppointment | null
  planItems?: Array<{ planItemId: string; title: string }>
  onBack: (() => void) | null
  onDone: (appointment: BookingAppointment) => void
}) {
  const queryClient = useQueryClient()
  const changing = mode === "cambiar"
  const [branchChoice, setBranchChoice] = useState<string | null>(null)
  const [chosen, setChosen] = useState<WeekSlot | null>(null)
  const [editing, setEditing] = useState(false)
  const [enteringData, setEnteringData] = useState(false)
  const [dataDraft, setDataDraft] = useState<BookingDataDraft>(emptyBookingDataDraft)
  const [submissionId] = useState(() => crypto.randomUUID())
  const [registered, setRegistered] = useState(false)

  const fixedBranch = mode === "reservar" ? (view.booking?.branchId ?? null) : null
  const branch: BookingLinkBranch | undefined =
    changing && current
      ? (view.branches.find((item) => item.id === current.branchId) ?? {
          id: current.branchId,
          name: current.branchName,
          address: current.branchAddress,
          directionsUrl: current.branchDirectionsUrl,
          timeZone: current.timeZone,
          defaultMinutes: current.durationMin,
        })
      : (view.branches.find((item) => item.id === (branchChoice ?? fixedBranch)) ?? (view.branches.length === 1 ? view.branches[0] : undefined))

  const week = useWeekSlots({
    queryKey: ["booking-slots", slug, token, mode, branch?.id ?? null],
    fetchSlots: async (range) => (await fetchBookingSlots(slug, token, { branchId: branch?.id ?? "", ...range })).data,
    enabled: branch !== undefined,
    fallbackTimeZone: branch?.timeZone,
  })
  const timeZone = week.timeZone
  const refreshSlots = () => {
    setChosen(null)
    setEnteringData(false)
    week.refresh()
  }
  const act = useMutation({
    retry: false,
    mutationFn: (slot: WeekSlot) => {
      const where = { startsAt: slot.startsAt, dentistUserId: slot.dentistUserId, ...(slot.chairId ? { chairId: slot.chairId } : {}) }
      if (changing) return changeBooking(slug, { token, ...where })
      return reserveBooking(slug, {
        token,
        branchId: branch?.id ?? "",
        ...where,
        ...(mode === "tratamiento" && planItems ? { planItemIds: planItems.map((item) => item.planItemId) } : {}),
      })
    },
    onSuccess: (result) => onDone(result.data),
    onError: refreshSlots,
  })

  const needsData = mode === "reservar" && !!view.booking?.needsRegistration && !registered
  const withData = mode === "reservar" && (!!view.booking?.needsRegistration || registered)
  const serviceName =
    mode === "cambiar"
      ? (current?.serviceName ?? "Consulta")
      : mode === "tratamiento"
        ? (planItems ?? []).map((item) => item.title).join(" · ") || "Tu tratamiento"
        : (view.booking?.service?.name ?? "Consulta")
  const minutes = changing ? (current?.durationMin ?? null) : mode === "reservar" ? (view.booking?.service?.durationMin ?? branch?.defaultMinutes ?? null) : (branch?.defaultMinutes ?? null)
  const actionError =
    act.error instanceof ApiError
      ? ["BOOKING_LINK_USED", "BOOKING_LINK_EXPIRED", "BOOKING_NOT_CHANGEABLE"].includes(act.error.shape.code ?? "")
        ? (act.error.shape.message ?? EXPIRED_TEXT)
        : "Ese horario acaba de ocuparse. Elige otro de la lista."
      : act.error
        ? "No pudimos reservar. Revisa tu conexión y vuelve a intentarlo."
        : null
  const chosenLabel = chosen ? `${shortDay(chosen.startsAt, timeZone)}, ${timeLabel(chosen.startsAt, timeZone)}` : null
  const title = changing ? "Cambia tu cita" : mode === "tratamiento" ? "Elige el horario de tu tratamiento" : "Elige tu cita"
  const steps = withData ? 3 : 2

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
      <SubmitButton type="button" className="min-h-11 w-full" pending={act.isPending} disabled={chosen === null} onClick={() => chosen && act.mutate(chosen)}>
        {changing ? `Cambiar a${suffix || " este horario"}` : `Reservar${suffix}`}
      </SubmitButton>
    )
  }
  const errors = actionError ? (
    <p role="alert" className="text-sm text-destructive">
      {actionError}
    </p>
  ) : null
  const closingNote = needsData ? "Es tu primera cita: después de elegir te pedimos unos datos y reservamos." : "Podrás cambiarla o cancelarla desde este mismo enlace."
  const backButton = onBack ? (
    <Button type="button" variant="outline" className="min-h-11 w-full" onClick={onBack}>
      {changing ? "Conservar mi cita" : "Volver a lo pendiente"}
    </Button>
  ) : null

  const heading = (stepNumber: number) => (
    <header className="mb-6 flex flex-col gap-1">
      <p className="text-sm font-semibold text-muted-foreground">
        {view.clinicName}
        {mode === "reservar" ? (
          <span>
            {" "}
            · paso {stepNumber} de {steps}
          </span>
        ) : null}
      </p>
      <h1 className="text-xl font-semibold">{stepNumber === 2 && needsData ? "Tus datos" : title}</h1>
    </header>
  )

  // «Tus datos» de quien aún no es paciente: con el horario ya elegido, deja lo esencial y la página reserva enseguida.
  if (enteringData && chosen !== null && (needsData || (registered && act.isPending))) {
    return (
      <PageShell maxWidth="md">
        {heading(2)}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-2xl bg-primary-soft px-4 py-3 text-primary-soft-foreground">
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="font-semibold">
                {capital(shortDay(chosen.startsAt, timeZone))}, {timeLabel(chosen.startsAt, timeZone)} · {serviceName}
              </p>
              <p className="text-sm">{[branch ? `Sede ${branch.name}` : null, chosen.dentistName].filter(Boolean).join(" · ")}</p>
            </div>
            <Button type="button" variant="link" className="h-auto min-h-11 shrink-0 p-0" aria-label="Cambiar horario" disabled={act.isPending} onClick={() => setEnteringData(false)}>
              Cambiar
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Es tu primera cita con nosotros. Solo pedimos lo necesario para reservarla; lo demás se completa en la clínica.</p>
          <BookingDataForm
            slug={slug}
            token={token}
            submissionId={submissionId}
            draft={dataDraft}
            onDraftChange={setDataDraft}
            reserving={act.isPending}
            onRegistered={() => {
              setRegistered(true)
              void queryClient.invalidateQueries({ queryKey: ["booking-link", slug, token] })
              act.mutate(chosen)
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
        {heading(1)}
        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)_17rem] lg:items-start">
          <section aria-label="Para qué es la cita" className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="hidden text-sm font-semibold text-muted-foreground lg:block">Para qué es la cita</p>
                <p className="font-semibold">{serviceName}</p>
                <p className="text-sm text-muted-foreground">
                  {[minutes ? `${minutes} minutos` : null, branch ? `sede ${branch.name}` : null, view.patientFirstName ? `para ${view.patientFirstName}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {/* «Cómo llegar» debajo de la sede elegida (issue 36), a la vista también en el teléfono. */}
                {branch?.directionsUrl ? (
                  <a
                    href={branch.directionsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <MapPin aria-hidden className="size-4" />
                    Cómo llegar
                  </a>
                ) : null}
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
              {!changing && !fixedBranch && view.branches.length > 1 ? (
                <Field>
                  <FieldLabel htmlFor="reserva-sede">Sede</FieldLabel>
                  <Select
                    value={branch?.id ?? ""}
                    onValueChange={(value) => {
                      setBranchChoice(value)
                      week.reset()
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
              {branch !== undefined ? <DentistSelect state={week} id="reserva-profesional" onChange={() => setChosen(null)} /> : null}
            </div>
          </section>

          {branch === undefined ? (
            <p className="text-sm text-muted-foreground">Elige una sede para ver los horarios libres.</p>
          ) : (
            <WeekSlotsGrid state={week} chosen={chosen} onChoose={setChosen} minutes={minutes} />
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
            {backButton}
            <p className="text-sm text-muted-foreground">{closingNote}</p>
          </aside>
        </div>
      </div>

      {/* Teléfono: el botón que avanza, fijo abajo y con el horario elegido. */}
      <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t bg-background p-4 lg:hidden">
        {errors}
        {mainAction(true)}
        {backButton ?? <p className="text-center text-sm text-muted-foreground">{chosen ? closingNote : "Elige un día y una hora para reservar."}</p>}
      </div>
    </PageShell>
  )
}
