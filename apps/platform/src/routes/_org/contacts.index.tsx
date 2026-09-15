import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import {
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  PageHeader,
  fieldErrorMessages,
  useListSearch,
} from "@odentia/ui-patterns";
import { MessageCircle, Plus, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { apiFetch } from "../../lib/api";
import { timeAgo, type ContactListItem, type Pipeline } from "../../lib/crm";
import { useOrgEvents } from "../../lib/org-events";

export const Route = createFileRoute("/_org/contacts/")({
  component: ContactsPage,
});

const orgRouteApi = getRouteApi("/_org");

const contactSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  notes: z.string(),
  tags: z.string(),
});

type ContactFormValues = z.infer<typeof contactSchema>;

const emptyValues: ContactFormValues = { displayName: "", notes: "", tags: "" };

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function ContactsPage() {
  const queryClient = useQueryClient();
  const { org } = orgRouteApi.useRouteContext();
  const listSearch = useListSearch();
  const search = useDebounced(listSearch.get("search") ?? "", 300);
  const stageId = listSearch.get("stageId") ?? undefined;

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  });
  const stages = useMemo(() => pipelinesQuery.data?.data.flatMap((p) => p.stages) ?? [], [pipelinesQuery.data]);
  const stageName = useMemo(() => new Map(stages.map((s) => [s.id, s.name])), [stages]);

  const contactsQuery = useQuery({
    queryKey: ["contacts", search, stageId],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (stageId) params.set("stageId", stageId);
      return apiFetch<{ data: ContactListItem[]; nextCursor: string | null }>(`/api/contacts?${params}`);
    },
  });

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
  });

  const [drawerOpen, setDrawerOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (values: ContactFormValues) => {
      await apiFetch("/api/contacts", {
        method: "POST",
        body: JSON.stringify({
          displayName: values.displayName,
          notes: values.notes || undefined,
          tags: values.tags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
    },
    onSuccess: () => {
      setDrawerOpen(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: contactSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  });

  const columns = useMemo<ColumnDef<ContactListItem>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: "Nombre",
        cell: ({ row }) => (
          <Link
            to="/contacts/$contactId"
            params={{ contactId: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.displayName}
          </Link>
        ),
      },
      {
        id: "channels",
        header: "Canales",
        cell: ({ row }) => (
          <span className="flex gap-1">
            {row.original.channels.includes("whatsapp") && <MessageCircle className="size-4 text-green-600" />}
            {row.original.channels.includes("telegram") && <Send className="size-4 text-sky-600" />}
          </span>
        ),
      },
      {
        id: "stage",
        header: "Etapa",
        cell: ({ row }) =>
          row.original.stageId ? <Badge variant="secondary">{stageName.get(row.original.stageId) ?? "—"}</Badge> : "—",
      },
      {
        accessorKey: "tags",
        header: "Etiquetas",
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.tags.map((t) => (
              <Badge variant="secondary" key={t}>{t}</Badge>
            ))}
          </span>
        ),
      },
      {
        accessorKey: "lastInteractionAt",
        header: "Última actividad",
        cell: ({ row }) => timeAgo(row.original.lastInteractionAt),
      },
      {
        id: "assignee",
        header: "Asignado",
        cell: ({ row }) => {
          const member = org.members.find((m) => m.userId === row.original.assignedUserId);
          return member ? member.user.name : <span className="text-muted-foreground">—</span>;
        },
      },
    ],
    [org.members, stageName],
  );

  const table = useReactTable({
    data: contactsQuery.data?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contactos"
        subtitle="Pacientes y conversaciones asociadas"
        actions={
          <Button
            type="button"
            className="min-h-11"
            onClick={() => setDrawerOpen(true)}
          >
            <Plus aria-hidden />
            Nuevo contacto
          </Button>
        }
      />
      <FilterBar
        filters={[
          {
            key: "stageId",
            label: "Etapa",
            type: "select",
            options: stages.map((s) => ({ value: s.id, label: s.name })),
          },
        ]}
        sortOptions={[]}
        searchPlaceholder="Buscar contacto"
      />
      {contactsQuery.data?.data.length === 0 && !contactsQuery.isLoading ? (
        <EmptyState title="Sin contactos" description="Crea el primero o espera un mensaje entrante." />
      ) : (
        <DataTable table={table} />
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nuevo contacto"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={saveMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="notes">
            {(field) => (
              <Field>
                <FieldLabel>Notas (opcional)</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="tags">
            {(field) => (
              <Field>
                <FieldLabel>Etiquetas separadas por coma (opcional)</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="ortodoncia, vip"
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>
    </div>
  );
}
