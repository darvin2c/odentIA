import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import { Chip, EmptyState, FormDrawer, NewButton, PageHeader, fieldErrorMessages } from "@odentia/ui-patterns";
import { MessageCircle, Send } from "lucide-react";
import { useState } from "react";
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

  const items = listQuery.data?.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Canales"
        subtitle="Conexiones de WhatsApp y Telegram"
        actions={<NewButton label="Nueva conexión" onClick={() => { setCreated(null); setDrawerOpen(true); }} />}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      {created && (
        <div className="flex flex-col gap-1 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
          <p className="font-semibold">Conexión creada. Pega estos valores en Meta/Telegram:</p>
          <p className="break-all">Webhook: {created.webhookUrl}</p>
          <p className="break-all">Verify token: {created.webhookSecret}</p>
        </div>
      )}
      {items.length === 0 && !listQuery.isLoading ? (
        <EmptyState title="Sin conexiones" description="Conecta un bot de Telegram o un número de WhatsApp." />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((conn) => (
            <div key={conn.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              {conn.channel === "whatsapp" ? (
                <MessageCircle className="size-4 text-green-600" />
              ) : (
                <Send className="size-4 text-sky-600" />
              )}
              <span className="text-sm font-medium">{conn.displayName}</span>
              {conn.externalId && <span className="text-xs text-muted-foreground">{conn.externalId}</span>}
              <Chip variant={conn.status === "active" ? "success" : "neutral"}>{conn.status}</Chip>
              {conn.capabilities?.templates && <Chip>plantillas</Chip>}
              {conn.capabilities?.media && <Chip>media</Chip>}
              <span className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => actionMutation.mutate(`${conn.id}/test`)}>
                Probar
              </Button>
              {conn.status === "active" ? (
                <Button variant="outline" size="sm" onClick={() => actionMutation.mutate(`${conn.id}/disable`)}>
                  Desactivar
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => actionMutation.mutate(`${conn.id}/enable`)}>
                  Activar
                </Button>
              )}
            </div>
          ))}
        </div>
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
