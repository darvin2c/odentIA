import { surfacesForTooth } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  createTreatmentPlanApi,
  fetchTreatmentPlanDetail,
  fetchTreatmentPlans,
  planDecisionLabel,
} from "../../lib/budgets"
import { createOptionGroupApi } from "../../lib/clinical-journey"
import { useCanWrite } from "../../lib/crm"
import type { OdontogramState, PlanItem } from "../../lib/patients"
import { formatMoney, type ServiceCatalogItem, TREATMENT_SCOPE_LABELS } from "../../lib/services"
import { Cie10Search } from "./cie10-search"
import { treatmentSiteLabel } from "./plan-tab"
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

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : "No se pudo guardar la indicación."
}

/**
 * Indicación durante la atención: plan con origen aquí, ámbito y sitio,
 * prestación del tarifario con tarifa de solo lectura y alta una por una sin
 * cerrar el panel ni perder la boca. Registrar indicación nunca ejecuta nada.
 */
export function EncounterPlanPanel({
  patientId,
  encounterId,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
}: {
  patientId: string
  encounterId: string
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const uid = useId()

  const [planId, setPlanId] = useState("")
  const [newTitle, setNewTitle] = useState("Plan de tratamiento")
  const [scope, setScope] = useState("general")
  const [teeth, setTeeth] = useState<number[]>([])
  const [surfaces, setSurfaces] = useState<string[]>([])
  const [quadrant, setQuadrant] = useState("")
  const [arch, setArch] = useState("")
  const [service, setService] = useState<ServiceCatalogItem | null>(null)
  const [findingId, setFindingId] = useState("")
  const [optionGroupId, setOptionGroupId] = useState("")
  const [isRecommended, setIsRecommended] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupTitle, setGroupTitle] = useState("")
  const [groupError, setGroupError] = useState<string | null>(null)
  const [detail, setDetail] = useState("")
  const [cie, setCie] = useState("")
  const [error, setError] = useState<string | null>(null)

  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
  })
  const planOptions = plansQuery.data?.data ?? []
  const detailQuery = useQuery({
    queryKey: ["treatment-plan", patientId, planId],
    queryFn: () => fetchTreatmentPlanDetail(patientId, planId),
    enabled: planId !== "",
  })
  const items: PlanItem[] = detailQuery.data?.data.items ?? []
  const optionGroups = detailQuery.data?.data.optionGroups ?? []

  const odontogramQuery = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
  })
  // Solo hallazgos vigentes de la pieza elegida: la indicación responde a lo observado.
  const tooth = teeth[0] ?? null
  const findings = (odontogramQuery.data?.data.history ?? []).filter(
    (entry) => !entry.voidedAt && tooth != null && entry.toothNumber === tooth,
  )

  const fieldDisabled = disabled || !canWrite
  const blocked = fieldDisabled

  const invalidatePlans = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["treatment-plans", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["treatment-plan", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["plan", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
    ])

  const createPlanMutation = useMutation({
    mutationFn: async () => {
      const title = newTitle.trim() || "Plan de tratamiento"
      onPendingChange(true)
      try {
        await beforeWrite()
        const created = await createTreatmentPlanApi(patientId, {
          title,
          originEncounterId: encounterId,
        })
        await invalidatePlans()
        setPlanId(created.data.id)
        setNewTitle("Plan de tratamiento")
        setError(null)
      } finally {
        onPendingChange(false)
      }
    },
    onError: (err) => setError(mutationMessage(err)),
  })

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!planId) throw new Error("Elige el plan clínico donde se indicará.")
      if (!service) throw new Error("Busca y elige la prestación del tarifario.")
      const tooth = teeth[0] ?? null
      const body: Record<string, unknown> = {
        serviceId: service.id,
        planId,
        sourceEncounterId: encounterId,
        detail: detail.trim() === "" ? null : detail.trim(),
        diagnosisCode: cie.trim() === "" ? null : cie.trim(),
        odontogramEntryId: findingId === "" ? null : findingId,
        optionGroupId: optionGroupId === "" ? null : optionGroupId,
        isRecommended: optionGroupId !== "" && isRecommended,
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
        await invalidatePlans()
        await onChanged()
        setService(null)
        setDetail("")
        setCie("")
        setFindingId("")
        setIsRecommended(false)
        setError(null)
      } finally {
        onPendingChange(false)
      }
    },
    onError: (err) => setError(mutationMessage(err)),
  })

  const groupMutation = useMutation({
    mutationFn: async () => {
      onPendingChange(true)
      try {
        await beforeWrite()
        const created = await createOptionGroupApi(patientId, planId, { title: groupTitle.trim() })
        await invalidatePlans()
        setOptionGroupId(created.data.id)
        setGroupOpen(false)
        setGroupError(null)
      } finally {
        onPendingChange(false)
      }
    },
    onError: (err) => setGroupError(mutationMessage(err)),
  })

  const busy = createPlanMutation.isPending || addMutation.isPending || groupMutation.isPending
  const toothForSurfaces = teeth[0] ?? null
  const validSurfaces =
    toothForSurfaces != null ? surfacesForTooth(toothForSurfaces).map(String) : []

  const toggleSurface = (surface: string): void => {
    setSurfaces((prev) =>
      prev.includes(surface) ? prev.filter((s) => s !== surface) : [...prev, surface],
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-6 rounded-md bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Indicar en el plan</div>
        </div>
        <div className="flex flex-col gap-3">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${uid}-plan`}>Plan clínico</FieldLabel>
              <Select
                value={planId}
                onValueChange={(v) => setPlanId(v ?? "")}
                disabled={blocked || busy}
              >
                <SelectTrigger id={`${uid}-plan`}>
                  <SelectValue
                    placeholder={plansQuery.isLoading ? "Cargando…" : "Elige el plan…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {planOptions.map((p) => (
                    <SelectItem key={p.plan.id} value={p.plan.id}>
                      {p.plan.title} · {p.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${uid}-new-title`}>
                Nuevo plan (origen: esta atención)
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={`${uid}-new-title`}
                  value={newTitle}
                  maxLength={200}
                  disabled={blocked || busy}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={blocked || busy}
                  onClick={() => void createPlanMutation.mutate()}
                >
                  {createPlanMutation.isPending ? "Creando…" : "Crear"}
                </Button>
              </div>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${uid}-scope`}>Ámbito</FieldLabel>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v ?? "general")}
                disabled={blocked || busy}
              >
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
                  disabled={blocked || busy}
                />
              </Field>
            )}
            {(scope === "tooth" || scope === "surfaces") && findings.length > 0 && (
              <Field>
                <FieldLabel htmlFor={`${uid}-finding`}>Hallazgo que motiva</FieldLabel>
                <Select
                  value={findingId || undefined}
                  onValueChange={(v) => setFindingId(v ?? "")}
                  disabled={blocked || busy}
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
                <Select
                  value={quadrant}
                  onValueChange={(v) => setQuadrant(v ?? "")}
                  disabled={blocked || busy}
                >
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
                <Select
                  value={arch}
                  onValueChange={(v) => setArch(v ?? "")}
                  disabled={blocked || busy}
                >
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

          {scope === "surfaces" && toothForSurfaces != null ? (
            <Field>
              <FieldLabel>Superficies de la pieza {toothForSurfaces}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {validSurfaces.map((surface) => (
                  <label key={surface} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={surfaces.includes(surface)}
                      disabled={blocked || busy}
                      onCheckedChange={() => toggleSurface(surface)}
                    />
                    {surface}
                  </label>
                ))}
              </div>
            </Field>
          ) : null}

          <ServicePicker
            value={service?.id ?? ""}
            label="Tratamiento"
            disabled={blocked || busy}
            onChange={(next) => {
              setService(next)
              if (next.scope) setScope(next.scope)
              setError(null)
            }}
          />
          {service ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Tarifa de solo lectura: {formatMoney(service.priceCents, service.currency)}
              {service.scope ? ` · ${TREATMENT_SCOPE_LABELS[service.scope] ?? service.scope}` : ""}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${uid}-option-group`}>Alternativa de (opcional)</FieldLabel>
              <div className="flex gap-2">
                <Select
                  value={optionGroupId || undefined}
                  onValueChange={(v) => {
                    setOptionGroupId(v ?? "")
                    if (!v) setIsRecommended(false)
                  }}
                  disabled={blocked || busy || !planId}
                >
                  <SelectTrigger id={`${uid}-option-group`}>
                    <SelectValue placeholder="Sin agrupación" />
                  </SelectTrigger>
                  <SelectContent>
                    {optionGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={blocked || busy || !planId}
                  onClick={() => {
                    setGroupTitle("")
                    setGroupError(null)
                    setGroupOpen(true)
                  }}
                >
                  Nueva
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Agrupa opciones excluyentes del mismo problema: al aceptar una, las demás quedan
                rechazadas.
              </p>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${uid}-recommended`}>Recomendación</FieldLabel>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`${uid}-recommended`}
                  checked={isRecommended}
                  disabled={blocked || busy || optionGroupId === ""}
                  onCheckedChange={(next) => setIsRecommended(next === true)}
                />
                Recomendada dentro de la agrupación
              </label>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor={`${uid}-detail`}>Detalle</FieldLabel>
            <Textarea
              id={`${uid}-detail`}
              rows={2}
              value={detail}
              maxLength={4000}
              disabled={blocked || busy}
              onChange={(e) => setDetail(e.target.value)}
            />
          </Field>
          <Cie10Search value={cie} onChange={(code) => setCie(code)} disabled={blocked || busy} />

          <div>
            <Button
              type="button"
              disabled={blocked || busy || !planId || !service}
              onClick={() => void addMutation.mutate()}
            >
              {addMutation.isPending ? "Añadiendo…" : "Añadir al plan"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            La fila queda en el plan con la boca y el listado visibles; se limpia la prestación y se
            conserva la selección anatómica. El plan puede seguir recibiendo indicaciones en futuras
            atenciones.
          </p>
        </div>
      </div>

      {planId ? (
        <div className="flex flex-col gap-6 rounded-md bg-card p-6">
          <div className="flex flex-col gap-1.5">
            <div className="font-heading text-base font-medium">Tratamientos del plan</div>
          </div>
          <div className="flex flex-col gap-2">
            {detailQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">El plan aún no tiene tratamientos.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{item.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {treatmentSiteLabel(item)} ·{" "}
                        {item.priceCents != null
                          ? formatMoney(item.priceCents, item.currency)
                          : "sin tarifa"}
                      </span>
                    </span>
                    <span className="flex gap-1">
                      <Badge variant={item.decision === "aceptado" ? "success" : "secondary"}>
                        {planDecisionLabel(item.decision)}
                      </Badge>
                      <Badge variant="outline">{item.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      <FormDrawer
        open={groupOpen}
        title="Nueva agrupación de alternativas"
        description="Se crea en este plan; después quedará seleccionada para la indicación que estás registrando."
        error={groupError}
        isSubmitting={groupMutation.isPending}
        submitLabel="Crear agrupación"
        onClose={() => {
          if (!groupMutation.isPending) setGroupOpen(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!groupTitle.trim()) {
            setGroupError("Indica un título para la agrupación.")
            return
          }
          groupMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-group-title`}>Título</FieldLabel>
          <Input
            id={`${uid}-group-title`}
            value={groupTitle}
            maxLength={200}
            disabled={busy}
            onChange={(event) => setGroupTitle(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}
