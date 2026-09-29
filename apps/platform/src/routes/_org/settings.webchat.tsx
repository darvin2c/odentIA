import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { EmptyState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { Copy, ExternalLink, MessageCircle, Plus } from "lucide-react"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/webchat")({
  component: WebchatSettingsPage,
})

const orgRouteApi = getRouteApi("/_org")

interface WebchatConfig {
  allowedOrigins: string[]
  widgetTitle?: string
  widgetColor?: string
  greeting?: string
  notifyUrl?: string
}

interface WebchatConnection {
  id: string
  displayName: string
  externalId: string | null
  status: string
  createdAt: string
  updatedAt: string
  config: WebchatConfig
}

interface ConnectionForm {
  displayName: string
  allowedOrigins: string
  widgetTitle: string
  widgetColor: string
  greeting: string
  notifyUrl: string
}

const EMPTY_FORM: ConnectionForm = {
  displayName: "",
  allowedOrigins: "",
  widgetTitle: "",
  widgetColor: "#0f766e",
  greeting: "",
  notifyUrl: "",
}

function formOf(item: WebchatConnection): ConnectionForm {
  return {
    displayName: item.displayName,
    allowedOrigins: item.config.allowedOrigins.join("\n"),
    widgetTitle: item.config.widgetTitle ?? "",
    widgetColor: item.config.widgetColor ?? "#0f766e",
    greeting: item.config.greeting ?? "",
    notifyUrl: item.config.notifyUrl ?? "",
  }
}

function payloadOf(form: ConnectionForm): Record<string, unknown> {
  const origins = form.allowedOrigins
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean)
  return {
    displayName: form.displayName.trim(),
    allowedOrigins: origins,
    ...(form.widgetTitle.trim() ? { widgetTitle: form.widgetTitle.trim() } : {}),
    ...(form.widgetColor.trim() ? { widgetColor: form.widgetColor.trim() } : {}),
    ...(form.greeting.trim() ? { greeting: form.greeting.trim() } : {}),
    ...(form.notifyUrl.trim() ? { notifyUrl: form.notifyUrl.trim() } : {}),
  }
}

/** Snippet flotante: burbuja + panel con el widget (sin archivos externos). */
function floatingSnippet(widgetUrl: string, title: string, color: string): string {
  return `<script>
(function () {
  var d = document, btn = d.createElement("button"), panel = d.createElement("div");
  btn.textContent = "💬";
  btn.setAttribute("aria-label", ${JSON.stringify(title)});
  btn.style.cssText = "position:fixed;right:20px;bottom:20px;width:56px;height:56px;border:0;border-radius:50%;background:${color};color:#fff;font-size:24px;cursor:pointer;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.25)";
  panel.style.cssText = "position:fixed;right:20px;bottom:88px;width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 120px);display:none;z-index:2147483647;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.25)";
  var frame = d.createElement("iframe");
  frame.src = ${JSON.stringify(widgetUrl)};
  frame.title = ${JSON.stringify(title)};
  frame.style.cssText = "border:0;width:100%;height:100%";
  panel.appendChild(frame);
  btn.onclick = function () { panel.style.display = panel.style.display === "none" ? "block" : "none"; };
  d.body.appendChild(panel);
  d.body.appendChild(btn);
})();
</script>`
}

function iframeSnippet(widgetUrl: string, title: string): string {
  return `<iframe src="${widgetUrl}" title="${title.replaceAll('"', "")}" style="border:0;width:380px;height:560px;max-width:100%" allow="clipboard-write"></iframe>`
}

function WebchatSettingsPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const [drawer, setDrawer] = useState<{ mode: "create" } | { mode: "edit"; item: WebchatConnection } | null>(null)
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [snippetId, setSnippetId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const listQuery = useQuery({
    queryKey: ["webchat-connections", org.slug],
    queryFn: () => apiFetch<{ data: WebchatConnection[] }>("/api/channels/webchat"),
    enabled: canRead,
    retry: false,
  })
  const items = listQuery.data?.data ?? []
  const snippetItem = items.find((i) => i.id === snippetId) ?? null

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError(null)
    setDrawer({ mode: "create" })
  }

  function openEdit(item: WebchatConnection) {
    setForm(formOf(item))
    setFormError(null)
    setDrawer({ mode: "edit", item })
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = payloadOf(form)
      if (drawer?.mode === "edit") {
        const { displayName, ...rest } = payload
        return apiFetch<{ data: WebchatConnection }>(`/api/channels/webchat/${drawer.item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ displayName, ...rest }),
        })
      }
      return apiFetch<{ data: WebchatConnection }>("/api/channels/webchat", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      setDrawer(null)
      void queryClient.invalidateQueries({ queryKey: ["webchat-connections", org.slug] })
    },
    onError: (e) => {
      setFormError(e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar") : "No se pudo guardar")
    },
  })

  const statusMutation = useMutation({
    mutationFn: async ({ id, enable }: { id: string; enable: boolean }) =>
      apiFetch<{ data: WebchatConnection }>(`/api/channels/webchat/${id}/${enable ? "enable" : "disable"}`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webchat-connections", org.slug] })
    },
  })

  const rotateMutation = useMutation({
    mutationFn: async (id: string) =>
      apiFetch<{ data: WebchatConnection }>(`/api/channels/webchat/${id}/rotate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webchat-connections", org.slug] })
    },
  })

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Chat web" subtitle="Widget embebible propio" />
        <EmptyState
          title="Sin permiso"
          description="Necesitas permiso de configuración para ver el chat web."
        />
      </div>
    )
  }
  const widgetUrl = snippetItem ? `${window.location.origin}/embed/${snippetItem.id}` : ""
  const snippetTitle = snippetItem?.config.widgetTitle ?? snippetItem?.displayName ?? "Chat"
  const snippetColor = snippetItem?.config.widgetColor ?? "#0f766e"

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Chat web"
        subtitle="Widget embebible propio: mismos mensajes y bandeja que el resto de canales"
        actions={
          canWrite ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" /> Nueva conexión
            </Button>
          ) : undefined
        }
      />

      {listQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando conexiones…</p>
      ) : listQuery.isError ? (
        <EmptyState
          title="No pudimos cargar el chat web"
          description="Intenta nuevamente más tarde."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="Sin chat web"
          description="Crea una conexión con los orígenes permitidos de tu sitio y obtén el snippet para incrustarlo."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{item.displayName}</span>
                <Badge variant={item.status === "active" ? "default" : "secondary"}>
                  {item.status === "active" ? "Activo" : "Desactivado"}
                </Badge>
                <span className="ml-auto flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSnippetId(item.id)}>
                    Snippet
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(`/embed/${item.id}`, "_blank", "noopener")}
                  >
                    <ExternalLink className="size-3.5" /> Abrir widget
                  </Button>
                  {canWrite ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => openEdit(item)}>
                        Editar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={statusMutation.isPending}
                        onClick={() =>
                          statusMutation.mutate({ id: item.id, enable: item.status !== "active" })
                        }
                      >
                        {item.status === "active" ? "Desactivar" : "Activar"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rotateMutation.isPending}
                        onClick={() => rotateMutation.mutate(item.id)}
                        title="Revoca todas las sesiones de visitante activas"
                      >
                        Rotar secreto
                      </Button>
                    </>
                  ) : null}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Orígenes: {item.config.allowedOrigins.join(", ")}
              </p>
              {item.config.greeting ? (
                <p className="mt-1 text-sm text-muted-foreground">Saludo: {item.config.greeting}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {snippetItem ? (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="font-medium">Snippet de {snippetItem.displayName}</h2>
          <p className="text-sm text-muted-foreground">
            Pega el flotante en tu sitio (recomendado) o el iframe donde quieras mostrarlo. Solo los
            orígenes permitidos pueden iniciar sesiones.
          </p>
          <h3 className="text-sm font-medium">Flotante</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {floatingSnippet(widgetUrl, snippetTitle, snippetColor)}
          </pre>
          <h3 className="text-sm font-medium">Iframe</h3>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {iframeSnippet(widgetUrl, snippetTitle)}
          </pre>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(floatingSnippet(widgetUrl, snippetTitle, snippetColor))
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
              }}
            >
              <Copy className="size-3.5" /> {copied ? "Copiado" : "Copiar flotante"}
            </Button>
          </div>
        </section>
      ) : null}

      <FormDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        title={drawer?.mode === "edit" ? "Editar chat web" : "Nueva conexión de chat web"}
        description="Orígenes https de tu sitio (uno por línea). Sin red externa: los mensajes viven en tu bandeja."
        onSubmit={(e) => {
          e.preventDefault()
          saveMutation.mutate()
        }}
        isSubmitting={saveMutation.isPending}
        error={formError}
        submitLabel={drawer?.mode === "edit" ? "Guardar" : "Crear"}
      >
        <Field>
          <FieldLabel htmlFor="webchat-name">Nombre</FieldLabel>
          <Input
            id="webchat-name"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            maxLength={120}
            placeholder="Chat del sitio principal"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="webchat-origins">Orígenes permitidos (uno por línea)</FieldLabel>
          <Textarea
            id="webchat-origins"
            value={form.allowedOrigins}
            onChange={(e) => setForm({ ...form, allowedOrigins: e.target.value })}
            rows={3}
            placeholder={"https://tu-sitio.test\nhttps://tienda.tu-sitio.test"}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="webchat-title">Título del widget</FieldLabel>
          <Input
            id="webchat-title"
            value={form.widgetTitle}
            onChange={(e) => setForm({ ...form, widgetTitle: e.target.value })}
            maxLength={80}
            placeholder="Clínica Sonrisa"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="webchat-color">Color del widget</FieldLabel>
          <Input
            id="webchat-color"
            type="color"
            value={form.widgetColor}
            onChange={(e) => setForm({ ...form, widgetColor: e.target.value })}
            className="h-10 w-20 p-1"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="webchat-greeting">Saludo inicial</FieldLabel>
          <Textarea
            id="webchat-greeting"
            value={form.greeting}
            onChange={(e) => setForm({ ...form, greeting: e.target.value })}
            rows={2}
            maxLength={500}
            placeholder="Hola, ¿en qué podemos ayudarte?"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="webchat-notify">Webhook del sitio (opcional, https)</FieldLabel>
          <Input
            id="webchat-notify"
            value={form.notifyUrl}
            onChange={(e) => setForm({ ...form, notifyUrl: e.target.value })}
            placeholder="https://tu-sitio.test/webchat/eventos"
          />
        </Field>
      </FormDrawer>
    </div>
  )
}
