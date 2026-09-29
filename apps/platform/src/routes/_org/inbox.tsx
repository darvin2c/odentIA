import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  Attachment,
  type AttachmentData,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@odentia/ui/components/ai-elements/attachments"
import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerDurationDisplay,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerTimeRange,
} from "@odentia/ui/components/ai-elements/audio-player"
import { Message, MessageContent } from "@odentia/ui/components/ai-elements/message"
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@odentia/ui/components/ai-elements/prompt-input"
import { SpeechInput } from "@odentia/ui/components/ai-elements/speech-input"
import {
  EmptyState,
  FilterBar,
  PageHeader,
  PageShell,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import {
  AlertCircle,
  Bot,
  CheckCheck,
  ChevronLeft,
  Clock,
  Copy,
  MessageCircle,
  Send,
  UserPlus,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch, apiUpload } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import {
  type ChatMessage,
  type ConversationDetail,
  type ConversationListItem,
  timeAgo,
  usePermission,
  useMyUserId,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { createRegistrationLink } from "../../lib/patient-registration"

export const Route = createFileRoute("/_org/inbox")({
  validateSearch: (search: Record<string, unknown>) => ({
    conversation: typeof search.conversation === "string" ? search.conversation : undefined,
    ...(search.prepareRegistration === true || search.prepareRegistration === "true"
      ? { prepareRegistration: true as const }
      : {}),
    ...(typeof search.q === "string" ? { q: search.q } : {}),
    ...(typeof search.sort === "string" ? { sort: search.sort } : {}),
    ...(typeof search.status === "string" ? { status: search.status } : {}),
    ...(typeof search.channel === "string" ? { channel: search.channel } : {}),
    ...(typeof search.assigned === "string" ? { assigned: search.assigned } : {}),
  }),
  component: InboxPage,
})
const orgRouteApi = getRouteApi("/_org")

function InboxPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const myUserId = useMyUserId()
  const canRead = usePermission("conversations.read")
  const canWrite = usePermission("conversations.write")
  const canRegister = usePermission("crm.write")
  const navigate = useNavigate({ from: Route.fullPath })
  const listSearch = useListSearch()
  const status = listSearch.get("status") ?? "open"
  const channel = listSearch.get("channel")
  const assigned = listSearch.get("assigned")
  const search = listSearch.get("q") ?? ""
  const sort = listSearch.get("sort")
  const routeSearch = Route.useSearch()
  const [selectedId, setSelectedId] = useState<string | null>(routeSearch.conversation ?? null)

  // La selección sigue al search `conversation` (navegación desde contactos),
  // no solo al estado del primer montaje.
  useEffect(() => {
    if (routeSearch.conversation !== undefined) setSelectedId(routeSearch.conversation)
  }, [routeSearch.conversation])

  // Consumir la intención una sola vez: retirar el flag con replace.
  // La mutación real la dispara ThreadView con el detalle ya cargado.
  const consumePrepareRegistration = () => {
    void navigate({
      search: (previous) => ({ ...previous, prepareRegistration: undefined }),
      replace: true,
    })
  }

  const listParams = useMemo(() => {
    const params = new URLSearchParams()
    if (status !== "all") params.set("status", status)
    if (channel) params.set("channel", channel)
    if (assigned === "me") params.set("assigned", myUserId)
    else if (assigned === "none") params.set("assigned", "none")
    if (search.trim()) params.set("q", search.trim())
    return params.toString()
  }, [status, channel, assigned, search, myUserId])

  const listQuery = useInfiniteQuery({
    queryKey: ["conversations", listParams],
    queryFn: ({ pageParam }) =>
      apiFetch<{ data: ConversationListItem[]; nextCursor: string | null }>(
        `/api/conversations?${listParams}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor,
    enabled: canRead,
  })

  useOrgEvents(["message.created", "message.updated", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    if (selectedId) void queryClient.invalidateQueries({ queryKey: ["conversation", selectedId] })
  })

  const items = useMemo(() => {
    const base = listQuery.data?.pages.flatMap((page) => page.data) ?? []
    if (!sort) return base
    const field = sort.replace(/^-/, "")
    const sorted = [...base]
    if (field === "noleidos") {
      sorted.sort(
        (a, b) =>
          b.unreadCount - a.unreadCount ||
          (b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0) -
            (a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0),
      )
      return sorted
    }
    if (field === "actividad") {
      const desc = sort !== "-actividad"
      sorted.sort((a, b) => {
        const diff =
          (b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0) -
          (a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0)
        return desc ? diff : -diff
      })
      return sorted
    }
    return base
  }, [listQuery.data, sort])

  const mode = useDetailMode()

  const thread = selectedId ? (
    <ThreadView
      key={selectedId}
      id={selectedId}
      members={org.members}
      orgName={org.name}
      orgSlug={org.slug}
      canRead={canRead}
      canWrite={canWrite}
      canRegister={canRegister}
      prepareRegistration={
        routeSearch.prepareRegistration === true && routeSearch.conversation === selectedId
      }
      onConsumePrepareRegistration={consumePrepareRegistration}
      onBack={() => setSelectedId(null)}
    />
  ) : null

  if (!canRead) {
    return (
      <PageShell fill className="gap-4">
        <PageHeader title="Bandeja" subtitle="Todas las conversaciones de la clínica" />
        <EmptyState title="Sin acceso" description="Sin permiso de lectura de conversaciones." />
      </PageShell>
    )
  }

  return (
    <PageShell fill className="gap-4">
      <PageHeader title="Bandeja" subtitle="Todas las conversaciones de la clínica" />
      <FilterBar
        filters={[
          {
            key: "status",
            label: "Estado",
            type: "select",
            options: [
              { value: "open", label: "Abiertas" },
              { value: "closed", label: "Cerradas" },
              { value: "all", label: "Todas" },
            ],
          },
          {
            key: "channel",
            label: "Canal",
            type: "select",
            options: [
              { value: "whatsapp", label: "WhatsApp" },
              { value: "telegram", label: "Telegram" },
            ],
          },
          {
            key: "assigned",
            label: "Asignado",
            type: "select",
            options: [
              { value: "me", label: "Mías" },
              { value: "none", label: "Sin asignar" },
            ],
          },
        ]}
        sortOptions={[
          { value: "actividad", label: "Actividad reciente" },
          { value: "noleidos", label: "No leídos primero" },
        ]}
        searchPlaceholder="Buscar contacto"
      />
      {/* PageShell `fill` acota al viewport: el hilo ocupa el alto restante y el
          composer queda fijo como footer suyo. La lista se separa con un handle
          arrastrable; en ancho corto (useDetailMode) se muestra una a la vez. */}
      {mode === "panel" ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel
            id="lista"
            defaultSize="26rem"
            minSize="20rem"
            maxSize="36rem"
            className="flex min-h-0 flex-col"
          >
            <ConversationList
              items={items}
              selectedId={selectedId}
              isLoading={listQuery.isLoading}
              hasNextPage={listQuery.hasNextPage}
              isFetchingNextPage={listQuery.isFetchingNextPage}
              onSelect={setSelectedId}
              onFetchNextPage={() => void listQuery.fetchNextPage()}
            />
          </ResizablePanel>
          <ResizableHandle withHandle className="mx-1 w-4 bg-transparent" />
          <ResizablePanel id="hilo" minSize="28rem" className="flex min-h-0 min-w-0 flex-col">
            {thread ?? (
              <EmptyState
                title="Selecciona una conversación"
                description="Elige un hilo de la lista para verlo aquí."
              />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {thread ?? (
            <ConversationList
              items={items}
              selectedId={selectedId}
              isLoading={listQuery.isLoading}
              hasNextPage={listQuery.hasNextPage}
              isFetchingNextPage={listQuery.isFetchingNextPage}
              onSelect={setSelectedId}
              onFetchNextPage={() => void listQuery.fetchNextPage()}
            />
          )}
        </div>
      )}
    </PageShell>
  )
}

const NO_TEMPLATE = "__ninguna__"

/** Listado de conversaciones: filas, vacío y paginación por cursor. */
function ConversationList({
  items,
  selectedId,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onSelect,
  onFetchNextPage,
}: {
  items: ConversationListItem[]
  selectedId: string | null
  isLoading: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onSelect: (id: string) => void
  onFetchNextPage: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={`flex flex-col gap-1 rounded-md bg-card p-3 text-left hover:bg-muted/70 ${
            item.id === selectedId ? "border border-primary bg-muted/70" : ""
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {item.connection.channel === "whatsapp" ? (
                <MessageCircle className="size-3.5 shrink-0 text-green-600" />
              ) : (
                <Send className="size-3.5 shrink-0 text-sky-600" />
              )}
              <span className="truncate text-sm font-medium">{item.contact.displayName}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {item.unreadCount > 0 && <Badge>{item.unreadCount}</Badge>}
              <span className="text-xs text-muted-foreground">{timeAgo(item.lastMessageAt)}</span>
            </span>
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {item.preview?.body ?? (item.preview ? "[adjunto]" : "—")}
          </span>
        </button>
      ))}
      {items.length === 0 && !isLoading && (
        <EmptyState title="Sin conversaciones" description="Los mensajes entrantes aparecen aquí." />
      )}
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={onFetchNextPage}
        >
          {isFetchingNextPage ? "Cargando…" : "Cargar más"}
        </Button>
      )}
    </div>
  )
}

interface Member {
  userId: string
  role: string
  user: { email: string; name: string }
}

function ThreadView({
  id,
  members,
  orgName,
  orgSlug,
  canRead,
  canWrite,
  canRegister,
  prepareRegistration,
  onConsumePrepareRegistration,
  onBack,
}: {
  id: string
  members: Member[]
  orgName: string
  orgSlug: string
  canRead: boolean
  canWrite: boolean
  canRegister: boolean
  prepareRegistration: boolean
  onConsumePrepareRegistration: () => void
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const [composer, setComposer] = useState("")
  const [older, setOlder] = useState<ChatMessage[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [windowClosed, setWindowClosed] = useState(false)
  const [templateName, setTemplateName] = useState("")
  const [templateParams, setTemplateParams] = useState("")
  const [markedRef, setMarkedRef] = useState<string | null>(null)
  const [registrationLink, setRegistrationLink] = useState<{
    url: string
    expiresAt: string
  } | null>(null)
  const [registrationError, setRegistrationError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const intentConsumedRef = useRef(false)

  const detailQuery = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => apiFetch<{ data: ConversationDetail }>(`/api/conversations/${id}`),
    enabled: canRead,
  })

  const detail = detailQuery.data?.data
  const messages = useMemo(() => [...older, ...(detail?.messages ?? [])], [older, detail?.messages])

  useEffect(() => {
    setOlder([])
    setOlderCursor(null)
    setComposer("")
    setWindowClosed(false)
    setMarkedRef(null)
    setRegistrationLink(null)
    setRegistrationError(null)
    setSendError(null)
    setCopied(false)
  }, [id])

  useEffect(() => {
    if (detail && detail.conversation.unreadCount > 0 && markedRef !== id) {
      setMarkedRef(id)
      void apiFetch(`/api/conversations/${id}/read`, { method: "POST" }).then(() =>
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      )
    }
  }, [detail, id, markedRef, queryClient])

  const templatesQuery = useQuery({
    queryKey: ["templates", detail?.connection.id],
    queryFn: () =>
      apiFetch<{ data: { name: string; language: string }[] }>(
        `/api/channels/connections/${detail?.connection.id}/templates`,
      ),
    enabled: windowClosed && !!detail && canWrite,
  })

  const templateItems = useMemo(
    () =>
      Object.fromEntries(
        (templatesQuery.data?.data ?? []).map((t) => [t.name, `${t.name} (${t.language})`]),
      ),
    [templatesQuery.data],
  )

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", id] })
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
  }

  const registrationMutation = useMutation({
    mutationFn: (contactId: string) => createRegistrationLink(contactId, id),
    onSuccess: (result) => {
      const url = result.data.url
      setRegistrationLink(result.data)
      setRegistrationError(null)
      setCopied(false)
      // Preparar el borrador en el composer existente; el operador revisa y envía.
      // Nunca se envía automáticamente al generar el enlace.
      setComposer(`Completa los datos del paciente para ${orgName}: ${url}`)
    },
    onError: (error) => {
      setRegistrationError(error instanceof ApiError ? error.message : "No se pudo crear el enlace")
    },
  })

  // Intención `prepareRegistration` (desde Contactos → Enviar registro):
  // usa la misma mutación que el botón, una sola vez por hilo.
  // El ref evita duplicados por re-render/StrictMode; el replace del padre
  // retira el flag para que navegar de nuevo no regenere el enlace.
  // Sin intención explícita jamás se crea un token al cargar el hilo.
  useEffect(() => {
    if (!prepareRegistration) {
      intentConsumedRef.current = false
      return
    }
    if (!canRegister || !detail || intentConsumedRef.current || registrationMutation.isPending) return
    intentConsumedRef.current = true
    onConsumePrepareRegistration()
    registrationMutation.mutate(detail.contact.id)
  }, [prepareRegistration, canRegister, detail])

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/api/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      setComposer("")
      setWindowClosed(false)
      setSendError(null)
      invalidate()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.shape.code === "WINDOW_CLOSED") {
        // La URL se conserva en el composer; el operador la usa en la plantilla.
        setWindowClosed(true)
        setSendError(null)
      } else {
        // Conexión desactivada u otro fallo real: bloquear el envío con el motivo.
        setSendError(error instanceof ApiError ? error.message : "No se pudo enviar el mensaje")
      }
    },
  })

  // Envía texto y/o adjuntos del composer. Lanza en error para que PromptInput
  // conserve el texto y los adjuntos (permite reintentar sin perder nada).
  async function handleComposerSubmit(message: PromptInputMessage) {
    const text = message.text.trim()
    const files = message.files ?? []
    if (!text && files.length === 0) return
    setUploading(true)
    try {
      if (text) await sendMutation.mutateAsync(text)
      for (const file of files) {
        const blob = await (await fetch(file.url)).blob()
        const form = new FormData()
        form.set("file", new File([blob], file.filename ?? "adjunto", { type: file.mediaType }))
        await apiUpload(`/api/conversations/${id}/messages/media`, form)
      }
      setComposer("")
      setWindowClosed(false)
      setSendError(null)
      invalidate()
    } catch (error) {
      if (error instanceof ApiError && error.shape.code === "WINDOW_CLOSED") {
        setWindowClosed(true)
        setSendError(null)
      } else {
        setSendError(error instanceof ApiError ? error.message : "No se pudo enviar el mensaje")
      }
      throw error
    } finally {
      setUploading(false)
    }
  }

  const templateMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/conversations/${id}/messages/template`, {
        method: "POST",
        body: JSON.stringify({
          name: templateName,
          language:
            templatesQuery.data?.data.find((t) => t.name === templateName)?.language ?? "es_PE",
          params: templateParams
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => {
      setTemplateName("")
      setTemplateParams("")
      setWindowClosed(false)
      invalidate()
    },
    onError: (error) => {
      setRegistrationError(
        error instanceof ApiError ? error.message : "No se pudo enviar la plantilla",
      )
    },
  })

  const actionMutation = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      apiFetch(`/api/conversations/${id}${path}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: invalidate,
  })

  async function loadOlder() {
    const cursor = olderCursor ?? detail?.messagesCursor
    if (!cursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await apiFetch<{ data: ChatMessage[]; nextCursor: string | null }>(
        `/api/conversations/${id}/messages?before=${encodeURIComponent(cursor)}&limit=50`,
      )
      setOlder((prev) => [...page.data, ...prev])
      setOlderCursor(page.nextCursor)
    } finally {
      setLoadingOlder(false)
    }
  }

  if (detailQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>
  }
  if (!detail) {
    return <EmptyState title="No encontrada" description="La conversación ya no existe." />
  }

  const conv = detail.conversation
  const closed = conv.status === "closed"
  const assignee = members.find((m) => m.userId === conv.assignedUserId)

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md bg-card">
      <div className="flex items-center gap-2 border-b p-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label="Volver"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <Link
            to="/contacts/$contactId"
            params={{ contactId: detail.contact.id }}
            className="truncate text-sm font-semibold hover:underline"
          >
            {detail.contact.displayName}
          </Link>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{detail.connection.channel === "whatsapp" ? "WhatsApp" : "Telegram"}</span>
            <span>·</span>
            <Badge
              variant="secondary"
              className={closed ? undefined : "border-emerald-300 bg-emerald-50 text-emerald-900"}
            >
              {closed ? "Cerrada" : "Abierta"}
            </Badge>
            {detail.contact.isActive === false && <Badge variant="secondary">Archivado</Badge>}
            {assignee && <span>· {assignee.user.name}</span>}
          </div>
        </div>
        {canRegister && (
          <Button
            variant="outline"
            size="sm"
            disabled={registrationMutation.isPending}
            onClick={() => registrationMutation.mutate(detail.contact.id)}
            title="Genera un enlace y prepara el mensaje para revisión; no se envía solo"
          >
            <UserPlus className="size-4" />
            {registrationMutation.isPending ? "Generando…" : "Enviar registro"}
          </Button>
        )}
        {canWrite && (
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-md border bg-background px-3 py-1 text-sm hover:bg-muted">
              {assignee ? assignee.user.name : "Asignar"}
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onSelect={() => actionMutation.mutate({ path: "/assign", body: { userId: null } })}
              >
                Sin asignar
              </DropdownMenuItem>
              {members.map((m) => (
                <DropdownMenuItem
                  key={m.userId}
                  onSelect={() =>
                    actionMutation.mutate({ path: "/assign", body: { userId: m.userId } })
                  }
                >
                  {m.user.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canWrite && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              actionMutation.mutate({ path: "/agent", body: { enabled: conv.agentStatus !== "on" } })
            }
            title={conv.agentStatus === "on" ? "Pausar agente (toma humana)" : "Reactivar agente"}
          >
            <Bot className="size-4" />
            {conv.agentStatus === "on" ? "ON" : "OFF"}
          </Button>
        )}
        {canWrite && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => actionMutation.mutate({ path: closed ? "/reopen" : "/close" })}
          >
            {closed ? "Reabrir" : "Cerrar"}
          </Button>
        )}
      </div>

      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport preserveScrollOnPrepend className="p-3">
            {(olderCursor ?? detail.messagesCursor) && (
              <Button
                variant="ghost"
                size="sm"
                className="mb-2 w-fit"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? "Cargando…" : "Cargar anteriores"}
              </Button>
            )}
            <MessageScrollerContent className="gap-2">
              {messages.map((msg) => (
                <MessageScrollerItem key={msg.id} messageId={msg.id}>
                  <MessageBubble msg={msg} conversationId={id} orgSlug={orgSlug} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="border-t p-3">
        {detail.contact.isActive === false && (
          <p className="mb-2 text-xs text-muted-foreground">
            Contacto archivado: las conversaciones siguen accesibles, pero reactívalo para iniciar
            nuevos envíos o crear relaciones.
          </p>
        )}
        {registrationError && (
          <p className="mb-2 text-sm text-red-600" role="alert">
            {registrationError}
          </p>
        )}
        {registrationLink && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
            <span className="min-w-0 flex-1 truncate" title={registrationLink.url}>
              Enlace de registro listo para revisar antes de enviar: {registrationLink.url}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(registrationLink.url)
                  setCopied(true)
                } catch {
                  setRegistrationError(
                    "No se pudo copiar el enlace; selecciónalo y cópialo manualmente",
                  )
                }
              }}
            >
              <Copy className="size-3.5" />
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
        )}
        {closed ? (
          <p className="text-sm text-muted-foreground">
            Conversación cerrada. Reábrela para responder.
          </p>
        ) : windowClosed ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-amber-700">
              Fuera de la ventana de 24h de WhatsApp: responde con una plantilla autorizada.
            </p>
            {registrationLink && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate" title={registrationLink.url}>
                  Enlace listo: {registrationLink.url}
                </span>
              </div>
            )}
            {(templatesQuery.data?.data ?? []).length === 0 && !templatesQuery.isLoading && (
              <p className="text-xs text-muted-foreground">
                No hay plantillas autorizadas disponibles: copia el enlace de arriba y compártelo
                por otro medio. No se registró ningún envío.
              </p>
            )}
            <div className="flex gap-2">
              <Select
                items={{ [NO_TEMPLATE]: "Elegir plantilla…", ...templateItems }}
                value={templateName || NO_TEMPLATE}
                onValueChange={(v) => setTemplateName(!v || v === NO_TEMPLATE ? "" : String(v))}
              >
                <SelectTrigger aria-label="Plantilla" className="w-56">
                  <SelectValue placeholder="Elegir plantilla…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEMPLATE}>Elegir plantilla…</SelectItem>
                  {(templatesQuery.data?.data ?? []).map((t) => (
                    <SelectItem key={`${t.name}:${t.language}`} value={t.name}>
                      {t.name} ({t.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Parámetros separados por coma"
                value={templateParams}
                onChange={(e) => setTemplateParams(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!templateName || templateMutation.isPending || !canWrite}
                onClick={() => templateMutation.mutate()}
              >
                Enviar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setWindowClosed(false)}>
                Volver
              </Button>
            </div>
          </div>
        ) : !canWrite ? (
          <p className="text-sm text-muted-foreground">
            Sin permiso de escritura de conversaciones.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <PromptInput
              accept="image/jpeg,image/png,image/webp,application/pdf,audio/ogg,audio/mpeg"
              multiple
              className="h-auto min-h-10 items-end bg-background"
              onSubmit={handleComposerSubmit}
            >
              <PromptInputBody>
                <PromptInputAttachmentsRow />
                <PromptInputTextarea
                  aria-label="Mensaje"
                  rows={1}
                  placeholder="Escribe un mensaje… (Enter para enviar)"
                  value={composer}
                  onChange={(e) => {
                    setComposer(e.target.value)
                    if (sendError) setSendError(null)
                  }}
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger aria-label="Adjuntar archivo" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments label="Adjuntar archivo" />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  <SpeechInput
                    lang="es-PE"
                    size="icon-sm"
                    aria-label="Dictar"
                    onTranscriptionChange={(text) =>
                      setComposer((previous) => (previous ? `${previous} ` : "") + text)
                    }
                  />
                </PromptInputTools>
                <PromptInputSubmit
                  aria-label="Enviar"
                  disabled={sendMutation.isPending || uploading}
                />
              </PromptInputFooter>
            </PromptInput>
            {sendError && (
              <p className="text-sm text-red-600" role="alert">
                {sendError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function statusIcon(status: string) {
  if (status === "read") return <CheckCheck className="size-3.5 text-sky-500" />
  if (status === "delivered" || status === "sent")
    return <CheckCheck className="size-3.5 text-muted-foreground" />
  if (status === "failed") return <AlertCircle className="size-3.5 text-red-500" />
  return <Clock className="size-3.5 text-muted-foreground" />
}

function MessageAttachments({
  msg,
  conversationId,
  orgSlug,
}: {
  msg: ChatMessage
  conversationId: string
  orgSlug: string
}) {
  if (msg.attachments.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {msg.attachments.map((att, index) => {
        // `?org=` porque <img>/<audio>/<a> no pueden enviar el header de tenant.
        const url = `${API_URL}/api/conversations/${conversationId}/messages/${msg.id}/attachments/${index}?org=${encodeURIComponent(orgSlug)}`
        if (att.mimeType.startsWith("image/")) {
          return (
            <a key={index} href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={att.filename} className="max-w-64 rounded-md" />
            </a>
          )
        }
        if (att.mimeType.startsWith("audio/")) {
          return (
            <AudioPlayer key={index} className="w-64">
              <AudioPlayerElement src={url} />
              <AudioPlayerControlBar>
                <AudioPlayerPlayButton />
                <AudioPlayerTimeRange className="flex-1" />
                <AudioPlayerDurationDisplay />
                <AudioPlayerMuteButton />
              </AudioPlayerControlBar>
            </AudioPlayer>
          )
        }
        const data: AttachmentData = {
          id: `${msg.id}-${index}`,
          type: "file",
          url,
          mediaType: att.mimeType,
          filename: att.filename,
        }
        return (
          <a key={index} href={url} target="_blank" rel="noreferrer">
            <Attachments variant="list">
              <Attachment data={data}>
                <AttachmentPreview />
                <AttachmentInfo showMediaType />
              </Attachment>
            </Attachments>
          </a>
        )
      })}
    </div>
  )
}

function MessageBubble({
  msg,
  conversationId,
  orgSlug,
}: {
  msg: ChatMessage
  conversationId: string
  orgSlug: string
}) {
  const out = msg.direction === "out"
  return (
    <Message from={out ? "user" : "assistant"}>
      <MessageContent className={out ? undefined : "rounded-lg bg-muted px-4 py-3"}>
        {!out && msg.senderKind === "agent" && (
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Bot className="size-3" /> Agente
          </div>
        )}
        {/* WhatsApp muestra la media arriba y el texto (caption o transcripción) abajo. */}
        <MessageAttachments msg={msg} conversationId={conversationId} orgSlug={orgSlug} />
        {msg.contentType === "template" ? (
          <span className="italic opacity-80">
            Plantilla: {msg.templateName} {(msg.templateParams ?? []).join(" · ")}
          </span>
        ) : (
          msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>
        )}
        <div
          className={`flex items-center gap-1 text-xs text-muted-foreground ${out ? "justify-end" : ""}`}
        >
          {new Date(msg.createdAt).toLocaleTimeString("es-PE", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {out && statusIcon(msg.status)}
        </div>
      </MessageContent>
    </Message>
  )
}

function PromptInputAttachmentsRow() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <Attachments variant="inline">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove label="Quitar" />
        </Attachment>
      ))}
    </Attachments>
  )
}
