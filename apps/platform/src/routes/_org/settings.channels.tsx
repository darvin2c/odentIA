import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import {
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  PageHeader,
  RowActions,
  fieldErrorMessages,
  useListSearch,
} from "@odentia/ui-patterns";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { MessageCircle, Plus, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite, type ConnectionItem } from "../../lib/crm";

export const Route = createFileRoute("/_org/settings/channels")({
  component: ChannelsPage,
});

const telegramSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  botToken: z.string().min(1, "Ingresa el bot token"),
});

const whatsappSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  phoneNumberId: z.string().min(1, "Requerido"),
  wabaId: z.string().min(1, "Requerido"),
  accessToken: z.string().min(1, "Requerido"),
  appSecret: z.string().min(1, "Requerido"),
  templates: z.string(),
});

function ChannelsPage() {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [provider, setProvider] = useState<"telegram_bot_api" | "whatsapp_cloud_api">("telegram_bot_api");
  const [created, setCreated] = useState<{ webhookUrl: string; webhookSecret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["connections"] });

  const actionMutation = useMutation({
    mutationFn: (path: string) => apiFetch(`/api/channels/connections/${path}`, { method: "POST" }),
    onSuccess: () => void invalidate(),
    onError: (e) => setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación"),
  });

  const tgForm = useForm({
    defaultValues: { displayName: "", botToken: "" },
    validators: { onSubmit: telegramSchema },
    onSubmit: ({ value }) => createConnection("telegram", "telegram_bot_api", value.displayName, { botToken: value.botToken }),
  });

  const waForm = useForm({
    defaultValues: { displayName: "", phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "", templates: "" },
    validators: { onSubmit: whatsappSchema },
    onSubmit: ({ value }) =>
      createConnection("whatsapp", "whatsapp_cloud_api", value.displayName, {
        phoneNumberId: value.phoneNumberId,
        wabaId: value.wabaId,
        accessToken: value.accessToken,
        appSecret: value.appSecret,
        templates: value.templates
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, language] = line.split(":").map((s) => s.trim());
            return { name: name ?? "", language: language ?? "es_PE" };
          }),
      }),
  });

  async function createConnection(channel: string, providerId: string, displayName: string, config: Record<string, unknown>) {
    setError(null);
    try {
      const res = await apiFetch<{ data: { webhookUrl: string; webhookSecret: string } }>("/api/channels/connections", {
        method: "POST",
        body: JSON.stringify({ channel, provider: providerId, displayName, config }),
      });
      setCreated(res.data);
      setDrawerOpen(false);
      tgForm.reset();
      waForm.reset();
      void invalidate();
    } catch (e) {
      setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo crear") : "No se pudo crear");
    }
  }

  if (!canWrite) {
    return <EmptyState title="Sin acceso" description="Solo owner/admin pueden gestionar conexiones." />;
  }

  const listSearch = useListSearch();
  const search = listSearch.get("q") ?? "";
  const canalFilter = listSearch.get("canal");
  const estadoFilter = listSearch.get("estado");
  const sort = listSearch.get("sort");

  const items = listQuery.data?.data ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = items.filter((conn) => {
      if (canalFilter && conn.channel !== canalFilter) return false;
      if (estadoFilter && conn.status !== estadoFilter) return false;
      if (needle && !`${conn.displayName} ${conn.externalId ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const field = (sort ?? "").replace(/^-/, "");
    const desc = (sort ?? "").startsWith("-");
    const compare = (a: ConnectionItem, b: ConnectionItem) => {
      if (field === "estado") return a.status.localeCompare(b.status);
      return a.displayName.localeCompare(b.displayName);
    };
    return [...rows].sort((a, b) => (desc ? -compare(a, b) : compare(a, b)));
  }, [items, search, canalFilter, estadoFilter, sort]);

  const columns = useMemo<ColumnDef<ConnectionItem>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: "Conexión",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            {row.original.channel === "whatsapp" ? (
              <MessageCircle className="size-4 shrink-0 text-green-600" aria-hidden />
            ) : (
              <Send className="size-4 shrink-0 text-sky-600" aria-hidden />
            )}
            <span className="flex flex-col">
              <span className="font-medium">{row.original.displayName}</span>
              {row.original.externalId && (
                <span className="text-xs text-muted-foreground">{row.original.externalId}</span>
              )}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "channel",
        header: "Canal",
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.channel === "whatsapp" ? "WhatsApp" : "Telegram"}</Badge>
        ),
      },
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.status === "active" ? "success" : "secondary"}>
            {row.original.status === "active" ? "Activa" : "Inactiva"}
          </Badge>
        ),
      },
      {
        id: "capabilities",
        header: "Capacidades",
        cell: ({ row }) => {
          const badges = [
            row.original.capabilities?.templates ? "plantillas" : null,
            row.original.capabilities?.media ? "media" : null,
          ].filter((b): b is string => b !== null);
          if (badges.length === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="flex flex-wrap gap-1">
              {badges.map((b) => (
                <Badge key={b} variant="secondary">
                  {b}
                </Badge>
              ))}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const conn = row.original;
          return (
            <RowActions
              label={`Acciones de ${conn.displayName}`}
              items={[
                {
                  key: "test",
                  label: "Probar",
                  onSelect: () => actionMutation.mutate(`${conn.id}/test`),
                },
                conn.status === "active"
                  ? {
                      key: "disable",
                      label: "Desactivar",
                      tone: "danger" as const,
                      onSelect: () => actionMutation.mutate(`${conn.id}/disable`),
                    }
                  : {
                      key: "enable",
                      label: "Activar",
                      onSelect: () => actionMutation.mutate(`${conn.id}/enable`),
                    },
              ]}
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const hasCriteria = search.trim() !== "" || Boolean(canalFilter) || Boolean(estadoFilter);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Canales"
        subtitle="Conexiones de WhatsApp y Telegram"
        actions={
          <Button
            type="button"
            className="min-h-11"
            onClick={() => { setCreated(null); setDrawerOpen(true); }}
          >
            <Plus aria-hidden />
            Nueva conexión
          </Button>
        }
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      {created && (
        <div className="flex flex-col gap-1 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
          <p className="font-semibold">Conexión creada. Pega estos valores en Meta/Telegram:</p>
          <p className="break-all">Webhook: {created.webhookUrl}</p>
          <p className="break-all">Verify token: {created.webhookSecret}</p>
        </div>
      )}
      <FilterBar
        filters={[
          {
            key: "canal",
            label: "Canal",
            type: "select",
            options: [
              { value: "whatsapp", label: "WhatsApp" },
              { value: "telegram", label: "Telegram" },
            ],
          },
          {
            key: "estado",
            label: "Estado",
            type: "select",
            options: [
              { value: "active", label: "Activa" },
              { value: "inactive", label: "Inactiva" },
            ],
          },
        ]}
        sortOptions={[
          { value: "nombre", label: "Nombre" },
          { value: "estado", label: "Estado" },
        ]}
        searchPlaceholder="Buscar conexión"
      />
      {items.length === 0 && !listQuery.isLoading ? (
        <EmptyState title="Sin conexiones" description="Conecta un bot de Telegram o un número de WhatsApp." />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Sin resultados"
          description={
            hasCriteria
              ? "Ninguna conexión coincide con los criterios de búsqueda."
              : "Todavía no hay conexiones para mostrar."
          }
        />
      ) : (
        <DataTable table={table} />
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nueva conexión"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        onSubmit={(event) => {
          event.preventDefault();
          if (provider === "telegram_bot_api") void tgForm.handleSubmit();
          else void waForm.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Canal</FieldLabel>
            <select
              aria-label="Proveedor"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
            >
              <option value="telegram_bot_api">Telegram (BotFather)</option>
              <option value="whatsapp_cloud_api">WhatsApp (Cloud API)</option>
            </select>
          </Field>
          {provider === "telegram_bot_api" ? (
            <>
              <tgForm.Field name="displayName">
                {(field) => (
                  <Field>
                    <FieldLabel>Nombre</FieldLabel>
                    <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                    <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                  </Field>
                )}
              </tgForm.Field>
              <tgForm.Field name="botToken">
                {(field) => (
                  <Field>
                    <FieldLabel>Bot token</FieldLabel>
                    <Input
                      type="password"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                    <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                  </Field>
                )}
              </tgForm.Field>
            </>
          ) : (
            <>
              <waForm.Field name="displayName">
                {(field) => (
                  <Field>
                    <FieldLabel>Nombre</FieldLabel>
                    <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                    <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                  </Field>
                )}
              </waForm.Field>
              {(["phoneNumberId", "wabaId", "accessToken", "appSecret"] as const).map((name) => (
                <waForm.Field key={name} name={name}>
                  {(field) => (
                    <Field>
                      <FieldLabel>{name}</FieldLabel>
                      <Input
                        type="password"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                      <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                    </Field>
                  )}
                </waForm.Field>
              ))}
              <waForm.Field name="templates">
                {(field) => (
                  <Field>
                    <FieldLabel>Plantillas (una por línea: nombre:idioma)</FieldLabel>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="cita_recordatorio:es_PE"
                    />
                    <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                  </Field>
                )}
              </waForm.Field>
            </>
          )}
        </div>
      </FormDrawer>
    </div>
  );
}
