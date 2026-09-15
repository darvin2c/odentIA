import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "@odentia/ui";
import { SubmitButton } from "@odentia/ui-patterns";
import { useId, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import {
  planStatusLabel,
  type EncounterDetail,
  type PlanItem,
} from "../../lib/patients";
import { Cie10Search } from "./cie10-search";

const NO_TOOTH = "__sin-pieza__";
const NO_PLAN = "__sin-plan__";
const MAX_DESCRIPTION = 4000;

const OPEN_STATUSES: readonly string[] = ["pendiente", "programado"];

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message;
  return err instanceof Error ? err.message : "No se pudo registrar el procedimiento.";
}

function planOptionLabel(item: PlanItem): string {
  const piece = item.toothNumber == null ? "General" : `Pieza ${item.toothNumber}`;
  const price = item.priceCents == null ? "por definir" : formatMoney(item.priceCents, item.currency);
  return `${item.title} · ${piece} · ${planStatusLabel(item.status)} · ${price}`;
}

/**
 * Procedimientos de la atención: lista los procedimientos reales del detalle
 * y permite registrar uno nuevo, opcionalmente vinculado a un ítem abierto
 * del plan (el POST lo marca realizado de forma atómica en el servidor).
 * Toda escritura respeta el protocolo de barrera: avisa pending al padre,
 * espera `beforeWrite` (flush del borrador), escribe, refresca plan + resumen,
 * espera `onChanged` (refresh del encounter) y recién ahí libera.
 */
export function EncounterProcedures({
  patientId,
  detail,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
}: {
  patientId: string;
  detail: EncounterDetail;
  disabled?: boolean;
  beforeWrite: () => Promise<void>;
  onChanged: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}): React.JSX.Element {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const uid = useId();
  const [description, setDescription] = useState("");
  const [toothSel, setToothSel] = useState<string>(NO_TOOTH);
  const [cie, setCie] = useState("");
  const [planSel, setPlanSel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const encounter = detail.encounter;
  const finalized = encounter.status === "finalizada";
  const busy = disabled || saving;

  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canWrite && !finalized,
  });

  const allItems = planQuery.data?.data ?? [];
  const openItems = allItems.filter((item) => OPEN_STATUSES.includes(item.status));
  const planById: Record<string, PlanItem> = Object.fromEntries(allItems.map((item) => [item.id, item]));

  const tooth = toothSel === NO_TOOTH ? null : Number(toothSel);
  // Al elegir pieza solo caben sus ítems más los generales (sin pieza); el
  // servidor no exige coincidencia, así que los generales siempre aplican.
  const visiblePlans =
    tooth == null ? openItems : openItems.filter((item) => item.toothNumber == null || item.toothNumber === tooth);
  const selectedPlan = planSel ? (planById[planSel] ?? null) : null;
  const options =
    selectedPlan && !visiblePlans.some((item) => item.id === selectedPlan.id)
      ? [...visiblePlans, selectedPlan]
      : visiblePlans;

  const toothItems: Record<string, string> = { [NO_TOOTH]: "Sin pieza" };
  for (const n of [...FDI_ADULT, ...FDI_CHILD]) toothItems[String(n)] = `Pieza ${n}`;
  const planItems: Record<string, string> = { [NO_PLAN]: "Sin vincular" };
  for (const item of options) planItems[item.id] = planOptionLabel(item);

  const onToothChange = (value: string | null) => {
    const next = value ?? NO_TOOTH;
    setToothSel(next);
    if (planSel) {
      const linked = planById[planSel] ?? null;
      const nextTooth = next === NO_TOOTH ? null : Number(next);
      if (linked && linked.toothNumber != null && linked.toothNumber !== nextTooth) {
        setPlanSel("");
      }
    }
  };

  const onPlanChange = (value: string | null) => {
    const next = value ?? NO_PLAN;
    if (next === NO_PLAN) {
      setPlanSel("");
      return;
    }
    const linked = planById[next];
    if (!linked) return;
    setPlanSel(next);
    if (description.trim() === "") setDescription(linked.title);
    if (linked.diagnosisCode) setCie(linked.diagnosisCode);
    if (linked.toothNumber != null) setToothSel(String(linked.toothNumber));
  };

  const canSubmit = canWrite && !finalized && !busy && description.trim() !== "";

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = description.trim();
    if (!trimmed || saving || disabled) return;
    const trimmedCie = cie.trim();
    const body = {
      description: trimmed,
      toothNumber: tooth,
      diagnosisCode: trimmedCie === "" ? null : trimmedCie,
      planItemId: planSel === "" ? null : planSel,
    };
    onPendingChange(true);
    setSaving(true);
    setError(null);
    try {
      await beforeWrite();
      await apiFetch(`/api/patients/${patientId}/encounters/${encounter.id}/procedures`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      // El servidor ya marcó el plan realizado: solo refrescar, sin mutación manual.
      await queryClient.invalidateQueries({ queryKey: ["plan", patientId] });
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] });
      await onChanged();
      setDescription("");
      setToothSel(NO_TOOTH);
      setCie("");
      setPlanSel("");
    } catch (err) {
      setError(mutationMessage(err));
    } finally {
      setSaving(false);
      onPendingChange(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Procedimientos registrados">
        {detail.procedures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin procedimientos registrados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.procedures.map((proc) => {
              const linked = proc.planItemId ? planById[proc.planItemId] : undefined;
              return (
                <li key={proc.id} className="border-b pb-2 text-sm last:border-0">
                  <p>{proc.description}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {proc.toothNumber != null ? <span>Pieza {proc.toothNumber}</span> : null}
                    {proc.diagnosisCode ? <Badge>CIE-10 {proc.diagnosisCode}</Badge> : null}
                    {proc.planItemId ? (
                      <span>Plan: {linked ? linked.title : proc.planItemId.slice(0, 8)}</span>
                    ) : null}
                    <time dateTime={proc.createdAt}>{formatDateTime(proc.createdAt)}</time>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canWrite && !finalized && (
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <Field>
            <FieldLabel htmlFor={`${uid}-descripcion`}>Procedimiento</FieldLabel>
            <Textarea
              id={`${uid}-descripcion`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="p. ej. Obturación resina pieza 36"
              rows={3}
              maxLength={MAX_DESCRIPTION}
              required
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              {description.length}/{MAX_DESCRIPTION}
            </p>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${uid}-pieza`}>Pieza (FDI, opcional)</FieldLabel>
            <Select value={toothSel} items={toothItems} onValueChange={onToothChange} disabled={busy}>
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

          <Field>
            <FieldLabel htmlFor={`${uid}-plan`}>Vincular al plan (opcional)</FieldLabel>
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
                <SelectTrigger id={`${uid}-plan`} aria-label="Vincular al plan (opcional)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PLAN}>Sin vincular</SelectItem>
                  {options.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {planOptionLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedPlan && (
              <p className="text-xs text-muted-foreground">
                Al guardar, «{selectedPlan.title}» quedará realizado y vinculado a esta atención.
              </p>
            )}
          </Field>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <SubmitButton type="submit" pending={saving} disabled={!canSubmit}>
              Registrar procedimiento
            </SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
