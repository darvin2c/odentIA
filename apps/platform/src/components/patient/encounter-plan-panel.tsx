/**
 * «Plan y controles» dentro de la atención (tablero 3, ADR 0034): un solo
 * bloque en lugar de «Plan de tratamiento», «Tratamientos de esta atención» y
 * «Controles». De arriba abajo: el plan en corto con lo indicado hoy marcado e
 * «Indicar un tratamiento», «Hecho hoy» con «Completar», «Próximo control» con
 * «Reservar» y, si hay un presupuesto por enviar y la persona sigue en el
 * sillón, «Enviar presupuesto».
 *
 * Indicar no ejecuta ni cobra, y no se elige plan: va al plan abierto de la
 * persona, que se crea solo con la primera indicación.
 */
import { formatMoney, surfacesForTooth } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchTreatmentPlans, planDecisionLabel } from "../../lib/budgets"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { type OdontogramState, type PlanItem, planStatusLabel } from "../../lib/patients"
import { type ServiceCatalogItem, TREATMENT_SCOPE_LABELS } from "../../lib/services"
import { ControlesPanel } from "./clinical-panels"
import { Cie10Search } from "./cie10-search"
import { EncounterTreatments } from "./encounter-treatments"
import { treatmentSiteLabel } from "./plan/budget-parts"
import { BudgetSendButton } from "./plan/budget-send"
import { usePlanNextStep } from "./plan/plan-next"
import { ServicePicker } from "./service-picker"
import { ToothSelector } from "./tooth-selector"

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

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : "No se pudo guardar la indicación."
}

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
}: {
  patientId: string
  encounterId: string
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

      <EncounterBudgetSend patientId={patientId} beforeWrite={beforeWrite} />
    </div>
  )
}

/**
 * «Enviar presupuesto» mientras la persona sigue en el sillón: el borrador que
 * ya está armado (de una atención anterior o revisado). Lo de esta atención se
 * suma al firmar, y el cierre pregunta «¿Enviárselo ahora?». La misma regla de
 * «Qué sigue» decide si hay algo que enviar.
 */
function EncounterBudgetSend({
  patientId,
  beforeWrite,
}: {
  patientId: string
  beforeWrite: () => Promise<void>
}): React.JSX.Element | null {
  const canSend = usePermission("budgets.send")
  const step = usePlanNextStep(patientId, canSend).data?.data ?? null
  if (!canSend || step?.kind !== "enviar" || !step.action?.budgetId) return null
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
      </div>
    </BlockPart>
  )
}

/** «Indicar un tratamiento»: ámbito y sitio, prestación con su tarifa, hallazgo, detalle y CIE-10. */
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
  const [scope, setScope] = useState("general")
  const [teeth, setTeeth] = useState<number[]>([])
  const [surfaces, setSurfaces] = useState<string[]>([])
  const [quadrant, setQuadrant] = useState("")
  const [arch, setArch] = useState("")
  const [service, setService] = useState<ServiceCatalogItem | null>(null)
  const [findingId, setFindingId] = useState("")
  const [detail, setDetail] = useState("")
  const [cie, setCie] = useState("")
  const [error, setError] = useState<string | null>(null)

  const odontogramQuery = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
    enabled: canRead,
  })
  // Solo hallazgos vigentes de la pieza elegida: la indicación responde a lo observado.
  const tooth = teeth[0] ?? null
  const findings = (odontogramQuery.data?.data.history ?? []).filter(
    (entry) => !entry.voidedAt && tooth != null && entry.toothNumber === tooth,
  )

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!service) throw new Error("Busca y elige la prestación de la lista de servicios.")
      // Sin plan: el servidor usa el abierto o lo crea con esta atención como origen.
      const body: Record<string, unknown> = {
        serviceId: service.id,
        sourceEncounterId: encounterId,
        detail: detail.trim() === "" ? null : detail.trim(),
        diagnosisCode: cie.trim() === "" ? null : cie.trim(),
        odontogramEntryId: findingId === "" ? null : findingId,
      }
      if (scope === "tooth" || scope === "surfaces") {
        if (tooth == null) throw new Error("Selecciona la pieza.")
        body.toothNumber = tooth
      }
      if (scope === "surfaces") {
        if (surfaces.length === 0) throw new Error("Marca al menos una superficie.")
        body.surfaces = surfaces
      }
      if (scope === "quadrant") {
        if (!quadrant) throw new Error("Elige el cuadrante.")
        body.quadrant = Number(quadrant)
      }
      if (scope === "arch") {
        if (!arch) throw new Error("Elige la arcada.")
        body.arch = arch
      }
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
        setService(null)
        setDetail("")
        setCie("")
        setFindingId("")
        setError(null)
      } finally {
        onPendingChange(false)
      }
    },
    onError: (err) => setError(mutationMessage(err)),
  })

  const blocked = disabled || addMutation.isPending
  const validSurfaces = tooth != null ? surfacesForTooth(tooth).map(String) : []
  const toggleSurface = (surface: string): void => {
    setSurfaces((prev) =>
      prev.includes(surface) ? prev.filter((s) => s !== surface) : [...prev, surface],
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${uid}-scope`}>Ámbito</FieldLabel>
          <Select value={scope} onValueChange={(v) => setScope(v ?? "general")} disabled={blocked}>
            <SelectTrigger id={`${uid}-scope`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TREATMENT_SCOPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {(scope === "tooth" || scope === "surfaces") && (
          <Field>
            <FieldLabel>Pieza</FieldLabel>
            <ToothSelector
              value={teeth.slice(0, 1)}
              onChange={(next) => {
                setTeeth(next.slice(0, 1))
                setSurfaces([])
                setFindingId("")
              }}
              disabled={blocked}
            />
          </Field>
        )}
        {(scope === "tooth" || scope === "surfaces") && findings.length > 0 && (
          <Field>
            <FieldLabel htmlFor={`${uid}-finding`}>Hallazgo que motiva</FieldLabel>
            <Select
              value={findingId || undefined}
              onValueChange={(v) => setFindingId(v ?? "")}
              disabled={blocked}
            >
              <SelectTrigger id={`${uid}-finding`}>
                <SelectValue placeholder="Sin hallazgo asociado" />
              </SelectTrigger>
              <SelectContent>
                {findings.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.condition}
                    {entry.surface ? ` · ${entry.surface}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {scope === "quadrant" && (
          <Field>
            <FieldLabel htmlFor={`${uid}-quadrant`}>Cuadrante</FieldLabel>
            <Select value={quadrant} onValueChange={(v) => setQuadrant(v ?? "")} disabled={blocked}>
              <SelectTrigger id={`${uid}-quadrant`}>
                <SelectValue placeholder="Elige el cuadrante" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(QUADRANT_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {scope === "arch" && (
          <Field>
            <FieldLabel htmlFor={`${uid}-arch`}>Arcada</FieldLabel>
            <Select value={arch} onValueChange={(v) => setArch(v ?? "")} disabled={blocked}>
              <SelectTrigger id={`${uid}-arch`}>
                <SelectValue placeholder="Elige la arcada" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upper">Superior</SelectItem>
                <SelectItem value="lower">Inferior</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      {scope === "surfaces" && tooth != null ? (
        <Field>
          <FieldLabel>Superficies de la pieza {tooth}</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {validSurfaces.map((surface) => (
              <FieldLabel key={surface} className="flex items-center gap-1.5 text-sm font-normal">
                <Checkbox
                  checked={surfaces.includes(surface)}
                  disabled={blocked}
                  onCheckedChange={() => toggleSurface(surface)}
                />
                {surface}
              </FieldLabel>
            ))}
          </div>
        </Field>
      ) : null}

      <ServicePicker
        value={service?.id ?? ""}
        label="Tratamiento"
        disabled={blocked}
        onChange={(next) => {
          setService(next)
          if (next.scope) setScope(next.scope)
          setError(null)
        }}
      />
      {service ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Precio de la tarifa:{" "}
          {orgLocale ? formatMoney(service.priceCents, service.currency, orgLocale) : "…"}
          {service.scope ? ` · ${TREATMENT_SCOPE_LABELS[service.scope] ?? service.scope}` : ""}
        </p>
      ) : null}

      <Field>
        <FieldLabel htmlFor={`${uid}-detail`}>Detalle</FieldLabel>
        <Textarea
          id={`${uid}-detail`}
          rows={2}
          value={detail}
          maxLength={4000}
          disabled={blocked}
          onChange={(e) => setDetail(e.target.value)}
        />
      </Field>
      <Cie10Search value={cie} onChange={(code) => setCie(code)} disabled={blocked} />

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          className="self-start"
          disabled={blocked || !service}
          onClick={() => void addMutation.mutate()}
        >
          {addMutation.isPending ? "Añadiendo…" : "Añadir al plan"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Se conserva la pieza elegida para indicar el siguiente. Al firmar la atención, lo indicado
          se suma al presupuesto por enviar.
        </p>
      </div>
    </div>
  )
}
