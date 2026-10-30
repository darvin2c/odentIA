/**
 * «Plan y controles» dentro de la atención (tablero 3, ADR 0034): un solo
 * bloque en lugar de «Plan de tratamiento», «Tratamientos de esta atención» y
 * «Controles». De arriba abajo: el plan en corto con lo indicado hoy marcado e
 * «Indicar un tratamiento», «Hecho hoy» con «Completar», «Próximo control» con
 * «Reservar» y, si hay un presupuesto por enviar y la persona sigue en el
 * unidad dental, «Enviar presupuesto».
 *
 * Indicar no ejecuta ni cobra, y no se elige plan: va al plan abierto de la
 * persona, que se crea solo con la primera indicación.
 */
import { formatMoney } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldLabel,
} from "@odentia/ui"
import { LoadingState, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useId, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { fetchTreatmentPlans, planDecisionLabel } from "../../lib/budgets"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { type PlanItem, planStatusLabel } from "../../lib/patients"
import { type ServiceCatalogItem, TREATMENT_SCOPE_LABELS } from "../../lib/services"
import { ControlesPanel } from "./clinical-panels"
import { DiagnosisSearch } from "./diagnosis-search"
import { EncounterTreatments } from "./encounter-treatments"
import { treatmentSiteLabel } from "./plan/budget-parts"
import { BudgetSendButton } from "./plan/budget-send"
import { BudgetShowActions } from "./plan/budget-show"
import { usePlanNextStep } from "./plan/plan-next"
import { ServicePicker } from "./service-picker"
import { productUi } from "../../product/product-ui"
import { partNames } from "../../product/site-fields"

const QUADRANT_LABELS: Record<string, string> = {
  "1": "Cuadrante 1 · superior derecho",
  "2": "Cuadrante 2 · superior izquierdo",
  "3": "Cuadrante 3 · inferior izquierdo",
  "4": "Cuadrante 4 · inferior derecho",
  "5": "Cuadrante 5 · superior derecho temporal",
  "6": "Cuadrante 6 · superior izquierdo temporal",
  "7": "Cuadrante 7 · inferior izquierdo temporal",
  "8": "Cuadrante 8 · inferior derecho temporal",
}

/** Lo cerrado ya no es «lo que sigue» en el plan en corto. */
const CLOSED = new Set(["realizado", "cancelado", "reemplazado"])

const QUADRANT_OPTIONS = Object.entries(QUADRANT_LABELS).map(([value, label]) => ({ value, label }))
const ARCH_OPTIONS = [
  { value: "upper", label: "Superior" },
  { value: "lower", label: "Inferior" },
]
const SCOPE_OPTIONS = Object.entries(TREATMENT_SCOPE_LABELS).map(([value, label]) => ({ value, label }))

interface IndicationValues {
  scope: string
  teeth: number[]
  surfaces: string[]
  quadrant: string
  arch: string
  service: ServiceCatalogItem | null
  odontogramEntryId: string
  detail: string
  diagnosisCode: string
}

const EMPTY_INDICATION: IndicationValues = {
  scope: "general",
  teeth: [],
  surfaces: [],
  quadrant: "",
  arch: "",
  service: null,
  odontogramEntryId: "",
  detail: "",
  diagnosisCode: "",
}

/** Lo que falta para indicar, en el campo que hay que completar. */
function indicationErrors(value: IndicationValues): Record<string, string> {
  const fields: Record<string, string> = {}
  if (!value.service) fields.service = "Busca y elige la prestación de la lista de servicios."
  if ((value.scope === "tooth" || value.scope === "surfaces") && value.teeth.length === 0)
    fields.teeth = "Selecciona la pieza."
  if (value.scope === "surfaces" && value.teeth.length > 0 && value.surfaces.length === 0)
    fields.surfaces = "Marca al menos una superficie."
  if (value.scope === "quadrant" && !value.quadrant) fields.quadrant = "Elige el cuadrante."
  if (value.scope === "arch" && !value.arch) fields.arch = "Elige la arcada."
  return fields
}

/** El servidor nombra el dato como en el cuerpo de la petición. */
const INDICATION_FIELD_MAP = { serviceId: "service", toothNumber: "teeth" }

function BlockPart({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-base font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function EncounterPlanPanel({
  patientId,
  encounterId,
  plannedItems,
  indicatedItems,
  attentionItems,
  disabled = false,
  autoOpen = false,
  beforeWrite,
  onChanged,
  onPendingChange,
  patientName,
}: {
  patientId: string
  encounterId: string
  /** Para «Mostrar a Rosa» el presupuesto en borrador. */
  patientName: string
  /** Tratamientos vinculados a esta atención (sesión registrada o traídos por la cita). */
  plannedItems: PlanItem[]
  /** Indicados en esta atención: se marcan «Hoy» en el plan en corto. */
  indicatedItems: PlanItem[]
  /** Unos y otros, para ligar un control a su tratamiento. */
  attentionItems: PlanItem[]
  disabled?: boolean
  /** Recién agregado el bloque: abre «Indicar un tratamiento» sin un clic de más. */
  autoOpen?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const orgLocale = useOrgProfile().data?.locale
  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled: canRead,
  })
  const itemsQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canRead,
  })
  const openPlan = (plansQuery.data?.data ?? []).find((row) => row.isOpen) ?? null
  const today = new Set(indicatedItems.map((item) => item.id))
  // El plan en corto: lo abierto del plan vigente, con lo de hoy primero.
  const brief = (itemsQuery.data?.data ?? [])
    .filter((item) => item.planId === openPlan?.plan.id && !CLOSED.has(item.status))
    .sort((a, b) => Number(today.has(b.id)) - Number(today.has(a.id)))
  const [indicating, setIndicating] = useState(autoOpen)

  return (
    <div className="flex flex-col gap-4">
      <BlockPart title="Plan">
        {itemsQuery.isPending || plansQuery.isPending ? (
          <LoadingState message="Cargando el plan…" />
        ) : brief.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay tratamientos por hacer. El primero que indiques abre el plan.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {brief.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {item.title}
                    {today.has(item.id) ? (
                      <Badge variant="default" className="ml-2 align-middle">
                        Hoy
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      treatmentSiteLabel(item),
                      item.priceCents != null && orgLocale
                        ? formatMoney(item.priceCents, item.currency, orgLocale)
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Badge variant={item.decisionStatus === "aceptado" ? "success" : "secondary"}>
                    {planDecisionLabel(item.decisionStatus)}
                  </Badge>
                  <Badge variant="outline">{planStatusLabel(item.status)}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <Collapsible open={indicating} onOpenChange={setIndicating} className="flex flex-col gap-3">
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant={indicating ? "ghost" : "outline"}
                  size="sm"
                  className="group self-start"
                  disabled={disabled}
                >
                  Indicar un tratamiento
                  <ChevronDown
                    aria-hidden
                    className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                  />
                </Button>
              }
            />
            <CollapsibleContent>
              <IndicationForm
                patientId={patientId}
                encounterId={encounterId}
                disabled={disabled}
                beforeWrite={beforeWrite}
                onChanged={onChanged}
                onPendingChange={onPendingChange}
              />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </BlockPart>

      <EncounterTreatments
        patientId={patientId}
        encounterId={encounterId}
        items={plannedItems}
        disabled={disabled}
        beforeWrite={beforeWrite}
        onChanged={() => void onChanged()}
      />

      <ControlesPanel
        patientId={patientId}
        encounterId={encounterId}
        encounterOnly
        items={attentionItems}
        heading="Próximo control"
      />

      <EncounterBudgetSend patientId={patientId} patientName={patientName} beforeWrite={beforeWrite} />
    </div>
  )
}

/**
 * «Enviar presupuesto» mientras la persona sigue en la unidad dental: el borrador que
 * ya está armado (de una atención anterior, revisado o armado a pedido con
 * Clío). Se le muestra a pantalla completa, se imprime o se envía sin salir de
 * la atención. Lo de esta atención se suma al firmar, y el cierre pregunta
 * «¿Enviárselo ahora?». La misma regla de «Qué sigue» decide si hay algo que enviar.
 */
export function EncounterBudgetSend({
  patientId,
  patientName,
  beforeWrite,
  compact = false,
}: {
  patientId: string
  patientName: string
  beforeWrite: () => Promise<void>
  /** En el bloque cerrado de la atención: una fila, sin abrir el bloque (lo armado por Clío se ve ahí). */
  compact?: boolean
}): React.JSX.Element | null {
  const canSend = usePermission("budgets.send")
  const step = usePlanNextStep(patientId, canSend).data?.data ?? null
  if (!canSend || step?.kind !== "enviar" || !step.action?.budgetId) return null
  if (compact) {
    return (
      <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2">
        <span className="min-w-0 flex-1 text-sm">
          Presupuesto por enviar{step.detail ? ` · ${step.detail}` : ""}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <BudgetShowActions patientId={patientId} budgetId={step.action.budgetId} patientName={patientName} beforeWrite={beforeWrite} />
          <BudgetSendButton patientId={patientId} budgetId={step.action.budgetId} size="sm" beforeSend={beforeWrite} />
        </div>
      </div>
    )
  }
  return (
    <BlockPart title="Presupuesto por enviar">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {step.detail ?? "Ya está armado y nadie lo envió."} Lo que indiques hoy se suma al firmar.
        </p>
        <BudgetSendButton
          patientId={patientId}
          budgetId={step.action.budgetId}
          size="sm"
          beforeSend={beforeWrite}
        />
        <BudgetShowActions patientId={patientId} budgetId={step.action.budgetId} patientName={patientName} beforeWrite={beforeWrite} />
      </div>
    </BlockPart>
  )
}

/** «Indicar un tratamiento»: ámbito y sitio, prestación con su tarifa, hallazgo, detalle y diagnóstico. */
function IndicationForm({
  patientId,
  encounterId,
  disabled,
  beforeWrite,
  onChanged,
  onPendingChange,
}: {
  patientId: string
  encounterId: string
  disabled: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canRead = usePermission("clinical.read")
  const orgLocale = useOrgProfile().data?.locale
  const uid = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  const form = useAppForm({
    defaultValues: EMPTY_INDICATION,
    validators: {
      onSubmit: ({ value }) => {
        const fields = indicationErrors(value)
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!value.service) return
      const tooth = value.teeth[0] ?? null
      // Sin plan: el servidor usa el abierto o lo crea con esta atención como origen.
      const body: Record<string, unknown> = {
        serviceId: value.service.id,
        sourceEncounterId: encounterId,
        detail: value.detail.trim() === "" ? null : value.detail.trim(),
        diagnosisCode: value.diagnosisCode.trim() === "" ? null : value.diagnosisCode.trim(),
        odontogramEntryId: value.odontogramEntryId === "" ? null : value.odontogramEntryId,
      }
      if (value.scope === "tooth" || value.scope === "surfaces") body.toothNumber = tooth
      if (value.scope === "surfaces") body.surfaces = value.surfaces
      if (value.scope === "quadrant") body.quadrant = Number(value.quadrant)
      if (value.scope === "arch") body.arch = value.arch
      onPendingChange(true)
      try {
        await beforeWrite()
        await apiFetch(`/api/patients/${patientId}/plan/items`, {
          method: "POST",
          body: JSON.stringify(body),
        })
        await Promise.all(
          ["treatment-plans", "treatment-plan", "plan-items", "patient-summary", "plan-next"].map((key) =>
            queryClient.invalidateQueries({ queryKey: [key, patientId] }),
          ),
        )
        await onChanged()
        // Se conserva el ámbito y el sitio para indicar el siguiente.
        form.reset({ ...value, service: null, detail: "", diagnosisCode: "", odontogramEntryId: "" })
      } finally {
        onPendingChange(false)
      }
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const scope = useStore(form.store, (state) => state.values.scope)
  const tooth = useStore(form.store, (state) => state.values.teeth[0] ?? null)
  const service = useStore(form.store, (state) => state.values.service)

  const vigentes = productUi().useFindings(patientId, canRead)
  // Solo hallazgos vigentes de la pieza elegida: la indicación responde a lo observado.
  const findings = vigentes.filter((entry) => tooth != null && entry.toothNumber === tooth)

  const blocked = disabled || pending
  // El «dónde» del producto (odentIA: la pieza y sus caras).
  const site = productUi().site
  const validSurfaces = tooth != null ? (site?.partsOf(tooth) ?? []).map(String) : []

  return (
    <div ref={rootRef} className="flex flex-col gap-3 rounded-lg border p-4">
      {/* Lo que falta se dice en su campo; lo que no es de ninguno, junto al botón. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Sin «dónde» (latidIA, decisión 4 del issue 229) todo es general: no hay ámbito que elegir. */}
        {site ? (
          <form.AppField name="scope">
            {(field) => (
              <field.SelectField id={`${uid}-scope`} label="Ámbito" options={SCOPE_OPTIONS} disabled={blocked} />
            )}
          </form.AppField>
        ) : null}
        {site && (scope === "tooth" || scope === "surfaces") && (
          <form.AppField
            name="teeth"
            listeners={{
              onChange: () => {
                form.setFieldValue("surfaces", [])
                form.setFieldValue("odontogramEntryId", "")
              },
            }}
          >
            {(field) => (
              <field.Control id={`${uid}-place`} label={site.placeLabel}>
                {(control) => (
                  <site.PlacesPicker
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value.slice(0, 1)}
                    onChange={(next) => field.handleChange(next.slice(0, 1))}
                    disabled={blocked}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        )}
        {(scope === "tooth" || scope === "surfaces") && findings.length > 0 && (
          <form.AppField name="odontogramEntryId">
            {(field) => (
              <field.SelectField
                id={`${uid}-finding`}
                label="Hallazgo que motiva"
                placeholder="Sin hallazgo asociado"
                disabled={blocked}
                options={findings.map((entry) => ({
                  value: entry.id,
                  label: `${site?.findingName(entry.condition) ?? entry.condition}${entry.surface ? ` · ${partNames([entry.surface])}` : ""}`,
                }))}
              />
            )}
          </form.AppField>
        )}
        {scope === "quadrant" && (
          <form.AppField name="quadrant">
            {(field) => (
              <field.SelectField
                id={`${uid}-quadrant`}
                label="Cuadrante"
                placeholder="Elige el cuadrante"
                options={QUADRANT_OPTIONS}
                disabled={blocked}
              />
            )}
          </form.AppField>
        )}
        {scope === "arch" && (
          <form.AppField name="arch">
            {(field) => (
              <field.SelectField
                id={`${uid}-arch`}
                label="Arcada"
                placeholder="Elige la arcada"
                options={ARCH_OPTIONS}
                disabled={blocked}
              />
            )}
          </form.AppField>
        )}
      </div>

      {scope === "surfaces" && tooth != null ? (
        <form.AppField name="surfaces">
          {(field) => (
            <field.Group legend={`Superficies de la pieza ${tooth}`}>
              {(control) => (
                <div className="flex flex-wrap gap-2">
                  {validSurfaces.map((surface, index) => (
                    <FieldLabel key={surface} className="flex items-center gap-1.5 text-sm font-normal">
                      <Checkbox
                        id={index === 0 ? control.id : undefined}
                        checked={field.state.value.includes(surface)}
                        disabled={blocked}
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        onCheckedChange={() =>
                          field.handleChange(
                            field.state.value.includes(surface)
                              ? field.state.value.filter((s) => s !== surface)
                              : [...field.state.value, surface],
                          )
                        }
                      />
                      {partNames([surface])}
                    </FieldLabel>
                  ))}
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
      ) : null}

      <form.AppField name="service">
        {(field) => (
          <field.Control id={`${uid}-service`} label="Tratamiento">
            {(control) => (
              <ServicePicker
                id={control.id}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                value={field.state.value?.id ?? ""}
                disabled={blocked}
                onChange={(next) => {
                  field.handleChange(next)
                  if (next.scope) form.setFieldValue("scope", next.scope)
                }}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      {service ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Precio de la tarifa:{" "}
          {orgLocale ? formatMoney(service.priceCents, service.currency, orgLocale) : "…"}
          {site && service.scope ? ` · ${TREATMENT_SCOPE_LABELS[service.scope] ?? service.scope}` : ""}
        </p>
      ) : null}

      <form.AppField name="detail">
        {(field) => (
          <field.TextareaField id={`${uid}-detail`} label="Detalle" rows={2} maxLength={4000} disabled={blocked} />
        )}
      </form.AppField>
      <form.AppField name="diagnosisCode">
        {(field) => (
          <field.Control id={`${uid}-diagnosis`} label="Diagnóstico (opcional)">
            {(control) => (
              <DiagnosisSearch
                id={control.id}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                value={field.state.value}
                onChange={(code) => field.handleChange(code)}
                disabled={blocked}
              />
            )}
          </field.Control>
        )}
      </form.AppField>

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          className="self-start"
          disabled={blocked}
          onClick={() => void submitForm(form, { root: rootRef.current, fieldMap: INDICATION_FIELD_MAP })}
        >
          {pending ? "Añadiendo…" : "Añadir al plan"}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {productUi().plan.budgetRequired ? (
          <p className="text-xs text-muted-foreground">
            Se conserva la pieza elegida para indicar el siguiente. Al firmar la atención, lo indicado
            se suma al presupuesto por enviar.
          </p>
        ) : (
          // latidIA (decisión 15 del issue 229): sin «dónde» que conservar ni presupuesto que esperar.
          <p className="text-xs text-muted-foreground">
            Lo indicado queda aceptado: se puede agendar enseguida, sin presupuesto.
          </p>
        )}
      </div>
    </div>
  )
}
