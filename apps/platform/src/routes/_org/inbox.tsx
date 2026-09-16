import {
  Badge,
  Bubble,
  BubbleContent,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { EmptyState, FilterBar, PageHeader, useListSearch } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import {
  AlertCircle,
  Bot,
  CheckCheck,
  ChevronLeft,
  Clock,
  MessageCircle,
  Paperclip,
  Send,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import {
  type ChatMessage,
  type ConversationDetail,
  type ConversationListItem,
  timeAgo,
  useMyUserId,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/inbox")({
  validateSearch: (search: Record<string, unknown>) => ({
    conversation: typeof search.conversation === "string" ? search.conversation : undefined,
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
  const listSearch = useListSearch()
  const status = listSearch.get("status") ?? "open"
  const channel = listSearch.get("channel")
  const assigned = listSearch.get("assigned")
  const search = listSearch.get("q") ?? ""
  const sort = listSearch.get("sort")
  const initial = Route.useSearch()
  const [selectedId, setSelectedId] = useState<string | null>(initial.conversation ?? null)

  const listParams = useMemo(() => {
    const params = new URLSearchParams()
    if (status !== "all") params.set("status", status)
    if (channel) params.set("channel", channel)
    if (assigned === "me") params.set("assigned", myUserId)
    else if (assigned === "none") params.set("assigned", "none")
    if (search.trim()) params.set("q", search.trim())
    return params.toString()
  }, [status, channel, assigned, search, myUserId])

  const listQuery = useQuery({
    queryKey: ["conversations", listParams],
    queryFn: () =>
      apiFetch<{ data: ConversationListItem[]; nextCursor: string | null }>(
        `/api/conversations?${listParams}`,
      ),
  })

  useOrgEvents(["message.created", "message.updated", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    if (selectedId) void queryClient.invalidateQueries({ queryKey: ["conversation", selectedId] })
  })

  const items = useMemo(() => {
    const base = listQuery.data?.data ?? []
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Bandeja" subtitle="Conversaciones de WhatsApp y Telegram" />
      <div className="flex gap-4" style={{ height: "calc(100vh - 220px)", minHeight: 480 }}>
        <section
          className={`w-full flex-col gap-3 md:flex md:w-[clamp(280px,30%,420px)] md:shrink-0 ${selectedId ? "hidden" : "flex"}`}
        >
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
          <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`flex flex-col gap-1 rounded-lg border p-3 text-left hover:bg-muted/50 ${
                  item.id === selectedId ? "border-primary bg-muted/50" : ""
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
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(item.lastMessageAt)}
                    </span>
                  </span>
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {item.preview?.body ?? (item.preview ? "[adjunto]" : "—")}
                </span>
              </button>
            ))}
            {items.length === 0 && !listQuery.isLoading && (
              <EmptyState
                title="Sin conversaciones"
                description="Los mensajes entrantes aparecen aquí."
              />
            )}
          </div>
        </section>
        <section className={`min-w-0 flex-1 flex-col ${selectedId ? "flex" : "hidden md:flex"}`}>
          {selectedId ? (
            <ThreadView id={selectedId} members={org.members} onBack={() => setSelectedId(null)} />
          ) : (
            <EmptyState
              title="Selecciona una conversación"
              description="Elige un hilo de la lista para verlo aquí."
            />
          )}
        </section>
      </div>
    </div>
  )
}

const NO_TEMPLATE = "__ninguna__"

interface Member {
  userId: string
  role: string
  user: { email: string; name: string }
}

function ThreadView({
  id,
  members,
  onBack,
}: {
  id: string
  members: Member[]
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

  const detailQuery = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => apiFetch<{ data: ConversationDetail }>(`/api/conversations/${id}`),
  })

  const detail = detailQuery.data?.data
  const messages = useMemo(() => [...older, ...(detail?.messages ?? [])], [older, detail?.messages])

  useEffect(() => {
    setOlder([])
    setOlderCursor(null)
    setComposer("")
    setWindowClosed(false)
    setMarkedRef(null)
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
    enabled: windowClosed && !!detail,
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

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/api/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      setComposer("")
      setWindowClosed(false)
      invalidate()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.shape.code === "WINDOW_CLOSED") {
        setWindowClosed(true)
      }
    },
  })

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
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border">
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
            <Badge variant={closed ? "secondary" : "success"}>
              {closed ? "Cerrada" : "Abierta"}
            </Badge>
            {assignee && <span>· {assignee.user.name}</span>}
          </div>
        </div>
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => actionMutation.mutate({ path: closed ? "/reopen" : "/close" })}
        >
          {closed ? "Reabrir" : "Cerrar"}
        </Button>
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
                  <MessageBubble msg={msg} conversationId={id} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="border-t p-3">
        {closed ? (
          <p className="text-sm text-muted-foreground">
            Conversación cerrada. Reábrela para responder.
          </p>
        ) : windowClosed ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-amber-700">
              Fuera de la ventana de 24h de WhatsApp: responde con una plantilla autorizada.
            </p>
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
                disabled={!templateName || templateMutation.isPending}
                onClick={() => templateMutation.mutate()}
              >
                Enviar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setWindowClosed(false)}>
                Volver
              </Button>
            </div>
          </div>
        ) : (
          <InputGroup className="h-auto min-h-10 items-end bg-background">
            <InputGroupTextarea
              aria-label="Mensaje"
              rows={1}
              placeholder="Escribe un mensaje… (Enter para enviar)"
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  if (composer.trim() && !sendMutation.isPending)
                    sendMutation.mutate(composer.trim())
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-sm"
                aria-label="Enviar"
                disabled={!composer.trim() || sendMutation.isPending}
                onClick={() => sendMutation.mutate(composer.trim())}
              >
                <Send aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
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

function MessageBubble({ msg, conversationId }: { msg: ChatMessage; conversationId: string }) {
  const out = msg.direction === "out"
  return (
    <Message align={out ? "end" : "start"}>
      <MessageContent>
        {!out && msg.senderKind === "agent" && (
          <MessageHeader>
            <Bot className="size-3" /> Agente
          </MessageHeader>
        )}
        <Bubble variant={out ? "default" : "muted"} align={out ? "end" : "start"}>
          <BubbleContent>
            {msg.contentType === "template" ? (
              <span className="italic opacity-80">
                Plantilla: {msg.templateName} {(msg.templateParams ?? []).join(" · ")}
              </span>
            ) : (
              msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>
            )}
            {msg.attachments.length > 0 && (
              <span className="mt-1 flex flex-col gap-1">
                {msg.attachments.map((att, i) => (
                  <a
                    key={i}
                    className="flex items-center gap-1 underline"
                    href={`${API_URL}/api/conversations/${conversationId}/messages/${msg.id}/attachments/${i}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Paperclip className="size-3" /> {att.filename}
                  </a>
                ))}
              </span>
            )}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="gap-1">
          {new Date(msg.createdAt).toLocaleTimeString("es-PE", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {out && statusIcon(msg.status)}
        </MessageFooter>
      </MessageContent>
    </Message>
  )
}
