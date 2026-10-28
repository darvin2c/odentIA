import { diagnosisCodeLabel } from "@odentia/clinical"
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { ConfirmDialog, FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { voidProcedureApi } from "../../lib/encounters"
import {
  type EncounterDetail,
  type PlanItem,
  type ProcedureItem,
  planStatusLabel,
} from "../../lib/patients"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"
import { type ServiceCatalogItem } from "../../lib/services"
import { DiagnosisSearch } from "./diagnosis-search"
import { ServicePicker } from "./service-picker"
import { type PlaceWithParts, productUi } from "../../product/product-ui"
import { partNames, SiteField } from "../../product/site-fields"
import { activeOrgLocale } from "../../lib/locale"

const NO_PLAN = "__sin-plan__"
const NO_SITE: PlaceWithParts = { toothNumber: null, surfaces: [] }
const QUADRANTS = ["1", "2", "3", "4", "5", "6", "7", "8"]

/**
 * «36 · Oclusal», «Cuadrante 2», «Arcada superior» o «General». Un tratamiento
 * indicado con la pieza o la cara por definir lo dice (`scope`): no es «General».
 */
function procedureSiteLabel(
  proc: Pick<ProcedureItem, "toothNumber" | "surfaces" | "quadrant" | "arch">,
  scope?: string | null,
) {
  if (proc.toothNumber != null) {
    const surfaces = partNames(proc.surfaces)
    if (!surfaces && scope === "surfaces") return `Pieza ${proc.toothNumber} · cara por definir`
    return surfaces ? `Pieza ${proc.toothNumber} · ${surfaces}` : `Pieza ${proc.toothNumber}`
  }
  if (!proc.quadrant && !proc.arch && (scope === "tooth" || scope === "surfaces")) return "Pieza por definir"
  if (proc.quadrant != null) return `Cuadrante ${proc.quadrant}`
  if (proc.arch) return proc.arch === "upper" ? "Arcada superior" : "Arcada inferior"
  return "General"
}

/** Tratamiento aceptado que aún admite sesiones: incluye el que ya está en curso. */
const OPEN_STATUSES: readonly string[] = ["pendiente", "programado", "en_curso"]

function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(activeOrgLocale(), { dateStyle: "short", timeStyle: "short" })
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : "No se pudo registrar el procedimiento."
}

function planOptionLabel(item: PlanItem, locale: string | undefined): string {
  const price =
    item.priceCents == null
      ? "sin precio"
      : locale
        ? formatMoney(item.priceCents, item.currency, locale)
        : "…"
  const tooth =
    item.toothNumber != null
      ? `pieza ${item.toothNumber}`
      : item.scope === "tooth" || item.scope === "surfaces"
        ? "pieza por definir"
        : "general"
  return `${item.title} · ${tooth} · ${planStatusLabel(item.status)} · ${price}`
}

/**
 * Procedimientos de la atención: resumen de lectura con los procedimientos
 * reales del detalle y los tratamientos vinculados al abrir (pendientes de
 * realizar), más registro en un FormDrawer hermano (tratamiento aceptado del
 * presupuesto o servicio directo del catálogo, con pieza y diagnóstico opcionales).
 * Toda escritura respeta el protocolo de barrera: avisa pending al padre,
 * espera `beforeWrite` (flush del borrador), escribe, espera `onChanged`
 * (refresh del encounter) y recién ahí libera y cierra.
 */
export function EncounterProcedures({
  patientId,
  detail,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
  autoOpen = false,
}: {
  patientId: string
  detail: EncounterDetail
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
  /** Recién agregado el bloque: el formulario de agregar ya viene abierto. */
  autoOpen?: boolean
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const orgLocale = useOrgProfile().data?.locale
  const queryClient = useQueryClient()
  const uid = useId()
  const [open, setOpen] = useState(autoOpen && !disabled)
  const [service, setService] = useState<ServiceCatalogItem | null>(null)
  const serviceId = service?.id ?? ""
  const [freeMode, setFreeMode] = useState(false)
  const [freeDescription, setFreeDescription] = useState("")
  const [site, setSite] = useState<PlaceWithParts>(NO_SITE)
  const [quadrant, setQuadrant] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [arch, setArch] = useState("")
  const [cie, setCie] = useState("")
  const [cieSystem, setCieSystem] = useState<string | null>(null)
  const [planSel, setPlanSel] = useState<string>("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voidingProc, setVoidingProc] = useState<ProcedureItem | null>(null)
  const [voidReason, setVoidReason] = useState("")
  const [voidError, setVoidError] = useState<string | null>(null)

  const encounter = detail.encounter
  // Solo el borrador admite registrar o anular actos.
  const finalized = encounter.status !== "borrador"
  const busy = disabled || saving
  const canOpen = canWrite && !finalized && !disabled

  const planQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canRead && canWrite && !finalized,
  })
  const allItems = planQuery.data?.data ?? []
  const openItems = allItems.filter(
    (item) => item.decision === "aceptado" && OPEN_STATUSES.includes(item.status),
  )
  const planById: Record<string, PlanItem> = Object.fromEntries(
    allItems.map((item) => [item.id, item]),
  )

  const tooth = site.toothNumber
  // Al elegir pieza solo caben sus ítems más los generales (sin pieza); el
  // servidor no exige coincidencia, así que los generales siempre aplican.
  const visiblePlans =
    tooth == null
      ? openItems
      : openItems.filter((item) => item.toothNumber == null || item.toothNumber === tooth)
  const selectedPlan = planSel ? (planById[planSel] ?? null) : null
  const options =
    selectedPlan && !visiblePlans.some((item) => item.id === selectedPlan.id)
      ? [...visiblePlans, selectedPlan]
      : visiblePlans

  const planItems: Record<string, string> = { [NO_PLAN]: "Seleccionar otro servicio del catálogo" }
  for (const item of options) planItems[item.id] = planOptionLabel(item, orgLocale)

  // El ámbito del servicio decide qué sitio pide: pieza, superficies,
  // cuadrante, arcada o nada (general). El acto libre admite pieza opcional.
  const scope = freeMode ? "tooth-optional" : (service?.scope ?? null)
  const needsTooth = scope === "tooth" || scope === "surfaces"
  // Indicado con la pieza o la cara por definir: se elige ahora, al hacerlo.
  const planPending = Boolean(
    selectedPlan &&
      (((selectedPlan.scope === "tooth" || selectedPlan.scope === "surfaces") && selectedPlan.toothNumber == null) ||
        (selectedPlan.scope === "surfaces" && (selectedPlan.surfaces ?? []).length === 0)),
  )
  const siteComplete = selectedPlan
    ? !planPending || (site.toothNumber !== null && (selectedPlan.scope !== "surfaces" || site.surfaces.length > 0))
    : (scope === "general" || scope === "tooth-optional" || scope === null
      ? true
      : scope === "tooth"
        ? site.toothNumber !== null
        : scope === "surfaces"
          ? site.toothNumber !== null && site.surfaces.length > 0
          : scope === "quadrant"
            ? quadrant !== ""
            : arch !== "")

  const onPlanChange = (value: string | null) => {
    const next = value ?? NO_PLAN
    if (next === NO_PLAN) {
      setPlanSel("")
      return
    }
    const linked = planById[next]
    if (!linked) return
    setPlanSel(next)
    setService(null)
    setCie(linked.diagnosisCode ?? "")
    setCieSystem(linked.diagnosisSystem ?? null)
    setSite({ toothNumber: linked.toothNumber, surfaces: linked.surfaces ?? [] })
  }

  const quantityNumber = Number(quantity)
  const quantityValid =
    Number.isInteger(quantityNumber) && quantityNumber >= 1 && quantityNumber <= 99
  const canSubmit =
    canWrite &&
    !finalized &&
    !busy &&
    siteComplete &&
    quantityValid &&
    (Boolean(selectedPlan) || serviceId !== "" || (freeMode && freeDescription.trim() !== ""))
  const isDirty =
    serviceId !== "" ||
    planSel !== "" ||
    cie.trim() !== "" ||
    site.toothNumber !== null ||
    freeDescription.trim() !== ""

  const resetForm = () => {
    setService(null)
    setSite(NO_SITE)
    setQuadrant("")
    setArch("")
    setQuantity("1")
    setCie("")
    setCieSystem(null)
    setPlanSel("")
    setFreeMode(false)
    setFreeDescription("")
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canSubmit) return
    const trimmedCie = cie.trim()
    const diagnosisCode = trimmedCie === "" ? null : trimmedCie
    const diagnosisSystem = diagnosisCode ? cieSystem : null
    // El tratamiento del plan conserva su sitio: el servidor lo toma de él. Si
    // quedó por definir, va lo que se eligió ahora y queda también en el tratamiento.
    const body = selectedPlan
      ? {
          planItemId: selectedPlan.id,
          diagnosisCode,
          diagnosisSystem,
          ...(planPending ? { toothNumber: tooth, surfaces: site.surfaces } : {}),
        }
      : freeMode
        ? {
            description: freeDescription.trim(),
            toothNumber: tooth,
            surfaces: site.surfaces,
            quantity: quantityNumber,
            diagnosisCode,
            diagnosisSystem,
          }
        : {
            serviceId,
            ...(needsTooth ? { toothNumber: tooth } : {}),
            ...(scope === "surfaces" ? { surfaces: site.surfaces } : {}),
            ...(scope === "quadrant" ? { quadrant: Number(quadrant) } : {}),
            ...(scope === "arch" ? { arch } : {}),
            quantity: quantityNumber,
            diagnosisCode,
            diagnosisSystem,
          }
    onPendingChange(true)
    setSaving(true)
    setError(null)
    try {
      await beforeWrite()
      await apiFetch(`/api/patients/${patientId}/encounters/${encounter.id}/procedures`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      // El servidor deja el tratamiento en curso (o realizado si es directo).
      await queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await onChanged()
      resetForm()
      setOpen(false)
    } catch (err) {
      setError(mutationMessage(err))
    } finally {
      setSaving(false)
      onPendingChange(false)
    }
  }

  const handleClose = () => {
    // Durante el guardado no se cierra: el error y lo elegido se conservan
    // en el drawer y no se pierde la selección del catálogo/presupuesto.
    if (saving) return
    resetForm()
    setError(null)
    setOpen(false)
  }

  const confirmVoid = async () => {
    if (!voidingProc || !voidReason.trim() || saving) return
    onPendingChange(true)
    setSaving(true)
    setVoidError(null)
    try {
      await beforeWrite()
      await voidProcedureApi(patientId, encounter.id, voidingProc.id, voidReason.trim())
      await queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await onChanged()
      setVoidingProc(null)
    } catch (err) {
      setVoidError(
        err instanceof ApiError && err.shape.message
          ? err.shape.message
          : "No se pudo anular el procedimiento.",
      )
    } finally {
      setSaving(false)
      onPendingChange(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">
          Procedimientos ({detail.procedures.filter((proc) => !proc.voidedAt).length})
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <section aria-label="Tratamientos vinculados en curso">
          {detail.plannedItems.filter(
            (item) =>
              item.status === "pendiente" ||
              item.status === "programado" ||
              item.status === "en_curso",
          ).length === 0 ? null : (
            <ul className="mb-3 flex flex-col gap-2">
              {detail.plannedItems
                .filter(
                  (item) =>
                    item.status === "pendiente" ||
                    item.status === "programado" ||
                    item.status === "en_curso",
                )
                .map((item) => (
                  <li key={item.id} className="rounded-md border border-dashed p-2 text-sm">
                    <p>{item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Vinculado al abrir
                      {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""} ·{" "}
                      {planStatusLabel(item.status)}
                    </p>
                  </li>
                ))}
            </ul>
          )}
        </section>
        <section aria-label="Procedimientos registrados">
          {detail.procedures.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin procedimientos registrados.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.procedures.map((proc) => {
                const linked = proc.planItemId ? planById[proc.planItemId] : undefined
                return (
                  <li
                    key={proc.id}
                    className="flex flex-wrap items-start justify-between gap-3 border-b pb-2 text-sm last:border-0"
                  >
                    <div className="min-w-0">
                      <p
                        className={proc.voidedAt ? "text-muted-foreground line-through" : undefined}
                      >
                        {proc.description}
                      </p>
                      {proc.voidedAt ? (
                        <p className="text-xs text-muted-foreground">
                          Anulado: {proc.voidReason}. No cuenta como sesión ni genera cargo.
                        </p>
                      ) : null}
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{procedureSiteLabel(proc)}</span>
                        {(proc.quantity ?? 1) > 1 ? <span>× {proc.quantity}</span> : null}
                        {proc.diagnosisCode ? <Badge>{diagnosisCodeLabel(proc.diagnosisSystem, proc.diagnosisCode)}</Badge> : null}
                        {proc.planItemId ? (
                          linked ? (
                            <span className="font-medium">Plan: {linked.title}</span>
                          ) : (
                            <span>Vinculado a un tratamiento del plan</span>
                          )
                        ) : null}
                        <time dateTime={proc.createdAt}>{formatDateTime(proc.createdAt)}</time>
                        {proc.priceCents != null && proc.currency ? (
                          <span className="font-medium text-foreground">
                            {orgLocale ? formatMoney(proc.priceCents, proc.currency, orgLocale) : "…"}
                          </span>
                        ) : (
                          <span>Sin cargo (acto libre)</span>
                        )}
                      </p>
                    </div>
                    {canWrite && !finalized && !proc.voidedAt ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setVoidReason("")
                          setVoidError(null)
                          setVoidingProc(proc)
                        }}
                      >
                        Anular…
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {canWrite && !finalized && (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={!canOpen}
              onClick={() => setOpen(true)}
            >
              Registrar procedimiento
            </Button>
          </div>
        )}

        {canWrite && !finalized && (
          <FormDrawer
            open={open}
            onClose={handleClose}
            title="Registrar procedimiento"
            description={
              productUi().plan.budgetRequired
                ? "Elige un tratamiento aceptado del presupuesto, un servicio del catálogo (se registra como tratamiento realizado en el acto), o marca acto libre para algo que no se cobra."
                : "Elige un tratamiento indicado, un servicio del catálogo (se registra como tratamiento realizado en el acto), o marca acto libre para algo que no se cobra."
            }
            onSubmit={(event) => void onSubmit(event)}
            isDirty={isDirty}
            isSubmitting={saving}
            submitDisabled={!canSubmit}
            submitLabel="Registrar procedimiento"
            error={error}
          >
            <div className="flex flex-col gap-4">
              <Field orientation="horizontal" className="items-center gap-2">
                <input
                  id={`${uid}-free`}
                  type="checkbox"
                  checked={freeMode}
                  disabled={busy}
                  onChange={(event) => {
                    setFreeMode(event.target.checked)
                    setService(null)
                    setPlanSel("")
                    setSite(NO_SITE)
                  }}
                />
                <FieldLabel htmlFor={`${uid}-free`} className="font-normal">
                  Acto libre (sin servicio de la lista; queda registrado pero no se cobra)
                </FieldLabel>
              </Field>
              {freeMode && (
                <Field>
                  <FieldLabel htmlFor={`${uid}-free-desc`}>Descripción del acto</FieldLabel>
                  <Textarea
                    id={`${uid}-free-desc`}
                    value={freeDescription}
                    onChange={(event) => setFreeDescription(event.target.value)}
                    placeholder="Ej.: ajuste oclusal menor de cortesía"
                    rows={2}
                    maxLength={2000}
                    disabled={busy}
                    required
                  />
                </Field>
              )}
              {!selectedPlan && !freeMode && (
                <ServicePicker
                  value={serviceId}
                  onChange={(next) => {
                    setService(next)
                    setSite(NO_SITE)
                    setQuadrant("")
                    setArch("")
                  }}
                  disabled={busy}
                />
              )}

              {selectedPlan && planPending ? (
                <SiteField
                  value={site}
                  onChange={setSite}
                  withSurfaces={selectedPlan.scope === "surfaces"}
                  surfacesRequired={selectedPlan.scope === "surfaces"}
                  label={selectedPlan.toothNumber == null ? "¿En qué pieza lo hiciste?" : "¿Qué cara trabajaste?"}
                  disabled={busy}
                />
              ) : selectedPlan ? (
                <p className="text-sm text-muted-foreground">
                  Sitio del tratamiento:{" "}
                  {procedureSiteLabel({
                    toothNumber: selectedPlan.toothNumber,
                    surfaces: selectedPlan.surfaces ?? [],
                    quadrant: selectedPlan.quadrant,
                    arch: selectedPlan.arch,
                  })}
                </p>
              ) : freeMode || needsTooth ? (
                <SiteField
                  value={site}
                  onChange={setSite}
                  withSurfaces={freeMode || scope === "surfaces"}
                  optional={freeMode}
                  surfacesRequired={scope === "surfaces"}
                  label={scope === "surfaces" ? "Pieza y superficies" : "Pieza"}
                  disabled={busy}
                />
              ) : scope === "quadrant" ? (
                <Field>
                  <FieldLabel htmlFor={`${uid}-quadrant`}>Cuadrante</FieldLabel>
                  <Select
                    value={quadrant}
                    items={Object.fromEntries(QUADRANTS.map((q) => [q, `Cuadrante ${q}`]))}
                    onValueChange={(value) => setQuadrant(value ?? "")}
                    disabled={busy}
                  >
                    <SelectTrigger id={`${uid}-quadrant`}>
                      <SelectValue placeholder="Elige el cuadrante" />
                    </SelectTrigger>
                    <SelectContent>
                      {QUADRANTS.map((q) => (
                        <SelectItem key={q} value={q}>
                          Cuadrante {q}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : scope === "arch" ? (
                <Field>
                  <FieldLabel htmlFor={`${uid}-arch`}>Arcada</FieldLabel>
                  <Select
                    value={arch}
                    items={{ upper: "Arcada superior", lower: "Arcada inferior" }}
                    onValueChange={(value) => setArch(value ?? "")}
                    disabled={busy}
                  >
                    <SelectTrigger id={`${uid}-arch`}>
                      <SelectValue placeholder="Elige la arcada" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="upper">Arcada superior</SelectItem>
                      <SelectItem value="lower">Arcada inferior</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              {!selectedPlan ? (
                <Field>
                  <FieldLabel htmlFor={`${uid}-quantity`}>Cantidad</FieldLabel>
                  <Input
                    id={`${uid}-quantity`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={99}
                    className="w-24"
                    value={quantity}
                    aria-invalid={!quantityValid}
                    disabled={busy}
                    onChange={(event) => setQuantity(event.target.value)}
                  />
                  <FieldDescription>
                    Unidades realizadas (p. ej. 3 sellantes); el cargo es precio × cantidad.
                  </FieldDescription>
                </Field>
              ) : null}

              <DiagnosisSearch
                value={cie}
                system={cieSystem}
                onChange={(code, _description, system) => {
                  setCie(code)
                  setCieSystem(system)
                }}
                label="Diagnóstico (opcional)"
                disabled={busy}
              />

              {!freeMode && (
                <Field>
                  <FieldLabel htmlFor={`${uid}-plan`}>
                    {productUi().plan.budgetRequired ? "Tratamiento aceptado del presupuesto" : "Tratamiento indicado"}
                  </FieldLabel>
                  {planQuery.isLoading ? (
                    <p className="text-sm text-muted-foreground">Cargando plan…</p>
                  ) : planQuery.isError ? (
                    <div className="flex flex-col gap-2">
                      <p role="alert" className="text-sm text-destructive">
                        No se pudo cargar el plan de tratamiento.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="self-start"
                        disabled={busy}
                        onClick={() => void planQuery.refetch()}
                      >
                        Reintentar
                      </Button>
                    </div>
                  ) : (
                    <Select
                      value={planSel === "" ? NO_PLAN : planSel}
                      items={planItems}
                      onValueChange={onPlanChange}
                      disabled={busy}
                    >
                      <SelectTrigger
                        id={`${uid}-plan`}
                        aria-label={productUi().plan.budgetRequired ? "Tratamiento del presupuesto" : "Tratamiento indicado"}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_PLAN}>
                          Seleccionar otro servicio del catálogo
                        </SelectItem>
                        {options.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {planOptionLabel(item, orgLocale)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {options.length === 0 && !selectedPlan && (
                    <p className="text-xs text-muted-foreground">
                      Sin tratamientos aceptados pendientes: registra un servicio directo del
                      catálogo.
                    </p>
                  )}
                  {selectedPlan && (
                    <p className="text-xs text-muted-foreground">
                      Al guardar, «{selectedPlan.title}» queda en curso y vinculado a esta atención.
                      Completarlo es una decisión aparte, en Tratamientos.
                    </p>
                  )}
                </Field>
              )}
            </div>
          </FormDrawer>
        )}
      </div>
      <ConfirmDialog
        open={voidingProc !== null}
        title="Anular procedimiento"
        description={`${voidingProc?.description ?? ""}. Queda en la traza como anulado: no cuenta como sesión ni genera cargo al cerrar.`}
        confirmLabel="Anular procedimiento"
        pending={saving}
        confirmDisabled={!voidReason.trim()}
        onConfirm={() => void confirmVoid()}
        onClose={() => {
          if (!saving) setVoidingProc(null)
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-void`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-void`}
            rows={2}
            maxLength={2000}
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
          />
        </Field>
        {voidError ? (
          <p role="alert" className="text-sm text-destructive">
            {voidError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
