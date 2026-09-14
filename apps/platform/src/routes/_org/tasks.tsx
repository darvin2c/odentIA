import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import {
  Chip,
  DataTable,
  EmptyState,
  FormDrawer,
  NewButton,
  PageHeader,
  SubmitButton,
  fieldErrorMessages,
} from "@odentia/ui-patterns";
import { useMemo, useState } from "react";
import { z } from "zod";
import { apiFetch } from "../../lib/api";
import { type TaskItem } from "../../lib/crm";
import { useOrgEvents } from "../../lib/org-events";
import { getRouteApi } from "@tanstack/react-router";

export const Route = createFileRoute("/_org/tasks")({
  component: TasksPage,
});

const orgRouteApi = getRouteApi("/_org");

const taskSchema = z.object({
  title: z.string().min(1, "Ingresa el título"),
  dueAt: z.string(),
  assigneeUserId: z.string(),
});

type TaskFormValues = z.infer<typeof taskSchema>;

const emptyValues: TaskFormValues = { title: "", dueAt: "", assigneeUserId: "" };

function TasksPage() {
  const queryClient = useQueryClient();
  const { org } = orgRouteApi.useRouteContext();
  const [status, setStatus] = useState("open");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const tasksQuery = useQuery({
    queryKey: ["tasks", status],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=${status}`),
  });

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tasks"] });

  const toggleMutation = useMutation({
    mutationFn: (task: TaskItem) =>
      apiFetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: task.status === "done" ? "open" : "done" }),
      }),
    onSuccess: () => void invalidate(),
  });

  const saveMutation = useMutation({
    mutationFn: async (values: TaskFormValues) => {
      await apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: values.title,
          dueAt: values.dueAt || undefined,
          assigneeUserId: values.assigneeUserId || null,
        }),
      });
    },
    onSuccess: () => {
      setDrawerOpen(false);
      form.reset();
      void invalidate();
    },
  });

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: taskSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  });

  const columns = useMemo<ColumnDef<TaskItem>[]>(
    () => [
      { accessorKey: "title", header: "Título" },
      {
        id: "assignee",
        header: "Asignado",
        cell: ({ row }) => {
          const member = org.members.find((m) => m.userId === row.original.assigneeUserId);
          return member ? member.user.name : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        accessorKey: "dueAt",
        header: "Vence",
        cell: ({ row }) =>
          row.original.dueAt
            ? new Date(row.original.dueAt).toLocaleDateString("es-PE", { day: "numeric", month: "short" })
            : "—",
      },
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Chip variant={row.original.status === "done" ? "success" : "neutral"}>{row.original.status}</Chip>
        ),
      },
      {
        accessorKey: "createdBy",
        header: "Origen",
        cell: ({ row }) => (row.original.createdBy === "agent" ? <Chip>Agente</Chip> : "Operador"),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button
            variant="outline"
            size="sm"
            disabled={toggleMutation.isPending}
            onClick={() => toggleMutation.mutate(row.original)}
          >
            {row.original.status === "done" ? "Reabrir" : "Completar"}
          </Button>
        ),
      },
    ],
    [org.members, toggleMutation],
  );

  const table = useReactTable({
    data: tasksQuery.data?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tareas"
        subtitle="Seguimientos creados por operadores y el agente"
        actions={
          <>
            <select
              aria-label="Estado"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="open">Abiertas</option>
              <option value="done">Hechas</option>
              <option value="cancelled">Canceladas</option>
            </select>
            <NewButton label="Nueva tarea" onClick={() => setDrawerOpen(true)} />
          </>
        }
      />
      {tasksQuery.data?.data.length === 0 && !tasksQuery.isLoading ? (
        <EmptyState title="Sin tareas" description="Crea la primera con el botón Nueva tarea." />
      ) : (
        <DataTable table={table} />
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nueva tarea"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={saveMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="title">
            {(field) => (
              <Field>
                <FieldLabel>Título</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Llamar al paciente"
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="dueAt">
            {(field) => (
              <Field>
                <FieldLabel>Vence (opcional)</FieldLabel>
                <Input type="date" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="assigneeUserId">
            {(field) => (
              <Field>
                <FieldLabel>Asignado (opcional)</FieldLabel>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">Sin asignar</option>
                  {org.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>
    </div>
  );
}
