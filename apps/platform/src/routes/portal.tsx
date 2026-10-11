import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  closePortalSessionApi,
  confirmPortalAppointmentApi,
  createPublicPortalRequestApi,
  decidePortalBudgetApi,
  fetchPortalAccount,
  fetchPortalAppointments,
  fetchPortalBudgets,
  fetchPortalDocumentUrl,
  fetchPortalDocuments,
  fetchPortalQuestionnaire,
  fetchPortalSession,
  fetchPublicPortalPolicyApi,
  formatPortalDate,
  formatPortalMoney,
  listMyPortalGrantsApi,
  portalErrorMessage,
  requestPasskeyAuthOptionsApi,
  requestPasskeyRegistrationOptionsApi,
  reschedulePortalAppointmentApi,
  savePortalQuestionnaireApi,
  fetchPortalRescheduleSlots,
  exchangePortalTokenApi,
  selectPortalGrantApi,
  verifyPasskeyAuthApi,
  verifyPasskeyRegistrationApi,
  type PortalAppointment,
  type PortalBudget,
} from "../lib/portal"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { AnswerInput, isFieldVisible, missingRequired } from "../components/patient/form-fields"

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

function defaultOrgSlug(override?: string): string {
  if (override && override.trim() !== "") return override.trim()
  try {
    return orgSlugFromHostname(requestHostname()) ?? ""
  } catch {
    return ""
  }
}

const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  programada: "Programada",
  confirmada: "Confirmada",
  atendida: "Atendida",
  no_asistio: "No asistió",
  cancelada: "Cancelada",
}

const BUDGET_STATUS_LABEL: Record<string, string> = {
  presentado: "Presentado",
  aceptado: "Aceptado",
  parcial: "Parcial",
  rechazado: "Rechazado",
  pospuesto: "Pospuesto",
  cancelado: "Cancelado",
  sustituido: "Sustituido",
  historico: "Histórico",
}

const DECISION_LABEL: Record<string, string> = {
  aceptado: "Acepto",
  rechazado: "Rechazo",
  pospuesto: "Pospongo",
}

function readStoredPortalSession(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function readStoredPortalOrg(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage.getItem(ORG_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredPortalSession(value: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value)
    else window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Almacenamiento no disponible: la sesión vive solo en memoria.
  }
}

function writeStoredPortalOrg(value: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (value) window.sessionStorage.setItem(ORG_STORAGE_KEY, value)
    else window.sessionStorage.removeItem(ORG_STORAGE_KEY)
  } catch {
    // Almacenamiento no disponible: la organización vive solo en memoria.
  }
}

function PortalPage() {
  const { token, org } = Route.useSearch()
  const navigate = useNavigate({ from: Route.id })
  // La sesión guardada vive en sessionStorage, que no existe en el servidor:
  // se lee al montar para que el HTML del servidor y el primer render del
  // cliente coincidan (sin error de hidratación).
  const [hydrated, setHydrated] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [storedOrg, setStoredOrg] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [pin, setPin] = useState("")
  useEffect(() => {
    setSessionToken(readStoredPortalSession())
    setStoredOrg(readStoredPortalOrg())
    setHydrated(true)
  }, [])

  const exchangeMutation = useMutation({
    mutationFn: (code: string) => exchangePortalTokenApi(token ?? "", code),
    onSuccess: (data) => {
      // La org se resuelve de la fuente confiable actual (parámetro explícito u
      // hostname), nunca de una sesión anterior; el token crudo sale de la URL.
      const slug = defaultOrgSlug(org ?? storedOrg ?? "")
      writeStoredPortalSession(data.sessionToken)
      setSessionToken(data.sessionToken)
      if (slug !== "") {
        writeStoredPortalOrg(slug)
        setStoredOrg(slug)
      } else {
        writeStoredPortalOrg(null)
        setStoredOrg(null)
      }
      setPin("")
      void navigate({ search: { org, token: undefined }, replace: true })
    },
  })

  function adoptSession(nextToken: string, orgSlug: string | null) {
    writeStoredPortalSession(nextToken)
    setSessionToken(nextToken)
    if (orgSlug) {
      writeStoredPortalOrg(orgSlug)
      setStoredOrg(orgSlug)
    }
    setClosed(false)
    setPin("")
  }

  function forgetSession() {
    writeStoredPortalSession(null)
    setSessionToken(null)
  }

  if (!hydrated)
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message="Abriendo tu portal…" />
      </PageShell>
    )

  if (!sessionToken && (!token || closed)) {
    if (closed) {
      return (
        <PageShell maxWidth="md">
          <EmptyState
            title="Sesión cerrada"
            description="Cerraste tu acceso. Puedes volver a entrar con tu passkey."
          />
          <PortalAccessLandingContent
            initialOrg={defaultOrgSlug(org ?? storedOrg ?? "")}
            onSession={(nextToken, orgSlug) => adoptSession(nextToken, orgSlug)}
          />
        </PageShell>
      )
    }
    return (
      <PortalAccessLanding
        initialOrg={defaultOrgSlug(org ?? storedOrg ?? "")}
        onSession={(nextToken, orgSlug) => adoptSession(nextToken, orgSlug)}
      />
    )
  }

  if (!sessionToken && token && !closed) {
    const pinValid = /^\d{6}$/.test(pin)
    return (
      <PageShell maxWidth="md">
        <PageHeader
          title="Portal del paciente"
          subtitle="Ingresa el código de 6 dígitos que te dio la clínica por una vía independiente del mensaje."
        />
        <div className="grid gap-3">
          <Label htmlFor="portal-pin">Código de acceso</Label>
          <Input
            id="portal-pin"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 dígitos"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          {exchangeMutation.isError && (
            <ErrorState
              title="No pudimos abrir tu acceso"
              message={portalErrorMessage(exchangeMutation.error)}
            />
          )}
          <div>
            <SubmitButton
              pending={exchangeMutation.isPending}
              disabled={!pinValid}
              onClick={() => exchangeMutation.mutate(pin)}
            >
              Abrir mi portal
            </SubmitButton>
          </div>
          <p className="text-sm text-muted-foreground">
            Si venció, fue revocado o agotaste los intentos, pide un nuevo enlace en recepción.
          </p>
        </div>
      </PageShell>
    )
  }
  if (!sessionToken) return null
  return (
    <PortalDashboard
      sessionToken={sessionToken}
      orgSlug={storedOrg ?? defaultOrgSlug(org ?? "")}
      onSessionToken={(nextToken) => adoptSession(nextToken, storedOrg ?? defaultOrgSlug(org ?? ""))}
      onClose={() => { setClosed(true); forgetSession() }}
    />
  )
}

function PortalDashboard({
  sessionToken,
  orgSlug,
  onSessionToken,
  onClose,
}: {
  sessionToken: string
  orgSlug: string
  onSessionToken: (nextToken: string) => void
  onClose: () => void
}) {
  const sessionQuery = useQuery({
    queryKey: ["portal-session", sessionToken],
    queryFn: () => fetchPortalSession(sessionToken),
    retry: false,
  })
  const closeMutation = useMutation({
    mutationFn: () => closePortalSessionApi(sessionToken),
    onSuccess: () => {
      writeStoredPortalSession(null)
      onClose()
    },
  })
  useEffect(() => {
    if (sessionQuery.isError) writeStoredPortalSession(null)
  }, [sessionQuery.isError])

  if (sessionQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Cargando tu portal…" />
      </PageShell>
    )
  }
  if (sessionQuery.isError) {
    return (
      <PageShell maxWidth="md">
        <ErrorState
          title="Tu sesión terminó"
          message={portalErrorMessage(sessionQuery.error)}
        />
        <p className="mt-3 text-center text-sm text-muted-foreground">
          Pide un nuevo enlace en recepción para volver a entrar.
        </p>
      </PageShell>
    )
  }
  const info = sessionQuery.data
  const scope = info.session.scope
  const tabs = [
    scope.appointments && { value: "citas", label: "Citas" },
    scope.appointments && { value: "cuestionario", label: "Antes de tu cita" },
    scope.budgets && { value: "presupuestos", label: "Presupuestos" },
    scope.documents.length > 0 && { value: "documentos", label: "Documentos" },
    scope.account && { value: "cuenta", label: "Cuenta" },
  ].filter((t): t is { value: string; label: string } => t !== false)
  const defaultTab = tabs[0]?.value ?? "citas"

  return (
    <PageShell maxWidth="lg">
      <PageHeader
        title={`Hola, ${info.patientName}`}
        subtitle={`Tu acceso vence el ${formatPortalDate(info.session.expiresAt)}; no compartas esta pantalla.`}
      />
      <GrantSwitcher sessionToken={sessionToken} onSessionToken={onSessionToken} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tabs.map((t) => (
          <Badge key={t.value} variant="secondary">{t.label}</Badge>
        ))}
        <span className="flex-1" />
        <Button variant="outline" size="sm" disabled={closeMutation.isPending} onClick={() => closeMutation.mutate()}>
          Cerrar sesión
        </Button>
      </div>
      <PasskeyRegisterSection sessionToken={sessionToken} orgSlug={orgSlug} />
      {tabs.length === 0 ? (
        <EmptyState title="Sin secciones" description="Tu acceso no tiene secciones autorizadas." />
      ) : (
        <Tabs defaultValue={defaultTab}>
          {/* En móvil las pestañas se desplazan en horizontal: nunca desbordan la página. */}
          <TabsList className="max-w-full justify-start overflow-x-auto">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
          {scope.appointments && (
            <TabsContent value="citas">
              <AppointmentsTab sessionToken={sessionToken} />
            </TabsContent>
          )}
          {scope.appointments && (
            <TabsContent value="cuestionario">
              <QuestionnaireTab sessionToken={sessionToken} />
            </TabsContent>
          )}
          {scope.budgets && (
            <TabsContent value="presupuestos">
              <BudgetsTab sessionToken={sessionToken} />
            </TabsContent>
          )}
          {scope.documents.length > 0 && (
            <TabsContent value="documentos">
              <DocumentsTab sessionToken={sessionToken} />
            </TabsContent>
          )}
          {scope.account && (
            <TabsContent value="cuenta">
              <AccountTab sessionToken={sessionToken} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </PageShell>
  )
}

function AppointmentsTab({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const appointmentsQuery = useQuery({
    queryKey: ["portal-appointments", sessionToken],
    queryFn: () => fetchPortalAppointments(sessionToken),
    retry: false,
  })
  const confirmMutation = useMutation({
    mutationFn: (id: string) => confirmPortalAppointmentApi(sessionToken, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["portal-appointments", sessionToken] }),
  })
  const [rescheduling, setRescheduling] = useState("")
  const [slotDay, setSlotDay] = useState("")
  const [chosenSlot, setChosenSlot] = useState("")
  const rescheduleMutation = useMutation({
    mutationFn: (appt: PortalAppointment) =>
      reschedulePortalAppointmentApi(sessionToken, appt.id, {
        expectedVersion: appt.version,
        startsAt: chosenSlot,
      }),
    onSuccess: () => {
      setRescheduling("")
      setSlotDay("")
      setChosenSlot("")
      void queryClient.invalidateQueries({ queryKey: ["portal-appointments", sessionToken] })
    },
  })

  if (appointmentsQuery.isPending) return <LoadingState message="Cargando tus citas…" />
  if (appointmentsQuery.isError) {
    return <ErrorState title="No pudimos cargar tus citas" message={portalErrorMessage(appointmentsQuery.error)} onRetry={() => appointmentsQuery.refetch()} />
  }
  const items = appointmentsQuery.data
  if (items.length === 0) {
    return <EmptyState title="Sin citas próximas" description="No tienes citas programadas por ahora." />
  }
  const mutationError = confirmMutation.isError
    ? portalErrorMessage(confirmMutation.error)
    : rescheduleMutation.isError
      ? portalErrorMessage(rescheduleMutation.error)
      : null
  return (
    <div className="grid gap-3">
      {mutationError && <ErrorState title="No se pudo actualizar la cita" message={mutationError} />}
      {items.map((appt) => {
        const future = new Date(appt.startsAt).getTime() > Date.now()
        const confirmable = appt.status === "programada" && future
        const movable = (appt.status === "programada" || appt.status === "confirmada") && future
        return (
          <div key={appt.id} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{appt.serviceName ?? "Cita"}</p>
              <Badge variant={appt.status === "confirmada" ? "default" : "secondary"}>
                {APPOINTMENT_STATUS_LABEL[appt.status] ?? appt.status}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatPortalDate(appt.startsAt)} · {appt.branchName}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {confirmable && (
                <SubmitButton
                  size="sm"
                  pending={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate(appt.id)}
                >
                  Confirmar asistencia
                </SubmitButton>
              )}
              {movable && rescheduling !== appt.id && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRescheduling(appt.id)
                    setSlotDay(new Date().toISOString().slice(0, 10))
                    setChosenSlot("")
                  }}
                >
                  Pedir reprogramación
                </Button>
              )}
            </div>
            {rescheduling === appt.id && (
              <RescheduleSlots
                sessionToken={sessionToken}
                appt={appt}
                slotDay={slotDay}
                onDayChange={(day) => { setSlotDay(day); setChosenSlot("") }}
                chosenSlot={chosenSlot}
                onChoose={setChosenSlot}
                pending={rescheduleMutation.isPending}
                onConfirm={() => rescheduleMutation.mutate(appt)}
                onCancel={() => { setRescheduling(""); setSlotDay(""); setChosenSlot("") }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function RescheduleSlots({
  sessionToken,
  appt,
  slotDay,
  onDayChange,
  chosenSlot,
  onChoose,
  pending,
  onConfirm,
  onCancel,
}: {
  sessionToken: string
  appt: PortalAppointment
  slotDay: string
  onDayChange: (day: string) => void
  chosenSlot: string
  onChoose: (startsAt: string) => void
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const range = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDay)) return null
    const from = new Date(`${slotDay}T00:00:00`)
    if (!Number.isFinite(from.getTime())) return null
    return { from: from.toISOString(), to: new Date(from.getTime() + 7 * 24 * 3600_000).toISOString() }
  })()
  const slotsQuery = useQuery({
    queryKey: ["portal-slots", sessionToken, appt.id, range?.from, range?.to],
    queryFn: () => fetchPortalRescheduleSlots(sessionToken, appt.id, { from: range!.from, to: range!.to }),
    enabled: range !== null,
    retry: false,
  })
  return (
    <div className="mt-2 grid gap-2">
      <Label htmlFor={`portal-slot-day-${appt.id}`}>Elige el día</Label>
      <Input
        id={`portal-slot-day-${appt.id}`}
        type="date"
        value={slotDay}
        onChange={(e) => onDayChange(e.target.value)}
      />
      {slotsQuery.isPending && <LoadingState message="Buscando huecos…" />}
      {slotsQuery.isError && (
        <ErrorState
          title="No pudimos buscar huecos"
          message={portalErrorMessage(slotsQuery.error)}
          onRetry={() => slotsQuery.refetch()}
        />
      )}
      {slotsQuery.data && slotsQuery.data.slots.length === 0 && (
        <p className="text-sm text-muted-foreground">Sin huecos esos días; prueba con otro día.</p>
      )}
      {slotsQuery.data && slotsQuery.data.slots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {slotsQuery.data.slots.map((slot) => (
            <Button
              key={slot.startsAt}
              variant={chosenSlot === slot.startsAt ? "default" : "outline"}
              size="sm"
              onClick={() => onChoose(slot.startsAt)}
            >
              {formatPortalDate(slot.startsAt)}
            </Button>
          ))}
        </div>
      )}
      {slotsQuery.data?.truncated && (
        <p className="text-xs text-muted-foreground">Hay más huecos: elige un día próximo para verlos.</p>
      )}
      <div className="flex gap-2">
        <SubmitButton size="sm" pending={pending} disabled={!chosenSlot} onClick={onConfirm}>
          Mover mi cita
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Huecos reales con tu mismo profesional y sillón (Agenda).
      </p>
    </div>
  )
}

/**
 * Cuestionario previo a la cita, por pasos (una sección por paso). Se guarda
 * el avance al cambiar de paso; al enviarlo, el equipo lo revisa contigo.
 */
function QuestionnaireTab({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["portal-questionnaire", sessionToken],
    queryFn: () => fetchPortalQuestionnaire(sessionToken),
  })
  const [answers, setAnswers] = useState<Record<string, unknown> | null>(null)
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (submit: boolean) =>
      savePortalQuestionnaireApi(sessionToken, { answers: answers ?? {}, submit }),
    onSuccess: (data) => {
      setError(null)
      queryClient.setQueryData(["portal-questionnaire", sessionToken], data)
    },
    onError: (e) => setError(portalErrorMessage(e)),
  })
  if (query.isPending) return <LoadingState message="Cargando tu cuestionario…" />
  if (query.isError) return <ErrorState message={portalErrorMessage(query.error)} />
  const { template, response, respondent } = query.data
  if (!template)
    return (
      <EmptyState
        title="No hay cuestionario pendiente"
        description="Tu clínica no te ha pedido completar información antes de la cita."
      />
    )
  if (response?.submittedAt)
    return (
      <EmptyState
        title="Gracias, recibimos tus respuestas"
        description={`Las enviaste el ${formatPortalDate(response.submittedAt)}; tu odontólogo las revisará contigo en la cita.`}
      />
    )
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
    <section aria-labelledby="questionnaire-title" className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div>
        <h2 id="questionnaire-title" className="text-lg font-semibold">
          {template.title}
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

function BudgetsTab({ sessionToken }: { sessionToken: string }) {
  const queryClient = useQueryClient()
  const budgetsQuery = useQuery({
    queryKey: ["portal-budgets", sessionToken],
    queryFn: () => fetchPortalBudgets(sessionToken),
    retry: false,
  })
  if (budgetsQuery.isPending) return <LoadingState message="Cargando tus presupuestos…" />
  if (budgetsQuery.isError) {
    return <ErrorState title="No pudimos cargar tus presupuestos" message={portalErrorMessage(budgetsQuery.error)} onRetry={() => budgetsQuery.refetch()} />
  }
  const items = budgetsQuery.data
  if (items.length === 0) {
    return <EmptyState title="Sin presupuestos" description="No tienes presupuestos presentados por ahora." />
  }
  return (
    <div className="grid gap-4">
      {items.map((budget) => (
        <BudgetCard
          key={budget.id}
          sessionToken={sessionToken}
          budget={budget}
          onDecided={() => void queryClient.invalidateQueries({ queryKey: ["portal-budgets", sessionToken] })}
        />
      ))}
    </div>
  )
}

function BudgetCard({ sessionToken, budget, onDecided }: { sessionToken: string; budget: PortalBudget; onDecided: () => void }) {
  const [decisions, setDecisions] = useState<Record<string, "aceptado" | "rechazado" | "pospuesto">>({})
  const [note, setNote] = useState("")
  const decideMutation = useMutation({
    mutationFn: () =>
      decidePortalBudgetApi(sessionToken, budget.id, {
        decisions: budget.items.map((item) => ({
          planItemId: item.planItemId,
          decision: decisions[item.planItemId] ?? "pospuesto",
        })),
        decisionNote: note.trim() || null,
      }),
    onSuccess: onDecided,
  })
  const decidable = budget.status === "presentado"

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">
          {budget.title} · N.º {budget.budgetNumber} rev. {budget.revisionNumber}
        </p>
        <Badge variant={budget.status === "presentado" ? "default" : "secondary"}>
          {BUDGET_STATUS_LABEL[budget.status] ?? budget.status}
        </Badge>
      </div>
      {budget.notes && <p className="mt-1 text-sm text-muted-foreground">{budget.notes}</p>}
      <ul className="mt-2 grid gap-1">
        {budget.items.map((item) => (
          <li key={item.planItemId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex-1">{item.title}</span>
            <span className="font-medium">{formatPortalMoney(item.priceCents, item.currency)}</span>
            {decidable ? (
              <Select
                value={decisions[item.planItemId] ?? "pospuesto"}
                onValueChange={(v) => {
                  if (v !== "aceptado" && v !== "rechazado" && v !== "pospuesto") return
                  setDecisions((prev) => ({ ...prev, [item.planItemId]: v }))
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
              </Select>
            ) : (
              <Badge variant="secondary">{DECISION_LABEL[item.decision] ?? item.decision}</Badge>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm font-medium">Total: {formatPortalMoney(budget.totalCents, budget.currency)}</p>
      {budget.decidedAt && (
        <p className="mt-1 text-xs text-muted-foreground">
          Decidido el {formatPortalDate(budget.decidedAt)}
          {budget.acceptedByName ? ` por ${budget.acceptedByName}` : ""}
          {budget.decisionNote ? ` · ${budget.decisionNote}` : ""}
        </p>
      )}
      {decidable && (
        <div className="mt-3 grid gap-2">
          <Label htmlFor={`portal-note-${budget.id}`}>Comentario (opcional)</Label>
          <Textarea
            id={`portal-note-${budget.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Algo que la clínica deba saber…"
            maxLength={2000}
          />
          {decideMutation.isError && (
            <ErrorState title="No se pudo registrar tu decisión" message={portalErrorMessage(decideMutation.error)} />
          )}
          <div>
            <SubmitButton pending={decideMutation.isPending} onClick={() => decideMutation.mutate()}>
              Enviar mi decisión
            </SubmitButton>
          </div>
        </div>
      )}
    </div>
  )
}

function DocumentsTab({ sessionToken }: { sessionToken: string }) {
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

function AccountTab({ sessionToken }: { sessionToken: string }) {
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
          <p className="text-sm font-medium">Saldo en {row.currency}</p>
          <p className="mt-1 text-2xl font-semibold">{formatPortalMoney(row.outstandingCents, row.currency)}</p>
          <p className="text-xs text-muted-foreground">pendiente de pago</p>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Tratamiento aceptado</dt>
            <dd className="text-right">{formatPortalMoney(row.agreedCents, row.currency)}</dd>
            <dt className="text-muted-foreground">Cargado</dt>
            <dd className="text-right">{formatPortalMoney(row.chargedCents, row.currency)}</dd>
            <dt className="text-muted-foreground">Pagado</dt>
            <dd className="text-right">{formatPortalMoney(row.paidCents, row.currency)}</dd>
            {row.availableCreditCents > 0 && (
              <>
                <dt className="text-muted-foreground">Crédito a favor</dt>
                <dd className="text-right">{formatPortalMoney(row.availableCreditCents, row.currency)}</dd>
              </>
            )}
          </dl>
        </div>
      ))}
      <div className="grid gap-2">
        <p className="text-sm font-medium">Historial</p>
        {account.charges.map((charge) => (
          <div key={`c-${charge.id}`} className="flex items-center gap-2 text-sm">
            <span className="flex-1">{charge.description}</span>
            <span>{formatPortalMoney(charge.amountCents, charge.currency)}</span>
            {charge.voidedAt && <Badge variant="secondary">Anulado</Badge>}
          </div>
        ))}
        {account.payments.map((payment) => (
          <div key={`p-${payment.id}`} className="flex items-center gap-2 text-sm">
            <span className="flex-1">
              Pago · {payment.method}{payment.reference ? ` · ${payment.reference}` : ""} · {formatPortalDate(payment.paidAt)}
            </span>
            <span>{formatPortalMoney(payment.amountCents, payment.currency)}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        El pago se realiza en recepción o por los medios de la clínica; aquí ves tu historial y saldo real.
      </p>
    </div>
  )
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
function passkeyFriendlyMessage(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError")
    return "Se canceló la operación. Vuelve a intentarlo cuando quieras."
  return portalErrorMessage(error)
}

function PortalAccessLanding({
  initialOrg,
  onSession,
}: {
  initialOrg: string
  onSession: (nextToken: string, orgSlug: string) => void
}) {
  return (
    <PageShell maxWidth="md">
      <PortalAccessLandingContent initialOrg={initialOrg} onSession={onSession} />
    </PageShell>
  )
}

function PortalAccessLandingContent({
  initialOrg,
  onSession,
}: {
  initialOrg: string
  onSession: (nextToken: string, orgSlug: string) => void
}) {
  return (
    <>
      <PageHeader
        title="Portal del paciente"
        subtitle="Solicita acceso a tu clínica o entra con tu passkey si ya registraste este dispositivo."
      />
      <Tabs defaultValue="solicitar">
        <TabsList>
          <TabsTrigger value="solicitar">Solicitar acceso</TabsTrigger>
          <TabsTrigger value="passkey">Entrar con passkey</TabsTrigger>
        </TabsList>
        <TabsContent value="solicitar">
          <PublicRequestForm initialOrg={initialOrg} />
        </TabsContent>
        <TabsContent value="passkey">
          <PasskeyLoginForm initialOrg={initialOrg} onSession={onSession} />
        </TabsContent>
      </Tabs>
      <p className="mt-4 text-sm text-muted-foreground">
        ¿Tienes un enlace de la clínica? Ábrelo directamente: te pedirá tu código de 6 dígitos.
      </p>
    </>
  )
}

function PublicRequestForm({ initialOrg }: { initialOrg: string }) {
  const [orgSlug, setOrgSlug] = useState(initialOrg)
  const [contactName, setContactName] = useState("")
  const [contactText, setContactText] = useState("")
  const [patientHint, setPatientHint] = useState("")

  // En hostname de la clínica la organización es conocida: sin código técnico.
  const hostnameOrg = defaultOrgSlug()
  const effectiveOrg = (hostnameOrg !== "" ? hostnameOrg : orgSlug).trim()
  const debouncedOrg = useDebouncedValue(effectiveOrg, 300)

  const policyQuery = useQuery({
    queryKey: ["public-portal-policy", debouncedOrg],
    queryFn: () => fetchPublicPortalPolicyApi(debouncedOrg),
    enabled: debouncedOrg !== "",
    retry: false,
  })
  const requestsOpen = policyQuery.data
    ? policyQuery.data.enabled && policyQuery.data.requestsEnabled
    : true

  const requestMutation = useMutation({
    mutationFn: () =>
      createPublicPortalRequestApi({
        orgSlug: effectiveOrg,
        contactName: contactName.trim(),
        contactText: contactText.trim(),
        patientHint: patientHint.trim() === "" ? undefined : patientHint.trim(),
        idempotencyKey: crypto.randomUUID(),
      }),
  })

  if (requestMutation.isSuccess) {
    return (
      <div className="grid gap-3 pt-2">
        <p className="text-sm" role="status">
          Recibimos tu solicitud. Si la clínica la aprueba tras verificar tu identidad, te
          contactará por la vía que indicaste. Este paso puede tomar unos días.
        </p>
      </div>
    )
  }

  const canSubmit =
    effectiveOrg !== "" &&
    contactName.trim() !== "" &&
    contactText.trim() !== "" &&
    requestsOpen &&
    !requestMutation.isPending

  return (
    <div className="grid gap-3 pt-2">
      {hostnameOrg !== "" ? (
        <p className="text-sm text-muted-foreground" role="note">
          Solicitud para {policyQuery.data?.orgName ? `la clínica ${policyQuery.data.orgName}` : "tu clínica"}.
        </p>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="portal-request-org">Código de la organización</Label>
          <Input
            id="portal-request-org"
            value={orgSlug}
            maxLength={128}
            placeholder="El código que te dio la clínica"
            onChange={(e) => setOrgSlug(e.target.value)}
          />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="portal-request-name">Tu nombre</Label>
        <Input
          id="portal-request-name"
          value={contactName}
          maxLength={120}
          autoComplete="name"
          onChange={(e) => setContactName(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="portal-request-contact">Dónde contactarte</Label>
        <Input
          id="portal-request-contact"
          value={contactText}
          maxLength={200}
          placeholder="Teléfono o correo"
          onChange={(e) => setContactText(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Solo para gestionar tu solicitud. El teléfono no verifica tu identidad.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="portal-request-hint">Paciente al que representas (opcional)</Label>
        <Input
          id="portal-request-hint"
          value={patientHint}
          maxLength={200}
          onChange={(e) => setPatientHint(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Usaremos estos datos solo para gestionar tu acceso al portal. No los usaremos para
        publicidad ni los compartiremos con terceros con fines de marketing.
      </p>
      {requestMutation.isError && (
        <ErrorState
          title="No pudimos enviar tu solicitud"
          message={portalErrorMessage(requestMutation.error)}
        />
      )}
      <div>
        {!requestsOpen && (
          <p className="text-sm text-muted-foreground" role="note">
            Esta organización no recibe solicitudes web por ahora. Pide tu acceso en recepción.
          </p>
        )}
        <SubmitButton
          pending={requestMutation.isPending}
          disabled={!canSubmit}
          onClick={() => requestMutation.mutate()}
        >
          Enviar solicitud
        </SubmitButton>
      </div>
    </div>
  )
}

function PasskeyLoginForm({
  initialOrg,
  onSession,
}: {
  initialOrg: string
  onSession: (nextToken: string, orgSlug: string) => void
}) {
  const [orgSlug, setOrgSlug] = useState(initialOrg)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window
  const hostnameOrg = defaultOrgSlug()
  const effectiveOrg = (hostnameOrg !== "" ? hostnameOrg : orgSlug).trim()
  const debouncedOrg = useDebouncedValue(effectiveOrg, 300)
  const policyQuery = useQuery({
    queryKey: ["public-portal-policy", debouncedOrg],
    queryFn: () => fetchPublicPortalPolicyApi(debouncedOrg),
    enabled: debouncedOrg !== "",
    retry: false,
  })
  const passkeysOpen = policyQuery.data
    ? policyQuery.data.enabled && policyQuery.data.passkeysEnabled
    : true

  async function login() {
    const slug = effectiveOrg
    if (slug === "" || pending) return
    setPending(true)
    setError(null)
    try {
      const challenge = await requestPasskeyAuthOptionsApi(slug)
      const response = await startAuthentication({ optionsJSON: challenge.options })
      const result = await verifyPasskeyAuthApi(slug, {
        challengeId: challenge.challengeId,
        response,
      })
      onSession(result.sessionToken, slug)
    } catch (e) {
      setError(passkeyFriendlyMessage(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-3 pt-2">
      {hostnameOrg !== "" ? (
        <p className="text-sm text-muted-foreground" role="note">
          Acceso para {policyQuery.data?.orgName ? `la clínica ${policyQuery.data.orgName}` : "tu clínica"}.
        </p>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="portal-passkey-org">Código de la organización</Label>
          <Input
            id="portal-passkey-org"
            value={orgSlug}
            maxLength={128}
            placeholder="El código que te dio la clínica"
            onChange={(e) => setOrgSlug(e.target.value)}
          />
        </div>
      )}
      {!supported && (
        <p className="text-sm text-muted-foreground" role="alert">
          Este navegador no admite passkeys. Usa un navegador reciente o pide un nuevo enlace en
          recepción.
        </p>
      )}
      {error && <ErrorState title="No pudimos abrir tu acceso" message={error} />}
      {policyQuery.data && !passkeysOpen && (
        <p className="text-sm text-muted-foreground" role="note">
          Esta organización no tiene activado el acceso con passkey. Pide un enlace en recepción.
        </p>
      )}
      <div>
        <SubmitButton pending={pending} disabled={effectiveOrg === "" || !supported || !passkeysOpen} onClick={() => void login()}>
          Entrar con mi passkey
        </SubmitButton>
      </div>
      <p className="text-xs text-muted-foreground">
        Si representas a varios pacientes, elegirás entre tus accesos autorizados tras entrar.
      </p>
    </div>
  )
}

function GrantSwitcher({
  sessionToken,
  onSessionToken,
}: {
  sessionToken: string
  onSessionToken: (nextToken: string) => void
}) {
  const queryClient = useQueryClient()
  const [grantId, setGrantId] = useState("")
  const grantsQuery = useQuery({
    queryKey: ["portal-my-grants", sessionToken],
    queryFn: () => listMyPortalGrantsApi(sessionToken),
    retry: false,
  })
  const sessionQuery = useQuery({
    queryKey: ["portal-session", sessionToken],
    queryFn: () => fetchPortalSession(sessionToken),
    retry: false,
  })
  const selectMutation = useMutation({
    mutationFn: (id: string) => selectPortalGrantApi(sessionToken, id),
    onSuccess: (result) => {
      setGrantId("")
      onSessionToken(result.sessionToken)
      void queryClient.invalidateQueries({ queryKey: ["portal-session"] })
      void queryClient.invalidateQueries({ queryKey: ["portal-my-grants"] })
    },
  })

  if (grantsQuery.isPending || grantsQuery.isError) return null
  const active = grantsQuery.data.filter((g) => g.status === "activo")
  if (active.length <= 1) return null
  const current = sessionQuery.data

  return (
    <div className="mb-4 grid gap-2 rounded-md border p-3">
      <Label htmlFor="portal-grant-switch">Paciente autorizado</Label>
      <div className="flex flex-wrap gap-2">
        <Select
          value={grantId}
          onValueChange={(value) => {
            if (value !== null) setGrantId(value)
          }}
        >
          <SelectTrigger id="portal-grant-switch" className="min-w-48 flex-1">
            <SelectValue placeholder="Elige el paciente" />
          </SelectTrigger>
          <SelectContent>
            {active.map((g) => {
              const isCurrent =
                current !== undefined &&
                g.patientId === current.session.patientId &&
                g.contactId === current.session.contactId
              return (
                <SelectItem key={g.id} value={g.id}>
                  {g.patientName}
                  {isCurrent ? " (actual)" : ""}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <SubmitButton
          size="sm"
          pending={selectMutation.isPending}
          disabled={grantId === ""}
          onClick={() => selectMutation.mutate(grantId)}
        >
          Cambiar
        </SubmitButton>
      </div>
      {selectMutation.isError && (
        <ErrorState
          title="No pudimos cambiar de paciente"
          message={portalErrorMessage(selectMutation.error)}
        />
      )}
    </div>
  )
}

function PasskeyRegisterSection({
  sessionToken,
  orgSlug,
}: {
  sessionToken: string
  orgSlug: string
}) {
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window

  async function register() {
    if (orgSlug === "" || pending) return
    setPending(true)
    setError(null)
    try {
      const challenge = await requestPasskeyRegistrationOptionsApi(sessionToken, orgSlug)
      const response = await startRegistration({ optionsJSON: challenge.options })
      await verifyPasskeyRegistrationApi(sessionToken, orgSlug, {
        challengeId: challenge.challengeId,
        response,
      })
      setDone(true)
    } catch (e) {
      setError(passkeyFriendlyMessage(e))
    } finally {
      setPending(false)
    }
  }

  if (!supported || orgSlug === "") return null
  return (
    <div className="mb-4 grid gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">Acceso rápido en este dispositivo</p>
      {done ? (
        <p className="text-sm text-muted-foreground" role="status">
          Passkey registrada. La próxima vez entra con tu huella, rostro o PIN del dispositivo.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Registra este dispositivo para entrar sin enlace ni código. Solo funciona aquí.
          </p>
          {error && <ErrorState title="No pudimos registrar tu passkey" message={error} />}
          <div>
            <SubmitButton size="sm" pending={pending} onClick={() => void register()}>
              Registrar passkey
            </SubmitButton>
          </div>
        </>
      )}
    </div>
  )
}
