import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  focusFirstInvalid,
  LoadingState,
  PageShell,
  SubmitButton,
  submitForm,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Fingerprint } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { ChoiceButtons } from "../../components/choice-buttons"
import { AppointmentBlock } from "../../components/public/appointment-block"
import { type BudgetAnswer, BudgetResponder } from "../../components/public/budget-responder"
import {
  chosenSlotSchema,
  longDay,
  ProfessionalSelect,
  SLOT_FIELD_MAP,
  shortDay,
  slotTakenError,
  timeLabel,
  useWeekSlots,
  type WeekSlot,
  WeekSlotsField,
} from "../../components/public/week-slots"
import { ApiError } from "../../lib/api"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { activeOrgLocale, activeOrgTimeZone, setOrgLocale } from "../../lib/locale"
import {
  cancelPortalAppointmentApi,
  closePortalSessionApi,
  confirmPortalAppointmentApi,
  decidePortalBudgetApi,
  downloadPortalCalendar,
  exchangePortalTokenApi,
  fetchPortalAccount,
  fetchPortalOrders,
  fetchPortalAppointments,
  fetchPortalBudgets,
  fetchPortalPaperFileUrl,
  fetchPortalPaperPdf,
  fetchPortalPapers,
  fetchPortalHealth,
  fetchPortalVisit,
  portalHealthLines,
  fetchPortalRescheduleSlots,
  fetchPortalSession,
  fetchPublicPortalPolicyApi,
  formatPortalDate,
  type PortalPaper,
  sentenceEnd,
  formatPortalMoney,
  portalTotalsText,
  listMyPortalGrantsApi,
  markPortalBudgetSeenApi,
  type PortalAppointment,
  type PortalBudget,
  portalErrorMessage,
  rememberPortalSessionApi,
  requestPasskeyAuthOptionsApi,
  requestPasskeyRegistrationOptionsApi,
  reschedulePortalAppointmentApi,
  sendPortalVisitApi,
  selectPortalGrantApi,
  verifyPasskeyAuthApi,
  verifyPasskeyRegistrationApi,
} from "../../lib/portal"
import { appWords } from "../../lib/product-words"
import { productUi } from "../../product/product-ui"
import { PortalAccountSkeleton, PortalAppointmentSkeleton, PortalBudgetsSkeleton, PortalDocumentsSkeleton, PortalPageSkeleton } from "../../components/skeletons/public-portal"

/**
 * El portal del paciente (ADR 0037): lo privado, todo junto y cuando quiera.
 * Una sola página: su próxima cita (el mismo bloque de «Su enlace»), «Antes
 * de tu cita» (lo de su visita, si se le pregunta), «Por decidir», sus documentos y su
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
  pendingComponent: PortalPageSkeleton,
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
  return portalFormMessage(error) ?? portalErrorMessage(error)
}

/**
 * Lo que se dice junto a los botones cuando no es de ningún campo: el gesto
 * cancelado y el acceso que no está disponible, en palabras del paciente. Sin
 * respuesta, con un 5xx o con un error del navegador (WebAuthn) no se habla de
 * «guardar» ni se muestra su texto en inglés. Lo demás, como lo dice la API (`null`).
 */
function portalFormMessage(error: unknown): string | null {
  if (error instanceof Error && error.name === "NotAllowedError") return "Se canceló. Vuelve a intentarlo cuando quieras."
  if (error instanceof ApiError && error.status === 404) return "Este acceso no está disponible."
  if (!(error instanceof ApiError) || error.status >= 500 || error.status === 408) return "No pudimos completar la solicitud."
  return null
}

/** El código de la clínica que escribe el paciente, como lo pide la API (`portalSlugInput`). */
const CLINIC_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const clinicCodeSchema = z
  .string()
  .transform((text) => text.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, "Escribe el código de la clínica.")
      .max(100, "El código de la clínica tiene como mucho 100 caracteres.")
      .regex(CLINIC_CODE, "Revisa el código de la clínica: solo letras, números y guiones."),
  )
/** Sin decir si la clínica existe: lo mismo para un código que no es de nadie y para un portal apagado. */
const CLINIC_NOT_FOUND = "No encontramos un portal con ese código. Revísalo o pídelo en recepción."

const pinSchema = z.object({ pin: z.string().regex(/^\d{6}$/, "Escribe los 6 dígitos del código.") })

function PortalPage() {
  const { token, org } = Route.useSearch()
  const navigate = useNavigate({ from: Route.id })
  // La sesión guardada no existe en el servidor: se lee al montar para que el
  // HTML del servidor y el primer render del cliente coincidan.
  const [hydrated, setHydrated] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [storedOrg, setStoredOrg] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
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
  const pinForm = useAppForm({
    defaultValues: { pin: "" },
    validators: { onSubmit: pinSchema },
    onSubmit: async ({ value }) => {
      await exchange.mutateAsync(value.pin)
    },
  })
  const submitPin = useFormSubmit(pinForm, { formMessage: portalFormMessage })
  const pinError = useFormSubmitError(pinForm)

  if (!hydrated) {
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message="Abriendo tu portal…" />
      </PageShell>
    )
  }

  if (!sessionToken && token && !closed) {
    return (
      <PageShell maxWidth="md">
        <header className="mb-6 flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Tu portal</h1>
          <p id="portal-pin-instrucciones" className="text-sm text-muted-foreground">Escribe el código de 6 dígitos que te dieron en la clínica. Nunca llega junto con este enlace.</p>
        </header>
        <form className="flex flex-col gap-3" onSubmit={submitPin} noValidate>
          <pinForm.AppField name="pin">
            {(field) => (
              <field.Control label="Código" id="portal-pin">
                {(control) => (
                  <Input
                    {...control.props}
                    aria-describedby={[control.describedBy, "portal-pin-instrucciones"].filter(Boolean).join(" ")}
                    className="min-h-11 text-lg tracking-widest"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                )}
              </field.Control>
            )}
          </pinForm.AppField>
          {pinError ? (
            <p role="alert" className="text-sm text-destructive">
              {pinError}
            </p>
          ) : null}
          <SubmitButton type="submit" className="min-h-11 w-full" pending={exchange.isPending}>
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
  const queryClient = useQueryClient()
  const hostnameOrg = defaultOrgSlug()
  const form = useAppForm({
    defaultValues: { orgSlug: initialOrg },
    // Con la clínica en la dirección no se escribe nada: el campo no está y siempre pasa.
    validators: { onSubmit: z.object({ orgSlug: hostnameOrg !== "" ? z.string() : clinicCodeSchema }) },
    onSubmit: async ({ value }) => {
      const slug = hostnameOrg !== "" ? hostnameOrg : value.orgSlug.trim().toLowerCase()
      const challenge = await requestPasskeyAuthOptionsApi(slug)
      const response = await startAuthentication({ optionsJSON: challenge.options })
      const result = await verifyPasskeyAuthApi(slug, { challengeId: challenge.challengeId, response })
      onSession(result.sessionToken, slug)
    },
  })
  const login = useFormSubmit(form, { formMessage: portalFormMessage })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const typed = useStore(form.store, (state) => state.values.orgSlug.trim().toLowerCase())
  const slug = hostnameOrg !== "" ? hostnameOrg : typed.length <= 100 && CLINIC_CODE.test(typed) ? typed : ""
  const policy = useQuery({
    queryKey: ["public-portal-policy", slug],
    queryFn: () => fetchPublicPortalPolicyApi(slug),
    enabled: slug !== "",
    retry: false,
  })
  const supported = passkeySupported()
  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-col gap-1">
        {policy.data?.orgName ? <p className="text-sm font-semibold text-muted-foreground">{policy.data.orgName}</p> : null}
        <h1 className="text-xl font-semibold">{closed ? "Cerraste tu sesión" : "Tu portal"}</h1>
        <p className="text-sm text-muted-foreground">Tus citas, presupuestos y documentos, cuando quieras.</p>
      </header>
      <form className="flex flex-col gap-4" onSubmit={login} noValidate>
        {hostnameOrg === "" ? (
          <form.AppField
            name="orgSlug"
            validators={{
              // Un código bien escrito que no lleva a un portal encendido se dice aquí, sin decir si la clínica existe.
              onChangeAsyncDebounceMs: 400,
              onChangeAsync: async ({ value }) => {
                const code = value.trim().toLowerCase()
                if (code.length > 100 || !CLINIC_CODE.test(code)) return undefined
                const found = await queryClient
                  .fetchQuery({
                    queryKey: ["public-portal-policy", code],
                    queryFn: () => fetchPublicPortalPolicyApi(code),
                    retry: false,
                    staleTime: 30_000,
                  })
                  .catch(() => null)
                return found && !found.enabled ? CLINIC_NOT_FOUND : undefined
              },
            }}
          >
            {(field) => (
              <field.TextField
                label="Código de la clínica"
                id="portal-org"
                inputClassName="min-h-11"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={100}
              />
            )}
          </form.AppField>
        ) : null}
        {hostnameOrg !== "" && policy.data && !policy.data.enabled ? (
          <p className="text-sm text-muted-foreground" role="note">
            Esta clínica no tiene el portal encendido.
          </p>
        ) : supported ? (
          <SubmitButton type="submit" className="min-h-11 w-full" pending={pending}>
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
        {/* Con el portal apagado no hay acceso que pedir: no se promete. Solo se sabe por la dirección de la clínica;
            mientras se escribe el código, la frase no aparece y desaparece con cada tecla. */}
        {hostnameOrg !== "" && policy.data && !policy.data.enabled ? null : (
          <p className="text-sm text-muted-foreground">¿Aún no tienes acceso? Pídelo en recepción.</p>
        )}
      </form>
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
    return <PortalPageSkeleton />
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
  const nothing = !scope.appointments && !scope.budgets && !scope.account && !scope.papers

  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold">Hola, {info.patientName}</h1>
          <p className="text-sm text-muted-foreground">
            {sentenceEnd(`Tu sesión en este teléfono termina el ${formatPortalDate(info.session.expiresAt)}`)}
          </p>
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
        {scope.appointments ? <VisitBlock sessionToken={sessionToken} /> : null}
        {scope.appointments ? <HealthBlock sessionToken={sessionToken} /> : null}
        {scope.budgets ? <BudgetsBlock sessionToken={sessionToken} /> : null}
        {scope.papers ? <DocumentsBlock sessionToken={sessionToken} /> : null}
        {/* Sus pedidos van con «Tu cuenta» (ADR 0172), donde la clínica trabaja con pedidos. */}
        {scope.account && productUi().orders ? <OrdersBlock sessionToken={sessionToken} /> : null}
        {scope.account ? (
          <Block title="Tu cuenta">
            <AccountBlock sessionToken={sessionToken} />
          </Block>
        ) : null}
        {nothing ? <EmptyState title="Aún no hay nada que ver" description="La clínica todavía no muestra nada en su portal." /> : null}
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
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando tu cita…">
        <PortalAppointmentSkeleton title="Tu próxima cita" />
      </SkeletonRegion>
    )
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
  })
  const form = useAppForm({
    defaultValues: { slot: null as WeekSlot | null },
    validators: { onSubmit: z.object({ slot: chosenSlotSchema("Elige un día y una hora para cambiarla.") }) },
    onSubmit: async ({ value, formApi }) => {
      if (!value.slot) return
      try {
        await move.mutateAsync(value.slot)
      } catch (error) {
        const shown = slotTakenError(error)
        // Solo si el horario se ocupó se vuelve a pedir lo libre; con otro motivo la elección se conserva.
        if (shown !== error) {
          formApi.setFieldValue("slot", null)
          week.refresh()
        }
        throw shown
      }
      onDone()
    },
  })
  const submit = useFormSubmit(form, { fieldMap: SLOT_FIELD_MAP, formMessage: portalFormMessage })
  const error = useFormSubmitError(form)
  const chosen = useStore(form.store, (state) => state.values.slot)
  const zone = week.timeZone
  return (
    <form aria-label="Cambiar tu cita" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">Cambia tu cita</h2>
        <p className="text-sm text-muted-foreground">
          Hoy la tienes el {longDay(appointment.startsAt, appointment.timeZone ?? zone).toLowerCase()}, {timeLabel(appointment.startsAt, appointment.timeZone ?? zone)} · Sede {appointment.branchName}.
        </p>
      </div>
      <ProfessionalSelect state={week} id="portal-profesional" onChange={() => form.setFieldValue("slot", null)} />
      <form.AppField name="slot">{() => <WeekSlotsField state={week} minutes={minutes} />}</form.AppField>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton type="submit" className="min-h-11" pending={move.isPending}>
          {chosen ? `Cambiar a ${shortDay(chosen.startsAt, zone)}, ${timeLabel(chosen.startsAt, zone)}` : "Cambiar a este horario"}
        </SubmitButton>
        <Button type="button" variant="outline" className="min-h-11" onClick={onKeep}>
          Conservar mi cita
        </Button>
      </div>
    </form>
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
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando tus presupuestos…">
        <PortalBudgetsSkeleton title="Por decidir" />
      </SkeletonRegion>
    )
  if (query.isError) return <ErrorState title="No pudimos cargar tus presupuestos" message={portalErrorMessage(query.error)} onRetry={() => void query.refetch()} />
  const awaiting = query.data.filter((budget) => AWAITING.has(budget.status))
  const decided = query.data.filter((budget) => !AWAITING.has(budget.status))
  // Sin título propio se llama «Presupuesto N.º 456»: no se repite (repaso final de la ficha, B3).
  const row = (budget: PortalBudget) => {
    const number = `Presupuesto N.º ${budget.budgetNumber}`
    const named = budget.title && budget.title !== number ? `${number} · ${budget.title}` : number
    return `${named} · ${portalTotalsText(budget, budget)}`
  }
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
        <SelectTrigger
          id="portal-grant-switch"
          className="min-h-11 w-full"
          aria-invalid={select.isError || undefined}
          aria-describedby={select.isError ? "portal-grant-switch-error" : undefined}
        >
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
      {select.isError ? <FieldError id="portal-grant-switch-error">{portalErrorMessage(select.error)}</FieldError> : null}
    </Field>
  )
}

/**
 * «Antes de tu cita» (mesa del 13 nov, entrega 8): lo de su visita para su próxima cita, con la
 * misma regla de su enlace: lo responde quien decide por el paciente, una vez por cita y todo
 * opcional. En una sesión o un control se le dice a qué viene y solo se le pregunta si le duele.
 * De lo enviado solo se dice cuándo llegó, nunca qué respondió.
 */
function VisitBlock({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["portal-visit", sessionToken],
    queryFn: () => fetchPortalVisit(sessionToken),
  })
  const [reason, setReason] = useState("")
  const [pain, setPain] = useState<"si" | "no" | null>(null)
  const [painLevel, setPainLevel] = useState<string | null>(null)
  const [more, setMore] = useState("")
  const [sentNow, setSentNow] = useState(false)
  const send = useMutation({
    mutationFn: () =>
      sendPortalVisitApi(sessionToken, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(pain ? { pain } : {}),
        ...(pain === "si" && painLevel !== null ? { painLevel: Number(painLevel) } : {}),
        ...(more.trim() ? { more: more.trim() } : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["portal-visit", sessionToken], data)
      setSentNow(true)
    },
  })
  if (query.isPending) return null
  if (query.isError) return <ErrorState message={portalErrorMessage(query.error)} onRetry={() => void query.refetch()} />
  const { visit, respondent } = query.data
  const clinician = appWords().clinician.one
  if (!visit) {
    if (!sentNow) return null
    return (
      <p role="status" className="rounded-2xl bg-success-soft p-4 text-sm">
        Listo, lo recibimos. Lo lee tu {clinician} antes de atenderte.
      </p>
    )
  }
  const { questions } = visit
  return (
    <form
      aria-labelledby="portal-visit-title"
      className="flex flex-col gap-4 rounded-2xl border bg-card p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!send.isPending) send.mutate()
      }}
    >
      <div>
        <h2 id="portal-visit-title" className="text-lg font-semibold">
          Antes de tu cita
        </h2>
        <p className="text-sm text-muted-foreground">
          Para tu cita del {formatPortalDate(visit.startsAt)}. Lo lee tu {clinician} antes de empezar. Todo es opcional.
        </p>
        <p className="text-sm text-muted-foreground">
          Respondes por: {respondent.name}
          {respondent.relationship === "self" ? " (tú)" : ""}
        </p>
      </div>
      {visit.purpose ? (
        <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Vienes a: </span>
          <span className="font-medium">{visit.purpose}</span>
        </p>
      ) : null}
      {questions.reason ? (
        <Field>
          <FieldLabel htmlFor="portal-visit-reason">
            ¿A qué vienes? Cuéntalo con tus palabras: qué te molesta o qué te gustaría cambiar.
          </FieldLabel>
          <Textarea id="portal-visit-reason" rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      ) : null}
      {questions.pain ? (
        <FieldSet>
          <FieldLegend id="portal-visit-pain" variant="label">
            ¿Te duele ahora?
          </FieldLegend>
          <ChoiceButtons
            aria-labelledby="portal-visit-pain"
            value={pain}
            options={[
              { value: "no", label: "No" },
              { value: "si", label: "Sí" },
            ]}
            onChange={(value) => {
              setPain(value)
              if (value !== "si") setPainLevel(null)
            }}
            columns={2}
          />
        </FieldSet>
      ) : null}
      {questions.pain && pain === "si" ? (
        <FieldSet>
          <FieldLegend id="portal-visit-level" variant="label">
            ¿Cuánto? 0 es sin dolor, 10 el peor.
          </FieldLegend>
          <ChoiceButtons
            aria-labelledby="portal-visit-level"
            value={painLevel}
            options={Array.from({ length: 11 }, (_, level) => ({ value: String(level), label: String(level) }))}
            onChange={setPainLevel}
            onClear={() => setPainLevel(null)}
          />
        </FieldSet>
      ) : null}
      {questions.more ? (
        <Field>
          <FieldLabel htmlFor="portal-visit-more">¿Algo más que quieras contarnos?</FieldLabel>
          <Input id="portal-visit-more" maxLength={2000} value={more} onChange={(event) => setMore(event.target.value)} />
        </Field>
      ) : null}
      {send.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {portalErrorMessage(send.error)}
        </p>
      ) : null}
      <SubmitButton type="submit" className="min-h-11 self-start" pending={send.isPending}>
        Enviar
      </SubmitButton>
    </form>
  )
}

/**
 * «Lo que nos contaste de tu salud» (mesa del 13 nov, entrega 10, C8): su enlace dice qué envió y
 * cuándo, sin los valores, porque se abre sin código (decisión 9); aquí, donde entró con su
 * código, los lee tal como los envió. Lo vigente lo revisa y lo corrige su clínica. Sin nada que
 * decir no se muestra.
 */
function HealthBlock({ sessionToken }: { sessionToken: string }) {
  const query = useQuery({
    queryKey: ["portal-health", sessionToken],
    queryFn: () => fetchPortalHealth(sessionToken),
    retry: false,
  })
  if (query.isPending || query.isError || (!query.data.told && !query.data.unchanged)) return null
  const { told, unchanged } = query.data
  const lines = told ? portalHealthLines(told.health) : []
  const title = "Lo que nos contaste de tu salud"
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {told ? (
          <p className="text-sm text-muted-foreground">
            {told.reason === "correccion" ? "Lo corregiste" : told.reason === "cambio" ? "Nos dijiste que cambió" : "Lo enviaste"} el{" "}
            {formatPortalDay(told.at)}. Tu {appWords().clinician.one} lo revisa contigo; si algo está mal, corrígelo desde tu enlace o
            díselo en la cita.
          </p>
        ) : null}
      </div>
      {lines.length > 0 ? (
        <dl className="grid gap-1 text-sm">
          {lines.map((line) => (
            <div key={line.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">{line.label}</dt>
              <dd className="break-words">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {unchanged ? (
        <p className="text-sm">Después nos dijiste que nada cambió, el {formatPortalDay(unchanged.at)}.</p>
      ) : null}
    </section>
  )
}

/** Cuántos se ven de entrada: lo más reciente; el resto, con «Ver todos». */
const PAPERS_FIRST = 10

/**
 * «Tus documentos» (ADR 0156): todo lo suyo, lo más reciente primero, con su
 * tipo y la etiqueta en texto («Anulada», «Vencida», «Nuevo»), los 10 últimos y
 * «Ver todos». Cada fila se toca entera y abre el papel: el PDF o la imagen.
 * Lo arma el servidor; aquí no se decide nada.
 */
function DocumentsBlock({ sessionToken }: { sessionToken: string }) {
  const papersQuery = useQuery({
    queryKey: ["portal-papers", sessionToken],
    queryFn: () => fetchPortalPapers(sessionToken),
    retry: false,
  })
  const [opening, setOpening] = useState("")
  const [openError, setOpenError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const items = papersQuery.data ?? []
  const fresh = items.filter((paper) => paper.isNew).length
  const title = "Tus documentos"

  async function openPaper(paper: PortalPaper) {
    const key = `${paper.kind}:${paper.id}`
    // La pestaña se abre en el toque, para que el teléfono no la bloquee.
    const tab = window.open("", "_blank")
    if (tab) tab.opener = null
    setOpening(key)
    setOpenError(null)
    try {
      const url =
        paper.kind === "archivo"
          ? (await fetchPortalPaperFileUrl(sessionToken, paper.id)).url
          : URL.createObjectURL(await fetchPortalPaperPdf(sessionToken, paper))
      if (tab && !tab.closed) tab.location.href = url
      else window.open(url, "_blank", "noopener,noreferrer")
      if (url.startsWith("blob:")) window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
    } catch (error) {
      if (tab && !tab.closed) tab.close()
      setOpenError(portalErrorMessage(error))
    } finally {
      setOpening("")
    }
  }

  const body = papersQuery.isPending ? (
    <SkeletonRegion message="Cargando tus documentos…">
      <PortalDocumentsSkeleton />
    </SkeletonRegion>
  ) : papersQuery.isError ? (
    <ErrorState title="No pudimos cargar tus documentos" message={portalErrorMessage(papersQuery.error)} onRetry={() => papersQuery.refetch()} />
  ) : items.length === 0 ? (
    <EmptyState
      title="Aún no hay documentos"
      description="Aquí aparecerán tus recetas, órdenes, comprobantes e imágenes cuando la clínica los emita."
    />
  ) : (
    <div className="grid gap-2">
      {openError ? <ErrorState title="No se pudo abrir" message={`${openError} Vuelve a tocar.`} /> : null}
      <ul className="grid gap-2">
        {(all ? items : items.slice(0, PAPERS_FIRST)).map((paper) => {
          const key = `${paper.kind}:${paper.id}`
          return (
            <li key={key}>
              <button
                type="button"
                disabled={opening === key}
                onClick={() => void openPaper(paper)}
                className="flex min-h-11 w-full min-w-0 items-start gap-3 rounded-md border p-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="line-clamp-2 break-words text-sm font-medium">{paper.title}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {paper.type} · {formatPortalDay(paper.at)}
                    </span>
                    {paper.stateWord ? <Badge variant="outline">{paper.stateWord}</Badge> : null}
                    {paper.isNew ? <Badge variant="secondary">Nuevo</Badge> : null}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium text-primary">
                  {opening === key ? "Abriendo…" : "Ver"}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {!all && items.length > PAPERS_FIRST ? (
        <Button type="button" variant="ghost" className="min-h-11 self-start" onClick={() => setAll(true)}>
          Ver todos ({items.length})
        </Button>
      ) : null}
    </div>
  )

  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{title}</h2>
        {fresh > 0 ? (
          <span className="text-sm text-muted-foreground">
            · {fresh === 1 ? "1 nuevo" : `${fresh} nuevos`}
          </span>
        ) : null}
      </div>
      {body}
    </section>
  )
}

/** «6 nov 2026»: el día de un documento, sin la hora. */
function formatPortalDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(activeOrgLocale(), { dateStyle: "medium", timeZone: activeOrgTimeZone() })
  } catch {
    return formatPortalDate(iso)
  }
}

/**
 * «Tus pedidos» (ADR 0172): lo que se encargó para la persona, si ya está listo
 * para recoger, para cuándo se le prometió y lo que le falta pagar. Sin pedidos
 * no se muestra; un fallo se dice con «Reintentar».
 */
function OrdersBlock({ sessionToken }: { sessionToken: string }) {
  const orders = useQuery({
    queryKey: ["portal-orders", sessionToken],
    queryFn: () => fetchPortalOrders(sessionToken),
    retry: false,
  })
  if (orders.isPending) return null
  if (orders.isError)
    return (
      <Block title="Tus pedidos">
        <ErrorState title="No pudimos cargar tus pedidos" message={portalErrorMessage(orders.error)} onRetry={() => orders.refetch()} />
      </Block>
    )
  const { items, locale } = orders.data
  if (items.length === 0) return null
  return (
    <Block title="Tus pedidos" count={items.filter((item) => item.ready).length || undefined}>
      <ul className="flex flex-col divide-y">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.title}</span>
              <Badge variant={item.ready ? "success" : "secondary"}>{item.ready ? "Listo para recoger" : item.statusLabel}</Badge>
            </div>
            <span className="text-sm text-muted-foreground">
              Pedido N.º {item.orderNumber}
              {item.statusLabel === "Entregado" ? "" : ` · para el ${formatPortalDate(`${item.promisedOn}T12:00:00Z`, { locale })}`}
            </span>
            {item.dueCents > 0 && item.currency ? (
              <span className="text-sm">Te falta pagar {formatPortalMoney(item.dueCents, item.currency, locale)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Block>
  )
}

function AccountBlock({ sessionToken }: { sessionToken: string }) {
  const accountQuery = useQuery({
    queryKey: ["portal-account", sessionToken],
    queryFn: () => fetchPortalAccount(sessionToken),
    retry: false,
  })
  if (accountQuery.isPending)
    return (
      <SkeletonRegion message="Cargando tu cuenta…">
        <PortalAccountSkeleton />
      </SkeletonRegion>
    )
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
            {/* Sale de los presupuestos aceptados: en latidIA, sin presupuesto, no dice nada (issue 229, decisión 15). */}
            {productUi().plan.budgetRequired ? (
              <>
                <dt className="text-muted-foreground">Tratamiento aceptado</dt>
                <dd className="text-right">{formatPortalMoney(row.agreedCents, row.currency, account.locale)}</dd>
              </>
            ) : null}
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
