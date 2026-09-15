import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui";
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns";
import { useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import type { Allergy, Condition, Medication } from "../../lib/patients";

const SEVERITY_ITEMS = { leve: "Leve", moderada: "Moderada", severa: "Severa" } as const;

type Severity = keyof typeof SEVERITY_ITEMS;

function errorText(error: unknown): string | null {
  if (error instanceof ApiError) {
    const shape = error.shape as { message?: unknown; code?: unknown };
    if (typeof shape.message === "string" && shape.message !== "") return shape.message;
    if (typeof shape.code === "string" && shape.code !== "") return `Error: ${shape.code}`;
    return `Error ${error.status}`;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return null;
}

/** Antecedentes médicos (alergias, condiciones y medicamentos) con su CRUD completo. */
export function AntecedentesCards({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

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

  const [severity, setSeverity] = useState<Severity>("moderada");
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
      <Card>
        <CardHeader>
          <CardTitle>Alergias</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {allergiesQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(allergiesQuery.error) ?? "No se pudieron cargar las alergias."}
            </p>
          )}
          {(allergiesQuery.data?.data ?? []).map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0"
            >
              <span>
                {a.isActive ? (
                  <Badge variant="destructive">{a.substance}</Badge>
                ) : (
                  <span className="text-muted-foreground line-through">{a.substance}</span>
                )}
                <span className="text-muted-foreground"> · {a.severity}</span>
                {a.reaction && <span className="text-muted-foreground"> · {a.reaction}</span>}
              </span>
              {a.isActive && canWrite && (
                <Button size="sm" variant="outline" onClick={() => setDeactivating(a)}>
                  Desactivar
                </Button>
              )}
            </div>
          ))}
          {canWrite && (
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (addAllergy.isPending) return;
                const form = new FormData(e.currentTarget);
                const substance = String(form.get("substance") ?? "").trim();
                if (!substance) return;
                void addAllergy.mutate({
                  substance,
                  reaction: String(form.get("reaction") ?? "").trim() || undefined,
                  severity,
                });
                e.currentTarget.reset();
              }}
            >
              <Field>
                <FieldLabel htmlFor={`alergia-sustancia-${patientId}`}>Sustancia</FieldLabel>
                <Input
                  id={`alergia-sustancia-${patientId}`}
                  name="substance"
                  placeholder="Sustancia (p. ej. Penicilina)"
                  maxLength={200}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`alergia-reaccion-${patientId}`}>Reacción (opcional)</FieldLabel>
                <Input id={`alergia-reaccion-${patientId}`} name="reaction" placeholder="Reacción (opcional)" />
              </Field>
              <Field>
                <FieldLabel htmlFor={`alergia-severidad-${patientId}`}>Severidad</FieldLabel>
                <Select value={severity} items={SEVERITY_ITEMS} onValueChange={(v) => setSeverity((v as Severity) ?? "moderada")}>
                  <SelectTrigger id={`alergia-severidad-${patientId}`} aria-label="Severidad">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SEVERITY_ITEMS) as Severity[]).map((o) => (
                      <SelectItem key={o} value={o}>
                        {SEVERITY_ITEMS[o]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {addAllergy.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {errorText(addAllergy.error) ?? "No se pudo agregar la alergia."}
                </p>
              )}
              <SubmitButton type="submit" pending={addAllergy.isPending}>Agregar alergia</SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Condiciones</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {conditionsQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(conditionsQuery.error) ?? "No se pudieron cargar las condiciones."}
            </p>
          )}
          {(conditionsQuery.data?.data ?? []).map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0"
            >
              <span>
                {c.status === "activa" ? (
                  <Badge variant="destructive">{c.name}</Badge>
                ) : (
                  <span className="text-muted-foreground">{c.name}</span>
                )}
                <span className="text-muted-foreground"> · {c.status}</span>
              </span>
              {c.status === "activa" && canWrite && (
                <Button size="sm" variant="outline" onClick={() => setResolving(c)}>
                  Resolver
                </Button>
              )}
            </div>
          ))}
          {canWrite && (
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (addCondition.isPending) return;
                const form = new FormData(e.currentTarget);
                const name = String(form.get("name") ?? "").trim();
                if (!name) return;
                void addCondition.mutate({
                  name,
                  notes: String(form.get("notes") ?? "").trim() || undefined,
                });
                e.currentTarget.reset();
              }}
            >
              <Field>
                <FieldLabel htmlFor={`condicion-nombre-${patientId}`}>Condición</FieldLabel>
                <Input
                  id={`condicion-nombre-${patientId}`}
                  name="name"
                  placeholder="Condición (p. ej. Diabetes tipo 2)"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`condicion-notas-${patientId}`}>Notas (opcional)</FieldLabel>
                <Input id={`condicion-notas-${patientId}`} name="notes" placeholder="Notas (opcional)" />
              </Field>
              {addCondition.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {errorText(addCondition.error) ?? "No se pudo agregar la condición."}
                </p>
              )}
              <SubmitButton type="submit" pending={addCondition.isPending}>Agregar condición</SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Medicamentos</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {medicationsQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(medicationsQuery.error) ?? "No se pudieron cargar los medicamentos."}
            </p>
          )}
          {(medicationsQuery.data?.data ?? []).map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0"
            >
              <span>
                {m.name}
                {m.dose && <span className="text-muted-foreground"> · {m.dose}</span>}
                {m.frequency && <span className="text-muted-foreground"> · {m.frequency}</span>}
                {m.endDate && <span className="text-muted-foreground"> · suspendido</span>}
              </span>
              {!m.endDate && canWrite && (
                <Button size="sm" variant="outline" onClick={() => setDiscontinuing(m)}>
                  Suspender
                </Button>
              )}
            </div>
          ))}
          {canWrite && (
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (addMedication.isPending) return;
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
              <Field>
                <FieldLabel htmlFor={`medicamento-nombre-${patientId}`}>Medicamento</FieldLabel>
                <Input id={`medicamento-nombre-${patientId}`} name="name" placeholder="Medicamento" />
              </Field>
              <Field>
                <FieldLabel htmlFor={`medicamento-dosis-${patientId}`}>Dosis (opcional)</FieldLabel>
                <Input id={`medicamento-dosis-${patientId}`} name="dose" placeholder="Dosis (opcional)" />
              </Field>
              <Field>
                <FieldLabel htmlFor={`medicamento-frecuencia-${patientId}`}>Frecuencia (opcional)</FieldLabel>
                <Input
                  id={`medicamento-frecuencia-${patientId}`}
                  name="frequency"
                  placeholder="Frecuencia (opcional)"
                />
              </Field>
              {addMedication.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {errorText(addMedication.error) ?? "No se pudo agregar el medicamento."}
                </p>
              )}
              <SubmitButton type="submit" pending={addMedication.isPending}>Agregar medicamento</SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>

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
