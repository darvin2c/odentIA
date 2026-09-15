import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { useCanWrite } from "../lib/crm";
import { CONDITIONS, FDI_ADULT, FDI_ADULT_ROWS, FDI_CHILD, FDI_CHILD_ROWS, STATUSES, conditionLabel, statusLabel, winnersAsOf, type OdontogramEntry, type OdontogramState } from "../lib/patients";
import { ToothPanel } from "./tooth-panel";
import { ToothSVG } from "./tooth-svg";

const CONDITION_ITEMS = Object.fromEntries(CONDITIONS.map((value) => [value, conditionLabel(value)]));
const STATUS_ITEMS = Object.fromEntries(STATUSES.map((value) => [value, statusLabel(value)]));

export function OdontogramStudio({ patientId, state, onChanged, encounterId, compact = false, initialTooth, onToothSelect, readOnly = false, disabled = false, beforeWrite, onPendingChange }: {
  patientId: string;
  state: OdontogramState;
  onChanged: () => void | Promise<void>;
  encounterId?: string;
  compact?: boolean;
  initialTooth?: number;
  onToothSelect?: (tooth: number) => void;
  readOnly?: boolean;
  disabled?: boolean;
  beforeWrite?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const id = useId();
  const [dentition, setDentition] = useState<"adulta" | "temporal">(initialTooth && FDI_CHILD.includes(initialTooth) ? "temporal" : "adulta");
  const [mode, setMode] = useState<"ver" | "pintar">("ver");
  const [whole, setWhole] = useState(true);
  const [condition, setCondition] = useState("caries");
  const [status, setStatus] = useState("registrado");
  const [selected, setSelected] = useState<number | null>(initialTooth ?? null);
  const [snapshot, setSnapshot] = useState("actual");
  useEffect(() => {
    if (initialTooth && (FDI_ADULT.includes(initialTooth) || FDI_CHILD.includes(initialTooth))) {
      setSelected(initialTooth);
      setDentition(FDI_CHILD.includes(initialTooth) ? "temporal" : "adulta");
    }
  }, [initialTooth]);
  const dates = useMemo(() => [...new Set(state.history.flatMap((entry) => entry.createdAt ? [entry.createdAt] : []))].sort().reverse(), [state.history]);
  const view = useMemo(() => snapshot === "actual" ? state : winnersAsOf(state.history, snapshot), [state, snapshot]);
  const history = useMemo(() => {
    if (snapshot === "actual") return state.history;
    const cutoff = new Date(snapshot).getTime();
    return state.history.filter((entry) => entry.createdAt && new Date(entry.createdAt).getTime() <= cutoff);
  }, [state.history, snapshot]);
  const byTooth = useMemo(() => {
    const byId = new Map(state.history.map((entry) => [entry.id, entry]));
    const result = new Map<number, OdontogramEntry[]>();
    for (const [tooth, current] of Object.entries(view.teeth)) {
      const entries = current.entries.flatMap((entryId) => { const entry = byId.get(entryId); return entry ? [entry] : []; });
      entries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id));
      result.set(Number(tooth), entries);
    }
    return result;
  }, [state.history, view.teeth]);
  const refresh = async () => {
    await Promise.all(["patient-summary", "timeline"].map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })));
    await onChanged();
  };
  const paint = useMutation({
    mutationFn: async ({ tooth, surface }: { tooth: number; surface?: string }) => {
      onPendingChange?.(true);
      await beforeWrite?.();
      return apiFetch(`/api/patients/${patientId}/odontogram/entries`, {
        method: "POST",
        body: JSON.stringify({ toothNumber: tooth, condition, status, ...(surface ? { surfaces: [surface] } : {}), ...(encounterId ? { encounterId } : {}) }),
      });
    },
    onSuccess: refresh,
    onSettled: () => onPendingChange?.(false),
  });
  const locked = !canWrite || readOnly || snapshot !== "actual";
  const painting = mode === "pintar" && !locked;
  const busy = disabled || paint.isPending;
  const select = (tooth: number) => { setSelected(tooth); onToothSelect?.(tooth); };
  const rows = dentition === "adulta" ? FDI_ADULT_ROWS : FDI_CHILD_ROWS;
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-wrap gap-2" aria-label="Dentición">
        <Button variant={dentition === "adulta" ? "default" : "outline"} aria-pressed={dentition === "adulta"} onClick={() => { setDentition("adulta"); if (selected && FDI_CHILD.includes(selected)) setSelected(null); }}>Adulta (32)</Button>
        <Button variant={dentition === "temporal" ? "default" : "outline"} aria-pressed={dentition === "temporal"} onClick={() => { setDentition("temporal"); if (selected && FDI_ADULT.includes(selected)) setSelected(null); }}>Temporal (20)</Button>
      </div>
      {!compact && <Field className="w-64"><FieldLabel htmlFor={`${id}-fecha`}>Ver estado al</FieldLabel><Select value={snapshot} items={{ actual: "Actual", ...Object.fromEntries(dates.map((date) => [date, new Date(date).toLocaleString("es-PE")])) }} onValueChange={(value) => { setSnapshot(value ?? "actual"); setMode("ver"); }}><SelectTrigger id={`${id}-fecha`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="actual">Actual</SelectItem>{dates.map((date) => <SelectItem key={date} value={date}>{new Date(date).toLocaleString("es-PE")}</SelectItem>)}</SelectContent></Select></Field>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant={!painting ? "default" : "outline"} aria-pressed={!painting} onClick={() => setMode("ver")}>Ver</Button>
      {canWrite && !readOnly && <Button variant={painting ? "default" : "outline"} aria-pressed={painting} disabled={snapshot !== "actual" || busy} onClick={() => setMode("pintar")}>Pintar</Button>}
      {snapshot !== "actual" && <Badge variant="outline">Estado histórico · solo lectura</Badge>}
      {paint.isPending && <span role="status" className="text-sm text-muted-foreground">Guardando hallazgo…</span>}
    </div>
    {painting && <Card><CardContent className="flex flex-wrap items-end gap-4 pt-4">
      <Field className="w-44"><FieldLabel htmlFor={`${id}-condicion`}>Condición</FieldLabel><Select value={condition} items={CONDITION_ITEMS} onValueChange={(value) => { if (value) setCondition(value); }} disabled={busy}><SelectTrigger id={`${id}-condicion`}><SelectValue /></SelectTrigger><SelectContent>{CONDITIONS.map((value) => <SelectItem key={value} value={value}>{conditionLabel(value)}</SelectItem>)}</SelectContent></Select></Field>
      <Field className="w-40"><FieldLabel htmlFor={`${id}-estado`}>Estado</FieldLabel><Select value={status} items={STATUS_ITEMS} onValueChange={(value) => { if (value) setStatus(value); }} disabled={busy}><SelectTrigger id={`${id}-estado`}><SelectValue /></SelectTrigger><SelectContent>{STATUSES.map((value) => <SelectItem key={value} value={value}>{statusLabel(value)}</SelectItem>)}</SelectContent></Select></Field>
      <div className="flex gap-2"><Button variant={whole ? "default" : "outline"} aria-pressed={whole} disabled={busy} onClick={() => setWhole(true)}>Pieza completa</Button><Button variant={!whole ? "default" : "outline"} aria-pressed={!whole} disabled={busy} onClick={() => setWhole(false)}>Por superficie</Button></div>
    </CardContent></Card>}
    {paint.isError && <p role="alert" className="text-sm text-destructive">{paint.error.message}</p>}
    <div className={!compact && selected ? "grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]" : "grid gap-4"}>
      <Card className="min-w-0"><CardHeader><CardTitle>Odontograma FDI</CardTitle></CardHeader><CardContent className="flex min-w-0 flex-col gap-3">
        <div className="overflow-x-auto rounded-lg border p-3"><div className="flex min-w-max flex-col gap-5">
          {rows.map((row, index) => <div key={index} className="flex flex-col gap-2"><p className="text-center text-xs text-muted-foreground">{index === 0 ? "Arcada superior" : "Arcada inferior"}</p><div className="flex justify-center gap-1">{row.map((tooth) => <ToothSVG key={tooth} toothNumber={tooth} entries={byTooth.get(tooth) ?? []} selected={selected === tooth} painting={painting && !whole} disabled={busy} onSelect={() => { select(tooth); if (painting && whole && !busy) paint.mutate({ tooth }); }} onPaint={(surface) => { if (painting && !whole && !busy) { select(tooth); paint.mutate({ tooth, surface }); } }} />)}</div></div>)}
        </div></div>
        <p className="text-sm text-muted-foreground">{locked ? "Estado del odontograma: solo lectura." : painting ? whole ? "Selecciona una pieza para registrar el hallazgo completo." : "Selecciona una superficie para registrar el hallazgo." : compact ? "Selecciona Pintar para registrar hallazgos en esta atención." : "Selecciona una pieza para consultar diagnósticos, plan, imágenes e historial."}</p>
        <div className="flex flex-wrap gap-4 text-xs"><span className="flex items-center gap-1"><span className="size-2 rounded-full bg-red-500" />Registrado / planificado</span><span className="flex items-center gap-1"><span className="size-2 rounded-full bg-blue-500" />Realizado</span></div>
      </CardContent></Card>
      {!compact && selected && <ToothPanel key={`${selected}-${snapshot}`} patientId={patientId} toothNumber={selected} entries={byTooth.get(selected) ?? []} history={history.filter((entry) => entry.toothNumber === selected)} onChanged={refresh} encounterId={encounterId} readOnly={locked} />}
    </div>
  </div>;
}
