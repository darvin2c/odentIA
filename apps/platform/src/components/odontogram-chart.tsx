import { useState } from "react";
import { Button } from "@odentia/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@odentia/ui";
import { ConfirmDialog } from "@odentia/ui-patterns";
import { apiFetch } from "../lib/api";
import { entryColor } from "../lib/patients";

type ToothState = {
  condition: string;
  status: string;
  surfaces: string[];
  entries: string[];
};

type HistoryEntry = {
  id: string;
  toothNumber: number;
  surface: string | null;
  condition: string;
  status: string;
  note: string | null;
};

export function OdontogramChart({
  patientId,
  state,
  onChanged,
}: {
  patientId: string;
  state: { teeth: Record<string, ToothState>; history: HistoryEntry[] };
  onChanged: () => void;
}) {
  const [dentition, setDentition] = useState<"adulta" | "temporal">("adulta");
  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null);
  const [voidPending, setVoidPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teeth = dentition === "adulta" ? FDI_ADULT_ROWS : FDI_CHILD_ROWS;

  const voidEntry = async () => {
    if (!voiding) return;
    setVoidPending(true);
    setError(null);
    try {
      await apiFetch(
        `/api/patients/${patientId}/odontogram/entries/${voiding.id}/void`,
        { method: "POST" },
      );
      setVoiding(null);
      onChanged();
    } catch {
      setError("No se pudo anular la entrada.");
    } finally {
      setVoidPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={dentition === "adulta" ? "default" : "outline"}
          size="sm"
          onClick={() => setDentition("adulta")}
        >
          Adulta (32)
        </Button>
        <Button
          type="button"
          variant={dentition === "temporal" ? "default" : "outline"}
          size="sm"
          onClick={() => setDentition("temporal")}
        >
          Temporal (20)
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-col gap-3 overflow-x-auto rounded-lg border p-4">
        {teeth.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="flex items-stretch justify-center gap-1.5"
            role="row"
            aria-label={rowIndex === 0 ? "Arcada superior" : "Arcada inferior"}
          >
            {row.map((tooth) => {
              const toothState = state.teeth[String(tooth)];
              const entries = state.history.filter(
                (e) => e.toothNumber === tooth && e.status !== "anulado",
              );
              return (
                <Popover key={tooth}>
                  <PopoverTrigger
                    className="flex min-w-11 cursor-pointer flex-col items-center gap-0.5 rounded-md border bg-background p-1 transition-colors hover:ring-2 hover:ring-ring"
                    title={`Pieza ${tooth}${toothState ? ` — ${conditionLabel(toothState.condition)}` : ""}`}
                  >
                    <svg
                      viewBox="0 0 24 28"
                      className={`h-7 w-6 ${toothState ? entryColor(toothState.status) : "fill-transparent"}`}
                      stroke="currentColor"
                      strokeWidth={1.5}
                      aria-hidden
                    >
                      <path d="M12 2C7 2 4 5.5 4 9.5c0 3 1.2 4.8 1.8 7.3.5 2.2.8 4.7 1.4 6.7.3 1.1 1.7 1.4 2.3.4.7-1.3.9-3.4 1-5.4.1-1.4.4-2.7 1.5-2.7s1.4 1.3 1.5 2.7c.1 2 .3 4.1 1 5.4.6 1 2 .7 2.3-.4.6-2 .9-4.5 1.4-6.7.6-2.5 1.8-4.3 1.8-7.3C20 5.5 17 2 12 2Z" />
                    </svg>
                    <span className="text-[0.7rem] font-medium tabular-nums">{tooth}</span>
                  </PopoverTrigger>
                  <PopoverContent className="w-72">
                    <ToothForm
                      key={`${tooth}-${entries.length}`}
                      patientId={patientId}
                      toothNumber={tooth}
                      entries={entries}
                      onChanged={onChanged}
                      onVoid={(id, label) => setVoiding({ id, label })}
                      onError={setError}
                    />
                  </PopoverContent>
                </Popover>
              );
            })}
          </div>
        ))}
        <p className="text-center text-xs text-muted-foreground">
          Haz clic en una pieza para registrar un hallazgo o anular una entrada existente.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Historial de entradas</h4>
        {state.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin entradas registradas.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {state.history.map((entry) => {
              const anulada = entry.status === "anulado";
              return (
                <li
                  key={entry.id}
                  className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2 py-1 text-sm ${
                    anulada ? "text-muted-foreground" : ""
                  }`}
                >
                  <span className="font-medium tabular-nums">Pieza {entry.toothNumber}</span>
                  <span className={anulada ? "line-through" : ""}>
                    {conditionLabel(entry.condition)}
                    {entry.surface ? ` (${surfaceLabel(entry.surface)})` : ""}
                    {" · "}
                    {statusLabel(entry.status)}
                  </span>
                  {entry.note && (
                    <span className={`text-muted-foreground ${anulada ? "line-through" : ""}`}>
                      — {entry.note}
                    </span>
                  )}
                  {anulada ? (
                    <span className="text-xs">(anulada)</span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      onClick={() =>
                        setVoiding({
                          id: entry.id,
                          label: `pieza ${entry.toothNumber} (${conditionLabel(entry.condition)})`,
                        })
                      }
                    >
                      Anular
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        onConfirm={voidEntry}
        title={`Anular entrada de ${voiding?.label ?? "la pieza"}`}
        description="La entrada quedará marcada como anulada y visible en el historial. Esta acción no se puede deshacer."
        confirmLabel="Anular"
        variant="destructive"
        pending={voidPending}
      />
    </div>
  );
}

function ToothForm({
  patientId,
  toothNumber,
  entries,
  onChanged,
  onVoid,
  onError,
}: {
  patientId: string;
  toothNumber: number;
  entries: HistoryEntry[];
  onChanged: () => void;
  onVoid: (id: string, label: string) => void;
  onError: (message: string | null) => void;
}) {
  const [condition, setCondition] = useState("caries");
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [status, setStatus] = useState("registrado");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);

  const toggleSurface = (surface: string) => {
    setSurfaces((prev) =>
      prev.includes(surface) ? prev.filter((s) => s !== surface) : [...prev, surface],
    );
  };

  const submit = async () => {
    setPending(true);
    onError(null);
    try {
      await apiFetch(`/api/patients/${patientId}/odontogram/entries`, {
        method: "POST",
        body: JSON.stringify({
          toothNumber,
          condition,
          surfaces,
          status,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      setSurfaces([]);
      setNote("");
      onChanged();
    } catch {
      onError("No se pudo registrar la entrada del odontograma.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-medium">Pieza {toothNumber}</p>

      <label className="flex flex-col gap-1 text-xs">
        Condición
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={condition}
          onChange={(event) => setCondition(event.target.value)}
        >
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {conditionLabel(c)}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs">Superficies (vacío = pieza completa)</legend>
        <div className="grid grid-cols-2 gap-1">
          {SURFACES.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={surfaces.includes(s)}
                onChange={() => toggleSurface(s)}
              />
              {surfaceLabel(s)}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 text-xs">
        Estado
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs">
        Nota (opcional)
        <textarea
          className="min-h-14 rounded-md border bg-background p-2 text-sm"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
        />
      </label>

      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        {pending ? "Registrando…" : "Registrar"}
      </Button>

      {entries.length > 0 && (
        <div className="flex flex-col gap-1 border-t pt-2">
          <p className="text-xs text-muted-foreground">Entradas vigentes de esta pieza</p>
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 text-xs">
              <span>
                {conditionLabel(entry.condition)}
                {entry.surface ? ` (${surfaceLabel(entry.surface)})` : ""} ·{" "}
                {statusLabel(entry.status)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() =>
                  onVoid(entry.id, `pieza ${toothNumber} (${conditionLabel(entry.condition)})`)
                }
              >
                Anular
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dentición adulta: 32 piezas FDI (cuadrantes ordenados de derecha a izquierda). */
const FDI_ADULT_ROWS: number[][] = [
  [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
];

/** Dentición temporal: 20 piezas FDI. */
const FDI_CHILD_ROWS: number[][] = [
  [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
  [85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
];

const CONDITIONS = [
  "sano",
  "caries",
  "obturacion",
  "corona",
  "ausente",
  "extraccion_indicada",
  "endodoncia",
  "implante",
  "fractura",
  "sellante",
  "protesis",
  "desgaste",
  "otro",
];

const SURFACES = ["mesial", "distal", "vestibular", "lingual", "palatina", "oclusal", "incisal"];

const STATUSES = ["registrado", "realizado", "planificado"];

function conditionLabel(condition: string): string {
  switch (condition) {
    case "sano":
      return "Sano";
    case "caries":
      return "Caries";
    case "obturacion":
      return "Obturación";
    case "corona":
      return "Corona";
    case "ausente":
      return "Ausente";
    case "extraccion_indicada":
      return "Extracción indicada";
    case "endodoncia":
      return "Endodoncia";
    case "implante":
      return "Implante";
    case "fractura":
      return "Fractura";
    case "sellante":
      return "Sellante";
    case "protesis":
      return "Prótesis";
    case "desgaste":
      return "Desgaste";
    default:
      return "Otro";
  }
}

function surfaceLabel(surface: string): string {
  switch (surface) {
    case "mesial":
      return "Mesial";
    case "distal":
      return "Distal";
    case "vestibular":
      return "Vestibular";
    case "lingual":
      return "Lingual";
    case "palatina":
      return "Palatina";
    case "oclusal":
      return "Oclusal";
    default:
      return "Incisal";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "registrado":
      return "Registrado";
    case "realizado":
      return "Realizado";
    case "planificado":
      return "Planificado";
    default:
      return "Anulado";
  }
}
