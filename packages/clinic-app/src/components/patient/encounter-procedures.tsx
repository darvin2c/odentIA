import { diagnosisCodeLabel } from "@odentia/clinical"
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
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
const QUADRANT_OPTIONS = QUADRANTS.map((q) => ({ value: q, label: `Cuadrante ${q}` }))
const ARCH_OPTIONS = [
  { value: "upper", label: "Arcada superior" },
  { value: "lower", label: "Arcada inferior" },
]
const MAX_TEXT = 2000
const QUANTITY_RANGE = "La cantidad va de 1 a 99"

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

/** Indicado con la pieza o la cara por definir: se elige ahora, al hacerlo. */
function isPlanPending(plan: PlanItem | null): boolean {
  return Boolean(
    plan &&
      (((plan.scope === "tooth" || plan.scope === "surfaces") && plan.toothNumber == null) ||
        (plan.scope === "surfaces" && (plan.surfaces ?? []).length === 0)),
  )
}

/**
 * Lo mismo que pide la API (`procedureInput` y `addEncounterProcedure`): qué
 * registrar, el sitio que pide su ámbito y la cantidad. Cada falta, en su campo.
 */
function procedureSchema(planById: Record<string, PlanItem>) {
  return z
    .object({
      freeMode: z.boolean(),
      description: z.string().max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
      service: z.custom<ServiceCatalogItem | null>(),
      planItemId: z.string(),
      site: z.custom<PlaceWithParts>(),
      quadrant: z.string(),
      arch: z.string(),
      quantity: z.string(),
      diagnosisCode: z.string(),
      diagnosisSystem: z.string().nullable(),
    })
    .superRefine((value, ctx) => {
      const plan = value.planItemId ? (planById[value.planItemId] ?? null) : null
      if (plan) {
        if (isPlanPending(plan)) {
          if (value.site.toothNumber === null)
            ctx.addIssue({ code: "custom", path: ["site"], message: "Elige la pieza en que lo hiciste" })
          else if (plan.scope === "surfaces" && value.site.surfaces.length === 0)
            ctx.addIssue({ code: "custom", path: ["site"], message: "Marca al menos una cara" })
        }
        return
      }
      if (value.freeMode) {
        if (!value.description.trim())
          ctx.addIssue({ code: "custom", path: ["description"], message: "Describe el acto libre" })
      } else if (!value.service) {
        ctx.addIssue({ code: "custom", path: ["service"], message: "Elige el tratamiento" })
      } else {
        const scope = value.service.scope
        if ((scope === "tooth" || scope === "surfaces") && value.site.toothNumber === null)
          ctx.addIssue({ code: "custom", path: ["site"], message: "Elige la pieza" })
        else if (scope === "surfaces" && value.site.surfaces.length === 0)
          ctx.addIssue({ code: "custom", path: ["site"], message: "Marca al menos una superficie" })
        if (scope === "quadrant" && !value.quadrant)
          ctx.addIssue({ code: "custom", path: ["quadrant"], message: "Elige el cuadrante" })
        if (scope === "arch" && !value.arch)
          ctx.addIssue({ code: "custom", path: ["arch"], message: "Elige la arcada" })
      }
      const quantity = Number(value.quantity)
      if (!value.quantity.trim() || !Number.isInteger(quantity) || quantity < 1 || quantity > 99)
        ctx.addIssue({ code: "custom", path: ["quantity"], message: QUANTITY_RANGE })
    })
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
  const [open, setOpen] = useState(autoOpen && !disabled)
  const [voidingProc, setVoidingProc] = useState<ProcedureItem | null>(null)

  const encounter = detail.encounter
  // Solo el borrador admite registrar o anular actos.
  const finalized = encounter.status !== "borrador"

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

  const form = useAppForm({
    defaultValues: {
      freeMode: false,
      description: "",
      service: null as ServiceCatalogItem | null,
      planItemId: "",
      site: NO_SITE,
      quadrant: "",
      arch: "",
      quantity: "1",
      diagnosisCode: "",
      diagnosisSystem: null as string | null,
    },
    validators: { onSubmit: procedureSchema(planById) },
    onSubmit: async ({ value, formApi }) => {
      const plan = value.planItemId ? (planById[value.planItemId] ?? null) : null
      const trimmedCie = value.diagnosisCode.trim()
      const diagnosisCode = trimmedCie === "" ? null : trimmedCie
      const diagnosisSystem = diagnosisCode ? value.diagnosisSystem : null
      const quantity = Number(value.quantity)
      const serviceScope = value.service?.scope ?? null
      // El tratamiento del plan conserva su sitio: el servidor lo toma de él. Si
      // quedó por definir, va lo que se eligió ahora y queda también en el tratamiento.
      const body = plan
        ? {
            planItemId: plan.id,
            diagnosisCode,
            diagnosisSystem,
            ...(isPlanPending(plan) ? { toothNumber: value.site.toothNumber, surfaces: value.site.surfaces } : {}),
          }
        : value.freeMode
          ? {
              description: value.description.trim(),
              toothNumber: value.site.toothNumber,
              surfaces: value.site.surfaces,
              quantity,
              diagnosisCode,
              diagnosisSystem,
            }
          : {
              serviceId: value.service?.id,
              ...(serviceScope === "tooth" || serviceScope === "surfaces" ? { toothNumber: value.site.toothNumber } : {}),
              ...(serviceScope === "surfaces" ? { surfaces: value.site.surfaces } : {}),
              ...(serviceScope === "quadrant" ? { quadrant: Number(value.quadrant) } : {}),
              ...(serviceScope === "arch" ? { arch: value.arch } : {}),
              quantity,
              diagnosisCode,
              diagnosisSystem,
            }
      onPendingChange(true)
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
      } finally {
        onPendingChange(false)
      }
      formApi.reset()
      setOpen(false)
    },
  })
  const surface = useFormSurface(form, {
    // La pieza y sus caras son un solo control; el servicio, el del catálogo
    // (o la descripción en el acto libre); la lista va con el código.
    fieldMap: (key) => {
      if (key === "toothNumber" || key === "surfaces") return "site"
      if (key === "serviceId") return form.state.values.freeMode ? "description" : "service"
      if (key === "diagnosisSystem") return "diagnosisCode"
      return undefined
    },
  })
  const values = useStore(form.store, (state) => state.values)

  const voidForm = useAppForm({
    defaultValues: { reason: "" },
    validators: {
      onSubmit: z.object({
        reason: z.string().trim().min(1, "Escribe el motivo.").max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
      }),
    },
    onSubmit: async ({ value }) => {
      if (!voidingProc) return
      onPendingChange(true)
      try {
        await beforeWrite()
        await voidProcedureApi(patientId, encounter.id, voidingProc.id, value.reason.trim())
        await queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
        await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
        await onChanged()
      } finally {
        onPendingChange(false)
      }
      setVoidingProc(null)
    },
  })
  const voidSubmitting = useStore(voidForm.store, (state) => state.isSubmitting)
  const voidError = useFormSubmitError(voidForm)

  const busy = disabled || surface.isSubmitting || voidSubmitting
  const canOpen = canWrite && !finalized && !disabled

  const tooth = values.site.toothNumber
  // Al elegir pieza solo caben sus ítems más los generales (sin pieza); el
  // servidor no exige coincidencia, así que los generales siempre aplican.
  const visiblePlans =
    tooth == null
      ? openItems
      : openItems.filter((item) => item.toothNumber == null || item.toothNumber === tooth)
  const selectedPlan = values.planItemId ? (planById[values.planItemId] ?? null) : null
  const options =
    selectedPlan && !visiblePlans.some((item) => item.id === selectedPlan.id)
      ? [...visiblePlans, selectedPlan]
      : visiblePlans

  const planItems: Record<string, string> = { [NO_PLAN]: "Seleccionar otro servicio del catálogo" }
  for (const item of options) planItems[item.id] = planOptionLabel(item, orgLocale)

  // El ámbito del servicio decide qué sitio pide: pieza, superficies,
  // cuadrante, arcada o nada (general). El acto libre admite pieza opcional.
  const freeMode = values.freeMode
  const scope = freeMode ? "tooth-optional" : (values.service?.scope ?? null)
  const needsTooth = scope === "tooth" || scope === "surfaces"
  const planPending = isPlanPending(selectedPlan)

  const onPlanChange = (value: string | null) => {
    const next = value ?? NO_PLAN
    if (next === NO_PLAN) {
      form.setFieldValue("planItemId", "")
      return
    }
    const linked = planById[next]
    if (!linked) return
    form.setFieldValue("planItemId", next)
    form.setFieldValue("service", null)
    form.setFieldValue("diagnosisCode", linked.diagnosisCode ?? "")
    form.setFieldValue("diagnosisSystem", linked.diagnosisSystem ?? null)
    form.setFieldValue("site", { toothNumber: linked.toothNumber, surfaces: linked.surfaces ?? [] })
  }

  const handleClose = () => {
    // Durante el guardado no se cierra: el error y lo elegido se conservan
    // en el drawer y no se pierde la selección del catálogo/presupuesto.
    if (surface.isSubmitting) return
    form.reset()
    setOpen(false)
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
                          voidForm.reset()
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
            {...surface}
            open={open}
            onClose={handleClose}
            title="Registrar procedimiento"
            description={
              productUi().plan.budgetRequired
                ? "Elige un tratamiento aceptado del presupuesto, un servicio del catálogo (se registra como tratamiento realizado en el acto), o marca acto libre para algo que no se cobra."
                : "Elige un tratamiento indicado, un servicio del catálogo (se registra como tratamiento realizado en el acto), o marca acto libre para algo que no se cobra."
            }
            submitLabel="Registrar procedimiento"
          >
            <div className="flex flex-col gap-4">
              <form.AppField
                name="freeMode"
                listeners={{
                  onChange: () => {
                    form.setFieldValue("service", null)
                    form.setFieldValue("planItemId", "")
                    form.setFieldValue("site", NO_SITE)
                  },
                }}
              >
                {(field) => (
                  <field.CheckboxField
                    label="Acto libre (sin servicio de la lista; queda registrado pero no se cobra)"
                    disabled={busy}
                  />
                )}
              </form.AppField>
              {freeMode && (
                <form.AppField name="description">
                  {(field) => (
                    <field.TextareaField
                      label="Descripción del acto"
                      placeholder="Ej.: ajuste oclusal menor de cortesía"
                      rows={2}
                      maxLength={MAX_TEXT}
                      disabled={busy}
                    />
                  )}
                </form.AppField>
              )}
              {!selectedPlan && !freeMode && (
                <form.AppField name="service">
                  {(field) => (
                    <field.Control label="Tratamiento">
                      {(control) => (
                        <ServicePicker
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          value={field.state.value?.id ?? ""}
                          onChange={(next) => {
                            field.handleChange(next)
                            form.setFieldValue("site", NO_SITE)
                            form.setFieldValue("quadrant", "")
                            form.setFieldValue("arch", "")
                          }}
                          disabled={busy}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
              )}

              {selectedPlan && planPending ? (
                productUi().site ? (
                  <form.AppField name="site">
                    {(field) => (
                      <field.Group
                        legend={selectedPlan.toothNumber == null ? "¿En qué pieza lo hiciste?" : "¿Qué cara trabajaste?"}
                      >
                        {(control) => (
                          <SiteField
                            id={control.id}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                            value={field.state.value}
                            onChange={(next) => field.handleChange(next)}
                            withSurfaces={selectedPlan.scope === "surfaces"}
                            surfacesRequired={selectedPlan.scope === "surfaces"}
                            disabled={busy}
                          />
                        )}
                      </field.Group>
                    )}
                  </form.AppField>
                ) : null
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
                productUi().site ? (
                  <form.AppField name="site">
                    {(field) => (
                      <field.Group
                        legend={
                          <>
                            {scope === "surfaces" ? "Pieza y superficies" : "Pieza"}
                            {freeMode ? <span className="text-muted-foreground"> (opcional)</span> : null}
                          </>
                        }
                      >
                        {(control) => (
                          <SiteField
                            id={control.id}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                            value={field.state.value}
                            onChange={(next) => field.handleChange(next)}
                            withSurfaces={freeMode || scope === "surfaces"}
                            surfacesRequired={scope === "surfaces"}
                            disabled={busy}
                          />
                        )}
                      </field.Group>
                    )}
                  </form.AppField>
                ) : null
              ) : scope === "quadrant" ? (
                <form.AppField name="quadrant">
                  {(field) => (
                    <field.SelectField
                      label="Cuadrante"
                      options={QUADRANT_OPTIONS}
                      placeholder="Elige el cuadrante"
                      disabled={busy}
                    />
                  )}
                </form.AppField>
              ) : scope === "arch" ? (
                <form.AppField name="arch">
                  {(field) => (
                    <field.SelectField
                      label="Arcada"
                      options={ARCH_OPTIONS}
                      placeholder="Elige la arcada"
                      disabled={busy}
                    />
                  )}
                </form.AppField>
              ) : null}

              {!selectedPlan ? (
                <form.AppField name="quantity">
                  {(field) => (
                    <field.TextField
                      label="Cantidad"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={99}
                      inputClassName="w-24"
                      disabled={busy}
                      description="Unidades realizadas (p. ej. 3 sellantes); el cargo es precio × cantidad."
                    />
                  )}
                </form.AppField>
              ) : null}

              <form.AppField name="diagnosisCode">
                {(field) => (
                  <field.Control label="Diagnóstico (opcional)">
                    {(control) => (
                      <DiagnosisSearch
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                        value={field.state.value}
                        system={values.diagnosisSystem}
                        onChange={(code, _description, system) => {
                          field.handleChange(code)
                          form.setFieldValue("diagnosisSystem", system)
                        }}
                        disabled={busy}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>

              {!freeMode && (
                <form.AppField name="planItemId">
                  {(field) => (
                    <field.Control
                      label={productUi().plan.budgetRequired ? "Tratamiento aceptado del presupuesto" : "Tratamiento indicado"}
                    >
                      {(control) => (
                        <>
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
                              value={field.state.value === "" ? NO_PLAN : field.state.value}
                              items={planItems}
                              onValueChange={onPlanChange}
                              disabled={busy}
                            >
                              <SelectTrigger
                                {...control.props}
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
                        </>
                      )}
                    </field.Control>
                  )}
                </form.AppField>
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
        pending={voidSubmitting}
        error={voidError}
        onConfirm={() => void submitForm(voidForm)}
        onClose={() => {
          if (!voidSubmitting) setVoidingProc(null)
        }}
      >
        <voidForm.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo" rows={2} maxLength={MAX_TEXT} aria-required />}
        </voidForm.AppField>
      </ConfirmDialog>
    </div>
  )
}
