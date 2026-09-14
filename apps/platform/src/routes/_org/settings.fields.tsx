import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormDrawer,
  NewButton,
  PageHeader,
  fieldErrorMessages,
} from "@odentia/ui-patterns";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { apiFetch } from "../../lib/api";
import { useCanWrite, type FieldDef } from "../../lib/crm";

export const Route = createFileRoute("/_org/settings/fields")({
  component: FieldsPage,
});

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "minúsculas, números y _ (máx 40)"),
  label: z.string().min(1, "Ingresa el label"),
  type: z.enum(["text", "number", "date", "select"]),
  options: z.string(),
});

type FieldFormValues = z.infer<typeof fieldSchema>;

function FieldsPage() {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleting, setDeleting] = useState<FieldDef | null>(null);

  const listQuery = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["fields"] });

  const saveMutation = useMutation({
    mutationFn: async (values: FieldFormValues) => {
      await apiFetch("/api/fields", {
        method: "POST",
        body: JSON.stringify({
          key: values.key,
          label: values.label,
          type: values.type,
          options: values.type === "select" ? values.options.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        }),
      });
    },
    onSuccess: () => {
      setDrawerOpen(false);
      form.reset();
      void invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/fields/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null);
      void invalidate();
    },
  });

  const form = useForm({
    defaultValues: { key: "", label: "", type: "text" as FieldFormValues["type"], options: "" },
    validators: { onSubmit: fieldSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  });

  const columns = useMemo<ColumnDef<FieldDef>[]>(
    () => [
      { accessorKey: "key", header: "Clave" },
      { accessorKey: "label", header: "Label" },
      { accessorKey: "type", header: "Tipo" },
      {
        id: "options",
        header: "Opciones",
        cell: ({ row }) => row.original.options?.join(", ") ?? "—",
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button variant="ghost" size="icon" aria-label="Eliminar" onClick={() => setDeleting(row.original)}>
            <Trash2 className="size-4" />
          </Button>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: listQuery.data?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (!canWrite) {
    return <EmptyState title="Sin acceso" description="Solo owner/admin pueden definir campos." />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Campos personalizados"
        subtitle="Datos extra de contactos (validados por tipo)"
        actions={<NewButton label="Nuevo campo" onClick={() => setDrawerOpen(true)} />}
      />
      {listQuery.data?.data.length === 0 && !listQuery.isLoading ? (
        <EmptyState title="Sin campos" description="Define el primero, p.ej. alergias o sede preferida." />
      ) : (
        <DataTable table={table} />
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nuevo campo"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={saveMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="key">
            {(field) => (
              <Field>
                <FieldLabel>Clave (a-z, 0-9, _)</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="label">
            {(field) => (
              <Field>
                <FieldLabel>Label</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="type">
            {(field) => (
              <Field>
                <FieldLabel>Tipo</FieldLabel>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value as FieldFormValues["type"])}
                >
                  <option value="text">Texto</option>
                  <option value="number">Número</option>
                  <option value="date">Fecha</option>
                  <option value="select">Opciones</option>
                </select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="options">
            {(field) => (
              <Field>
                <FieldLabel>Opciones separadas por coma (solo select)</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="norte, sur"
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Eliminar ${deleting?.label ?? ""}`}
        description="Los valores ya guardados quedan intactos pero se ocultan."
        confirmLabel="Eliminar"
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
      />
    </div>
  );
}
