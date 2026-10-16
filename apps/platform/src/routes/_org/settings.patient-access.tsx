import { canAccessAny, platformPathPermission } from "@odentia/auth/permissions"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Skeleton,
  toast,
} from "@odentia/ui"
import { PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { type ReactNode, useEffect, useId, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type ConnectionItem, useMyRole, usePermission } from "../../lib/crm"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import {
  fetchPortalPolicyApi,
  type PortalPolicy,
  type PortalPolicyInput,
  savePortalPolicyApi,
} from "../../lib/portal"

export const Route = createFileRoute("/_org/settings/patient-access")({
  component: PatientPortalPage,
})

const TITLE = "Portal del paciente"
const SUBTITLE =
  "Si tus pacientes pueden entrar a su portal y qué ven ahí. El acceso de cada persona se da en la ficha del paciente."

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6"
const LINK = "font-semibold text-primary underline-offset-4 hover:underline"

function PatientPortalPage() {
  const canRead = usePermission("settings.read")
  if (!canRead) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }
  return <PortalSettings />
}

/** El hueco de la pantalla mientras carga: sus dos tarjetas y las opciones avanzadas. */
function PortalSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <p role="status" className="sr-only">
        Cargando el portal del paciente…
      </p>
      <div className={CARD} aria-hidden>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className={CARD} aria-hidden>
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-11 w-full rounded-xl" aria-hidden />
    </div>
  )
}

/** Una casilla del formulario con su explicación debajo. Se guarda con «Guardar». */
function Option({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex min-h-11 items-start gap-3 sm:min-h-0">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-ayuda` : undefined}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        {hint ? (
          <span id={`${id}-ayuda`} className="text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** Un número entero del formulario; vacío solo donde se admite. */
function NumberField({
  label,
  hint,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  value: number | null
  placeholder?: string
  disabled: boolean
  onChange: (raw: string) => void
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className="max-w-40"
        inputMode="numeric"
        value={value === null ? "" : String(value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={`${id}-ayuda`}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      />
      <FieldDescription id={`${id}-ayuda`}>{hint}</FieldDescription>
    </Field>
  )
}

/**
 * Portal del paciente. A la vista, lo que casi siempre se decide: si está
 * encendido y qué puede ver el paciente. Lo demás —solicitudes, cuánto dura
 * cada acceso, cómo se vuelve a entrar— va en «Opciones avanzadas». Es un solo
 * formulario: nada vale hasta pulsar «Guardar».
 */
function PortalSettings() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("settings.write")
  const role = useMyRole()
  // El enlace a Integraciones solo se ofrece a quien puede abrirla.
  const integrationsRule = platformPathPermission("/settings/integrations")
  const canOpenIntegrations = integrationsRule === null || canAccessAny(role, integrationsRule)
  const policyQuery = useQuery({ queryKey: ["portal-policy"], queryFn: fetchPortalPolicyApi, retry: 1 })
  const connectionsQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
    retry: 1,
  })
  const [form, setForm] = useState<PortalPolicyInput | null>(null)
  const [baseline, setBaseline] = useState<PortalPolicyInput | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    if (policyQuery.data && form === null) {
      const { updatedAt: _ignored, ...input } = policyQuery.data
      setForm({ ...input, allowedConnectionIds: [...input.allowedConnectionIds] })
      setBaseline(input)
    }
  }, [policyQuery.data, form])

  const saveMutation = useMutation({
    mutationFn: (input: PortalPolicyInput) => savePortalPolicyApi(input),
    onSuccess: (policy: PortalPolicy, submitted) => {
      const { updatedAt: _ignored, ...input } = policy
      // Lo escrito mientras se guardaba no se pisa con la respuesta.
      setForm((current) =>
        sameDraft(current, submitted) ? { ...input, allowedConnectionIds: [...input.allowedConnectionIds] } : current,
      )
      setBaseline(input)
      setProblem(null)
      toast.success("Portal del paciente guardado")
      void queryClient.invalidateQueries({ queryKey: ["portal-policy"] })
    },
  })

  if (form === null) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {policyQuery.isError ? (
          <SettingsLoadError what="el portal del paciente" onRetry={() => void policyQuery.refetch()} />
        ) : (
          <PortalSkeleton />
        )}
      </div>
    )
  }

  const set = <K extends keyof PortalPolicyInput>(key: K, value: PortalPolicyInput[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  function toggleConnection(id: string) {
    setForm((prev) => {
      if (!prev) return prev
      const next = prev.allowedConnectionIds.includes(id)
        ? prev.allowedConnectionIds.filter((c) => c !== id)
        : [...prev.allowedConnectionIds, id]
      return { ...prev, allowedConnectionIds: next }
    })
  }

  /** Lo que impide guardar; todo lo que revisa está en «Opciones avanzadas». */
  function validate(current: PortalPolicyInput): string | null {
    if (!Number.isInteger(current.linkTtlMinutes) || current.linkTtlMinutes < 1 || current.linkTtlMinutes > 43200)
      return "El enlace de activación debe valer entre 1 y 43 200 minutos."
    if (!Number.isInteger(current.sessionTtlHours) || current.sessionTtlHours < 1 || current.sessionTtlHours > 168)
      return "Una sesión debe durar entre 1 y 168 horas."
    if (
      current.grantTtlDays !== null &&
      (!Number.isInteger(current.grantTtlDays) || current.grantTtlDays < 1 || current.grantTtlDays > 3650)
    )
      return "El acceso de una persona debe vencer entre 1 y 3 650 días, o quedar vacío para que no venza."
    return null
  }

  function onSave() {
    if (form === null || !canWrite) return
    const found = validate(form)
    setProblem(found)
    if (found) {
      // El dato que falla está dentro: se abre para que se vea.
      setAdvancedOpen(true)
      return
    }
    saveMutation.mutate(form)
  }

  const connections = connectionsQuery.data?.data ?? []
  const dirty = !sameDraft(
    { ...form, allowedConnectionIds: [...form.allowedConnectionIds].sort() },
    baseline && { ...baseline, allowedConnectionIds: [...baseline.allowedConnectionIds].sort() },
  )
  const integrations = canOpenIntegrations ? (
    <Link to="/settings/integrations" className={LINK}>
      Integraciones
    </Link>
  ) : (
    "Integraciones"
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {policyQuery.isError ? (
        <SettingsLoadError stale what="el portal del paciente" onRetry={() => void policyQuery.refetch()} />
      ) : null}
      {!canWrite ? (
        <p role="note" className="text-sm text-muted-foreground">
          Puedes ver el portal; cambiarlo es de quien administra la clínica.
        </p>
      ) : null}

      <section className={CARD} aria-labelledby="portal-encendido">
        <h2 id="portal-encendido" className="font-heading text-base font-medium">
          El portal
        </h2>
        <Option
          label="Portal del paciente encendido"
          hint="Apagado, nadie entra: no se dan enlaces de acceso ni se aceptan solicitudes."
          checked={form.enabled}
          disabled={!canWrite}
          onChange={(checked) => set("enabled", checked)}
        />
      </section>

      <section className={CARD} aria-labelledby="portal-alcance">
        <div className="flex flex-col gap-1.5">
          <h2 id="portal-alcance" className="font-heading text-base font-medium">
            Lo que el paciente puede ver
          </h2>
          <p className="text-sm text-muted-foreground">
            Es el máximo para toda la clínica. A cada persona se le da acceso en la ficha del paciente, y nunca a más
            de lo marcado aquí.
          </p>
        </div>
        <Option
          label="Citas"
          checked={form.allowedScope.appointments}
          disabled={!canWrite}
          onChange={(checked) => set("allowedScope", { ...form.allowedScope, appointments: checked })}
        />
        <Option
          label="Presupuestos"
          checked={form.allowedScope.budgets}
          disabled={!canWrite}
          onChange={(checked) => set("allowedScope", { ...form.allowedScope, budgets: checked })}
        />
        <Option
          label="Cuenta y saldo"
          checked={form.allowedScope.account}
          disabled={!canWrite}
          onChange={(checked) => set("allowedScope", { ...form.allowedScope, account: checked })}
        />
        <Option
          label="Documentos"
          checked={form.allowedScope.documents}
          disabled={!canWrite}
          onChange={(checked) => set("allowedScope", { ...form.allowedScope, documents: checked })}
        />
      </section>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="elevated rounded-xl border bg-card">
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="group h-auto min-h-13 w-full justify-between gap-3 rounded-xl px-5 py-3 text-left whitespace-normal sm:px-6"
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-heading text-base font-medium">Opciones avanzadas</span>
                <span className="text-sm font-normal text-muted-foreground">
                  Solicitudes de acceso, cuánto dura cada acceso y cómo se vuelve a entrar.
                </span>
              </span>
              <ChevronDown
                aria-hidden
                className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
              />
            </Button>
          }
        />
        <CollapsibleContent>
          <div className="flex flex-col gap-8 border-t px-5 py-5 sm:px-6">
            <section className="flex flex-col gap-4" aria-labelledby="portal-solicitudes">
              <h3 id="portal-solicitudes" className="text-sm font-semibold">
                Solicitudes de acceso
              </h3>
              <Option
                label="Aceptar solicitudes de acceso"
                hint="Una persona puede pedir su acceso y tu equipo la revisa. Una solicitud nunca dice si el paciente existe ni crea pacientes."
                checked={form.requestsEnabled}
                disabled={!canWrite}
                onChange={(checked) => set("requestsEnabled", checked)}
              />
              <Option
                label="Desde la página pública de la clínica"
                hint="Un formulario público, con el nombre de tu clínica."
                checked={form.publicRequestsEnabled}
                disabled={!canWrite || !form.requestsEnabled}
                onChange={(checked) => set("publicRequestsEnabled", checked)}
              />
              <Option
                label="Desde una conversación con la clínica"
                hint="Solo si lo piden con palabras claras en un canal autorizado. Por la conversación no viajan datos clínicos."
                checked={form.channelRequestsEnabled}
                disabled={!canWrite || !form.requestsEnabled}
                onChange={(checked) => set("channelRequestsEnabled", checked)}
              />
              <div className="flex flex-col gap-2">
                <p id="portal-canales" className="text-sm font-medium">
                  Canales donde se aceptan solicitudes
                </p>
                {connectionsQuery.isPending ? (
                  <div className="flex flex-col gap-2">
                    <p role="status" className="sr-only">
                      Cargando los canales conectados…
                    </p>
                    <Skeleton className="h-5 w-56" aria-hidden />
                    <Skeleton className="h-5 w-44" aria-hidden />
                  </div>
                ) : connectionsQuery.isError && connectionsQuery.data === undefined ? (
                  <p role="alert" className="text-sm text-muted-foreground">
                    No pudimos cargar los canales conectados. Lo demás se puede guardar.{" "}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => void connectionsQuery.refetch()}
                    >
                      Reintentar
                    </Button>
                  </p>
                ) : connections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aún no hay canales conectados. Se conectan en {integrations}.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2" aria-labelledby="portal-canales">
                    {connections.map((connection) => (
                      <li key={connection.id}>
                        <Option
                          label={`${connection.displayName} · ${channelLabel(connection.channel)}`}
                          checked={form.allowedConnectionIds.includes(connection.id)}
                          disabled={!canWrite}
                          onChange={() => toggleConnection(connection.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {connections.length > 0 ? (
                  <p className="text-sm text-muted-foreground">Los canales se conectan en {integrations}.</p>
                ) : null}
                {form.channelRequestsEnabled && form.allowedConnectionIds.length === 0 ? (
                  <p role="note" className="text-sm text-warning">
                    Sin un canal marcado, nadie podrá pedir su acceso desde una conversación.
                  </p>
                ) : null}
              </div>
              <Option
                label="Aprobar sola una solicitud si la identidad ya está verificada"
                hint="Apagado, tu equipo revisa cada solicitud. Encendido, se aprueba sola únicamente cuando tu equipo ya verificó antes a esa persona, con su documento o con evidencia registrada. Que coincida el teléfono nunca basta."
                checked={form.autoApproveVerified}
                disabled={!canWrite}
                onChange={(checked) => set("autoApproveVerified", checked)}
              />
            </section>

            <section className="flex flex-col gap-4" aria-labelledby="portal-vigencias">
              <h3 id="portal-vigencias" className="text-sm font-semibold">
                Cuánto dura cada acceso
              </h3>
              <NumberField
                label="El enlace de activación vale (minutos)"
                hint="Entre 1 y 43 200, que son 30 días."
                value={form.linkTtlMinutes}
                disabled={!canWrite}
                onChange={(raw) => {
                  const next = Number(raw)
                  set("linkTtlMinutes", Number.isSafeInteger(next) ? next : form.linkTtlMinutes)
                }}
              />
              <NumberField
                label="Una sesión abierta dura (horas)"
                hint="Entre 1 y 168, que son 7 días."
                value={form.sessionTtlHours}
                disabled={!canWrite}
                onChange={(raw) => {
                  const next = Number(raw)
                  set("sessionTtlHours", Number.isSafeInteger(next) ? next : form.sessionTtlHours)
                }}
              />
              <NumberField
                label="El acceso de una persona vence a los (días)"
                hint="Entre 1 y 3 650. Vacío, no vence."
                value={form.grantTtlDays}
                placeholder="No vence"
                disabled={!canWrite}
                onChange={(raw) => set("grantTtlDays", raw === "" ? null : Number(raw))}
              />
            </section>

            <section className="flex flex-col gap-4" aria-labelledby="portal-reingreso">
              <h3 id="portal-reingreso" className="text-sm font-semibold">
                Volver a entrar y recuperar el acceso
              </h3>
              <Option
                label="Volver a entrar con su propio dispositivo"
                hint="Tras activar con el enlace y el código, la persona registra su teléfono o computadora —con su huella, su rostro o la clave del equipo— y entra con él las siguientes veces."
                checked={form.passkeysEnabled}
                disabled={!canWrite}
                onChange={(checked) => set("passkeysEnabled", checked)}
              />
              <Option
                label="Recuperar el acceso con un código"
                hint="Si la persona ya entró y necesita volver a entrar, tu equipo le envía un enlace nuevo y le dice un código de 6 dígitos por una vía distinta del mensaje. La primera vez siempre entra con ese código, aunque esto esté apagado."
                checked={form.assistedRecoveryEnabled}
                disabled={!canWrite}
                onChange={(checked) => set("assistedRecoveryEnabled", checked)}
              />
            </section>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {saveMutation.isError ? (
        <Alert variant="destructive">
          <AlertTitle>No pudimos guardar el portal del paciente</AlertTitle>
          <AlertDescription>
            {saveMutation.error instanceof ApiError && saveMutation.error.shape.message
              ? saveMutation.error.shape.message
              : "Lo que escribiste sigue aquí: vuelve a intentarlo."}
          </AlertDescription>
        </Alert>
      ) : null}
      {canWrite ? (
        <div>
          <SubmitButton className="min-h-11" pending={saveMutation.isPending} onClick={onSave}>
            Guardar
          </SubmitButton>
        </div>
      ) : null}
    </div>
  )
}
