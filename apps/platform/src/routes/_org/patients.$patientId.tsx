import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Badge, Button, Field, FieldLabel, Input } from "@odentia/ui";
import { Chip, ConfirmDialog, EmptyState, PageHeader, SubmitButton } from "@odentia/ui-patterns";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { OdontogramChart } from "../../components/odontogram-chart";
import { apiFetch } from "../../lib/api";
import { API_URL } from "../../lib/auth-client";
import { timeAgo } from "../../lib/crm";
import { orgSlugFromHostname } from "../../lib/host";
import {
  ageFrom,
  hcLabel,
  type Allergy,
  type AnamnesisAnswers,
  type ClinicalNote,
  type Condition,
  type Medication,
  type OdontogramState,
  type PatientDocument,
  type PatientFull,
} from "../../lib/patients";

export const Route = createFileRoute("/_org/patients/$patientId")({
  component: PatientDetailPage,
});

type Section =
  | "resumen"
  | "filiacion"
  | "antecedentes"
  | "anamnesis"
  | "evoluciones"
  | "odontograma"
  | "documentos";

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "resumen", label: "Resumen" },
  { id: "filiacion", label: "Filiación" },
  { id: "antecedentes", label: "Antecedentes" },
  { id: "anamnesis", label: "Anamnesis" },
  { id: "evoluciones", label: "Evoluciones" },
  { id: "odontograma", label: "Odontograma" },
  { id: "documentos", label: "Documentos" },
];

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const inputCls = "rounded-md border bg-background px-2 py-1.5 text-sm";
const sectionCls = "flex flex-col gap-3 rounded-lg border p-4";
const labelCls = "text-xs font-medium text-muted-foreground";
function strField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function PatientDetailPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { patientId } = Route.useParams();
  const [section, setSection] = useState<Section>("resumen");

  const detailQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  });

  const invalidatePatient = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patients"] });
  };

  const detail = detailQuery.data?.data;
  if (detailQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>;
  }
  if (!detail) {
    return <EmptyState title="No encontrado" description="El paciente ya no existe." />;
  }

  const allergies = detail.activeAllergies;
  const conditions = detail.activeConditions;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={detail.displayName}
        subtitle={`${ageFrom(detail.patient.birthDate)} · Registrado ${timeAgo(detail.patient.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge>{hcLabel(detail.patient.patientNumber)}</Badge>
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/patients" })}>
              <ArrowLeft className="size-4" /> Pacientes
            </Button>
          </div>
        }
      />
      {(allergies.length > 0 || conditions.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {allergies.map((a) => (
            <Chip key={a.id} variant="danger">
              Alergia: {a.substance}
            </Chip>
          ))}
          {conditions.map((c) => (
            <Chip key={c.id} variant="danger">
              {c.name}
            </Chip>
          ))}
        </div>
      )}

      <nav className="flex flex-wrap gap-2" aria-label="Secciones de la ficha">
        {SECTIONS.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={section === s.id ? "default" : "outline"}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </nav>

      {section === "resumen" && <ResumenSection patientId={patientId} detail={detail} />}
      {section === "filiacion" && <FiliacionSection patientId={patientId} detail={detail} onSaved={invalidatePatient} />}
      {section === "antecedentes" && <AntecedentesSection patientId={patientId} />}
      {section === "anamnesis" && <AnamnesisSection patientId={patientId} />}
      {section === "evoluciones" && <EvolucionesSection patientId={patientId} />}
      {section === "odontograma" && <OdontogramaSection patientId={patientId} />}
      {section === "documentos" && <DocumentosSection patientId={patientId} />}
    </div>
  );
}

/* ---------------- Resumen ---------------- */

function ResumenSection({ patientId, detail }: { patientId: string; detail: PatientFull }) {
  const latestQuery = useQuery({
    queryKey: ["patient-anamnesis", patientId],
    queryFn: () =>
      apiFetch<{ data: { version: number; createdAt: string } }>(`/api/patients/${patientId}/anamnesis`),
    retry: false,
  });
  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
  });
  const notesQuery = useQuery({
    queryKey: ["patient-notes", patientId],
    queryFn: () => apiFetch<{ data: ClinicalNote[] }>(`/api/patients/${patientId}/notes?limit=5`),
  });
  const notes: ClinicalNote[] = notesQuery.data?.data ?? [];
  const alerts = [...detail.activeAllergies.map((a) => `Alergia: ${a.substance} (${a.severity})`), ...detail.activeConditions.map((c) => c.name)];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className={`${sectionCls} border-destructive/40`}>
        <h2 className="text-sm font-semibold text-destructive">Alertas médicas</h2>
        {alerts.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin alertas médicas registradas.</p>
        )}
        {alerts.map((a) => (
          <p key={a} className="text-sm font-medium text-destructive">
            {a}
          </p>
        ))}
        {detail.currentMedications.length > 0 && (
          <div className="mt-1">
            <p className={labelCls}>Medicación actual</p>
            {detail.currentMedications.map((m) => (
              <p key={m.id} className="text-sm">
                {m.name}
                {m.dose && <span className="text-muted-foreground"> · {m.dose}</span>}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Última anamnesis</h2>
        {latestQuery.isError ? (
          <p className="text-sm text-muted-foreground">Sin anamnesis.</p>
        ) : latestQuery.data ? (
          <p className="text-sm">
            Versión {latestQuery.data.data.version} · {timeAgo(latestQuery.data.data.createdAt)}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        )}
        <h2 className="mt-2 text-sm font-semibold">Documentos</h2>
        <p className="text-sm text-muted-foreground">
          {docsQuery.data ? `${docsQuery.data.data.length} documento(s)` : "Cargando…"}
        </p>
      </section>

      <section className={`${sectionCls} md:col-span-2`}>
        <h2 className="text-sm font-semibold">Últimas evoluciones</h2>
        {notes.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin notas clínicas.</p>
        )}
        {notes.map((n) => (
          <div key={n.id} className="flex flex-col gap-1 border-b py-2 last:border-0">
            <p className="text-sm">{n.note}</p>
            <p className="text-xs text-muted-foreground">
              {timeAgo(n.createdAt)}
              {n.diagnosisCode && (
                <>
                  {" · "} <Badge>{n.diagnosisCode}</Badge>
                </>
              )}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}

/* ---------------- Filiación ---------------- */

function FiliacionSection({
  patientId,
  detail,
  onSaved,
}: {
  patientId: string;
  detail: PatientFull;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const patchMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      onSaved();
    },
  });

  const p = detail.patient;
  const consentGiven = p.dataConsentAt != null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Datos de filiación</h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const str = (k: string) => {
              const v = String(form.get(k) ?? "").trim();
              return v === "" ? null : v;
            };
            void patchMutation.mutate({
              docType: str("docType"),
              docNumber: str("docNumber"),
              birthDate: str("birthDate"),
              sex: str("sex"),
              maritalStatus: str("maritalStatus"),
              educationLevel: str("educationLevel"),
              occupation: str("occupation"),
              address: str("address"),
              origin: str("origin"),
              emergencyContactName: str("emergencyContactName"),
              emergencyContactPhone: str("emergencyContactPhone"),
              insuranceType: str("insuranceType"),
              insuranceDetail: str("insuranceDetail"),
              referralSource: str("referralSource"),
              isActive: form.get("isActive") === "on",
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Tipo de documento</FieldLabel>
              <select name="docType" aria-label="Tipo de documento" className={inputCls} defaultValue={p.docType ?? ""} key={`dt:${p.docType ?? ""}`}>
                <option value="">—</option>
                {["DNI", "CE", "PASAPORTE", "OTRO"].map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel>Número de documento</FieldLabel>
              <Input name="docNumber" defaultValue={p.docNumber ?? ""} key={`dn:${p.docNumber ?? ""}`} maxLength={20} />
            </Field>
            <Field>
              <FieldLabel>Fecha de nacimiento</FieldLabel>
              <Input type="date" name="birthDate" defaultValue={p.birthDate ?? ""} key={`bd:${p.birthDate ?? ""}`} />
            </Field>
            <Field>
              <FieldLabel>Sexo</FieldLabel>
              <select name="sex" aria-label="Sexo" className={inputCls} defaultValue={p.sex ?? ""} key={`sx:${p.sex ?? ""}`}>
                <option value="">—</option>
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
              </select>
            </Field>
            <Field>
              <FieldLabel>Estado civil</FieldLabel>
              <Input name="maritalStatus" defaultValue={strField(p.maritalStatus)} key={`ms:${strField(p.maritalStatus)}`} />
            </Field>
            <Field>
              <FieldLabel>Grado de instrucción</FieldLabel>
              <Input name="educationLevel" defaultValue={strField(p.educationLevel)} key={`el:${strField(p.educationLevel)}`} />
            </Field>
            <Field>
              <FieldLabel>Ocupación</FieldLabel>
              <Input name="occupation" defaultValue={strField(p.occupation)} key={`oc:${strField(p.occupation)}`} />
            </Field>
            <Field>
              <FieldLabel>Procedencia</FieldLabel>
              <Input name="origin" defaultValue={strField(p.origin)} key={`or:${strField(p.origin)}`} />
            </Field>
          </div>
          <Field>
            <FieldLabel>Domicilio</FieldLabel>
            <Input name="address" defaultValue={strField(p.address)} key={`ad:${strField(p.address)}`} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Contacto de emergencia</FieldLabel>
              <Input name="emergencyContactName" defaultValue={strField(p.emergencyContactName)} key={`ecn:${strField(p.emergencyContactName)}`} />
            </Field>
            <Field>
              <FieldLabel>Teléfono de emergencia</FieldLabel>
              <Input name="emergencyContactPhone" defaultValue={strField(p.emergencyContactPhone)} key={`ecp:${strField(p.emergencyContactPhone)}`} />
            </Field>
            <Field>
              <FieldLabel>Seguro</FieldLabel>
              <select name="insuranceType" aria-label="Seguro" className={inputCls} defaultValue={strField(p.insuranceType)} key={`it:${strField(p.insuranceType)}`}>
                <option value="">—</option>
                {["PARTICULAR", "SIS", "ESSALUD", "EPS", "OTRO"].map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel>Detalle del seguro</FieldLabel>
              <Input name="insuranceDetail" defaultValue={strField(p.insuranceDetail)} key={`id:${strField(p.insuranceDetail)}`} />
            </Field>
          </div>
          <Field>
            <FieldLabel>Referido por</FieldLabel>
            <Input name="referralSource" defaultValue={strField(p.referralSource)} key={`rs:${strField(p.referralSource)}`} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={p.isActive} key={`ac:${String(p.isActive)}`} />
            Paciente activo
          </label>
          <SubmitButton pending={patchMutation.isPending}>Guardar filiación</SubmitButton>
        </form>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Consentimiento de datos</h2>
        {consentGiven ? (
          <p className="text-sm text-muted-foreground">
            Consentimiento registrado el {timeAgo(p.dataConsentAt ?? null)}. No puede retirarse desde este formulario.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void patchMutation.mutate(
                { dataConsent: true },
                { onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient", patientId] }) },
              );
            }}
          >
            <p className="text-sm text-muted-foreground">
              Datos de salud sensibles (Ley 29733): se requiere consentimiento expreso del paciente o tutor.
            </p>
            <div className="mt-3">
              <SubmitButton pending={patchMutation.isPending}>Registrar consentimiento</SubmitButton>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

/* ---------------- Antecedentes ---------------- */

function AntecedentesSection({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patient-conditions", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patient-medications", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
  };

  const allergiesQuery = useQuery({
    queryKey: ["patient-allergies", patientId],
    queryFn: () => apiFetch<{ data: Allergy[] }>(`/api/patients/${patientId}/allergies`),
  });
  const conditionsQuery = useQuery({
    queryKey: ["patient-conditions", patientId],
    queryFn: () => apiFetch<{ data: Condition[] }>(`/api/patients/${patientId}/conditions`),
  });
  const medicationsQuery = useQuery({
    queryKey: ["patient-medications", patientId],
    queryFn: () => apiFetch<{ data: Medication[] }>(`/api/patients/${patientId}/medications`),
  });

  const [deactivating, setDeactivating] = useState<Allergy | null>(null);
  const [resolving, setResolving] = useState<Condition | null>(null);
  const [discontinuing, setDiscontinuing] = useState<Medication | null>(null);

  const addAllergy = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}/allergies`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
  const setAllergy = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch(`/api/patients/${patientId}/allergies/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => {
      setDeactivating(null);
      invalidate();
    },
  });
  const addCondition = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}/conditions`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
  const setCondition = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/api/patients/${patientId}/conditions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      setResolving(null);
      invalidate();
    },
  });
  const addMedication = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}/medications`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
  const discontinueMedication = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/patients/${patientId}/medications/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ endDate: new Date().toISOString().slice(0, 10) }),
      }),
    onSuccess: () => {
      setDiscontinuing(null);
      invalidate();
    },
  });

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Alergias</h2>
        {(allergiesQuery.data?.data ?? []).map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
            <span>
              {a.isActive ? <Chip variant="danger">{a.substance}</Chip> : <span className="text-muted-foreground line-through">{a.substance}</span>}
              <span className="text-muted-foreground"> · {a.severity}</span>
              {a.reaction && <span className="text-muted-foreground"> · {a.reaction}</span>}
            </span>
            {a.isActive && (
              <Button size="sm" variant="outline" onClick={() => setDeactivating(a)}>
                Desactivar
              </Button>
            )}
          </div>
        ))}
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const substance = String(form.get("substance") ?? "").trim();
            if (!substance) return;
            void addAllergy.mutate({
              substance,
              reaction: String(form.get("reaction") ?? "").trim() || undefined,
              severity: String(form.get("severity") ?? "moderada"),
            });
            e.currentTarget.reset();
          }}
        >
          <Input name="substance" placeholder="Sustancia (p. ej. Penicilina)" maxLength={200} />
          <Input name="reaction" placeholder="Reacción (opcional)" />
          <select name="severity" aria-label="Severidad" className={inputCls} defaultValue="moderada">
            <option value="leve">Leve</option>
            <option value="moderada">Moderada</option>
            <option value="severa">Severa</option>
          </select>
          <SubmitButton pending={addAllergy.isPending}>Agregar alergia</SubmitButton>
        </form>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Condiciones</h2>
        {(conditionsQuery.data?.data ?? []).map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
            <span>
              {c.status === "activa" ? <Chip variant="danger">{c.name}</Chip> : <span className="text-muted-foreground">{c.name}</span>}
              <span className="text-muted-foreground"> · {c.status}</span>
            </span>
            {c.status === "activa" && (
              <Button size="sm" variant="outline" onClick={() => setResolving(c)}>
                Resolver
              </Button>
            )}
          </div>
        ))}
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const name = String(form.get("name") ?? "").trim();
            if (!name) return;
            void addCondition.mutate({ name, notes: String(form.get("notes") ?? "").trim() || undefined });
            e.currentTarget.reset();
          }}
        >
          <Input name="name" placeholder="Condición (p. ej. Diabetes tipo 2)" />
          <Input name="notes" placeholder="Notas (opcional)" />
          <SubmitButton pending={addCondition.isPending}>Agregar condición</SubmitButton>
        </form>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Medicamentos</h2>
        {(medicationsQuery.data?.data ?? []).map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
            <span>
              {m.name}
              {m.dose && <span className="text-muted-foreground"> · {m.dose}</span>}
              {m.frequency && <span className="text-muted-foreground"> · {m.frequency}</span>}
              {m.endDate && <span className="text-muted-foreground"> · suspendido</span>}
            </span>
            {!m.endDate && (
              <Button size="sm" variant="outline" onClick={() => setDiscontinuing(m)}>
                Suspender
              </Button>
            )}
          </div>
        ))}
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const name = String(form.get("name") ?? "").trim();
            if (!name) return;
            void addMedication.mutate({
              name,
              dose: String(form.get("dose") ?? "").trim() || undefined,
              frequency: String(form.get("frequency") ?? "").trim() || undefined,
            });
            e.currentTarget.reset();
          }}
        >
          <Input name="name" placeholder="Medicamento" />
          <Input name="dose" placeholder="Dosis (opcional)" />
          <Input name="frequency" placeholder="Frecuencia (opcional)" />
          <SubmitButton pending={addMedication.isPending}>Agregar medicamento</SubmitButton>
        </form>
      </section>

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={() => deactivating && setAllergy.mutate({ id: deactivating.id, isActive: false })}
        title={`Desactivar alergia a ${deactivating?.substance ?? ""}`}
        description="Quedará registrada como inactiva en el historial. Esta acción no se puede deshacer desde aquí."
        confirmLabel="Desactivar"
        variant="default"
        pending={setAllergy.isPending}
      />
      <ConfirmDialog
        open={resolving !== null}
        onClose={() => setResolving(null)}
        onConfirm={() => resolving && setCondition.mutate({ id: resolving.id, status: "resuelta" })}
        title={`Marcar resuelta: ${resolving?.name ?? ""}`}
        description="La condición pasará a estado resuelta con fecha de hoy. Quedará en el historial."
        confirmLabel="Marcar resuelta"
        variant="default"
        pending={setCondition.isPending}
      />
      <ConfirmDialog
        open={discontinuing !== null}
        onClose={() => setDiscontinuing(null)}
        onConfirm={() => discontinuing && discontinueMedication.mutate(discontinuing.id)}
        title={`Suspender ${discontinuing?.name ?? ""}`}
        description="Se registrará la fecha de suspensión de hoy. El registro se conserva en el historial."
        confirmLabel="Suspender"
        variant="default"
        pending={discontinueMedication.isPending}
      />
    </div>
  );
}

/* ---------------- Anamnesis ---------------- */

interface AnamnesisVersion {
  id: string;
  version: number;
  createdAt: string;
}

function strOf(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function nestedStr(answers: AnamnesisAnswers, group: string, key: string): string {
  const g = (answers as Record<string, unknown>)[group];
  if (typeof g !== "object" || g === null) return "";
  return strOf(g as Record<string, unknown>, key);
}

function AnamnesisSection({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const latestQuery = useQuery({
    queryKey: ["patient-anamnesis", patientId],
    queryFn: () =>
      apiFetch<{ data: { version: number; createdAt: string; answers: AnamnesisAnswers } }>(
        `/api/patients/${patientId}/anamnesis`,
      ),
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: ["patient-anamnesis-history", patientId],
    queryFn: () => apiFetch<{ data: AnamnesisVersion[] }>(`/api/patients/${patientId}/anamnesis/history`),
  });
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const viewingQuery = useQuery({
    queryKey: ["patient-anamnesis-version", patientId, viewingId],
    queryFn: () =>
      apiFetch<{ data: { version: number; createdAt: string; answers: AnamnesisAnswers } }>(
        `/api/patients/${patientId}/anamnesis/${viewingId}`,
      ),
    enabled: viewingId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: (answers: AnamnesisAnswers) =>
      apiFetch(`/api/patients/${patientId}/anamnesis`, {
        method: "POST",
        body: JSON.stringify({ answers }),
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["patient-anamnesis", patientId] });
      void queryClient.invalidateQueries({ queryKey: ["patient-anamnesis-history", patientId] });
    },
  });

  const latest = latestQuery.data?.data ?? null;
  const shown = viewingQuery.data?.data ?? latest;

  if (latestQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  if (!latest || editing) {
    const base = (latest?.answers ?? {}) as Record<string, unknown>;
    return (
      <div className="flex flex-col gap-4">
        <section className={sectionCls}>
          <h2 className="text-sm font-semibold">
            {latest ? `Nueva versión (actual: v${latest.version})` : "Primera anamnesis"}
          </h2>
          <AnamnesisForm
            key={latest ? `v${latest.version}` : "nueva"}
            base={base}
            pending={saveMutation.isPending}
            onCancel={latest ? () => setEditing(false) : undefined}
            onSubmit={(answers) => saveMutation.mutate(answers)}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className={sectionCls}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Anamnesis v{shown?.version} · {shown ? timeAgo(shown.createdAt) : ""}
          </h2>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Nueva versión
          </Button>
        </div>
        {shown && <AnswersView answers={shown.answers} />}
      </section>
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Historial de versiones</h2>
        {(historyQuery.data?.data ?? []).map((v) => (
          <div key={v.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
            <span>
              Versión {v.version} · <span className="text-muted-foreground">{timeAgo(v.createdAt)}</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => setViewingId(v.id)}>
              Ver
            </Button>
          </div>
        ))}
        {(historyQuery.data?.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">Sin versiones.</p>
        )}
      </section>
    </div>
  );
}

function AnswersView({ answers }: { answers: AnamnesisAnswers }) {
  const rec = answers as Record<string, unknown>;
  const entries = Object.entries(rec);
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">Sin respuestas.</p>;
  return (
    <dl className="flex flex-col gap-2">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className={labelCls}>{k}</dt>
          <dd className="text-sm whitespace-pre-wrap">
            {typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AnamnesisForm({
  base,
  pending,
  onCancel,
  onSubmit,
}: {
  base: Record<string, unknown>;
  pending: boolean;
  onCancel?: () => void;
  onSubmit: (answers: AnamnesisAnswers) => void;
}) {
  const answers = base as unknown as AnamnesisAnswers;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const s = (k: string) => {
          const v = String(form.get(k) ?? "").trim();
          return v === "" ? undefined : v;
        };
        const num = (k: string) => {
          const v = String(form.get(k) ?? "").trim();
          if (v === "") return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const habitos = String(form.get("od_habitos") ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 10);
        const cie10 = String(form.get("diagnosticoCie10") ?? "")
          .split(",")
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 10);
        onSubmit({
          motivoConsulta: s("motivoConsulta"),
          tiempoEnfermedad: s("tiempoEnfermedad"),
          antecedentesPersonales: {
            enfermedades: s("ap_enfermedades"),
            hospitalizaciones: s("ap_hospitalizaciones"),
            cirugias: s("ap_cirugias"),
            transfusiones: s("ap_transfusiones"),
            embarazo: form.get("ap_embarazo") === "on" ? true : undefined,
            semanasEmbarazo: num("ap_semanas"),
            medicacionHabitual: s("ap_medicacion"),
          },
          antecedentesFamiliares: s("antecedentesFamiliares"),
          antecedentesOdontologicos: {
            ultimaVisita: s("od_ultimaVisita"),
            experienciaPrevia: s("od_experienciaPrevia"),
            ansiedadDental: s("od_ansiedad"),
            cepilladosAlDia: num("od_cepillados"),
            hiloDental: form.get("od_hilo") === "on" ? true : undefined,
            bruxismo: form.get("od_bruxismo") === "on" ? true : undefined,
            habitos: habitos.length > 0 ? habitos : undefined,
          },
          examenClinico: {
            extraoral: s("ex_extraoral"),
            intraoral: s("ex_intraoral"),
            higieneOral: s("ex_higiene"),
          },
          diagnosticoPresuntivo: s("diagnosticoPresuntivo"),
          diagnosticoCie10: cie10.length > 0 ? cie10 : undefined,
          observaciones: s("observaciones"),
        } as unknown as AnamnesisAnswers);
      }}
    >
      <details open className="flex flex-col gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Motivo de consulta</summary>
        <Field>
          <FieldLabel>Motivo de consulta</FieldLabel>
          <textarea name="motivoConsulta" aria-label="Motivo de consulta" rows={2} className={inputCls} defaultValue={strOf(base, "motivoConsulta")} />
        </Field>
        <Field>
          <FieldLabel>Tiempo de enfermedad</FieldLabel>
          <Input name="tiempoEnfermedad" defaultValue={strOf(base, "tiempoEnfermedad")} />
        </Field>
      </details>

      <details className="flex flex-col gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Antecedentes personales</summary>
        <Field>
          <FieldLabel>Enfermedades</FieldLabel>
          <textarea name="ap_enfermedades" aria-label="Enfermedades" rows={2} className={inputCls} defaultValue={nestedStr(answers, "antecedentesPersonales", "enfermedades")} />
        </Field>
        <Field>
          <FieldLabel>Hospitalizaciones</FieldLabel>
          <Input name="ap_hospitalizaciones" defaultValue={nestedStr(answers, "antecedentesPersonales", "hospitalizaciones")} />
        </Field>
        <Field>
          <FieldLabel>Cirugías</FieldLabel>
          <Input name="ap_cirugias" defaultValue={nestedStr(answers, "antecedentesPersonales", "cirugias")} />
        </Field>
        <Field>
          <FieldLabel>Transfusiones</FieldLabel>
          <Input name="ap_transfusiones" defaultValue={nestedStr(answers, "antecedentesPersonales", "transfusiones")} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="ap_embarazo" /> Embarazo
        </label>
        <Field>
          <FieldLabel>Semanas de embarazo (0–42)</FieldLabel>
          <Input type="number" name="ap_semanas" min={0} max={42} defaultValue={nestedStr(answers, "antecedentesPersonales", "semanasEmbarazo")} />
        </Field>
        <Field>
          <FieldLabel>Medicación habitual</FieldLabel>
          <Input name="ap_medicacion" defaultValue={nestedStr(answers, "antecedentesPersonales", "medicacionHabitual")} />
        </Field>
      </details>

      <details className="flex flex-col gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Antecedentes familiares</summary>
        <Field>
          <FieldLabel>Antecedentes familiares</FieldLabel>
          <textarea name="antecedentesFamiliares" aria-label="Antecedentes familiares" rows={2} className={inputCls} defaultValue={strOf(base, "antecedentesFamiliares")} />
        </Field>
      </details>

      <details className="flex flex-col gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Antecedentes odontológicos</summary>
        <Field>
          <FieldLabel>Última visita</FieldLabel>
          <Input name="od_ultimaVisita" defaultValue={nestedStr(answers, "antecedentesOdontologicos", "ultimaVisita")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Experiencia previa</FieldLabel>
            <select name="od_experienciaPrevia" aria-label="Experiencia previa" className={inputCls} defaultValue={nestedStr(answers, "antecedentesOdontologicos", "experienciaPrevia")}>
              <option value="">—</option>
              <option value="positiva">Positiva</option>
              <option value="regular">Regular</option>
              <option value="traumatica">Traumática</option>
            </select>
          </Field>
          <Field>
            <FieldLabel>Ansiedad dental</FieldLabel>
            <select name="od_ansiedad" aria-label="Ansiedad dental" className={inputCls} defaultValue={nestedStr(answers, "antecedentesOdontologicos", "ansiedadDental")}>
              <option value="">—</option>
              <option value="ninguna">Ninguna</option>
              <option value="leve">Leve</option>
              <option value="moderada">Moderada</option>
              <option value="alta">Alta</option>
            </select>
          </Field>
        </div>
        <Field>
          <FieldLabel>Cepillados al día (0–10)</FieldLabel>
          <Input type="number" name="od_cepillados" min={0} max={10} defaultValue={nestedStr(answers, "antecedentesOdontologicos", "cepilladosAlDia")} />
        </Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="od_hilo" /> Hilo dental
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="od_bruxismo" /> Bruxismo
          </label>
        </div>
        <Field>
          <FieldLabel>Hábitos (separados por coma, máx. 10)</FieldLabel>
          <Input name="od_habitos" placeholder="tabaquismo, onicofagia" />
        </Field>
      </details>

      <details className="flex flex-col gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Examen clínico</summary>
        <Field>
          <FieldLabel>Extraoral</FieldLabel>
          <textarea name="ex_extraoral" aria-label="Examen extraoral" rows={2} className={inputCls} defaultValue={nestedStr(answers, "examenClinico", "extraoral")} />
        </Field>
        <Field>
          <FieldLabel>Intraoral</FieldLabel>
          <textarea name="ex_intraoral" aria-label="Examen intraoral" rows={2} className={inputCls} defaultValue={nestedStr(answers, "examenClinico", "intraoral")} />
        </Field>
        <Field>
          <FieldLabel>Higiene oral</FieldLabel>
          <select name="ex_higiene" aria-label="Higiene oral" className={inputCls} defaultValue={nestedStr(answers, "examenClinico", "higieneOral")}>
            <option value="">—</option>
            <option value="buena">Buena</option>
            <option value="regular">Regular</option>
            <option value="mala">Mala</option>
          </select>
        </Field>
      </details>

      <details open className="flex flex-col gap-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Diagnóstico y observaciones</summary>
        <Field>
          <FieldLabel>Diagnóstico presuntivo</FieldLabel>
          <textarea name="diagnosticoPresuntivo" aria-label="Diagnóstico presuntivo" rows={2} className={inputCls} defaultValue={strOf(base, "diagnosticoPresuntivo")} />
        </Field>
        <Field>
          <FieldLabel>Códigos CIE-10 (separados por coma, máx. 10)</FieldLabel>
          <Input name="diagnosticoCie10" placeholder="K02.1, K04.0" />
        </Field>
        <Field>
          <FieldLabel>Observaciones</FieldLabel>
          <textarea name="observaciones" aria-label="Observaciones" rows={2} className={inputCls} defaultValue={strOf(base, "observaciones")} />
        </Field>
      </details>

      <div className="flex gap-2">
        <SubmitButton pending={pending}>Guardar anamnesis</SubmitButton>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}

/* ---------------- Evoluciones ---------------- */

interface Cie10Row {
  code: string;
  description: string;
}

function EvolucionesSection({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const [cieQuery, setCieQuery] = useState("");
  const [cieCode, setCieCode] = useState<string | null>(null);
  const debouncedCie = useDebounced(cieQuery, 300);

  const notesQuery = useQuery({
    queryKey: ["patient-notes", patientId],
    queryFn: () => apiFetch<{ data: ClinicalNote[] }>(`/api/patients/${patientId}/notes`),
  });
  const cieResults = useQuery({
    queryKey: ["cie10", debouncedCie],
    queryFn: () => apiFetch<{ data: Cie10Row[] }>(`/api/cie10?q=${encodeURIComponent(debouncedCie)}`),
    enabled: debouncedCie.trim().length >= 1,
  });

  const addNote = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}/notes`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCieQuery("");
      setCieCode(null);
      void queryClient.invalidateQueries({ queryKey: ["patient-notes", patientId] });
    },
  });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Nueva evolución</h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const note = String(form.get("note") ?? "").trim();
            if (!note) return;
            void addNote.mutate(cieCode ? { note, diagnosisCode: cieCode } : { note });
            e.currentTarget.reset();
          }}
        >
          <Field>
            <FieldLabel>Nota clínica</FieldLabel>
            <textarea name="note" aria-label="Nota clínica" rows={4} className={inputCls} maxLength={4000} required />
          </Field>
          <Field>
            <FieldLabel>Diagnóstico CIE-10 {cieCode && <Badge>{cieCode}</Badge>}</FieldLabel>
            <Input
              placeholder="Buscar código o descripción…"
              value={cieQuery}
              onChange={(e) => {
                setCieQuery(e.target.value);
              }}
            />
            {debouncedCie.trim().length >= 1 && (
              <div className="max-h-60 overflow-auto rounded-md border p-1">
                {(cieResults.data?.data ?? []).map((r: Cie10Row) => (
                  <button
                    key={r.code}
                    type="button"
                    className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setCieCode(r.code);
                      setCieQuery(`${r.code} · ${r.description}`);
                    }}
                  >
                    <span className="font-medium">{r.code}</span>
                    <span className="text-xs text-muted-foreground">{r.description}</span>
                  </button>
                ))}
                {(cieResults.data?.data ?? []).length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">Sin resultados.</p>
                )}
              </div>
            )}
            {cieCode && (
              <Button type="button" size="sm" variant="outline" onClick={() => { setCieCode(null); setCieQuery(""); }}>
                Quitar código
              </Button>
            )}
          </Field>
          <SubmitButton pending={addNote.isPending}>Guardar evolución</SubmitButton>
        </form>
        <p className="text-xs text-muted-foreground">
          Las evoluciones son inmutables: no se pueden editar ni eliminar. Para corregir, registra una nueva nota.
        </p>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Historial</h2>
        {(notesQuery.data?.data ?? []).map((n) => (
          <div key={n.id} className="flex flex-col gap-1 border-b py-2 last:border-0">
            <p className="text-sm whitespace-pre-wrap">{n.note}</p>
            <p className="text-xs text-muted-foreground">
              {timeAgo(n.createdAt)}
              {n.diagnosisCode && (
                <>
                  {" · "} <Badge>{n.diagnosisCode}</Badge>
                </>
              )}
            </p>
          </div>
        ))}
        {(notesQuery.data?.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">Sin notas clínicas.</p>
        )}
      </section>
    </div>
  );
}

/* ---------------- Odontograma ---------------- */

function OdontogramaSection({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const odontoQuery = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () =>
      apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
  });

  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] });
  };

  const history = odontoQuery.data?.data.history ?? [];

  return (
    <div className="flex flex-col gap-4">
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Carta odontológica (FDI)</h2>
        {odontoQuery.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {odontoQuery.data && (
          <OdontogramChart
            patientId={patientId}
            state={{
              teeth: odontoQuery.data.data.teeth,
              history: odontoQuery.data.data.history.map((e) => ({
                ...e,
                surface: e.surface ?? null,
                note: e.note ?? null,
              })),
            }}
            onChanged={refetch}
          />
        )}
      </section>
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Historial de entradas</h2>
        {history.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin entradas registradas.</p>
        )}
        {history.map((e) => (
          <div key={e.id} className="flex flex-col gap-0.5 border-b py-1.5 text-sm last:border-0">
            <p className={e.status === "anulado" ? "text-muted-foreground line-through" : ""}>
              Pieza {e.toothNumber}
              {e.surface && ` · ${e.surface}`} · {e.condition} · {e.status}
              {e.diagnosisCode && (
                <>
                  {" · "} <Badge>{e.diagnosisCode}</Badge>
                </>
              )}
            </p>
            {e.note && (
              <p className={`text-xs text-muted-foreground ${e.status === "anulado" ? "line-through" : ""}`}>
                {e.note}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{timeAgo(e.createdAt ?? null)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

/* ---------------- Documentos ---------------- */

const DOC_CATEGORIES = ["consentimiento", "radiografia", "foto_clinica", "informe", "otro"] as const;

function DocumentosSection({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
  });

  const openDocument = async (documentId: string) => {
    const res = await apiFetch<{ data: { url: string } }>(
      `/api/patients/${patientId}/documents/${documentId}/url`,
    );
    window.open(res.data.url, "_blank", "noopener");
  };

  const onUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setUploadError(null);
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setUploadError("Selecciona un archivo.");
      return;
    }
    setUploading(true);
    try {
      const slug =
        typeof window === "undefined" ? null : orgSlugFromHostname(window.location.hostname);
      const response = await fetch(`${API_URL}/api/patients/${patientId}/documents`, {
        method: "POST",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body: form,
      });
      if (!response.ok) {
        let message = `Error ${response.status}`;
        try {
          const body = (await response.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          // cuerpo no-JSON
        }
        throw new Error(message);
      }
      e.currentTarget.reset();
      void queryClient.invalidateQueries({ queryKey: ["patient-documents", patientId] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "No se pudo subir el documento.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Subir documento</h2>
        <form className="flex flex-col gap-3" onSubmit={(e) => void onUpload(e)}>
          <Field>
            <FieldLabel>Archivo (PDF o imagen, máx. 10 MB)</FieldLabel>
            <input
              type="file"
              name="file"
              aria-label="Archivo"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="text-sm"
            />
          </Field>
          <Field>
            <FieldLabel>Categoría</FieldLabel>
            <select name="category" aria-label="Categoría" className={inputCls} defaultValue="otro">
              {DOC_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel>Etiqueta</FieldLabel>
            <Input name="label" placeholder="p. ej. Consentimiento informado" required />
          </Field>
          {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
          <SubmitButton pending={uploading}>Subir</SubmitButton>
        </form>
        <p className="text-xs text-muted-foreground">
          Los documentos se conservan como parte de la historia clínica: no se pueden eliminar.
        </p>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Archivos</h2>
        {(docsQuery.data?.data ?? []).map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2 border-b py-2 last:border-0">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{d.label}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge>{d.category}</Badge>
                {(d.sizeBytes / 1024).toFixed(0)} KB · {timeAgo(d.createdAt)}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => void openDocument(d.id)}>
              Ver
            </Button>
          </div>
        ))}
        {(docsQuery.data?.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">Sin documentos.</p>
        )}
      </section>
    </div>
  );
}
