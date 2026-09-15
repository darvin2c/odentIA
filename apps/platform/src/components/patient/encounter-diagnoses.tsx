import { Badge } from "@odentia/ui";
import { SubmitButton } from "@odentia/ui-patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import type { EncounterDetail } from "../../lib/patients";
import { Cie10Search } from "./cie10-search";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message;
  return err instanceof Error ? err.message : "No se pudo registrar el diagnóstico.";
}

/**
 * Diagnósticos de la atención: lista las notas de evolución del detalle y
 * permite registrar un diagnóstico CIE-10 como nota (`Dx: <descripción>`).
 * Toda escritura respeta el protocolo de barrera: avisa pending al padre,
 * espera `beforeWrite` (flush del borrador), escribe, espera `onChanged`
 * (refresh del encounter) y recién ahí libera.
 */
export function EncounterDiagnoses({
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
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const encounter = detail.encounter;
  const finalized = encounter.status === "finalizada";
  const busy = disabled || saving;
  const canSubmit = canWrite && !finalized && !busy && code.trim() !== "";

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const selectedCode = code.trim();
    if (!selectedCode || saving || disabled) return;
    const selectedDescription = description.trim();
    onPendingChange(true);
    setSaving(true);
    setError(null);
    try {
      await beforeWrite();
      await apiFetch(`/api/patients/${patientId}/notes`, {
        method: "POST",
        body: JSON.stringify({
          note: `Dx: ${selectedDescription || selectedCode}`,
          diagnosisCode: selectedCode,
          encounterId: encounter.id,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["timeline", patientId] });
      await onChanged();
      setCode("");
      setDescription("");
    } catch (err) {
      setError(mutationMessage(err));
    } finally {
      setSaving(false);
      onPendingChange(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Diagnósticos registrados">
        <h4 className="mb-2 text-sm font-medium">Diagnósticos ({detail.notes.length})</h4>
        {detail.notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin diagnósticos registrados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.notes.map((note) => (
              <li key={note.id} className="border-b pb-2 text-sm last:border-0">
                <p className="whitespace-pre-wrap">{note.note}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {note.diagnosisCode ? <Badge>{note.diagnosisCode}</Badge> : null}
                  <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canWrite && !finalized && (
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <Cie10Search
            value={code}
            onChange={(nextCode, nextDescription) => {
              setCode(nextCode);
              setDescription(nextCode ? nextDescription : "");
            }}
            disabled={busy}
          />
          {description && (
            <p className="text-sm text-muted-foreground">Se registrará como: Dx: {description}</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <SubmitButton type="submit" pending={saving} disabled={!canSubmit}>
              Registrar diagnóstico
            </SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
