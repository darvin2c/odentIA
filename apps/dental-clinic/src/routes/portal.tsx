import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { Badge, Button, Field, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Fingerprint } from "lucide-react"
import { useEffect, useState } from "react"
import { AppointmentBlock } from "../components/public/appointment-block"
import { type BudgetAnswer, BudgetResponder } from "../components/public/budget-responder"
import { ProfessionalSelect, longDay, shortDay, timeLabel, useWeekSlots, type WeekSlot, WeekSlotsGrid } from "../components/public/week-slots"
import {
  cancelPortalAppointmentApi,
  closePortalSessionApi,
  confirmPortalAppointmentApi,
  downloadPortalCalendar,
  decidePortalBudgetApi,
  exchangePortalTokenApi,
  fetchPortalAccount,
  fetchPortalAppointments,
  fetchPortalBudgets,
  fetchPortalDocumentUrl,
  fetchPortalDocuments,
  fetchPortalQuestionnaire,
  fetchPortalRescheduleSlots,
  fetchPortalSession,
  fetchPublicPortalPolicyApi,
  formatPortalDate,
  formatPortalMoney,
  listMyPortalGrantsApi,
  markPortalBudgetSeenApi,
  type PortalAppointment,
  type PortalBudget,
  portalErrorMessage,
  rememberPortalSessionApi,
  requestPasskeyAuthOptionsApi,
  requestPasskeyRegistrationOptionsApi,
  reschedulePortalAppointmentApi,
  savePortalQuestionnaireApi,
  selectPortalGrantApi,
  verifyPasskeyAuthApi,
  verifyPasskeyRegistrationApi,
} from "../lib/portal"
import { ApiError } from "../lib/api"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { setOrgLocale } from "../lib/locale"
import { AnswerInput, isFieldVisible, missingRequired } from "../components/patient/form-fields"

/**
 * El portal del paciente (ADR 0037): lo privado, todo junto y cuando quiera.
 * Una sola página: su próxima cita (el mismo bloque de «Su enlace»), «Antes
 * de tu cita» solo si hay un cuestionario, «Por decidir», sus documentos y su
 * cuenta, según lo que la clínica le dio. La primera vez entra con el enlace
 * de recepción y el código de 6 dígitos, y guardar su acceso en el teléfono es
 * el paso principal; después entra con su huella o su cara. Si el teléfono no
 * puede guardarlo, la sesión se recuerda 30 días.
 */
/**
 * La sesión del portal terminó de verdad: no hay sesión (401), no es de nadie
 * (403 o 404) o fue revocada o venció (409 con su código). Otro error no la
 * cierra.
 */
function sessionEnded(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === 401 || error.status === 403 || error.status === 404) return true
  return error.shape.code === "PORTAL_REVOKED" || error.shape.code === "PORTAL_EXPIRED" || error.shape.code === "PORTAL_DISABLED"
}

export const Route = createFileRoute("/portal")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" && search.token.length <= 256 ? search.token : undefined,
    org: typeof search.org === "string" && search.org.length <= 128 ? search.org : undefined,
  }),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PortalPage,
})

const STORAGE_KEY = "odentia-portal-session"
const ORG_STORAGE_KEY = "odentia-portal-org"
/** «Ahora no» a guardar el acceso: no se vuelve a preguntar en esta sesión. */
const SKIP_SAVE_KEY = "odentia-portal-skip-save"

function defaultOrgSlug(override?: string): string {
  if (override && override.trim() !== "") return override.trim()
  try {
    return orgSlugFromHostname(requestHostname()) ?? ""
  } catch {
    return ""
  }
}

/** Lo que el presupuesto espera aún de la persona. */
const AWAITING = new Set(["presentado", "parcial", "pospuesto"])

/**
 * La sesión vive en este navegador: en `sessionStorage` mientras dura (48
 * horas como mucho) y en `localStorage` si se recuerda 30 días en este
 * teléfono. El servidor decide cuándo vence; aquí solo se guarda el token.
 */
function readStored(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null, lasting = false): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.removeItem(key)
    window.localStorage.removeItem(key)
    if (value) (lasting ? window.localStorage : window.sessionStorage).setItem(key, value)
  } catch {
    // Almacenamiento no disponible: la sesión vive solo en memoria.
  }
}

function passkeySupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window
}

function passkeyFriendlyMessage(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError") return "Se canceló. Vuelve a intentarlo cuando quieras."
  return portalErrorMessage(error)
}

function PortalPage() {
  const { token, org } = Route.useSearch()
  const navigate = useNavigate({ from: Route.id })
  // La sesión guardada no existe en el servidor: se lee al montar para que el
  // HTML del servidor y el primer render del cliente coincidan.
  const [hydrated, setHydrated] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [storedOrg, setStoredOrg] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [pin, setPin] = useState("")
  // Acaba de entrar con el enlace y el código: se le ofrece guardar su acceso.
  const [firstEntry, setFirstEntry] = useState(false)
  useEffect(() => {
    setSessionToken(readStored(STORAGE_KEY))
    setStoredOrg(readStored(ORG_STORAGE_KEY))
    setHydrated(true)
  }, [])

  const orgSlug = storedOrg ?? defaultOrgSlug(org ?? "")
  function adoptSession(nextToken: string, slug: string | null, lasting = false) {
    writeStored(STORAGE_KEY, nextToken, lasting)
    setSessionToken(nextToken)
    if (slug) {
      writeStored(ORG_STORAGE_KEY, slug, true)
      setStoredOrg(slug)
    }
    setClosed(false)
    setPin("")
  }

  const exchange = useMutation({
    mutationFn: (code: string) => exchangePortalTokenApi(token ?? "", code),
    onSuccess: (data) => {
      // La organización sale de la fuente confiable actual (parámetro u hostname), nunca de una sesión anterior.
      const slug = defaultOrgSlug(org ?? storedOrg ?? "")
      adoptSession(data.sessionToken, slug || null)
      setFirstEntry(true)
      void navigate({ search: { org, token: undefined }, replace: true })
    },
  })

  if (!hydrated) {
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message="Abriendo tu portal…" />
      </PageShell>
    )
  }

  if (!sessionToken && token && !closed) {
    const pinValid = /^\d{6}$/.test(pin)
    return (
      <PageShell maxWidth="md">
        <header className="mb-6 flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Tu portal</h1>
          <p className="text-sm text-muted-foreground">Escribe el código de 6 dígitos que te dieron en la clínica. Nunca llega junto con este enlace.</p>
        </header>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (pinValid) exchange.mutate(pin)
          }}
        >
          <Field>
            <FieldLabel htmlFor="portal-pin">Código</FieldLabel>
            <Input
              id="portal-pin"
              className="min-h-11 text-lg tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </Field>
          {exchange.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {portalErrorMessage(exchange.error)}
            </p>
          ) : null}
          <SubmitButton type="submit" className="min-h-11 w-full" pending={exchange.isPending} disabled={!pinValid}>
            Entrar
          </SubmitButton>
          <p className="text-sm text-muted-foreground">Si el enlace venció o el código no funciona, pide uno nuevo en recepción.</p>
        </form>
      </PageShell>
    )
  }

  if (!sessionToken) {
    return <PortalLanding initialOrg={defaultOrgSlug(org ?? storedOrg ?? "")} closed={closed} onSession={(next, slug) => adoptSession(next, slug, true)} />
  }

  return (
    <PortalDashboard
      sessionToken={sessionToken}
      orgSlug={orgSlug}
      firstEntry={firstEntry}
      onSessionToken={(next) => adoptSession(next, orgSlug || null)}
      onRemembered={() => writeStored(STORAGE_KEY, sessionToken, true)}
      onClose={() => {
        writeStored(STORAGE_KEY, null)
        setSessionToken(null)
        setFirstEntry(false)
        setClosed(true)
      }}
    />
  )
}

/** Sin sesión: entrar con su huella o su cara. El acceso lo da recepción. */
function PortalLanding({ initialOrg, closed, onSession }: { initialOrg: string; closed: boolean; onSession: (token: string, slug: string) => void }) {
  const [orgInput, setOrgInput] = useState(initialOrg)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const hostnameOrg = defaultOrgSlug()
  const slug = (hostnameOrg !== "" ? hostnameOrg : orgInput).trim()
  const policy = useQuery({
    queryKey: ["public-portal-policy", slug],
    queryFn: () => fetchPublicPortalPolicyApi(slug),
    enabled: slug !== "",
    retry: false,
  })
  const supported = passkeySupported()
  async function login() {
    if (slug === "" || pending) return
    setPending(true)
    setError(null)
    try {
      const challenge = await requestPasskeyAuthOptionsApi(slug)
      const response = await startAuthentication({ optionsJSON: challenge.options })
      const result = await verifyPasskeyAuthApi(slug, { challengeId: challenge.challengeId, response })
      onSession(result.sessionToken, slug)
    } catch (e) {
      setError(passkeyFriendlyMessage(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        {policy.data?.orgName ? <p className="text-sm font-semibold text-muted-foreground">{policy.data.orgName}</p> : null}
        <h1 className="text-xl font-semibold">{closed ? "Cerraste tu sesión" : "Tu portal"}</h1>
        <p className="text-sm text-muted-foreground">Tus citas, presupuestos y documentos, cuando quieras.</p>
      </header>
      <div className="flex flex-col gap-4">
        {hostnameOrg === "" ? (
          <Field>
            <FieldLabel htmlFor="portal-org">Código de la clínica</FieldLabel>
            <Input id="portal-org" className="min-h-11" maxLength={128} value={orgInput} onChange={(event) => setOrgInput(event.target.value)} />
          </Field>
        ) : null}
        {policy.data && !policy.data.enabled ? (
          <p className="text-sm text-muted-foreground" role="note">
            Esta clínica no tiene el portal encendido.
          </p>
        ) : supported ? (
          <SubmitButton type="button" className="min-h-11 w-full" pending={pending} disabled={slug === ""} onClick={() => void login()}>
            <Fingerprint className="size-4" aria-hidden />
            Entrar con mi huella o mi cara
          </SubmitButton>
        ) : (
          <p className="text-sm text-muted-foreground" role="note">
            Este navegador no puede guardar tu acceso. Abre el enlace que te dieron en la clínica.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">¿Aún no tienes acceso? Pídelo en recepción.</p>
      </div>
    </PageShell>
  )
}

/** La primera vez: guardar el acceso en este teléfono es el paso principal. */
function SaveAccess({
  sessionToken,
  orgSlug,
  onDone,
  onRemembered,
}: {
  sessionToken: string
  orgSlug: string
  onDone: () => void
  onRemembered: () => void
}) {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const supported = passkeySupported() && orgSlug !== ""
  const remember = useMutation({
    mutationFn: () => rememberPortalSessionApi(sessionToken),
    onSuccess: () => {
      onRemembered()
      void queryClient.invalidateQueries({ queryKey: ["portal-session", sessionToken] })
      onDone()
    },
    onError: (e) => setError(portalErrorMessage(e)),
  })
  async function save() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const challenge = await requestPasskeyRegistrationOptionsApi(sessionToken, orgSlug)
      const response = await startRegistration({ optionsJSON: challenge.options })
      await verifyPasskeyRegistrationApi(sessionToken, orgSlug, { challengeId: challenge.challengeId, response })
      void queryClient.invalidateQueries({ queryKey: ["portal-session", sessionToken] })
      onDone()
    } catch (e) {
      setError(passkeyFriendlyMessage(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <section aria-label="Guarda tu acceso" className="flex flex-col gap-3 rounded-2xl border border-primary bg-primary-soft p-4 text-primary-soft-foreground">
      <h2 className="text-lg font-semibold">Guarda tu acceso en este teléfono</h2>
      {supported ? (
        <>
          <p className="text-sm">La próxima vez entras con tu huella o tu cara, sin pedir nada a la clínica.</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <SubmitButton type="button" className="min-h-11" pending={pending} onClick={() => void save()}>
              Guardar mi acceso
            </SubmitButton>
            <Button type="button" variant="outline" className="min-h-11" onClick={onDone}>
              Ahora no
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">Tu teléfono no puede guardarlo. Lo recordamos 30 días en este teléfono.</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <SubmitButton type="button" className="min-h-11" pending={remember.isPending} onClick={() => remember.mutate()}>
              Recordarme 30 días
            </SubmitButton>
            <Button type="button" variant="outline" className="min-h-11" onClick={onDone}>
              Ahora no
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

function PortalDashboard({
  sessionToken,
  orgSlug,
  firstEntry,
  onSessionToken,
  onRemembered,
  onClose,
}: {
  sessionToken: string
  orgSlug: string
  firstEntry: boolean
  onSessionToken: (nextToken: string) => void
  onRemembered: () => void
  onClose: () => void
}) {
  const [skipSave, setSkipSave] = useState(() => readStored(SKIP_SAVE_KEY) === "1")
  const sessionQuery = useQuery({
    queryKey: ["portal-session", sessionToken],
    queryFn: () => fetchPortalSession(sessionToken),
    retry: false,
  })
  const close = useMutation({
    mutationFn: () => closePortalSessionApi(sessionToken),
    onSettled: onClose,
  })
  // Solo una sesión que terminó se olvida; un corte de red o un error del
  // servidor no cierra el portal: se reintenta.
  const ended = sessionQuery.isError && sessionEnded(sessionQuery.error)
  useEffect(() => {
    if (ended) writeStored(STORAGE_KEY, null)
  }, [ended])

  if (sessionQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Abriendo tu portal…" />
      </PageShell>
    )
  }
  if (sessionQuery.isError && !ended) {
    return (
      <PageShell maxWidth="md">
        <ErrorState title="No pudimos abrir tu portal" message={portalErrorMessage(sessionQuery.error)} onRetry={() => void sessionQuery.refetch()} />
      </PageShell>
    )
  }
  if (sessionQuery.isError) {
    return (
      <PageShell maxWidth="md">
        <EmptyState title="Tu sesión terminó" description="Entra con tu huella o tu cara, o pide un enlace nuevo en recepción." actionLabel="Volver a entrar" onAction={onClose} />
      </PageShell>
    )
  }
  const info = sessionQuery.data
  // Página pública, sin layout de organización: el formato y la zona de la clínica llegan con la sesión.
  setOrgLocale(info.locale, info.timeZone)
  const scope = info.session.scope
  const offerSave = !skipSave && !info.accessSaved && !info.remembered && (firstEntry || info.session.authMethod === "enlace_pin")
  const nothing = !scope.appointments && !scope.budgets && !scope.account && scope.documents.length === 0

  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold">Hola, {info.patientName}</h1>
          <p className="text-sm text-muted-foreground">Tu sesión en este teléfono termina el {formatPortalDate(info.session.expiresAt)}.</p>
        </div>
        <Button type="button" variant="outline" className="min-h-11" disabled={close.isPending} onClick={() => close.mutate()}>
          Cerrar sesión
        </Button>
      </header>
      <div className="flex flex-col gap-4">
        {offerSave ? (
          <SaveAccess
            sessionToken={sessionToken}
            orgSlug={orgSlug}
            onRemembered={onRemembered}
            onDone={() => {
              writeStored(SKIP_SAVE_KEY, "1")
              setSkipSave(true)
            }}
          />
        ) : null}
        <GrantSwitcher sessionToken={sessionToken} currentPatientId={info.session.patientId} onSessionToken={onSessionToken} />
        {scope.appointments ? <NextAppointment sessionToken={sessionToken} /> : null}
        {scope.appointments ? <QuestionnaireBlock sessionToken={sessionToken} /> : null}
        {scope.budgets ? <BudgetsBlock sessionToken={sessionToken} /> : null}
        {scope.documents.length > 0 ? (
          <Block title="Tus documentos">
            <DocumentsBlock sessionToken={sessionToken} />
          </Block>
        ) : null}
        {scope.account ? (
          <Block title="Tu cuenta">
            <AccountBlock sessionToken={sessionToken} />
          </Block>
        ) : null}
        {nothing ? <EmptyState title="Aún no hay nada que ver" description="Pide en recepción que te den acceso a tus citas, presupuestos o documentos." /> : null}
      </div>
    </PageShell>
  )
}

function Block({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{title}</h2>
        {count ? <Badge variant="secondary">{count}</Badge> : null}
      </div>
      {children}
    </section>
  )
}

/** «Tu próxima cita»: el mismo bloque de «Su enlace», y «Cambiar» con la semana de horarios. */
function NextAppointment({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const key = ["portal-appointments", sessionToken]
  const query = useQuery({ queryKey: key, queryFn: () => fetchPortalAppointments(sessionToken), retry: false })
  const [changing, setChanging] = useState(false)
  const done = () => void queryClient.invalidateQueries({ queryKey: key })
  const confirm = useMutation({ mutationFn: (id: string) => confirmPortalAppointmentApi(sessionToken, id), onSuccess: done })
  const cancel = useMutation({ mutationFn: (id: string) => cancelPortalAppointmentApi(sessionToken, id), onSuccess: done })
  if (query.isPending) return <LoadingState message="Cargando tu cita…" />
  if (query.isError) return <ErrorState title="No pudimos cargar tus citas" message={portalErrorMessage(query.error)} onRetry={() => void query.refetch()} />
  const upcoming = query.data
    .filter((appt) => (appt.status === "programada" || appt.status === "confirmada") && new Date(appt.endsAt).getTime() > Date.now())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const next = upcoming[0]
  if (!next) {
    return (
      <Block title="Tu próxima cita">
        <p className="text-sm text-muted-foreground">No tienes citas por venir. Para reservar, escríbenos por el chat.</p>
      </Block>
    )
  }
  const timeZone = next.timeZone ?? "UTC"
  const future = new Date(next.startsAt).getTime() > Date.now()
  if (changing) {
    return (
      <Reschedule
        sessionToken={sessionToken}
        appointment={next}
        onDone={() => {
          setChanging(false)
          done()
        }}
        onKeep={() => setChanging(false)}
      />
    )
  }
  return (
    <>
      <AppointmentBlock
        title="Tu próxima cita"
        appointment={{ ...next, timeZone, confirmed: next.status === "confirmada" }}
        onAddToCalendar={() => downloadPortalCalendar(sessionToken, next.id)}
        canChange={future}
        canConfirm={future && next.status === "programada"}
        confirming={confirm.isPending}
        cancelling={cancel.isPending}
        error={confirm.isError ? portalErrorMessage(confirm.error) : cancel.isError ? portalErrorMessage(cancel.error) : null}
        onChange={() => setChanging(true)}
        onCancel={() => cancel.mutate(next.id)}
        onConfirm={() => confirm.mutate(next.id)}
      />
      {upcoming.length > 1 ? (
        <p className="text-sm text-muted-foreground">
          También tienes:{" "}
          {upcoming
            .slice(1)
            .map((appt) => `${shortDay(appt.startsAt, appt.timeZone ?? timeZone)}, ${timeLabel(appt.startsAt, appt.timeZone ?? timeZone)}`)
            .join(" · ")}
        </p>
      ) : null}
    </>
  )
}

/** Cambiar la cita: la semana de horarios de «Su enlace», en la misma sede y con la misma duración. */
function Reschedule({ sessionToken, appointment, onDone, onKeep }: { sessionToken: string; appointment: PortalAppointment; onDone: () => void; onKeep: () => void }) {
  const [chosen, setChosen] = useState<WeekSlot | null>(null)
  const week = useWeekSlots({
    queryKey: ["portal-slots", sessionToken, appointment.id],
    fetchSlots: (range) => fetchPortalRescheduleSlots(sessionToken, appointment.id, range),
    enabled: true,
    fallbackTimeZone: appointment.timeZone,
  })
  const minutes = Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000)
  const move = useMutation({
    mutationFn: (slot: WeekSlot) =>
      reschedulePortalAppointmentApi(sessionToken, appointment.id, {
        expectedVersion: appointment.version,
        startsAt: slot.startsAt,
        professionalUserId: slot.professionalUserId,
        ...(slot.roomId ? { roomId: slot.roomId } : {}),
      }),
    onSuccess: onDone,
    onError: () => {
      setChosen(null)
      week.refresh()
    },
  })
  const zone = week.timeZone
  return (
    <section aria-label="Cambiar tu cita" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">Cambia tu cita</h2>
        <p className="text-sm text-muted-foreground">
          Hoy la tienes el {longDay(appointment.startsAt, appointment.timeZone ?? zone).toLowerCase()}, {timeLabel(appointment.startsAt, appointment.timeZone ?? zone)} · Sede {appointment.branchName}.
        </p>
      </div>
      <ProfessionalSelect state={week} id="portal-profesional" onChange={() => setChosen(null)} />
      <WeekSlotsGrid state={week} chosen={chosen} onChoose={setChosen} minutes={minutes} />
      {move.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {portalErrorMessage(move.error)}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton type="button" className="min-h-11" pending={move.isPending} disabled={chosen === null} onClick={() => chosen && move.mutate(chosen)}>
          {chosen ? `Cambiar a ${shortDay(chosen.startsAt, zone)}, ${timeLabel(chosen.startsAt, zone)}` : "Cambiar a este horario"}
        </SubmitButton>
        <Button type="button" variant="outline" className="min-h-11" onClick={onKeep}>
          Conservar mi cita
        </Button>
      </div>
    </section>
  )
}

/** «Por decidir»: los presupuestos que esperan su respuesta; «Ver y responder» como en «Su enlace». */
function BudgetsBlock({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const key = ["portal-budgets", sessionToken]
  const query = useQuery({ queryKey: key, queryFn: () => fetchPortalBudgets(sessionToken), retry: false })
  const [open, setOpen] = useState<string | null>(null)
  const seen = useMutation({ mutationFn: (id: string) => markPortalBudgetSeenApi(sessionToken, id) })
  const answer = useMutation({
    mutationFn: ({ budgetId, input }: { budgetId: string; input: BudgetAnswer }) => decidePortalBudgetApi(sessionToken, budgetId, input),
    onSuccess: () => {
      setOpen(null)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })
  if (query.isPending) return <LoadingState message="Cargando tus presupuestos…" />
  if (query.isError) return <ErrorState title="No pudimos cargar tus presupuestos" message={portalErrorMessage(query.error)} onRetry={() => void query.refetch()} />
  const awaiting = query.data.filter((budget) => AWAITING.has(budget.status))
  const decided = query.data.filter((budget) => !AWAITING.has(budget.status))
  const row = (budget: PortalBudget) => `Presupuesto N.º ${budget.budgetNumber} · ${budget.title} · ${formatPortalMoney(budget.totalCents, budget.currency, budget.locale)}`
  return (
    <Block title="Por decidir" count={awaiting.length}>
      {awaiting.length === 0 ? <p className="text-sm text-muted-foreground">No tienes presupuestos por responder.</p> : null}
      {awaiting.map((budget) =>
        open === budget.id ? (
          <div key={budget.id} className="flex flex-col gap-3">
            <p className="text-sm font-semibold">{row(budget)}</p>
            <BudgetResponder
              budget={budget}
              pending={answer.isPending}
              error={answer.isError ? portalErrorMessage(answer.error) : null}
              onAnswer={(input) => answer.mutate({ budgetId: budget.id, input })}
            />
            <Button type="button" variant="ghost" className="min-h-11 self-start" onClick={() => setOpen(null)}>
              Cerrar
            </Button>
          </div>
        ) : (
          <div key={budget.id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">{row(budget)}</p>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => {
                setOpen(budget.id)
                seen.mutate(budget.id)
              }}
            >
              Ver y responder
            </Button>
          </div>
        ),
      )}
      {decided.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t pt-3 text-sm text-muted-foreground">
          {decided.map((budget) => (
            <li key={budget.id}>
              {row(budget)} · {budget.stateText}
            </li>
          ))}
        </ul>
      ) : null}
    </Block>
  )
}

function GrantSwitcher({ sessionToken, currentPatientId, onSessionToken }: { sessionToken: string; currentPatientId: string; onSessionToken: (nextToken: string) => void }) {
  const queryClient = useQueryClient()
  const grants = useQuery({ queryKey: ["portal-my-grants", sessionToken], queryFn: () => listMyPortalGrantsApi(sessionToken), retry: false })
  const select = useMutation({
    mutationFn: (id: string) => selectPortalGrantApi(sessionToken, id),
    onSuccess: (result) => {
      onSessionToken(result.sessionToken)
      void queryClient.invalidateQueries({ queryKey: ["portal-session"] })
    },
  })
  const active = grants.data?.filter((grant) => grant.status === "activo") ?? []
  if (active.length <= 1) return null
  const current = active.find((grant) => grant.patientId === currentPatientId)
  return (
    <Field>
      <FieldLabel htmlFor="portal-grant-switch">Estás viendo a</FieldLabel>
      <Select
        value={current?.id ?? ""}
        onValueChange={(value) => {
          if (value && value !== current?.id) select.mutate(value)
        }}
      >
        <SelectTrigger id="portal-grant-switch" className="min-h-11 w-full">
          <SelectValue>{current?.patientName ?? "Elige"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {active.map((grant) => (
            <SelectItem key={grant.id} value={grant.id}>
              {grant.patientName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {select.isError ? <p className="text-sm text-destructive">{portalErrorMessage(select.error)}</p> : null}
    </Field>
  )
}

/**
 * «Antes de tu cita»: solo aparece si hay un cuestionario por responder. Por
 * pasos (una sección por paso); se guarda el avance al cambiar de paso.
 */
function QuestionnaireBlock({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["portal-questionnaire", sessionToken],
    queryFn: () => fetchPortalQuestionnaire(sessionToken),
  })
  const [answers, setAnswers] = useState<Record<string, unknown> | null>(null)
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [sentNow, setSentNow] = useState(false)
  const save = useMutation({
    mutationFn: (submit: boolean) =>
      savePortalQuestionnaireApi(sessionToken, { answers: answers ?? {}, submit }),
    onSuccess: (data, submit) => {
      setError(null)
      if (submit) setSentNow(true)
      queryClient.setQueryData(["portal-questionnaire", sessionToken], data)
    },
    onError: (e) => setError(portalErrorMessage(e)),
  })
  if (query.isPending) return null
  if (query.isError) return <ErrorState message={portalErrorMessage(query.error)} onRetry={() => void query.refetch()} />
  const { template, response, respondent } = query.data
  if (!template) return null
  if (response?.submittedAt) {
    if (!sentNow) return null
    return (
      <p role="status" className="rounded-2xl bg-success-soft p-4 text-sm">
        Gracias, recibimos tus respuestas. Tu odontólogo las revisa contigo en la cita.
      </p>
    )
  }
  const current = answers ?? response?.answers ?? {}
  const sections = template.schema.sections
  const section = sections[Math.min(step, sections.length - 1)]!
  const last = step >= sections.length - 1
  const sectionMissing = missingRequired({ sections: [section] }, current)
  const goTo = async (next: number) => {
    if (answers) await save.mutateAsync(false).catch(() => {})
    setStep(next)
    window.scrollTo({ top: 0 })
  }
  return (
    <section aria-labelledby="questionnaire-title" className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
      <div>
        <h2 id="questionnaire-title" className="text-lg font-semibold">
          Antes de tu cita · {template.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          Respondes por: {respondent.name}
          {respondent.relationship === "self" ? " (tú)" : ""}
        </p>
        <p className="mt-1 text-sm font-medium" aria-live="polite">
          Paso {step + 1} de {sections.length} · {section.title}
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {section.fields
          .filter((field) => isFieldVisible(field, current))
          .map((field) => (
            <AnswerInput
              key={field.id}
              field={field}
              value={current[field.id]}
              onChange={(value) => {
                setError(null)
                setAnswers({ ...current, [field.id]: value })
              }}
            />
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Tu odontólogo revisará estas respuestas contigo en la cita. Guardamos tu avance; puedes
        continuar más tarde desde el mismo enlace.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="outline" disabled={step === 0 || save.isPending} onClick={() => void goTo(step - 1)}>
          Atrás
        </Button>
        {last ? (
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => {
              const pending = missingRequired(template.schema, current)
              if (pending.length > 0) {
                setError(`Falta responder: ${pending.map((f) => f.label).join(", ")}`)
                return
              }
              save.mutate(true)
            }}
          >
            {save.isPending ? "Enviando…" : "Enviar respuestas"}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => {
              if (sectionMissing.length > 0) {
                setError(`Falta responder: ${sectionMissing.map((f) => f.label).join(", ")}`)
                return
              }
              setError(null)
              void goTo(step + 1)
            }}
          >
            Continuar
          </Button>
        )}
      </div>
    </section>
  )
}

function DocumentsBlock({ sessionToken }: { sessionToken: string }) {
  const documentsQuery = useQuery({
    queryKey: ["portal-documents", sessionToken],
    queryFn: () => fetchPortalDocuments(sessionToken),
    retry: false,
  })
  const [opening, setOpening] = useState("")
  const [openError, setOpenError] = useState<string | null>(null)

  if (documentsQuery.isPending) return <LoadingState message="Cargando tus documentos…" />
  if (documentsQuery.isError) {
    return <ErrorState title="No pudimos cargar tus documentos" message={portalErrorMessage(documentsQuery.error)} onRetry={() => documentsQuery.refetch()} />
  }
  const items = documentsQuery.data
  if (items.length === 0) {
    return <EmptyState title="Sin documentos" description="No hay documentos autorizados en tu acceso." />
  }

  async function openDocument(id: string) {
    setOpening(id)
    setOpenError(null)
    try {
      const { url } = await fetchPortalDocumentUrl(sessionToken, id)
      window.open(url, "_blank", "noopener,noreferrer")
    } catch (error) {
      setOpenError(portalErrorMessage(error))
    } finally {
      setOpening("")
    }
  }

  return (
    <div className="grid gap-2">
      {openError && <ErrorState title="No se pudo abrir el documento" message={openError} />}
      {items.map((doc) => (
        <div key={doc.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{doc.label}</p>
            <p className="text-xs text-muted-foreground">
              {doc.category} · {formatPortalDate(doc.createdAt)}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={opening === doc.id} onClick={() => void openDocument(doc.id)}>
            {opening === doc.id ? "Abriendo…" : "Abrir"}
          </Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Cada apertura genera un enlace válido por 5 minutos y queda registrada.
      </p>
    </div>
  )
}

function AccountBlock({ sessionToken }: { sessionToken: string }) {
  const accountQuery = useQuery({
    queryKey: ["portal-account", sessionToken],
    queryFn: () => fetchPortalAccount(sessionToken),
    retry: false,
  })
  if (accountQuery.isPending) return <LoadingState message="Cargando tu cuenta…" />
  if (accountQuery.isError) {
    return <ErrorState title="No pudimos cargar tu cuenta" message={portalErrorMessage(accountQuery.error)} onRetry={() => accountQuery.refetch()} />
  }
  const account = accountQuery.data
  if (account.byCurrency.length === 0) {
    return <EmptyState title="Sin movimientos" description="Aún no hay cargos ni pagos registrados." />
  }
  return (
    <div className="grid gap-4">
      {account.byCurrency.map((row) => (
        <div key={row.currency} className="rounded-md border p-4">
          <p className="text-sm font-medium">Saldo</p>
          <p className="mt-1 text-2xl font-semibold">{formatPortalMoney(row.saldo, row.currency, account.locale)}</p>
          <p className="text-xs text-muted-foreground">
            {row.saldo > 0 ? "pendiente de pago" : row.porCobrar > 0 ? "lo que tienes a favor cubre lo que debes" : "estás al día"}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Debe</dt>
            <dd className="text-right">{formatPortalMoney(row.porCobrar, row.currency, account.locale)}</dd>
            {row.aFavor > 0 && (
              <>
                <dt className="text-muted-foreground">A favor</dt>
                <dd className="text-right">{formatPortalMoney(row.aFavor, row.currency, account.locale)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Tratamiento aceptado</dt>
            <dd className="text-right">{formatPortalMoney(row.agreedCents, row.currency, account.locale)}</dd>
            <dt className="text-muted-foreground">Pagado</dt>
            <dd className="text-right">{formatPortalMoney(row.pagado, row.currency, account.locale)}</dd>
          </dl>
        </div>
      ))}
      <div className="grid gap-2">
        <p className="text-sm font-medium">Historial</p>
        {account.charges.map((charge) => (
          <div key={`c-${charge.id}`} className="flex items-center gap-2 text-sm">
            <span className="flex-1">{charge.description}</span>
            <span>{formatPortalMoney(charge.amountCents, charge.currency, account.locale)}</span>
            {charge.voidedAt && <Badge variant="secondary">Anulado</Badge>}
          </div>
        ))}
        {account.payments.map((payment) => (
          <div key={`p-${payment.id}`} className="flex items-center gap-2 text-sm">
            <span className="flex-1">
              Pago · {payment.method}{payment.reference ? ` · ${payment.reference}` : ""} · {formatPortalDate(payment.paidAt, { locale: account.locale })}
            </span>
            <span>{formatPortalMoney(payment.amountCents, payment.currency, account.locale)}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        El pago se realiza en recepción o por los medios de la clínica; aquí ves tu historial y saldo real.
      </p>
    </div>
  )
}
