import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui";
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns";
import { useState } from "react";
import { ApiError, apiFetch } from "../lib/api";
import { timeAgo, useCanWrite } from "../lib/crm";
import {
  CONDITIONS,
  conditionLabel,
  planStatusLabel,
  statusLabel,
  surfaceLabel,
  toothTypeOf,
  type OdontogramEntry,
  type PatientDocument,
  type PlanItem,
} from "../lib/patients";
import { Cie10Search } from "./patient/cie10-search";

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000;

const CONDITION_ITEMS: Record<string, string> = Object.fromEntries(
  CONDITIONS.map((c) => [c, conditionLabel(c)]),
);

const OPEN_PLAN_STATUSES: readonly string[] = ["pendiente", "programado"];

function entryTime(entry: OdontogramEntry): number {
  if (!entry.createdAt) return 0;
  const t = new Date(entry.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function ToothPanel({
  patientId,
  toothNumber,
  entries,
  history,
  onChanged,
  encounterId,
  readOnly = false,
}: {
  patientId: string;
  toothNumber: number;
  /** Entradas vigentes de la pieza (ganadoras actuales), más recientes primero. */
  entries: OdontogramEntry[];
  /** Todas las entradas de la pieza incl. anuladas, ya filtradas por corte histórico. */
  history: OdontogramEntry[];
  onChanged: () => void;
  encounterId?: string;
  readOnly?: boolean;
}): React.JSX.Element {
  const canWrite = useCanWrite();
  const canMutate = !readOnly && canWrite;
  const innerSurface = [1, 2, 5, 6].includes(Math.trunc(toothNumber / 10)) ? "palatina" : "lingual";
  const kind = toothTypeOf(toothNumber);
  const centralSurface = kind === "incisivo" || kind === "canino" ? "incisal" : "oclusal";
  const allowedSurfaces = ["mesial", "distal", "vestibular", innerSurface, centralSurface];

  const [condition, setCondition] = useState("otro");
  const [diagnosisCode, setDiagnosisCode] = useState("");
  const [diagnosisDescription, setDiagnosisDescription] = useState("");
  const [note, setNote] = useState("");
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null);
  const [voidPending, setVoidPending] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);

  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  });

  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
  });

  const sortedHistory = [...history].sort((a, b) => entryTime(b) - entryTime(a));

  const affectedSurfaces = Array.from(
    new Set(entries.map((e) => e.surface).filter((s): s is string => s != null)),
  );
  const currentDiagnoses = Array.from(
    new Set(entries.map((e) => e.diagnosisCode).filter((c): c is string => c != null && c !== "")),
  );

  const toothPlan = (planQuery.data?.data ?? []).filter((item) => item.toothNumber === toothNumber);
  const openPlan = toothPlan.filter((item) => OPEN_PLAN_STATUSES.includes(item.status));
  const donePlan = toothPlan.filter((item) => !OPEN_PLAN_STATUSES.includes(item.status));

  const toothDocs = (docsQuery.data?.data ?? []).filter((d) => d.toothNumber === toothNumber);
  const toothImages = toothDocs.filter(
    (d) => d.category === "radiografia" || d.category === "foto_clinica",
  );
  const toothOtherDocs = toothDocs.filter(
    (d) => d.category !== "radiografia" && d.category !== "foto_clinica",
  );


  const toggleSurface = (surface: string) => {
    setSurfaces((prev) =>
      prev.includes(surface) ? prev.filter((s) => s !== surface) : [...prev, surface],
    );
  };

  const submitDiagnosis = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canMutate || formPending || !diagnosisCode) return;
    setFormPending(true);
    setFormError(null);
    try {
      const code = diagnosisCode.trim();
      const body: Record<string, unknown> = {
        toothNumber,
        condition,
        ...(surfaces.length > 0 ? { surfaces } : {}),
        ...(code ? { diagnosisCode: code } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(encounterId ? { encounterId } : {}),
      };
      await apiFetch(`/api/patients/${patientId}/odontogram/entries`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setDiagnosisCode("");
      setDiagnosisDescription("");
      setNote("");
      setSurfaces([]);
      onChanged();
    } catch (err) {
      setFormError(mutationMessage(err, "No se pudo registrar el diagnóstico."));
    } finally {
      setFormPending(false);
    }
  };

  const confirmVoid = async () => {
    if (!voiding || !canMutate) return;
    setVoidPending(true);
    setVoidError(null);
    try {
      await apiFetch(
        `/api/patients/${patientId}/odontogram/entries/${voiding.id}/void`,
        { method: "POST" },
      );
      setVoiding(null);
      onChanged();
    } catch (err) {
      setVoidError(mutationMessage(err, "No se pudo anular la entrada."));
    } finally {
      setVoidPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">Pieza {toothNumber}</h3>
        <Badge>{toothTypeOf(toothNumber)}</Badge>
      </div>

      <section aria-label="Estado actual" className="flex flex-col gap-2 rounded-lg border p-3">
        <h4 className="text-sm font-medium">Estado actual</h4>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin hallazgos vigentes en esta pieza.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {entries.map((entry) => (
                <Badge key={entry.id}>
                  {conditionLabel(entry.condition)} · {statusLabel(entry.status)}
                </Badge>
              ))}
            </div>
            {affectedSurfaces.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Superficies afectadas">
                {affectedSurfaces.map((s) => (
                  <Badge key={s} variant="outline">
                    {surfaceLabel(s)}
                  </Badge>
                ))}
              </div>
            )}
            {currentDiagnoses.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                CIE-10:
                {currentDiagnoses.map((code) => (
                  <Badge key={code} variant="outline">
                    {code}
                  </Badge>
                ))}
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-label="Plan de la pieza" className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Plan de la pieza</h4>
          <a
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            href="?tab=plan"
          >
            Ver plan
          </a>
        </div>
        {planQuery.isPending && <p className="text-sm text-muted-foreground">Cargando plan…</p>}
        {planQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            No se pudo cargar el plan de la pieza.
          </p>
        )}
        {!planQuery.isPending && !planQuery.isError && toothPlan.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin ítems del plan para esta pieza.</p>
        )}
        {!planQuery.isPending && !planQuery.isError && toothPlan.length > 0 && (
          <div className="flex flex-col gap-2">
            {openPlan.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">Pendiente / programado</p>
                <ul className="flex flex-col gap-1">
                  {openPlan.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className="font-medium">{item.title}</span>
                      <Badge variant="outline">{planStatusLabel(item.status)}</Badge>
                      {item.diagnosisCode && <Badge variant="outline">{item.diagnosisCode}</Badge>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {donePlan.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">Historial del plan</p>
                <ul className="flex flex-col gap-1">
                  {donePlan.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className="font-medium">{item.title}</span>
                      <Badge variant="outline">{planStatusLabel(item.status)}</Badge>
                      {item.diagnosisCode && <Badge variant="outline">{item.diagnosisCode}</Badge>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-label="Imágenes asociadas" className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Imágenes asociadas</h4>
          <a
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            href={`?tab=imagenes&tooth=${toothNumber}`}
          >
            Ver imágenes
          </a>
        </div>
        {docsQuery.isPending && <p className="text-sm text-muted-foreground">Cargando imágenes…</p>}
        {docsQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            No se pudieron cargar los documentos de la pieza.
          </p>
        )}
        {!docsQuery.isPending && !docsQuery.isError && toothDocs.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin imágenes ni documentos de esta pieza.</p>
        )}
        {!docsQuery.isPending && !docsQuery.isError && toothImages.length > 0 && (
          <ul className="grid grid-cols-2 gap-2">
            {toothImages.map((doc) => (
              <ToothImageThumb key={doc.id} patientId={patientId} doc={doc} />
            ))}
          </ul>
        )}
        {!docsQuery.isPending && !docsQuery.isError && toothOtherDocs.length > 0 && (
          <ul className="flex flex-col gap-1">
            {toothOtherDocs.map((doc) => (
              <ToothDocLink key={doc.id} patientId={patientId} doc={doc} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Registrar diagnóstico" className="flex flex-col gap-3 rounded-lg border p-3">
        <h4 className="text-sm font-medium">Registrar diagnóstico</h4>
        {!canMutate ? (
          <p className="text-sm text-muted-foreground">
            {readOnly
              ? "Solo lectura: no se pueden registrar cambios."
              : "No tienes permiso para registrar cambios en esta pieza."}
          </p>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(event) => void submitDiagnosis(event)}>
            <Cie10Search
              value={diagnosisCode}
              label="Diagnóstico CIE-10"
              disabled={formPending}
              onChange={(code, description) => {
                setDiagnosisCode(code);
                setDiagnosisDescription(description);
              }}
            />
            {diagnosisDescription && (
              <p className="text-xs text-muted-foreground">{diagnosisDescription}</p>
            )}
            <Field>
              <FieldLabel htmlFor={`tooth-panel-condition-${toothNumber}`}>Condición</FieldLabel>
              <Select
                value={condition}
                items={CONDITION_ITEMS}
                onValueChange={(v) => setCondition(v ?? "otro")}
              >
                <SelectTrigger id={`tooth-panel-condition-${toothNumber}`} aria-label="Condición" disabled={formPending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {conditionLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium">Superficies (vacío = pieza completa)</legend>
              <div className="grid grid-cols-2 gap-1">
                {allowedSurfaces.map((s) => (
                  <label key={s} htmlFor={`tooth-surface-${toothNumber}-${s}`} className="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      id={`tooth-surface-${toothNumber}-${s}`}
                      checked={surfaces.includes(s)}
                      disabled={formPending}
                      onCheckedChange={() => toggleSurface(s)}
                    />
                    {surfaceLabel(s)}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field>
              <FieldLabel htmlFor={`tooth-panel-note-${toothNumber}`}>Nota (opcional)</FieldLabel>
              <Textarea
                id={`tooth-panel-note-${toothNumber}`}
                value={note}
                disabled={formPending}
                maxLength={500}
                placeholder="Detalle clínico del hallazgo…"
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <SubmitButton type="submit" pending={formPending} disabled={!diagnosisCode}>
              Registrar diagnóstico
            </SubmitButton>
          </form>
        )}
      </section>

      <section aria-label="Historial de la pieza" className="flex flex-col gap-2 rounded-lg border p-3">
        <h4 className="text-sm font-medium">Historial de la pieza</h4>
        {sortedHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin entradas registradas.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sortedHistory.map((entry) => {
              const voided = entry.status === "anulado";
              return (
                <li
                  key={entry.id}
                  className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2 py-1 text-sm ${
                    voided ? "text-muted-foreground" : ""
                  }`}
                >
                  <span className={voided ? "line-through" : ""}>
                    {conditionLabel(entry.condition)}
                    {entry.surface ? ` (${surfaceLabel(entry.surface)})` : ""} ·{" "}
                    {statusLabel(entry.status)}
                  </span>
                  {entry.diagnosisCode && (
                    <Badge variant="outline" className={voided ? "line-through" : ""}>
                      {entry.diagnosisCode}
                    </Badge>
                  )}
                  {entry.note && (
                    <span className={`text-muted-foreground ${voided ? "line-through" : ""}`}>
                      — {entry.note}
                    </span>
                  )}
                  {entry.createdAt && (
                    <span className="text-xs text-muted-foreground">{timeAgo(entry.createdAt)}</span>
                  )}
                  {voided ? (
                    <span className="text-xs">(anulada)</span>
                  ) : (
                    canMutate && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="ml-auto"
                        disabled={voidPending}
                        onClick={() =>
                          setVoiding({
                            id: entry.id,
                            label: `pieza ${toothNumber} (${conditionLabel(entry.condition)})`,
                          })
                        }
                      >
                        Anular
                      </Button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {voidError && (
          <p role="alert" className="text-sm text-destructive">
            {voidError}
          </p>
        )}
      </section>

      <ConfirmDialog
        open={voiding !== null}
        onClose={() => {
          if (!voidPending) setVoiding(null);
        }}
        onConfirm={() => void confirmVoid()}
        title={`Anular entrada de ${voiding?.label ?? "la pieza"}`}
        description="La entrada quedará marcada como anulada y visible en el historial. Esta acción no se puede deshacer."
        confirmLabel="Anular"
        variant="destructive"
        pending={voidPending}
      />
    </div>
  );
}

function useSignedDocUrl(patientId: string, documentId: string) {
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${documentId}/url`),
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  });
}

function ToothImageThumb({ patientId, doc }: { patientId: string; doc: PatientDocument }) {
  const urlQuery = useSignedDocUrl(patientId, doc.id);
  const url = urlQuery.data?.data.url ?? null;
  const isImage = doc.contentType.startsWith("image/");

  return (
    <li className="overflow-hidden rounded-md border">
      {url && isImage ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`Ver ${doc.label}`}>
          <img src={url} alt={doc.label} loading="lazy" className="aspect-square w-full object-cover" />
        </a>
      ) : (
        <span className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-muted p-2 text-center">
          {urlQuery.isPending ? (
            <span className="text-xs text-muted-foreground">Cargando…</span>
          ) : url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Ver {doc.category === "radiografia" ? "radiografía" : "documento"}
            </a>
          ) : (
            <>
              <span className="text-xs font-medium">{doc.label}</span>
              <span className="text-xs text-destructive">Vista no disponible</span>
            </>
          )}
        </span>
      )}
      <div className="flex flex-col gap-1 p-2">
        <span className="truncate text-xs font-medium">{doc.label}</span>
        <span className="text-[11px] text-muted-foreground">{timeAgo(doc.createdAt)}</span>
      </div>
    </li>
  );
}

function ToothDocLink({ patientId, doc }: { patientId: string; doc: PatientDocument }) {
  const urlQuery = useSignedDocUrl(patientId, doc.id);
  const url = urlQuery.data?.data.url ?? null;

  return (
    <li className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{doc.label}</span>
        <span className="text-xs text-muted-foreground">
          {(doc.sizeBytes / 1024).toFixed(0)} KB · {timeAgo(doc.createdAt)}
        </span>
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Ver
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">
          {urlQuery.isPending ? "Cargando…" : "No disponible"}
        </span>
      )}
    </li>
  );
}
