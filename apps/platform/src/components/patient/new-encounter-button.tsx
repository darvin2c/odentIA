import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@odentia/ui";
import { FormDrawer, WizardSteps } from "@odentia/ui-patterns";
import { useId, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import type { Encounter, PatientSummary, PlanItem } from "../../lib/patients";
import { ToothSelector } from "./tooth-selector";

const MAX_REASON = 2000;
const BRANCH_NONE = "__sin-sucursal__";

interface Branch {
  id: string;
  name: string;
}

const STEPS = [
  { id: "motivo", label: "Motivo y sucursal" },
  { id: "tratamientos", label: "Tratamientos y piezas" },
  { id: "revision", label: "Revisión" },
] as const;
function planOptionLabel(item: PlanItem): string {
  const tooth = item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : "";
  return `${item.title}${tooth} (${item.status})`;
}

/**
 * Nueva atención guiada: el clic ya no crea un borrador vacío. Un FormDrawer
 * de 3 pasos captura motivo/sucursal, tratamientos ACEPTADOS pendientes y
 * piezas (ToothSelector gráfico), y recién en la revisión crea la atención con
 * sus vínculos encounter_plan_item. Cancelar antes de crear no deja borrador.
 * Con borrador abierto, el botón reanuda sin duplicar (navega al existente).
 */
export function NewEncounterButton({ patientId, openEncounterId, initialPlanItemIds }: { patientId: string; openEncounterId?: string | null; initialPlanItemIds?: string[] }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const open = (id: string) => window.location.assign(`/patients/${patientId}/encounters/${id}`);
  const uid = useId();
  // Preselección desde un tratamiento aceptado (BudgetUI): el resto del flujo
  // no cambia; el servidor valida aceptado/pendiente al crear.
  const initialSelected = [...new Set((initialPlanItemIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0))];
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState<readonly number[]>([0]);
  const [reason, setReason] = useState("");
  const [branchId, setBranchId] = useState(BRANCH_NONE);
  const [selectedPlans, setSelectedPlans] = useState<string[]>(initialSelected);
  const [teeth, setTeeth] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
    enabled: drawerOpen,
  });
  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: drawerOpen,
  });

  if (!canWrite) return null;
  // Borrador abierto: reanudar sin duplicar (el servidor también responde
  // DRAFT_OPEN si la carrera lo crea en paralelo).
  if (openEncounterId) {
    return <Button onClick={() => open(openEncounterId)}>Reanudar atención</Button>;
  }

  const linkable = (planQuery.data?.data ?? []).filter((item) => item.decision === "aceptado" && (item.status === "pendiente" || item.status === "programado"));
  const branches = branchesQuery.data?.data ?? [];
  const branchName = branchId === BRANCH_NONE ? "Sin sucursal" : (branches.find((b) => b.id === branchId)?.name ?? "…");
  const selectedItems = linkable.filter((item) => selectedPlans.includes(item.id));
  const reasonOk = reason.trim().length > 0;
  const isDirty = reason.trim() !== "" || branchId !== BRANCH_NONE || selectedPlans.length > 0 || teeth.length > 0;

  const go = (index: number) => {
    // Sin motivo no se avanza ni se salta a la revisión: todas las rutas del
    // asistente (Continuar y clics del WizardSteps) pasan por aquí.
    if (index > step && step === 0 && !reasonOk) {
      setError("Registra el motivo de la atención para continuar.");
      return;
    }
    setStep(index);
    setVisited((prev) => (prev.includes(index) ? prev : [...prev, index]));
  };

  const reset = () => {
    setDrawerOpen(false);
    setStep(0);
    setVisited([0]);
    setReason("");
    setBranchId(BRANCH_NONE);
    setSelectedPlans(initialSelected);
    setTeeth([]);
    setSaving(false);
    setError(null);
  };

  const togglePlan = (id: string) => {
    setSelectedPlans((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };
  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ data: Encounter }>(`/api/patients/${patientId}/encounters`, {
        method: "POST",
        body: JSON.stringify({
          reason: reason.trim(),
          branchId: branchId === BRANCH_NONE ? null : branchId,
          teeth,
          planItemIds: selectedPlans,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] });
      reset();
      open(result.data.id);
    } catch (err) {
      if (err instanceof ApiError && err.shape.code === "DRAFT_OPEN") {
        try {
          const summary = await apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`);
          if (summary.data.openEncounterId) {
            await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] });
            reset();
            open(summary.data.openEncounterId);
            return;
          }
        } catch {
          // Cae al error original si el resumen tampoco responde.
        }
      }
      setError(err instanceof ApiError && err.shape.message ? err.shape.message : err instanceof Error ? err.message : "No se pudo crear la atención.");
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (saving) return;
    if (step < STEPS.length - 1) {
      if (step === 0 && !reasonOk) {
        setError("Registra el motivo de la atención para continuar.");
        return;
      }
      setError(null);
      go(step + 1);
      return;
    }
    void create();
  };

  return (
    <>
      <Button onClick={() => { setError(null); setSelectedPlans(initialSelected); setDrawerOpen(true); }}>Nueva atención</Button>
      <FormDrawer
        open={drawerOpen}
        onClose={() => { if (!saving) reset(); }}
        title="Nueva atención"
        error={error}
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
        isDirty={isDirty}
        isSubmitting={saving}
        submitLabel={step < STEPS.length - 1 ? "Continuar" : "Crear atención"}
        cancelLabel="Cancelar"
        submitDisabled={saving || (step === 0 && !reasonOk)}
        onSubmit={onSubmit}
        headerContent={<WizardSteps steps={STEPS} current={step} visited={visited} onGo={go} />}
      >
        <div className="flex flex-col gap-4">
          {step > 0 && (
            <div>
              <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => go(step - 1)}>
                Atrás
              </Button>
            </div>
          )}

          {step === 0 && (
            <>
              <Field>
                <FieldLabel htmlFor={`${uid}-motivo`}>Motivo de la atención</FieldLabel>
                <Textarea
                  id={`${uid}-motivo`}
                  value={reason}
                  disabled={saving}
                  maxLength={MAX_REASON}
                  placeholder="Motivo de la consulta…"
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-sucursal`}>Sucursal</FieldLabel>
                <Select
                  value={branchId}
                  onValueChange={(value) => setBranchId(value ?? BRANCH_NONE)}
                  disabled={saving || branchesQuery.isLoading}
                >
                  <SelectTrigger id={`${uid}-sucursal`}>
                    <SelectValue placeholder={branchesQuery.isLoading ? "Cargando…" : "Sin sucursal"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BRANCH_NONE}>Sin sucursal</SelectItem>
                    {branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {branchesQuery.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    No se pudieron cargar las sucursales; puedes continuar sin sucursal.
                  </p>
                )}
              </Field>
            </>
          )}

          {step === 1 && (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">Tratamientos aceptados pendientes</legend>
                {planQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">Cargando plan…</p>
                ) : planQuery.isError ? (
                  <div className="flex flex-col gap-2">
                    <p role="alert" className="text-sm text-destructive">
                      No se pudo cargar el plan. Puedes continuar sin vincular tratamientos.
                    </p>
                    <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void planQuery.refetch()}>
                      Reintentar
                    </Button>
                  </div>
                ) : linkable.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Sin tratamientos aceptados pendientes: la atención se creará sin vínculos al presupuesto.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {linkable.map((item) => (
                      <li key={item.id} className="flex items-start gap-2">
                        <Checkbox
                          id={`${uid}-plan-${item.id}`}
                          checked={selectedPlans.includes(item.id)}
                          disabled={saving}
                          onCheckedChange={() => togglePlan(item.id)}
                        />
                        <label htmlFor={`${uid}-plan-${item.id}`} className="text-sm">
                          {planOptionLabel(item)}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Solo tratamientos con decisión aceptada y estado pendiente o programado. Vincularlos no los marca realizados.
                </p>
              </fieldset>
              <ToothSelector value={teeth} onChange={setTeeth} disabled={saving} label="Piezas de la atención" />
            </>
          )}

          {step === 2 && (
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Motivo</dt>
                <dd className="whitespace-pre-wrap">{reason.trim()}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Sucursal</dt>
                <dd>{branchName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Tratamientos vinculados ({selectedItems.length})</dt>
                <dd>
                  {selectedItems.length === 0 ? (
                    "Sin vínculos al presupuesto."
                  ) : (
                    <ul className="list-disc pl-5">
                      {selectedItems.map((item) => (
                        <li key={item.id}>{planOptionLabel(item)}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Piezas ({teeth.length})</dt>
                <dd>{teeth.length === 0 ? "Sin piezas." : [...teeth].sort((a, b) => a - b).map((t) => `Pieza ${t}`).join(", ")}</dd>
              </div>
            </dl>
          )}
        </div>
      </FormDrawer>
    </>
  );
}
