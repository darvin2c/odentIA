import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical"
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import { type EncounterDetail, type PlanItem, planStatusLabel } from "../../lib/patients"
import { formatMoney } from "../../lib/services"
import { Cie10Search } from "./cie10-search"
import { ServicePicker } from "./service-picker"

const NO_TOOTH = "__sin-pieza__"
const NO_PLAN = "__sin-plan__"

/** Tratamiento aceptado que aún admite sesiones: incluye el que ya está en curso. */
const OPEN_STATUSES: readonly string[] = ["pendiente", "programado", "en_curso"]

function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : "No se pudo registrar el procedimiento."
}

function planOptionLabel(item: PlanItem): string {
  const price = item.priceCents == null ? "sin tarifa" : formatMoney(item.priceCents, item.currency)
  const tooth = item.toothNumber == null ? "general" : `pieza ${item.toothNumber}`
  return `${item.title} · ${tooth} · ${planStatusLabel(item.status)} · ${price}`
}

/**
 * Procedimientos de la atención: resumen de lectura con los procedimientos
 * reales del detalle y los tratamientos vinculados al abrir (pendientes de
 * realizar), más registro en un FormDrawer hermano (tratamiento aceptado del
 * presupuesto o servicio directo del catálogo, con pieza y CIE-10 opcionales).
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
}: {
  patientId: string
  detail: EncounterDetail
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [serviceId, setServiceId] = useState("")
  const [freeMode, setFreeMode] = useState(false)
  const [freeDescription, setFreeDescription] = useState("")
  const [toothSel, setToothSel] = useState<string>(NO_TOOTH)
  const [cie, setCie] = useState("")
  const [planSel, setPlanSel] = useState<string>("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const encounter = detail.encounter
  const finalized = encounter.status === "finalizada"
  const busy = disabled || saving
  const canOpen = canWrite && !finalized && !disabled

  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canWrite && !finalized,
  })
  const allItems = planQuery.data?.data ?? []
  const openItems = allItems.filter(
    (item) => item.decision === "aceptado" && OPEN_STATUSES.includes(item.status),
  )
  const planById: Record<string, PlanItem> = Object.fromEntries(
    allItems.map((item) => [item.id, item]),
  )

  const tooth = toothSel === NO_TOOTH ? null : Number(toothSel)
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

  const toothItems: Record<string, string> = { [NO_TOOTH]: "Sin pieza" }
  for (const n of [...FDI_ADULT, ...FDI_CHILD]) toothItems[String(n)] = `Pieza ${n}`
  const planItems: Record<string, string> = { [NO_PLAN]: "Seleccionar otro servicio del catálogo" }
  for (const item of options) planItems[item.id] = planOptionLabel(item)

  const onToothChange = (value: string | null) => {
    const next = value ?? NO_TOOTH
    setToothSel(next)
    if (planSel) {
      const linked = planById[planSel] ?? null
      const nextTooth = next === NO_TOOTH ? null : Number(next)
      if (linked && linked.toothNumber != null && linked.toothNumber !== nextTooth) {
        setPlanSel("")
      }
    }
  }

  const onPlanChange = (value: string | null) => {
    const next = value ?? NO_PLAN
    if (next === NO_PLAN) {
      setPlanSel("")
      return
    }
    const linked = planById[next]
    if (!linked) return
    setPlanSel(next)
    setServiceId("")
    setCie(linked.diagnosisCode ?? "")
    setToothSel(linked.toothNumber == null ? NO_TOOTH : String(linked.toothNumber))
  }

  const canSubmit =
    canWrite &&
    !finalized &&
    !busy &&
    (Boolean(selectedPlan) || serviceId !== "" || (freeMode && freeDescription.trim() !== ""))
  const isDirty =
    serviceId !== "" ||
    planSel !== "" ||
    cie.trim() !== "" ||
    toothSel !== NO_TOOTH ||
    freeDescription.trim() !== ""

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canSubmit) return
    const trimmedCie = cie.trim()
    const body = freeMode
      ? {
          description: freeDescription.trim(),
          toothNumber: tooth,
          diagnosisCode: trimmedCie === "" ? null : trimmedCie,
        }
      : {
          ...(selectedPlan ? { planItemId: selectedPlan.id } : { serviceId }),
          toothNumber: tooth,
          diagnosisCode: trimmedCie === "" ? null : trimmedCie,
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
      // El servidor ya marcó el plan realizado: solo refrescar, sin mutación manual.
      await queryClient.invalidateQueries({ queryKey: ["plan", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await onChanged()
      setServiceId("")
      setToothSel(NO_TOOTH)
      setCie("")
      setPlanSel("")
      setFreeMode(false)
      setFreeDescription("")
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
    setServiceId("")
    setToothSel(NO_TOOTH)
    setCie("")
    setPlanSel("")
    setFreeMode(false)
    setFreeDescription("")
    setError(null)
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-6 rounded-md bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">
          Procedimientos ({detail.procedures.length})
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
                  <li key={proc.id} className="border-b pb-2 text-sm last:border-0">
                    <p>{proc.description}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {proc.toothNumber != null ? <span>Pieza {proc.toothNumber}</span> : null}
                      {proc.diagnosisCode ? <Badge>CIE-10 {proc.diagnosisCode}</Badge> : null}
                      {proc.planItemId ? (
                        linked ? (
                          <span className="font-medium">Plan: {linked.title}</span>
                        ) : (
                          <span>Plan: {proc.planItemId.slice(0, 8)}</span>
                        )
                      ) : null}
                      <time dateTime={proc.createdAt}>{formatDateTime(proc.createdAt)}</time>
                      {proc.priceCents != null && proc.currency ? (
                        <span className="font-medium text-foreground">
                          {formatMoney(proc.priceCents, proc.currency)}
                        </span>
                      ) : (
                        <span>Sin cargo (acto libre)</span>
                      )}
                    </p>
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
            description="Elige un tratamiento aceptado del presupuesto, un servicio del catálogo (se registra como tratamiento realizado en el acto), o marca acto libre para algo que no se cobra."
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
                    setServiceId("")
                    setPlanSel("")
                  }}
                />
                <FieldLabel htmlFor={`${uid}-free`} className="font-normal">
                  Acto libre (sin servicio del tarifario; queda registrado pero no se cobra)
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
                  onChange={(service) => setServiceId(service.id)}
                  disabled={busy}
                />
              )}

              <Field>
                <FieldLabel htmlFor={`${uid}-pieza`}>Pieza (FDI, opcional)</FieldLabel>
                <Select
                  value={toothSel}
                  items={toothItems}
                  onValueChange={onToothChange}
                  disabled={busy}
                >
                  <SelectTrigger id={`${uid}-pieza`} aria-label="Pieza (FDI, opcional)">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TOOTH}>Sin pieza</SelectItem>
                    <SelectGroup>
                      <SelectLabel>Permanentes</SelectLabel>
                      {FDI_ADULT.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          Pieza {n}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>Temporales</SelectLabel>
                      {FDI_CHILD.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          Pieza {n}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Cie10Search
                value={cie}
                onChange={(code) => setCie(code)}
                label="Diagnóstico CIE-10 (opcional)"
                disabled={busy}
              />

              {!freeMode && (
                <Field>
                  <FieldLabel htmlFor={`${uid}-plan`}>
                    Tratamiento aceptado del presupuesto
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
                      <SelectTrigger id={`${uid}-plan`} aria-label="Tratamiento del presupuesto">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_PLAN}>
                          Seleccionar otro servicio del catálogo
                        </SelectItem>
                        {options.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {planOptionLabel(item)}
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
                      Completarlo es una decisión aparte en la pestaña Realizado.
                    </p>
                  )}
                </Field>
              )}
            </div>
          </FormDrawer>
        )}
      </div>
    </div>
  )
}
