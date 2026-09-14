import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import {
  Chip,
  ConfirmDialog,
  EmptyState,
  FormDrawer,
  NewButton,
  PageHeader,
  fieldErrorMessages,
} from "@odentia/ui-patterns";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite, type Pipeline, type Stage } from "../../lib/crm";

export const Route = createFileRoute("/_org/settings/pipelines")({
  component: PipelinesPage,
});

const stageSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre"),
  kind: z.enum(["open", "won", "lost"]),
});

function PipelinesPage() {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Stage | null>(null);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  });

  const pipelines = listQuery.data?.data ?? [];
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0] ?? null;
  const stages = pipeline?.stages ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["pipelines"] });

  const fail = (e: unknown) => {
    setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación");
  };

  const createMutation = useMutation({
    mutationFn: (values: { name: string; kind: string }) =>
      apiFetch(`/api/pipelines/${pipeline?.id}/stages`, { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => {
      setDrawerOpen(false);
      form.reset();
      void invalidate();
    },
    onError: fail,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiFetch(`/api/pipelines/stages/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setEditing(null);
      void invalidate();
    },
    onError: fail,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/pipelines/stages/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null);
      void invalidate();
    },
    onError: (e) => {
      setDeleting(null);
      fail(e);
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (stageIds: string[]) =>
      apiFetch(`/api/pipelines/${pipeline?.id}/reorder`, { method: "POST", body: JSON.stringify({ stageIds }) }),
    onSuccess: () => void invalidate(),
    onError: fail,
  });

  const form = useForm({
    defaultValues: { name: "", kind: "open" as "open" | "won" | "lost" },
    validators: { onSubmit: stageSchema },
    onSubmit: ({ value }) => createMutation.mutate(value),
  });

  function move(index: number, delta: -1 | 1) {
    if (!pipeline) return;
    const ids = stages.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const current = ids[index];
    if (current === undefined) return;
    ids.splice(index, 1);
    ids.splice(target, 0, current);
    reorderMutation.mutate(ids);
  }

  if (!canWrite) {
    return <EmptyState title="Sin acceso" description="Solo owner/admin pueden editar pipelines." />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pipelines"
        subtitle="Etapas del kanban de ventas"
        actions={
          pipelines.length > 1 ? (
            <select
              aria-label="Pipeline"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={pipeline?.id ?? ""}
              onChange={(e) => setPipelineId(e.target.value)}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-col gap-2">
        {stages.map((stage, i) => (
          <div key={stage.id} className="flex items-center gap-2 rounded-lg border p-2.5">
            {editing?.id === stage.id ? (
              <>
                <Input
                  defaultValue={stage.name}
                  aria-label="Nombre de etapa"
                  id={`stage-${stage.id}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const input = e.currentTarget;
                      if (input.value.trim()) updateMutation.mutate({ id: stage.id, patch: { name: input.value.trim() } });
                    }
                  }}
                />
                <select
                  aria-label="Tipo"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  defaultValue={stage.kind}
                  onChange={(e) => updateMutation.mutate({ id: stage.id, patch: { kind: e.target.value } })}
                >
                  <option value="open">Abierta</option>
                  <option value="won">Ganada</option>
                  <option value="lost">Perdida</option>
                </select>
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  Listo
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm font-medium">{stage.name}</span>
                <Chip variant={stage.kind === "won" ? "success" : stage.kind === "lost" ? "danger" : "neutral"}>
                  {stage.kind}
                </Chip>
              </>
            )}
            <Button variant="ghost" size="icon" aria-label="Subir" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Bajar"
              disabled={i === stages.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Renombrar" onClick={() => setEditing(stage)}>
              <Pencil className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Eliminar" onClick={() => setDeleting(stage)}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div>
        <NewButton label="Nueva etapa" onClick={() => setDrawerOpen(true)} />
      </div>
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nueva etapa"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={createMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="name">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="kind">
            {(field) => (
              <Field>
                <FieldLabel>Tipo</FieldLabel>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value as "open" | "won" | "lost")}
                >
                  <option value="open">Abierta</option>
                  <option value="won">Ganada</option>
                  <option value="lost">Perdida</option>
                </select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Eliminar ${deleting?.name ?? ""}`}
        description="Solo si ningún contacto la usa."
        confirmLabel="Eliminar"
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
      />
    </div>
  );
}
