import { toast } from "@odentia/ui"
import { PageHeader, SkeletonRegion, SubmitButton, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { usePermission } from "../../lib/crm"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import {
  fetchPortalPolicyApi,
  type PortalPolicyInput,
  savePortalPolicyApi,
} from "../../lib/portal"
import { PatientPortalPageSkeleton, PatientPortalSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/patient-access")({
  pendingComponent: PatientPortalPageSkeleton,
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

/**
 * Portal del paciente (ADR 0037): solo si está encendido y qué puede ver el
 * paciente. Lo demás son valores fijos, que la página dice en palabras: el
 * enlace de recepción vale 3 días, el acceso no vence hasta «Quitar acceso» y
 * se vuelve a entrar con la huella o la cara (o 30 días recordado en el
 * teléfono). Es un solo formulario: nada vale hasta pulsar «Guardar».
 */
function PortalSettings() {
  const policyQuery = useQuery({ queryKey: ["portal-policy"], queryFn: fetchPortalPolicyApi, retry: 1 })
  if (!policyQuery.data) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {policyQuery.isError ? (
          <SettingsLoadError what="el portal del paciente" onRetry={() => void policyQuery.refetch()} />
        ) : (
          <SkeletonRegion message="Cargando el portal del paciente…">
            <PatientPortalSkeleton />
          </SkeletonRegion>
        )}
      </div>
    )
  }
  const { updatedAt: _ignored, ...initial } = policyQuery.data
  return (
    <PortalForm
      initial={initial}
      staleError={policyQuery.isError}
      onRetry={() => void policyQuery.refetch()}
    />
  )
}

/** El formulario, con los valores guardados una sola vez: una recarga no pisa el borrador. */
function PortalForm({
  initial,
  staleError,
  onRetry,
}: {
  initial: PortalPolicyInput
  staleError: boolean
  onRetry: () => void
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("settings.write")
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      const policy = await savePortalPolicyApi(value)
      const { updatedAt: _ignored, ...saved } = policy
      // Lo marcado mientras se guardaba no se pisa con la respuesta.
      if (sameDraft(form.state.values, value)) form.reset(saved)
      toast.success("Portal del paciente guardado")
      void queryClient.invalidateQueries({ queryKey: ["portal-policy"] })
    },
  })
  const dirty = useStore(form.store, (state) => !state.isDefaultValue)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const submitError = useFormSubmitError(form)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {staleError ? <SettingsLoadError stale what="el portal del paciente" onRetry={onRetry} /> : null}
      {!canWrite ? (
        <p role="note" className="text-sm text-muted-foreground">
          Puedes ver el portal; cambiarlo es de quien administra la clínica.
        </p>
      ) : null}

      <section className={CARD} aria-labelledby="portal-encendido">
        <h2 id="portal-encendido" className="font-heading text-base font-medium">
          El portal
        </h2>
        <form.AppField name="enabled">
          {(field) => (
            <field.CheckboxField
              label="Portal del paciente encendido"
              description="Apagado por defecto. Apagado, nadie entra y no se dan accesos."
              disabled={!canWrite}
            />
          )}
        </form.AppField>
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
        <form.AppField name="allowedScope.appointments">
          {(field) => <field.CheckboxField label="Citas" disabled={!canWrite} />}
        </form.AppField>
        <form.AppField name="allowedScope.budgets">
          {(field) => <field.CheckboxField label="Presupuestos" disabled={!canWrite} />}
        </form.AppField>
        <form.AppField name="allowedScope.account">
          {(field) => <field.CheckboxField label="Cuenta y saldo" disabled={!canWrite} />}
        </form.AppField>
        <form.AppField name="allowedScope.documents">
          {(field) => <field.CheckboxField label="Documentos" disabled={!canWrite} />}
        </form.AppField>
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

      {canWrite ? (
        <div className="flex flex-col gap-2">
          <div>
            <SubmitButton className="min-h-11" pending={isSubmitting} onClick={() => void submitForm(form)}>
              Guardar
            </SubmitButton>
          </div>
          {submitError ? (
            // Junto a «Guardar» (ADR 0113), con el título de siempre de esta pantalla.
            <div role="alert" className="flex flex-col gap-0.5 text-sm text-destructive">
              <p className="font-medium">No pudimos guardar el portal del paciente</p>
              <p>{submitError}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
