import { Alert, AlertDescription, AlertTitle, Checkbox, Skeleton, toast } from "@odentia/ui"
import { PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ReactNode, useEffect, useId, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
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

/** El hueco de la pantalla mientras carga: sus tarjetas. */
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

/**
 * Portal del paciente (ADR 0037): solo si está encendido y qué puede ver el
 * paciente. Lo demás son valores fijos, que la página dice en palabras: el
 * enlace de recepción vale 3 días, el acceso no vence hasta «Quitar acceso» y
 * se vuelve a entrar con la huella o la cara (o 30 días recordado en el
 * teléfono). Es un solo formulario: nada vale hasta pulsar «Guardar».
 */
function PortalSettings() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("settings.write")
  const policyQuery = useQuery({ queryKey: ["portal-policy"], queryFn: fetchPortalPolicyApi, retry: 1 })
  const [form, setForm] = useState<PortalPolicyInput | null>(null)
  const [baseline, setBaseline] = useState<PortalPolicyInput | null>(null)

  useEffect(() => {
    if (policyQuery.data && form === null) {
      const { updatedAt: _ignored, ...input } = policyQuery.data
      setForm(input)
      setBaseline(input)
    }
  }, [policyQuery.data, form])

  const saveMutation = useMutation({
    mutationFn: (input: PortalPolicyInput) => savePortalPolicyApi(input),
    onSuccess: (policy: PortalPolicy, submitted) => {
      const { updatedAt: _ignored, ...input } = policy
      // Lo escrito mientras se guardaba no se pisa con la respuesta.
      setForm((current) =>
        sameDraft(current, submitted) ? input : current,
      )
      setBaseline(input)
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

  function onSave() {
    if (form === null || !canWrite) return
    saveMutation.mutate(form)
  }

  const dirty = !sameDraft(form, baseline)

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
          hint="Apagado por defecto. Apagado, nadie entra y no se dan accesos."
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

      <section className={CARD} aria-labelledby="portal-fijo">
        <h2 id="portal-fijo" className="font-heading text-base font-medium">
          Cómo se entra
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>El acceso se da en la página de cada persona, en persona y con su documento.</li>
          <li>La primera vez entra con el enlace de recepción, que vale 3 días, y un código de 6 dígitos que se le dice aparte.</li>
          <li>Después entra con su huella o su cara. Si su teléfono no puede guardarlo, lo recordamos 30 días.</li>
          <li>El acceso no vence: dura hasta que alguien del equipo pulse «Quitar acceso».</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Para la cita, los datos, el presupuesto y el consentimiento no hace falta el portal: cada persona tiene «Su enlace».
        </p>
      </section>

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
