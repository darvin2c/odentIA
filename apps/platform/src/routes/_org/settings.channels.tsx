import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  MasterDetail,
  PageHeader,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { MessageCircle, Plus, Send } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import { PageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/channels")({
  component: ChannelsPage,
})

const telegramSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  botToken: z.string().min(1, "Ingresa el bot token"),
})

const whatsappSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  phoneNumberId: z.string().min(1, "Requerido"),
  wabaId: z.string().min(1, "Requerido"),
  accessToken: z.string().min(1, "Requerido"),
  appSecret: z.string().min(1, "Requerido"),
  templates: z.string(),
})

const messengerSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  pageId: z.string().min(1, "Requerido"),
  pageAccessToken: z.string().min(1, "Requerido"),
  appSecret: z.string().min(1, "Requerido"),
})

const instagramSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  instagramId: z.string().min(1, "Requerido"),
  accessToken: z.string().min(1, "Requerido"),
  appSecret: z.string().min(1, "Requerido"),
})

type ProviderId = "telegram_bot_api" | "whatsapp_cloud_api" | "messenger" | "instagram"

/** Proveedores ofrecidos al crear una conexión: etiqueta única para el select. */
const PROVIDERS: { value: ProviderId; label: string }[] = [
  { value: "telegram_bot_api", label: "Telegram (BotFather)" },
  { value: "whatsapp_cloud_api", label: "WhatsApp (Cloud API)" },
  { value: "messenger", label: "Messenger (página de Facebook)" },
  { value: "instagram", label: "Instagram (cuenta profesional)" },
]

/** Canal interno que cada proveedor exige (validado en el servicio). */
const PROVIDER_CHANNEL: Record<ProviderId, string> = {
  telegram_bot_api: "telegram",
  whatsapp_cloud_api: "whatsapp",
  messenger: "messenger",
  instagram: "instagram",
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
}
function ChannelsPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [provider, setProvider] = useState<ProviderId>("telegram_bot_api")
  const [created, setCreated] = useState<{ webhookUrl: string; webhookSecret: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["connections"] })

  const actionMutation = useMutation({
    mutationFn: (path: string) => apiFetch(`/api/channels/connections/${path}`, { method: "POST" }),
    onSuccess: () => void invalidate(),
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación",
      ),
  })

  const tgForm = useForm({
    defaultValues: { displayName: "", botToken: "" },
    validators: { onSubmit: telegramSchema },
    onSubmit: ({ value }) =>
      createConnection("telegram", "telegram_bot_api", value.displayName, {
        botToken: value.botToken,
      }),
  })

  const waForm = useForm({
    defaultValues: {
      displayName: "",
      phoneNumberId: "",
      wabaId: "",
      accessToken: "",
      appSecret: "",
      templates: "",
    },
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
            const [name, language] = line.split(":").map((s) => s.trim())
            return { name: name ?? "", language: language ?? "es_PE" }
          }),
      }),
  })

  const msgrForm = useForm({
    defaultValues: { displayName: "", pageId: "", pageAccessToken: "", appSecret: "" },
    validators: { onSubmit: messengerSchema },
    onSubmit: ({ value }) =>
      createConnection("messenger", "messenger", value.displayName, {
        pageId: value.pageId,
        pageAccessToken: value.pageAccessToken,
        appSecret: value.appSecret,
      }),
  })

  const igForm = useForm({
    defaultValues: { displayName: "", instagramId: "", accessToken: "", appSecret: "" },
    validators: { onSubmit: instagramSchema },
    onSubmit: ({ value }) =>
      createConnection("instagram", "instagram", value.displayName, {
        instagramId: value.instagramId,
        accessToken: value.accessToken,
        appSecret: value.appSecret,
      }),
  })

  // Cuatro formularios (uno por proveedor): el contenedor está sucio si
  // cualquiera tiene cambios sin guardar. Todas se llaman siempre:
  // encadenarlas con `||` las volvería condicionales.
  const tgDirty = useStore(tgForm.store, (state) => !state.isDefaultValue)
  const waDirty = useStore(waForm.store, (state) => !state.isDefaultValue)
  const msgrDirty = useStore(msgrForm.store, (state) => !state.isDefaultValue)
  const igDirty = useStore(igForm.store, (state) => !state.isDefaultValue)
  const isDirty = tgDirty || waDirty || msgrDirty || igDirty

  /** Cierra y deja los formularios prístinos: sin el reset, el dirty sobrevive
   *  al cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeForm() {
    setFormOpen(false)
    tgForm.reset()
    waForm.reset()
    msgrForm.reset()
    igForm.reset()
  }

  async function createConnection(
    channel: string,
    providerId: string,
    displayName: string,
    config: Record<string, unknown>,
  ) {
    setError(null)
    try {
      const res = await apiFetch<{ data: { webhookUrl: string; webhookSecret: string } }>(
        "/api/channels/connections",
        {
          method: "POST",
          body: JSON.stringify({ channel, provider: providerId, displayName, config }),
        },
      )
      setCreated(res.data)
      closeForm()
      void invalidate()
    } catch (e) {
      setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo crear") : "No se pudo crear")
    }
  }

  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const canalFilter = listSearch.get("canal")
  const estadoFilter = listSearch.get("estado")
  const sort = listSearch.get("sort")

  const items = listQuery.data?.data ?? []

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const rows = items.filter((conn) => {
      if (canalFilter && conn.channel !== canalFilter) return false
      if (estadoFilter && conn.status !== estadoFilter) return false
      if (needle && !`${conn.displayName} ${conn.externalId ?? ""}`.toLowerCase().includes(needle))
        return false
      return true
    })
    const field = (sort ?? "").replace(/^-/, "")
    const desc = (sort ?? "").startsWith("-")
    const compare = (a: ConnectionItem, b: ConnectionItem) => {
      if (field === "estado") return a.status.localeCompare(b.status)
      return a.displayName.localeCompare(b.displayName)
    }
    return [...rows].sort((a, b) => (desc ? -compare(a, b) : compare(a, b)))
  }, [items, search, canalFilter, estadoFilter, sort])

  const columns = useMemo<ColumnDef<ConnectionItem>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: "Conexión",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            {row.original.channel === "messenger" || row.original.channel === "instagram" ? (
              <MessageCircle className="size-4 shrink-0 text-primary" aria-hidden />
            ) : row.original.channel === "whatsapp" ? (
              <MessageCircle className="size-4 shrink-0 text-success" aria-hidden />
            ) : (
              <Send className="size-4 shrink-0 text-primary" aria-hidden />
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
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <Badge variant="secondary">{CHANNEL_LABEL[row.original.channel] ?? row.original.channel}</Badge>
        ),
      },
      {
        accessorKey: "status",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <Badge variant={row.original.status === "active" ? "success" : "secondary"}>
            {row.original.status === "active" ? "Activa" : "Inactiva"}
          </Badge>
        ),
      },
      {
        id: "capabilities",
        header: "Capacidades",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const badges = [
            row.original.capabilities?.templates ? "plantillas" : null,
            row.original.capabilities?.media ? "media" : null,
            row.original.capabilities?.readReceipts ? "lecturas" : null,
          ].filter((b): b is string => b !== null)
          if (badges.length === 0) return <span className="text-muted-foreground">—</span>
          return (
            <span className="flex flex-wrap gap-1">
              {badges.map((b) => (
                <Badge key={b} variant="secondary">
                  {b}
                </Badge>
              ))}
            </span>
          )
        },
      },
      {
        id: "actions",
        header: "",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          if (!canWrite) return null
          const conn = row.original
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
          )
        },
      },
    ],
    [canWrite],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canRead) {
    return (
      <EmptyState
        title="Sin acceso"
        description="Necesitas permiso de lectura de configuración para ver las conexiones."
      />
    )
  }

  const hasCriteria = search.trim() !== "" || Boolean(canalFilter) || Boolean(estadoFilter)

  const formFields = (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="proveedor-canal">Canal</FieldLabel>
        <Select
          value={provider}
          items={Object.fromEntries(PROVIDERS.map((p) => [p.value, p.label]))}
          onValueChange={(value) => setProvider(value as typeof provider)}
        >
          <SelectTrigger id="proveedor-canal">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {provider === "telegram_bot_api" ? (
        <>
          <tgForm.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
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
      ) : provider === "whatsapp_cloud_api" ? (
        <>
          <waForm.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
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
      ) : provider === "messenger" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Conecta la página de Facebook en Meta Developers (producto Messenger, permiso
            pages_messaging). Tras crear, pega la URL del webhook con el verify token y suscribe
            messages, messaging_postbacks, message_deliveries y message_reads. Sin página ni token
            válidos la creación falla: nunca se muestra como activa sin validar contra Meta.
          </p>
          <msgrForm.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </msgrForm.Field>
          {(["pageId", "pageAccessToken", "appSecret"] as const).map((name) => (
            <msgrForm.Field key={name} name={name}>
              {(field) => (
                <Field>
                  <FieldLabel>{name === "pageId" ? "ID de página" : name}</FieldLabel>
                  <Input
                    type={name === "pageId" ? "text" : "password"}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                </Field>
              )}
            </msgrForm.Field>
          ))}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Cuenta profesional con Instagram Login: pega el token de usuario de Instagram
            (permisos instagram_business_basic + instagram_business_manage_messages, sin OAuth
            completo: token manual). Tras crear, pega la URL del webhook con el verify token y
            suscribe messages, messaging_postbacks y messaging_seen. Texto máx. 1000 bytes;
            media imagen/audio/video/pdf. Sin cuenta ni token válidos la creación falla.
          </p>
          <igForm.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </igForm.Field>
          {(["instagramId", "accessToken", "appSecret"] as const).map((name) => (
            <igForm.Field key={name} name={name}>
              {(field) => (
                <Field>
                  <FieldLabel>
                    {name === "instagramId"
                      ? "ID de cuenta (IG-ID)"
                      : name === "accessToken"
                        ? "Token de usuario de Instagram"
                        : "App secret"}
                  </FieldLabel>
                  <Input
                    type={name === "instagramId" ? "text" : "password"}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
                </Field>
              )}
            </igForm.Field>
          ))}
        </>
      )}
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeForm,
    title: "Nueva conexión",
    isDirty,
    submitLabel: "Crear",
    cancelLabel: "Cancelar",
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      if (provider === "telegram_bot_api") void tgForm.handleSubmit()
      else if (provider === "whatsapp_cloud_api") void waForm.handleSubmit()
      else if (provider === "messenger") void msgrForm.handleSubmit()
      else void igForm.handleSubmit()
    },
  }

  return (
    <div className="flex flex-col gap-2">
      <PageDraftGuard dirty={formOpen && isDirty} />
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Canales"
          subtitle="Conexiones de WhatsApp, Telegram, Messenger e Instagram"
          actions={
            canWrite ? (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => {
                  setCreated(null)
                  setFormOpen(true)
                }}
              >
                <Plus aria-hidden />
                Nueva conexión
              </Button>
            ) : null
          }
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {created && (
          <div className="flex flex-col gap-1 rounded-lg border border-success/30 bg-success-soft p-4 text-sm">
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
                { value: "messenger", label: "Messenger" },
                { value: "instagram", label: "Instagram" },
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
          <EmptyState
            title="Sin conexiones"
            description="Conecta WhatsApp, Telegram, Messenger o Instagram. Cada conexión se valida contra su proveedor: sin credenciales válidas no se activa."
          />
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
          /* En modo panel el maestro en cards queda apretado: tabla mientras el
             formulario vive al costado. */
          <DataTable table={table} view={mode === "panel" ? "table" : "card"} />
        )}
      </MasterDetail>
    
      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
    </div>
  )
}
