import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui";
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import {
  FDI_ADULT,
  FDI_CHILD,
  encounterStatusLabel,
  hcLabel,
  type Encounter,
  type EncounterDetail,
  type OdontogramState,
  type PatientFull,
} from "../../lib/patients";
import { OdontogramStudio } from "../odontogram-studio";
import { EncounterDiagnoses } from "./encounter-diagnoses";
import { EncounterProcedures } from "./encounter-procedures";
import { ImagenesTab } from "./imagenes-tab";

export interface EncounterEditorProps {
  patientId: string;
  detail: EncounterDetail;
  patient: PatientFull;
  /** Refresca el query del encounter (lo implementa la ruta). */
  onChanged: () => Promise<void>;
  /** Invalida resumen/plan/timeline y navega a Historia (lo implementa la ruta). */
  onFinalized: () => Promise<void>;
  /** Solo navega: el editor hace flush antes de llamarla. */
  onBack: () => void | Promise<void>;
}

type DraftKey = "reason" | "evolution" | "indications" | "nextStep" | "nextAppointmentAt" | "teeth";

type SaveState = "saved" | "pending" | "saving" | "error";

interface DraftValues {
  reason: string;
  evolution: string;
  indications: string;
  nextStep: string;
  apptDate: string;
  apptTime: string;
  teeth: number[];
}

interface DraftPatch {
  reason?: string | null;
  evolution?: string | null;
  indications?: string | null;
  nextStep?: string | null;
  nextAppointmentAt?: string | null;
  teeth?: number[];
}

const AUTOSAVE_MS = 800;
const MAX_REASON = 2000;
const MAX_EVOLUTION = 10000;
const MAX_INDICATIONS = 4000;
const MAX_NEXT_STEP = 2000;
const APPT_INCOMPLETE = "Completa la fecha y la hora de la próxima cita, o limpia ambas.";

const VALID_TEETH: readonly number[] = [...FDI_ADULT, ...FDI_CHILD];

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "Guardado",
  pending: "Cambios pendientes…",
  saving: "Guardando…",
  error: "Error al guardar",
};

function toLocalDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toLocalTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** La cita solo se serializa con fecha+hora válidas, o null si ambas están vacías. */
function serializeAppt(date: string, time: string): { ok: true; value: string | null } | { ok: false } {
  if (!date && !time) return { ok: true, value: null };
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return { ok: false };
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return { ok: false };
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
    return { ok: false };
  }
  return { ok: true, value: local.toISOString() };
}

function sortTeeth(teeth: number[]): number[] {
  return [...teeth].sort((a, b) => a - b);
}

/** Identificador corto del odontólogo tratante (primeros 8 caracteres). */
export function dentistShortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function saveMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message;
  return err instanceof Error ? err.message : fallback;
}

/**
 * Borrador de la atención (solo borradores; la rama finalizada la posee la ruta).
 * Autosave con debounce + drenado serializado por campos dirty: nunca envía el
 * objeto completo para no pisar vínculos clínicos (piezas implícitas de
 * procedimientos, diagnósticos, imágenes u odontograma).
 */
export function EncounterEditor({
  patientId,
  detail,
  patient,
  onChanged,
  onFinalized,
  onBack,
}: EncounterEditorProps): React.JSX.Element {
  const encounter = detail.encounter;
  const encounterId = encounter.id;
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const uid = useId();

  const [reason, setReason] = useState(encounter.reason ?? "");
  const [evolution, setEvolution] = useState(encounter.evolution ?? "");
  const [indications, setIndications] = useState(encounter.indications ?? "");
  const [nextStep, setNextStep] = useState(encounter.nextStep ?? "");
  const [teeth, setTeeth] = useState<number[]>(() => sortTeeth(detail.teeth));
  const [apptDate, setApptDate] = useState(() => toLocalDate(encounter.nextAppointmentAt));
  const [apptTime, setApptTime] = useState(() => toLocalTime(encounter.nextAppointmentAt));
  const [addSel, setAddSel] = useState<string | null>(null);

  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [apptError, setApptError] = useState<string | null>(null);
  const [childCount, setChildCount] = useState(0);
  const [explicitSaving, setExplicitSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [backing, setBacking] = useState(false);

  const valuesRef = useRef<DraftValues>({
    reason: encounter.reason ?? "",
    evolution: encounter.evolution ?? "",
    indications: encounter.indications ?? "",
    nextStep: encounter.nextStep ?? "",
    apptDate: toLocalDate(encounter.nextAppointmentAt),
    apptTime: toLocalTime(encounter.nextAppointmentAt),
    teeth: sortTeeth(detail.teeth),
  });
  const dirtyRef = useRef<Set<DraftKey>>(new Set());
  const inflightRef = useRef<Set<DraftKey>>(new Set());
  const drainRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const childCountRef = useRef(0);
  const latestWriteAtRef = useRef(new Date(encounter.updatedAt).getTime());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
    };
  }, []);

  const dentalQuery = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
  });

  // Los textos pertenecen al editor. Solo los registros vinculados pueden
  // añadir piezas; una respuesta anterior al último PATCH no debe borrarlas.
  useEffect(() => {
    const updatedAt = new Date(encounter.updatedAt).getTime();
    if (updatedAt < latestWriteAtRef.current) return;
    latestWriteAtRef.current = updatedAt;
    if (dirtyRef.current.has("teeth") || inflightRef.current.has("teeth")) return;
    const next = sortTeeth(detail.teeth);
    if (next.join(",") !== valuesRef.current.teeth.join(",")) {
      valuesRef.current.teeth = next;
      setTeeth(next);
    }
  }, [detail.teeth, encounter.updatedAt]);

  const clearTimer = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  const buildBody = (keys: DraftKey[]): DraftPatch => {
    const values = valuesRef.current;
    const body: DraftPatch = {};
    for (const key of keys) {
      switch (key) {
        case "reason":
          body.reason = values.reason === "" ? null : values.reason;
          break;
        case "evolution":
          body.evolution = values.evolution === "" ? null : values.evolution;
          break;
        case "indications":
          body.indications = values.indications === "" ? null : values.indications;
          break;
        case "nextStep":
          body.nextStep = values.nextStep === "" ? null : values.nextStep;
          break;
        case "teeth":
          body.teeth = [...values.teeth];
          break;
        case "nextAppointmentAt": {
          const serialized = serializeAppt(values.apptDate, values.apptTime);
          if (serialized.ok) body.nextAppointmentAt = serialized.value;
          break;
        }
      }
    }
    return body;
  };

  /** Un solo drenado serializado: toma los dirty, los envía y repite si llegaron más. */
  const drain = (): Promise<void> => {
    if (drainRef.current) return drainRef.current;
    const run = (async () => {
      try {
        if (mountedRef.current) setSaveState("saving");
        for (;;) {
          if (dirtyRef.current.size === 0) break;
          const keys = [...dirtyRef.current];
          dirtyRef.current.clear();
          const sendable = keys.filter((key) => {
            if (key === "nextAppointmentAt" && !serializeAppt(valuesRef.current.apptDate, valuesRef.current.apptTime).ok) {
              dirtyRef.current.add(key);
              return false;
            }
            return true;
          });
          if (sendable.length === 0) break;
          for (const key of sendable) inflightRef.current.add(key);
          try {
            const saved = await apiFetch<{ data: Encounter }>(`/api/patients/${patientId}/encounters/${encounterId}`, {
              method: "PATCH",
              body: JSON.stringify(buildBody(sendable)),
            });
            latestWriteAtRef.current = Math.max(latestWriteAtRef.current, new Date(saved.data.updatedAt).getTime());
          } catch (err) {
            for (const key of sendable) dirtyRef.current.add(key);
            throw err;
          } finally {
            for (const key of sendable) inflightRef.current.delete(key);
          }
        }
        if (mountedRef.current) {
          setSaveError(null);
          setSaveState(dirtyRef.current.size > 0 ? "pending" : "saved");
        }
      } catch (err) {
        if (mountedRef.current) {
          setSaveError(saveMessage(err, "No se pudo guardar el borrador."));
          setSaveState("error");
        }
        throw err;
      }
    })().finally(() => {
      // También se libera cuando no hubo ningún await (borrador sin cambios).
      drainRef.current = null;
    });
    drainRef.current = run;
    return run;
  };

  const hasSendableDirty = (): boolean => {
    for (const key of dirtyRef.current) {
      if (key !== "nextAppointmentAt") return true;
      if (serializeAppt(valuesRef.current.apptDate, valuesRef.current.apptTime).ok) return true;
    }
    return false;
  };

  /** Barrera de escritura: la consumen hijos, guardado, finalizar y volver. */
  const flush = async (): Promise<void> => {
    clearTimer();
    for (;;) {
      await drain();
      if (!hasSendableDirty()) {
        if (dirtyRef.current.has("nextAppointmentAt")) {
          if (mountedRef.current) setApptError(APPT_INCOMPLETE);
          throw new Error(APPT_INCOMPLETE);
        }
        return;
      }
    }
  };

  const markEdited = (key: DraftKey) => {
    dirtyRef.current.add(key);
    if (mountedRef.current) {
      setSaveError(null);
      setSaveState(drainRef.current ? "saving" : "pending");
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void drain().catch(() => {});
    }, AUTOSAVE_MS);
  };

  const editReason = (value: string) => {
    valuesRef.current.reason = value;
    setReason(value);
    markEdited("reason");
  };

  const editEvolution = (value: string) => {
    valuesRef.current.evolution = value;
    setEvolution(value);
    markEdited("evolution");
  };

  const editIndications = (value: string) => {
    valuesRef.current.indications = value;
    setIndications(value);
    markEdited("indications");
  };

  const editNextStep = (value: string) => {
    valuesRef.current.nextStep = value;
    setNextStep(value);
    markEdited("nextStep");
  };

  const editApptDate = (value: string) => {
    valuesRef.current.apptDate = value;
    setApptDate(value);
    setApptError(null);
    markEdited("nextAppointmentAt");
  };

  const editApptTime = (value: string) => {
    valuesRef.current.apptTime = value;
    setApptTime(value);
    setApptError(null);
    markEdited("nextAppointmentAt");
  };

  const addTooth = (value: string | null) => {
    setAddSel(null);
    if (value == null || value === "") return;
    const tooth = Number(value);
    if (!Number.isInteger(tooth) || !VALID_TEETH.includes(tooth)) return;
    if (valuesRef.current.teeth.includes(tooth)) return;
    const next = sortTeeth([...valuesRef.current.teeth, tooth]);
    valuesRef.current.teeth = next;
    setTeeth(next);
    markEdited("teeth");
  };

  const removeTooth = (tooth: number) => {
    const next = valuesRef.current.teeth.filter((item) => item !== tooth);
    valuesRef.current.teeth = next;
    setTeeth(next);
    markEdited("teeth");
  };

  const apptBlocked = (): boolean => {
    const values = valuesRef.current;
    if (!values.apptDate && !values.apptTime) return false;
    return !serializeAppt(values.apptDate, values.apptTime).ok;
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (explicitSaving || finalizing || childCountRef.current > 0) return;
    if (apptBlocked()) {
      setApptError(APPT_INCOMPLETE);
      return;
    }
    setApptError(null);
    setExplicitSaving(true);
    try {
      await flush();
      await onChanged();
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo guardar el borrador."));
        setSaveState("error");
      }
    } finally {
      if (mountedRef.current) setExplicitSaving(false);
    }
  };

  const handleConfirmFinalize = async () => {
    if (finalizing || childCountRef.current > 0) return;
    if (apptBlocked()) {
      setApptError(APPT_INCOMPLETE);
      setConfirmOpen(false);
      return;
    }
    setApptError(null);
    setFinalizing(true);
    try {
      // Congela: primero todo PATCH pendiente y último dirty, recién después finalize.
      await flush();
      await apiFetch<{ data: unknown }>(`/api/patients/${patientId}/encounters/${encounterId}/finalize`, {
        method: "POST",
        body: "{}",
      });
      await onFinalized();
    } catch (err) {
      // Falla: se conserva el borrador intacto y se muestra el error real.
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo finalizar la atención."));
        setSaveState("error");
        setConfirmOpen(false);
      }
    } finally {
      if (mountedRef.current) setFinalizing(false);
    }
  };

  const handleBack = async () => {
    if (backing || finalizing || childCountRef.current > 0) return;
    setBacking(true);
    try {
      await flush();
      await onBack();
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo guardar el borrador."));
        setSaveState("error");
      }
    } finally {
      if (mountedRef.current) setBacking(false);
    }
  };

  const handlePendingChange = (pending: boolean) => {
    childCountRef.current = Math.max(0, childCountRef.current + (pending ? 1 : -1));
    if (mountedRef.current) setChildCount(childCountRef.current);
  };

  const handleChildChanged = async (): Promise<void> => {
    await onChanged();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["plan", patientId] }),
    ]);
  };

  const locked = !canWrite || childCount > 0 || finalizing || backing;
  const availableTeeth = VALID_TEETH.filter((tooth) => !teeth.includes(tooth));
  const availableItems: Record<string, string> = Object.fromEntries(
    availableTeeth.map((tooth) => [String(tooth), `Pieza ${tooth}`]),
  );
  const availableAdult = availableTeeth.filter((tooth) => FDI_ADULT.includes(tooth));
  const availableChild = availableTeeth.filter((tooth) => FDI_CHILD.includes(tooth));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{patient.displayName}</h1>
          <p className="text-sm text-muted-foreground">
            {hcLabel(patient.patient.patientNumber)} · Odontólogo {dentistShortId(encounter.dentistUserId)}
          </p>
        </div>
        <Badge variant="outline">{encounterStatusLabel(encounter.status)}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Borrador: {SAVE_LABEL[saveState]}
        </p>
        {childCount > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Registrando dato vinculado…
          </p>
        )}
      </div>
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">Solo lectura: no tienes permiso para editar este borrador.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Motivo de la atención</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor={`${uid}-reason`}>Motivo (máx. {MAX_REASON})</FieldLabel>
            <Input
              id={`${uid}-reason`}
              value={reason}
              disabled={locked}
              maxLength={MAX_REASON}
              placeholder="Motivo de la consulta…"
              onChange={(event) => editReason(event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Piezas tratadas ({teeth.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {teeth.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin piezas vinculadas.</p>
          ) : (
            <ul aria-label="Piezas vinculadas" className="flex flex-wrap gap-2">
              {teeth.map((tooth) => (
                <li key={tooth}>
                  <Badge variant="outline" className="flex items-center gap-1 py-1 pl-3 pr-1">
                    Pieza {tooth}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={locked}
                      aria-label={`Quitar pieza ${tooth}`}
                      onClick={() => removeTooth(tooth)}
                    >
                      Quitar
                    </Button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <Field className="w-52">
            <FieldLabel htmlFor={`${uid}-add-tooth`}>Agregar pieza</FieldLabel>
            <Select
              value={addSel}
              items={availableItems}
              onValueChange={(value) => addTooth(value)}
              disabled={locked || availableTeeth.length === 0}
            >
              <SelectTrigger id={`${uid}-add-tooth`}>
                <SelectValue placeholder="Seleccionar pieza…" />
              </SelectTrigger>
              <SelectContent>
                {availableAdult.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Adulta</SelectLabel>
                    {availableAdult.map((tooth) => (
                      <SelectItem key={tooth} value={String(tooth)}>
                        Pieza {tooth}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {availableChild.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Temporal</SelectLabel>
                    {availableChild.map((tooth) => (
                      <SelectItem key={tooth} value={String(tooth)}>
                        Pieza {tooth}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <EncounterDiagnoses
        patientId={patientId}
        detail={detail}
        disabled={locked}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
      />

      <Card>
        <CardHeader>
          <CardTitle>Odontograma</CardTitle>
        </CardHeader>
        <CardContent>
          {dentalQuery.isLoading && <p className="text-sm text-muted-foreground">Cargando odontograma…</p>}
          {dentalQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {dentalQuery.error instanceof ApiError && dentalQuery.error.shape.message
                ? dentalQuery.error.shape.message
                : "No se pudo cargar el odontograma."}
            </p>
          )}
          {dentalQuery.data && (
            <OdontogramStudio
              patientId={patientId}
              state={dentalQuery.data.data}
              compact
              encounterId={encounterId}
              onChanged={handleChildChanged}
              beforeWrite={flush}
              onPendingChange={handlePendingChange}
              disabled={locked}
              readOnly={!canWrite}
            />
          )}
        </CardContent>
      </Card>

      <EncounterProcedures
        patientId={patientId}
        detail={detail}
        disabled={locked}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
      />

      <Card>
        <CardHeader>
          <CardTitle>Evolución</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor={`${uid}-evolution`}>Evolución (máx. {MAX_EVOLUTION})</FieldLabel>
            <Textarea
              id={`${uid}-evolution`}
              value={evolution}
              disabled={locked}
              maxLength={MAX_EVOLUTION}
              placeholder="Evolución clínica…"
              onChange={(event) => editEvolution(event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <ImagenesTab
        patientId={patientId}
        encounterId={encounterId}
        beforeWrite={flush}
        onPendingChange={handlePendingChange}
        disabled={locked}
        readOnly={!canWrite}
        onUploaded={handleChildChanged}
      />

      <Card>
        <CardHeader>
          <CardTitle>Indicaciones y paso siguiente</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-indications`}>Indicaciones (máx. {MAX_INDICATIONS})</FieldLabel>
            <Textarea
              id={`${uid}-indications`}
              value={indications}
              disabled={locked}
              maxLength={MAX_INDICATIONS}
              placeholder="Indicaciones para el paciente…"
              onChange={(event) => editIndications(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-next-step`}>Paso siguiente (máx. {MAX_NEXT_STEP})</FieldLabel>
            <Textarea
              id={`${uid}-next-step`}
              value={nextStep}
              disabled={locked}
              maxLength={MAX_NEXT_STEP}
              placeholder="Paso siguiente del tratamiento…"
              onChange={(event) => editNextStep(event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Próxima cita</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor={`${uid}-appt-date`}>Fecha</FieldLabel>
              <Input
                id={`${uid}-appt-date`}
                type="date"
                value={apptDate}
                disabled={locked}
                onChange={(event) => editApptDate(event.target.value)}
              />
            </Field>
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor={`${uid}-appt-time`}>Hora</FieldLabel>
              <Input
                id={`${uid}-appt-time`}
                type="time"
                value={apptTime}
                disabled={locked}
                onChange={(event) => editApptTime(event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">Se guarda solo con fecha y hora juntas; vacías, quita la cita.</p>
          {apptError && (
            <p role="alert" className="text-sm text-destructive">
              {apptError}
            </p>
          )}
        </CardContent>
      </Card>

      <form onSubmit={(event) => void handleSave(event)} className="flex flex-wrap gap-2">
        <SubmitButton type="submit" pending={explicitSaving} disabled={locked || backing}>
          Guardar borrador
        </SubmitButton>
        <Button type="button" disabled={locked || explicitSaving || backing} onClick={() => setConfirmOpen(true)}>
          Finalizar atención
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={locked || explicitSaving}
          onClick={() => void handleBack()}
        >
          {backing ? "Guardando…" : "Volver"}
        </Button>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        title="Finalizar atención"
        description="La atención quedará inmutable y ya no se podrá editar el borrador. Después solo se podrán agregar adendas. Esta acción no se puede deshacer."
        confirmLabel="Finalizar atención"
        variant="default"
        pending={finalizing}
        onConfirm={() => void handleConfirmFinalize()}
        onClose={() => {
          if (!finalizing) setConfirmOpen(false);
        }}
      />
    </div>
  );
}
