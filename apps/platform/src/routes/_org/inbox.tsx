import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  Spinner,
  toast,
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
  AgentMark,
  ConfirmDialog,
  DataRefreshMarker,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  PageShell,
  RowActions,
  SideDockScopeProvider,
  SubmitButton,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import {
  AlertCircle,
  Bot,
  CheckCheck,
  CheckCircle2,
  ClipboardList,
  ChevronLeft,
  Clock,
  Copy,
  Hand,
  PanelRight,
  SquarePen,
  UserPlus,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch, apiUpload } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import {
  type ChatMessage,
  type ConversationAttention,
  type ConversationClosure,
  type ConversationDetail,
  type ConversationListItem,
  type InboxSummary,
  type ResolvePreview,
  timeAgo,
  usePermission,
  useMyUserId,
} from "../../lib/crm"
import {
  invalidateAgentPanelQueries,
  useAgentPanel,
  useAgentPanelDockBlocker,
  useAgentPanelFitsBesideContext,
} from "../../components/agent-panel"
import { AnswerTraceDrawer } from "../../components/agent/answer-trace"
import { CaseBriefDrawer } from "../../components/agent/case-brief"
import { LessonDrawer } from "../../components/agent/lesson-drawer"
import { ReceptionOffNotice } from "../../components/agent/reception-off-notice"
import { CorrectDrawer, type CorrectionTarget } from "../../components/agent/correct-drawer"
import type { AnswerTrace } from "../../lib/agent"
import { ContactWorkspace } from "../../components/crm/contact-workspace"
import { ResolvePreviewDetails } from "../../components/crm/resolve-preview"
import { InboxApprovedMessages } from "../../components/integrations/whatsapp/inbox-approved-messages"
import { ACTION_LABEL, type AgentProposal, permissionForAction, proposalErrorMessage } from "../../lib/agent"
import { channelIcon, channelLabel } from "../../lib/channels"
import { NewConversationDialog } from "../../components/inbox-new-conversation"
import { useOrgEvents } from "../../lib/org-events"
import { createPersonalLinkForContact, createRegistrationLink } from "../../lib/patient-registration"
import { activeOrgLocale } from "../../lib/locale"
import {
  closeWithoutResolvingWords,
  closureBand,
  type ConversationWords,
  conversationWords,
  fullWhenWords,
  messageTimeWords,
  pendingWords,
  resolveWords,
} from "../../lib/conversation-state"

export const Route = createFileRoute("/_org/inbox")({
  validateSearch: (search: Record<string, unknown>) => ({
    conversation: typeof search.conversation === "string" ? search.conversation : undefined,
    ...(search.prepareRegistration === true || search.prepareRegistration === "true"
      ? { prepareRegistration: true as const }
      : {}),
    ...(typeof search.q === "string" ? { q: search.q } : {}),
    ...(typeof search.channel === "string" ? { channel: search.channel } : {}),
    ...(typeof search.assigned === "string" ? { assigned: search.assigned } : {}),
    ...(typeof search.view === "string" ? { view: search.view } : {}),
    ...(search.contexto === true || search.contexto === "true"
      ? { contexto: true as const }
      : {}),
  }),
  component: InboxPage,
})
const orgRouteApi = getRouteApi("/_org")

/**
 * Canales del filtro de la bandeja: todos los soportados por el núcleo,
 * etiquetados con el helper canónico (no solo WhatsApp/Telegram).
 */
const CHANNEL_FILTER_OPTIONS = [
  "whatsapp",
  "telegram",
  "messenger",
  "instagram",
  "email",
  "webchat",
] as const

/**
 * Vistas de trabajo de la bandeja (filtrado SQL en el servidor, antes de
 * paginar). Solo valen las que tienen chip: una vista sin control visible
 * dejaría la lista filtrada sin forma de verlo ni de salir. «Abiertas» es la
 * bandeja sin vista; «Cerradas» pide además las cerradas.
 */
const VIEW_CHIPS = [
  { value: undefined, label: "Abiertas", total: "open" },
  { value: "unanswered", label: "Esperan respuesta", total: "unanswered" },
  { value: "team", label: "Con el equipo", total: "team" },
  { value: "awaiting_patient", label: "Esperan al paciente", total: "awaitingPatient" },
  { value: "closed", label: "Cerradas", total: "closed" },
] as const satisfies readonly { value?: string; label: string; total: keyof InboxSummary }[]
const CHIP_VIEWS: readonly (string | undefined)[] = VIEW_CHIPS.map((chip) => chip.value)
const DEFAULT_SUBTITLE = "Todas las conversaciones de la clínica"

/** Total de la bandeja entera; con filtros activos la cifra la da el chip, no el subtítulo. */
function waitingSubtitle(summary: InboxSummary | undefined): string {
  if (!summary) return DEFAULT_SUBTITLE
  if (summary.unanswered === 0) return "Ninguna conversación espera respuesta"
  return summary.unanswered === 1
    ? "1 conversación espera respuesta"
    : `${summary.unanswered} conversaciones esperan respuesta`
}

function InboxPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const myUserId = useMyUserId()
  const canRead = usePermission("conversations.read")
  const canWrite = usePermission("conversations.write")
  const canRegister = usePermission("crm.write")
  // «Contexto» y «Nueva conversación» leen a la persona en el CRM: quien no lo
  // ve (odontología) no recibe el botón, en vez de abrir «Sin acceso».
  const canReadCrm = usePermission("crm.read")
  const [newConversation, setNewConversation] = useState(false)
  const navigate = useNavigate({ from: Route.fullPath })
  const listSearch = useListSearch()
  const channel = listSearch.get("channel")
  const assigned = listSearch.get("assigned")
  const search = listSearch.get("q") ?? ""
  // Vistas de trabajo (filtrado SQL en el servidor, antes de paginar); el orden es
  // el del servidor, por actividad: reordenar aquí solo movería las páginas ya cargadas.
  const view = listSearch.get("view")
  const canDecideAgent = usePermission("agent.decide")
  const canReadAgent = usePermission("agent.read")
  const routeSearch = Route.useSearch()
  const showContext = routeSearch.contexto === true
  // La selección deriva solo de la URL: navegar es lo único que cambia el
  // hilo, así el bloqueador del workspace intercepta antes de desmontar.
  // Limpiar el search (undefined) también limpia la selección.
  const selectedId = routeSearch.conversation ?? null
  // El panel de contexto de escritorio se abre con cada hilo y puede ocultarse.
  const [contextOpen, setContextOpen] = useState(true)
  // Borrador del workspace (vía onDraftChange): cerrar el panel en escritorio
  // es estado local y no navega, así que se guarda aquí con confirmación.
  const [wsDraft, setWsDraft] = useState(false)
  const [confirmContextClose, setConfirmContextClose] = useState(false)
  useEffect(() => {
    setContextOpen(true)
    setWsDraft(false)
    setConfirmContextClose(false)
  }, [selectedId])

  // La selección vive en la URL: conservar la conversación permite volver al
  // caso desde cualquier vista y navegar en móvil una vista por vez.
  const selectConversation = useCallback(
    (id: string | null) => {
      void navigate({
        search: (previous) => ({ ...previous, conversation: id ?? undefined, contexto: undefined }),
        replace: true,
      })
    },
    [navigate],
  )
  // Cerrar u ocultar el panel con borrador pide confirmación; sin borrador
  // cierra directo. En móvil el cierre navega y lo guarda el bloqueador.
  const requestCloseContext = useCallback(() => {
    if (wsDraft) setConfirmContextClose(true)
    else setContextOpen(false)
  }, [wsDraft])

  // Consumir la intención una sola vez: retirar el flag con replace.
  // La mutación real la dispara ThreadView con el detalle ya cargado.
  const consumePrepareRegistration = () => {
    void navigate({
      search: (previous) => ({ ...previous, prepareRegistration: undefined }),
      replace: true,
    })
  }

  // Filtros sin la vista ni el estado: los comparten la lista y los totales de los chips.
  const filterParams = useMemo(() => {
    const params = new URLSearchParams()
    if (channel) params.set("channel", channel)
    if (assigned === "me") params.set("assigned", myUserId)
    else if (assigned === "none") params.set("assigned", "none")
    if (search.trim()) params.set("q", search.trim())
    return params.toString()
  }, [channel, assigned, search, myUserId])
  const activeView = view && CHIP_VIEWS.includes(view) ? view : undefined
  // El subtítulo habla de toda la bandeja: con filtros no afirma un total parcial.
  const narrowed = Boolean(channel) || Boolean(assigned) || search.trim() !== ""
  const listParams = useMemo(() => {
    const params = new URLSearchParams(filterParams)
    // Cada chip es abierta o cerrada: «Cerradas» pide las cerradas; las demás, las abiertas.
    params.set("status", activeView === "closed" ? "closed" : "open")
    if (activeView) params.set("view", activeView)
    return params.toString()
  }, [filterParams, activeView])

  // La clave empieza por `conversations`: se invalida junto con la lista.
  const summaryQuery = useQuery({
    queryKey: ["conversations", "summary", filterParams],
    queryFn: () => apiFetch<{ data: InboxSummary }>(`/api/conversations/summary?${filterParams}`),
    enabled: canRead,
  })
  const summary = summaryQuery.data?.data

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

  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const handleOrgEvent = useCallback(
    (kind: string) => {
      const current = selectedRef.current
      if (kind === "stream.reconnected") {
        // Reconexión: refrescar todo lo visible, no solo el hilo.
        void queryClient.invalidateQueries({ queryKey: ["crm-context"] })
        void queryClient.invalidateQueries({ queryKey: ["crm-activity"] })
        void queryClient.invalidateQueries({ queryKey: ["crm-opportunities"] })
        void queryClient.invalidateQueries({ queryKey: ["tasks"] })
        void queryClient.invalidateQueries({ queryKey: ["agent-proposals"] })
      }
      void queryClient.invalidateQueries({ queryKey: ["conversations"] })
      if (current) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", current] })
        void queryClient.invalidateQueries({ queryKey: ["agent-answer-traces", current] })
        void queryClient.invalidateQueries({ queryKey: ["crm-context"] })
        void queryClient.invalidateQueries({ queryKey: ["crm-activity"] })
      }
    },
    [queryClient],
  )
  useOrgEvents(
    [
      "message.created",
      "message.updated",
      "conversation.updated",
      "contact.updated",
      "opportunity.updated",
      "task.updated",
      "agent.proposal.created",
      "agent.proposal.decided",
      "agent.proposal.executed",
      "agent.handoff.created",
      "agent.run.recorded",
      "stream.reconnected",
    ],
    handleOrgEvent,
  )

  const items = useMemo(() => listQuery.data?.pages.flatMap((page) => page.data) ?? [], [listQuery.data])

  const mode = useDetailMode()
  // La columna del agente ocupa el lugar de «Contexto» mientras no quepan los
  // dos; «Contexto» sigue abierto por debajo y vuelve al cerrar el agente. Con
  // un borrador en «Contexto» el agente se abre como cajón y no lo desmonta.
  const agentPanel = useAgentPanel()
  const roomForAgentAndContext = useAgentPanelFitsBesideContext()
  const agentCoversContext =
    agentPanel.open && agentPanel.docked && !roomForAgentAndContext && !wsDraft
  useAgentPanelDockBlocker(mode === "panel" && contextOpen && wsDraft && !roomForAgentAndContext)
  const contextVisible = contextOpen && !agentCoversContext

  // Contacto del hilo seleccionado: sale de la lista; en enlace directo se
  // resuelve con el detalle ya cacheado por ThreadView (misma queryKey).
  const selectedItem = items.find((item) => item.id === selectedId) ?? null
  const contactFallbackQuery = useQuery({
    queryKey: ["conversation", selectedId ?? "ninguna"],
    queryFn: () =>
      apiFetch<{ data: ConversationDetail }>(`/api/conversations/${selectedId}`),
    enabled: canRead && !!selectedId && !selectedItem,
  })
  const workspaceContactId =
    selectedItem?.contact.id ?? contactFallbackQuery.data?.data.contact.id ?? null

  const openContextMobile = useCallback(() => {
    void navigate({ search: (previous) => ({ ...previous, contexto: true }), replace: true })
  }, [navigate])
  const closeContextMobile = useCallback(() => {
    void navigate({
      search: (previous) => ({ ...previous, contexto: undefined }),
      replace: true,
    })
  }, [navigate])

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
      onBack={() => selectConversation(null)}
      showBack={mode !== "panel"}
      onToggleContext={
        !canReadCrm
          ? undefined
          : mode === "panel"
          ? () => {
              if (contextVisible) return requestCloseContext()
              setContextOpen(true)
              // Pedir «Contexto» con el agente en su lugar cierra el agente.
              if (agentCoversContext) agentPanel.setOpen(false)
            }
          : openContextMobile
      }
      contextOpen={mode === "panel" ? contextVisible : true}
      attention={selectedItem?.attention}
      listClosure={selectedItem?.closure}
      canSeeProposals={canDecideAgent || canReadAgent}
    />
  ) : null

  const refreshAfterWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    if (selectedRef.current) {
      void queryClient.invalidateQueries({ queryKey: ["conversation", selectedRef.current] })
    }
  }, [queryClient])

  const workspace =
    canReadCrm && selectedId && workspaceContactId ? (
      <ContactWorkspace
        key={`${workspaceContactId}:${selectedId}`}
        contactId={workspaceContactId}
        conversationId={selectedId}
        onClose={mode === "panel" ? requestCloseContext : closeContextMobile}
        onRefresh={refreshAfterWorkspace}
        onDraftChange={setWsDraft}
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
    // La Bandeja ya reparte la ventana en lista, hilo y «Contexto»: lo que se
    // abre desde aquí va en cajón, no en la columna lateral.
    <SideDockScopeProvider value="fixed">
    <PageShell fill className="gap-4">
      <PageHeader
        title="Bandeja"
        subtitle={narrowed ? DEFAULT_SUBTITLE : waitingSubtitle(summary)}
        actions={
          canWrite && canReadCrm ? (
            <Button className="min-h-11 sm:min-h-9" onClick={() => setNewConversation(true)}>
              <SquarePen className="size-4" aria-hidden />
              Nueva conversación
            </Button>
          ) : undefined
        }
      />
      <NewConversationDialog
        open={newConversation}
        onClose={() => setNewConversation(false)}
        initialQuery={search.trim()}
      />
      {/* En angosto, con un hilo abierto, la pantalla es del hilo: vistas y filtros vuelven con la lista. */}
      <fieldset className={mode !== "panel" && selectedId ? "hidden" : "flex min-w-0 flex-wrap gap-1.5"}>
        <legend className="sr-only">Vista de la bandeja</legend>
        {VIEW_CHIPS.map((chip) => {
          const pressed = activeView === chip.value
          return (
            <Button
              key={chip.label}
              type="button"
              size="sm"
              variant={pressed ? "default" : "outline"}
              aria-pressed={pressed}
              className="min-h-11 rounded-full sm:min-h-9"
              onClick={() => listSearch.setParam("view", chip.value, { replace: true })}
            >
              {chip.label}
              {summary ? ` · ${summary[chip.total]}` : ""}
            </Button>
          )
        })}
      </fieldset>
      {mode === "panel" || !selectedId ? <FilterBar
        filters={[
          {
            key: "channel",
            label: "Canal",
            type: "select",
            options: CHANNEL_FILTER_OPTIONS.map((channel) => ({
              value: channel,
              label: channelLabel(channel),
            })),
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
        sortOptions={[]}
        searchPlaceholder="Buscar por nombre o teléfono"
        searchPending={listQuery.isFetching && !listQuery.isFetchingNextPage}
        resetKeys={["channel", "assigned", "q"]}
      /> : null}
      {/* Con el agente apagado en toda la clínica, lo dice junto a la lista; en angosto, con un hilo abierto, la pantalla es del hilo. */}
      {mode === "panel" || !selectedId ? <ReceptionOffNotice className="shrink-0" /> : null}
      {/* PageShell `fill` acota al viewport: el hilo ocupa el alto restante y el
          composer queda fijo como footer suyo. En escritorio hay tres paneles
          (lista, hilo, contexto); en angosto se muestra una vista por vez y la
          conversación se conserva en la URL. */}
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
              isLoading={listQuery.isLoading && items.length === 0}
              isRefreshing={listQuery.isFetching && !listQuery.isLoading && !listQuery.isFetchingNextPage}
              isError={listQuery.isError}
              hasItems={items.length > 0}
              hasNextPage={listQuery.hasNextPage ?? false}
              isFetchingNextPage={listQuery.isFetchingNextPage}
              onSelect={(id) => selectConversation(id)}
              onFetchNextPage={() => void listQuery.fetchNextPage()}
              onRetry={() => void listQuery.refetch()}
              onNew={canWrite && canReadCrm ? () => setNewConversation(true) : undefined}
              searching={search.trim() !== ""}
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
          {workspace && contextVisible && (
            <>
              <ResizableHandle withHandle className="mx-1 w-4 bg-transparent" />
              <ResizablePanel
                id="contexto"
                defaultSize="30rem"
                minSize="24rem"
                maxSize="40rem"
                className="flex min-h-0 flex-col"
              >
                {workspace}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {!selectedId || (!showContext && !thread) ? (
            <ConversationList
              items={items}
              selectedId={selectedId}
              isLoading={listQuery.isLoading && items.length === 0}
              isRefreshing={listQuery.isFetching && !listQuery.isLoading && !listQuery.isFetchingNextPage}
              isError={listQuery.isError}
              hasItems={items.length > 0}
              hasNextPage={listQuery.hasNextPage ?? false}
              isFetchingNextPage={listQuery.isFetchingNextPage}
              onSelect={(id) => selectConversation(id)}
              onFetchNextPage={() => void listQuery.fetchNextPage()}
              onRetry={() => void listQuery.refetch()}
              onNew={canWrite && canReadCrm ? () => setNewConversation(true) : undefined}
              searching={search.trim() !== ""}
            />
          ) : showContext ? (
            (workspace ??
              // Sin «Contexto» que mostrar (sin `crm.read` o sin la persona del hilo) siempre hay salida al hilo.
              (!canReadCrm ? (
                <EmptyState
                  title="Sin acceso al contexto"
                  description="Tu rol no ve los datos de la persona en el CRM."
                  actionLabel="Volver a la conversación"
                  onAction={closeContextMobile}
                />
              ) : contactFallbackQuery.isError ? (
                <div className="flex flex-col gap-2">
                  <ErrorState
                    message="No se pudo cargar el contexto de la persona."
                    onRetry={() => void contactFallbackQuery.refetch()}
                  />
                  <Button variant="ghost" className="min-h-11 self-center" onClick={closeContextMobile}>
                    Volver a la conversación
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <LoadingState message="Cargando contexto…" />
                  <Button variant="ghost" className="min-h-11 self-center" onClick={closeContextMobile}>
                    Volver a la conversación
                  </Button>
                </div>
              )))
          ) : (
            thread
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmContextClose}
        title="Ocultar contexto con borrador sin guardar"
        description="La nota operativa no se guardó y se perderá al ocultar el contexto. ¿Continuar?"
        confirmLabel="Ocultar sin guardar"
        variant="default"
        onClose={() => setConfirmContextClose(false)}
        onConfirm={() => {
          setConfirmContextClose(false)
          setContextOpen(false)
        }}
      />
    </PageShell>
    </SideDockScopeProvider>
  )
}

/**
 * En qué está la conversación, en palabras del servidor (`attention`,
 * `closure`; ver `conversationWords`). Nunca solo con color: el texto lo dice
 * y la marca solo lo acompaña.
 */
function StateLabel({ words, className = "" }: { words: ConversationWords; className?: string }) {
  if (words.tone === "agent") {
    return (
      <span className={`flex min-w-0 items-center gap-1 font-semibold text-primary-soft-foreground ${className}`}>
        <Bot className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{words.text}</span>
      </span>
    )
  }
  const tone =
    words.tone === "urgent"
      ? "font-semibold text-destructive"
      : words.tone === "team"
        ? "font-semibold text-warning"
        : words.tone === "waiting"
          ? "font-semibold text-foreground"
          : words.tone === "patient"
            ? "font-semibold"
            : ""
  const mark =
    words.tone === "urgent"
      ? "size-2 shrink-0 rounded-full bg-destructive"
      : words.tone === "team"
        ? "size-2 shrink-0 rounded-[2px] bg-warning"
        : words.tone === "waiting"
          ? "size-2 shrink-0 rounded-full bg-primary"
          : null
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${tone} ${className}`}>
      {mark ? <span aria-hidden className={mark} /> : null}
      <span className="truncate">{words.text}</span>
    </span>
  )
}

/**
 * Banda del hilo: el agente propuso una cita en esta conversación y espera el
 * sí del interlocutor. Dice qué y deja claro que nada se ejecuta sin ese sí.
 * Si el interlocutor ya dijo que sí en el chat, «Registrar confirmación» lo
 * deja constancia aquí mismo (la misma operación que Pendientes y «Contexto»:
 * el equipo no aprueba, solo registra lo que la persona ya dijo). «Ver» abre el
 * panel del agente en «Esperan al paciente», donde esa propuesta aparece primero.
 */
function AgentPendingBand({
  conversationId,
  attention,
  canSeeProposals,
}: {
  conversationId: string
  /** Lo que dice la lista; ausente si el hilo se abrió por enlace y no está en la página cargada. */
  attention: ConversationAttention | undefined
  canSeeProposals: boolean
}) {
  const { setOpen } = useAgentPanel()
  const queryClient = useQueryClient()
  const canDecide = usePermission("agent.decide")
  const canConversations = usePermission("conversations.write")
  const canAgenda = usePermission("appointments.write")
  const canCrm = usePermission("crm.write")
  const hinted = attention ? attention.pendingContact : null
  // Misma clave y petición que el panel de contexto: comparten la caché.
  const query = useQuery({
    queryKey: ["agent-proposals", "workspace", conversationId],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>(
        `/api/agent/proposals?status=propuesta&conversationId=${encodeURIComponent(conversationId)}`,
      ),
    enabled: canSeeProposals && hinted !== 0,
  })
  const confirm = useMutation({
    mutationFn: (proposal: AgentProposal) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${proposal.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ contactId: proposal.contactId }),
      }),
    onSuccess: () => {
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-proposals", "conversations", "conversation", "crm-context", "workspace-home"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
  const proposals = query.data?.data ?? []
  // Sin la lista (enlace directo) manda lo que devuelve la consulta del hilo.
  const total = attention?.pendingContact ?? proposals.length
  if (total === 0) return null
  const first = proposals[0]
  const label = first ? (ACTION_LABEL[first.action] ?? first.action) : null
  const what =
    total > 1 ? `${total} cambios` : label ? label.charAt(0).toLowerCase() + label.slice(1) : "un cambio"
  const outcome =
    total === 1
      ? "Espera la confirmación del interlocutor en este hilo."
      : "Esperan la confirmación del interlocutor en este hilo."
  // Registrar aquí la única propuesta pendiente: quien decide por el agente y puede hacer el acto.
  const needed = first ? permissionForAction(first.action) : null
  const canRegister =
    total === 1 && !!first && first.mode === "confirmar_usuario" && first.status === "propuesta" && !!first.contactId &&
    canDecide && canConversations &&
    (needed === "appointments.write" ? canAgenda : needed === "conversations.write" ? canConversations : canCrm)
  const failed = confirm.data ? proposalErrorMessage(confirm.data.data) : null
  const error =
    confirm.error instanceof ApiError
      ? (confirm.error.shape.message ?? "No se pudo registrar la confirmación.")
      : confirm.error
        ? "No se pudo registrar la confirmación."
        : failed
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2.5 border-t border-agent-border bg-agent-soft px-3.5 py-2.5 text-[13px]"
    >
      <AgentMark size="sm" />
      <p className="min-w-0 flex-1 basis-48">
        El agente propuso <span className="font-semibold">{what}</span>. {outcome}
      </p>
      {canRegister && first ? (
        <SubmitButton
          size="sm"
          className="min-h-11 rounded-full sm:min-h-9"
          pending={confirm.isPending}
          onClick={() => {
            confirm.reset()
            confirm.mutate(first)
          }}
        >
          Registrar confirmación
        </SubmitButton>
      ) : null}
      {canSeeProposals ? (
        <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-9" onClick={() => setOpen(true, "paciente")}>
          Ver
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Listado de conversaciones: filas, vacío y paginación por cursor. */
function ConversationList({
  items,
  selectedId,
  isLoading,
  isRefreshing,
  isError,
  hasItems,
  hasNextPage,
  isFetchingNextPage,
  onSelect,
  onFetchNextPage,
  onRetry,
  onNew,
  searching = false,
}: {
  items: ConversationListItem[]
  selectedId: string | null
  isLoading: boolean
  isRefreshing: boolean
  isError: boolean
  hasItems: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onSelect: (id: string) => void
  onFetchNextPage: () => void
  onRetry: () => void
  /** «Nueva conversación»: el vacío ofrece escribirle a alguien. */
  onNew?: () => void
  /** Hay una búsqueda: el vacío dice que nadie coincide. */
  searching?: boolean
}) {
  return (
    // El desplazamiento de la lista es el de la aplicación (ScrollArea), no la barra nativa.
    <ScrollArea className="elevated min-h-0 flex-1 rounded-xl border bg-card">
    <div className="flex flex-col divide-y">
      {items.map((item) => {
        const selected = item.id === selectedId
        const initials = item.contact.displayName.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("")
        const ChannelIcon = channelIcon(item.connection.channel)
        const words = conversationWords(item)
        return (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          aria-current={selected ? "true" : undefined}
          className={`relative flex gap-2.5 px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
            selected ? "bg-agent-soft shadow-[inset_3px_0_0_0_var(--color-primary)]" : "hover:bg-muted/70"
          }`}
        >
          <span
            aria-hidden
            className={`flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
              selected ? "bg-primary-soft text-primary-soft-foreground" : "bg-secondary"
            }`}
          >
            {initials || "?"}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className={`truncate text-sm ${item.unreadCount > 0 ? "font-bold" : "font-semibold"}`}>
                {item.contact.displayName}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.lastMessageAt)}</span>
            </span>
            <span className="truncate text-[13px] text-muted-foreground">
              {item.preview?.body ?? (item.preview ? "[adjunto]" : "—")}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ChannelIcon className="size-3.5 shrink-0" aria-hidden />
              {/* Con el estado a la vista, el canal queda en su icono: el estado no debe recortarse. */}
              <span className={words ? "sr-only" : "truncate"}>{channelLabel(item.connection.channel)}</span>
              {words ? <StateLabel words={words} /> : null}
              {item.unreadCount > 0 && (
                <span
                  className="ml-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground"
                  aria-label={`${item.unreadCount} sin leer`}
                >
                  {item.unreadCount}
                </span>
              )}
            </span>
          </span>
        </button>
        )
      })}
      {isRefreshing && hasItems ? (
        <div className="p-2">
          <DataRefreshMarker />
        </div>
      ) : null}
      {isLoading && !hasItems && (
        <LoadingState className="m-3" message="Cargando conversaciones…" />
      )}
      {isError && !hasItems && !isLoading && (
        <div className="flex flex-wrap items-center gap-2 p-4">
          <p className="text-sm text-destructive" role="alert">
            No se pudieron cargar las conversaciones.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Reintentar
          </Button>
        </div>
      )}
      {!isError && !hasItems && !isLoading && (
        <EmptyState
          title={searching ? "Nadie coincide con la búsqueda" : "Sin conversaciones"}
          description={
            searching
              ? "Busca por nombre o por teléfono. Si aún no le escribiste, empieza una conversación."
              : "Los mensajes entrantes aparecen aquí."
          }
          actionLabel={onNew ? "Nueva conversación" : undefined}
          onAction={onNew}
        />
      )}
      {isError && hasItems ? (
        <div className="flex flex-wrap items-center gap-2 p-4">
          <p className="text-sm text-destructive" role="alert">
            No se pudo actualizar la lista; se conservan las conversaciones cargadas.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Reintentar solo la lista
          </Button>
        </div>
      ) : null}
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={onFetchNextPage}
        >
          {isFetchingNextPage ? (
            <>
              <Spinner className="size-6" aria-hidden />
              Cargar más
            </>
          ) : (
            "Cargar más"
          )}
        </Button>
      )}
    </div>
    </ScrollArea>
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
  showBack,
  onToggleContext,
  contextOpen,
  attention,
  listClosure,
  canSeeProposals,
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
  showBack?: boolean
  onToggleContext?: () => void
  contextOpen?: boolean
  /** Estado de atención del hilo según la lista; ausente si se abrió por enlace y aún no está en la página cargada. */
  attention?: ConversationAttention
  /** Cierre según la lista, mientras llega el detalle. */
  listClosure?: ConversationClosure | null
  canSeeProposals: boolean
}) {
  const queryClient = useQueryClient()
  const [composer, setComposer] = useState("")
  const [older, setOlder] = useState<ChatMessage[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // WhatsApp cerró la ventana de 24 horas con el hilo ya abierto: el servidor lo dijo al enviar.
  const [windowClosed, setWindowClosed] = useState(false)
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

  // En qué se basó cada respuesta del agente: solo se ofrece en los mensajes que la tienen.
  const tracesQuery = useQuery({
    queryKey: ["agent-answer-traces", id],
    queryFn: () => apiFetch<{ data: AnswerTrace[] }>(`/api/agent/answer-traces?conversationId=${id}`),
    enabled: canRead,
  })
  const traceByMessage = useMemo(() => {
    const map = new Map<string, AnswerTrace>()
    // Llegan de la más reciente a la más antigua: la primera de cada mensaje es la vigente.
    for (const trace of tracesQuery.data?.data ?? []) {
      if (trace.messageId && !map.has(trace.messageId)) map.set(trace.messageId, trace)
    }
    return map
  }, [tracesQuery.data])
  const [openTrace, setOpenTrace] = useState<AnswerTrace | null>(null)
  // Marcar una respuesta del agente (bien o por corregir) es de quien atiende
  // conversaciones; lo que se aprende lo aprueba quien administra el agente.
  const canDecideAgent = usePermission("agent.decide")
  const canWriteConversations = usePermission("conversations.write")
  const canCorrectAgent = canDecideAgent || canWriteConversations
  const canManageAgent = usePermission("agent.write")
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null)
  // Resumen del caso para quien lo toma; guarda la conversación para que no siga abierto al cambiar de hilo.
  const canTakeCase = usePermission("conversations.write")
  const myUserId = useMyUserId()
  // Quien aún no es paciente solo lo ven recepción y quien dirige (`crm.read`); caja y odontología, solo pacientes.
  const canOpenPeople = usePermission("patients.read")
  const canSeeNonPatients = usePermission("crm.read")
  const [briefFor, setBriefFor] = useState<string | null>(null)

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
    setOpenTrace(null)
    setCorrecting(null)
    setConfirming(null)
  }, [id])

  useEffect(() => {
    if (detail && detail.conversation.unreadCount > 0 && markedRef !== id) {
      setMarkedRef(id)
      void apiFetch(`/api/conversations/${id}/read`, { method: "POST" }).then(() =>
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      )
    }
  }, [detail, id, markedRef, queryClient])

  // Cuando la persona vuelve a escribir, la ventana se abre de nuevo: manda lo que diga el servidor.
  const lastInboundAt = detail?.whatsappWindow?.lastInboundAt
  useEffect(() => {
    setWindowClosed(false)
  }, [lastInboundAt])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", id] })
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
  }

  const registrationMutation = useMutation({
    // Quien ya es paciente registra a un familiar; quien aún no lo es recibe «Su enlace» (ADR 0037).
    mutationFn: (contactId: string) =>
      detail?.contact.isPatient ? createRegistrationLink(contactId, id) : createPersonalLinkForContact(contactId, id),
    onSuccess: (result) => {
      const url = result.data.url
      setRegistrationLink(result.data)
      setRegistrationError(null)
      setCopied(false)
      // Preparar el borrador en el composer existente; el operador revisa y envía.
      // Nunca se envía automáticamente al generar el enlace. Quien ya es paciente
      // lo recibe para registrar a un familiar: el enlace no le ofrece registrarse.
      setComposer(
        detail?.contact.isPatient
          ? `Aquí puedes registrar a tu hijo o a un familiar en ${orgName}: ${url}`
          : `Aquí puedes elegir tu cita y dejarnos tus datos en ${orgName}: ${url}`,
      )
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
    onError: sendFailed,
  })

  /**
   * Un envío que no salió. Si WhatsApp cerró la ventana de 24 horas mientras se
   * escribía, la zona pasa a ofrecer los mensajes aprobados y lo escrito se
   * conserva; en lo demás se dice el motivo con las palabras del servidor.
   */
  function sendFailed(error: unknown) {
    const closedNow = error instanceof ApiError && error.shape.code === "WINDOW_CLOSED"
    if (closedNow && detail?.connection.capabilities?.templates) {
      setWindowClosed(true)
      setSendError(null)
      void queryClient.invalidateQueries({ queryKey: ["conversation", id] })
      return
    }
    // Conexión desactivada u otro fallo real: bloquear el envío con el motivo.
    setSendError(error instanceof ApiError ? error.message : "No se pudo enviar el mensaje")
  }

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
      sendFailed(error)
      throw error
    } finally {
      setUploading(false)
    }
  }

  // Tomar, devolver al agente, resolver, cerrar sin resolver, reabrir y asignar:
  // cada una es una operación del servidor; la pantalla solo refresca lo que la muestra.
  const actionMutation = useMutation({
    retry: false,
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      apiFetch(`/api/conversations/${id}${path}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: () => {
      setConfirming(null)
      invalidate()
      // Tomar y resolver también cambian sus casos derivados y las citas propuestas.
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-case-brief", "crm-context", "crm-activity"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
  const actionError =
    actionMutation.error instanceof ApiError
      ? actionMutation.error.shape.message
      : actionMutation.error
        ? "No se pudo completar la acción. Inténtalo de nuevo."
        : null
  // Resolver y cerrar sin resolver confirman antes con lo que dice el servidor que pasará.
  const [confirming, setConfirming] = useState<"resolve" | "close" | null>(null)
  const previewQuery = useQuery({
    queryKey: ["conversation-resolve-preview", id],
    queryFn: () => apiFetch<{ data: ResolvePreview }>(`/api/conversations/${id}/resolve-preview`),
    enabled: confirming !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
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
    } catch (error) {
      // Lo ya cargado se conserva; se avisa y el botón queda para volver a intentarlo.
      toast.error(
        error instanceof ApiError && error.shape.message
          ? error.shape.message
          : "No se pudieron cargar los mensajes anteriores. Vuelve a intentarlo.",
      )
    } finally {
      setLoadingOlder(false)
    }
  }

  // Sin detalle aún no hay estructura que anticipar; con detalle en caché el
  // refetch (automático o manual) nunca lo retira: sigue visible abajo.
  if (detailQuery.isPending && !detail) {
    return <LoadingState className="min-h-0 flex-1" message="Cargando la conversación…" />
  }
  if (!detail) {
    // Solo 404/403 dicen que no está o que no hay acceso; otro fallo (red, servidor) se reintenta.
    const gone =
      detailQuery.error instanceof ApiError && (detailQuery.error.status === 404 || detailQuery.error.status === 403)
    return (
      <div className="flex flex-col gap-2 p-4">
        {showBack && (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Volver">
            <ChevronLeft className="size-4" />
          </Button>
        )}
        {gone ? (
          <EmptyState
            title="Conversación no disponible"
            description="Esta conversación ya no está disponible o no tienes acceso."
            actionLabel="Volver a la bandeja"
            onAction={onBack}
          />
        ) : (
          <>
            <ErrorState
              message="No se pudo cargar la conversación. Revisa la conexión y vuelve a intentarlo."
              onRetry={() => void detailQuery.refetch()}
            />
            <Button variant="ghost" size="sm" className="self-center" onClick={onBack}>
              Volver a la bandeja
            </Button>
          </>
        )}
      </div>
    )
  }

  const conv = detail.conversation
  const closed = conv.status === "closed"
  // La ventana de 24 horas de WhatsApp la dice el servidor con el hilo, antes de que nadie escriba.
  const windowShut = windowClosed || detail.whatsappWindow?.open === false
  // La atención del propio hilo manda; la de la lista solo adelanta el dato
  // mientras llega el detalle. Sin ninguna, la cabecera calla: no se deduce aquí.
  const threadAttention = detail.attention ?? attention
  // El estado del detalle manda: reabierta, la lista podría traer todavía el cierre anterior.
  const closure = closed ? (detail.closure ?? conv.closure ?? listClosure ?? null) : null
  const words = conversationWords({ status: conv.status, attention: threadAttention, closure })
  const assignee = members.find((m) => m.userId === conv.assignedUserId)
  // «Tomar» mientras no la tenga quien mira con el agente apagado; «Devolver al
  // agente» mientras la tenga una persona. Cerrada, escribir la reabre.
  const takenByMe = conv.assignedUserId === myUserId && conv.agentStatus !== "on"
  const withPerson = conv.agentStatus !== "on" || conv.assignedUserId !== null
  const busy = actionMutation.isPending
  const name = detail.contact.displayName
  const preview = previewQuery.data?.data
  const resolveText = preview ? resolveWords(name, preview) : null
  const closeAlso = preview ? pendingWords(preview.handoffs, preview.pendingContact, "cerrar") : []
  const previewError =
    previewQuery.error instanceof ApiError
      ? previewQuery.error.shape.message
      : previewQuery.error
        ? "No se pudo consultar qué pasará al cerrarla."
        : null

  return (
    <div className="elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      {detailQuery.isError ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <p className="text-xs text-destructive" role="alert">
            No se pudo actualizar el hilo; se conserva la conversación cargada.
          </p>
          <Button variant="link" size="sm" onClick={() => void detailQuery.refetch()}>
            Reintentar solo el hilo
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        {showBack && (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Volver">
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          {/* El nombre lleva a la página de la persona (ADR 0029): también para odontología, que la ve sin el CRM si es paciente. */}
          {canOpenPeople && (canSeeNonPatients || detail.contact.isPatient) ? (
            <Link
              to="/people/$personId"
              params={{ personId: detail.contact.id }}
              className="block truncate text-[15px] font-bold hover:underline"
            >
              {detail.contact.displayName}
            </Link>
          ) : (
            <span className="block truncate text-[15px] font-bold">{detail.contact.displayName}</span>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{channelLabel(detail.connection.channel)}</span>
            {words ? (
              <>
                <span aria-hidden>·</span>
                <StateLabel words={words} />
              </>
            ) : null}
            {detail.contact.isActive === false && <Badge variant="secondary">Archivado</Badge>}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2">
        {threadAttention?.handoffPriority ? (
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setBriefFor(conv.id)}>
            <ClipboardList className="size-4" />
            Resumen del caso
          </Button>
        ) : null}
        {canWrite && !closed && !takenByMe ? (
          <SubmitButton
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            pending={busy && actionMutation.variables?.path === "/take"}
            disabled={busy}
            onClick={() => actionMutation.mutate({ path: "/take" })}
          >
            <Hand className="size-4" aria-hidden />
            Tomar
          </SubmitButton>
        ) : null}
        {/* Con un caso del agente abierto no se devuelve: antes se resuelve (el servidor responde HANDOFF_OPEN). */}
        {canWrite && !closed && withPerson && !threadAttention?.handoffPriority ? (
          <SubmitButton
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            pending={busy && actionMutation.variables?.path === "/release"}
            disabled={busy}
            onClick={() => actionMutation.mutate({ path: "/release" })}
          >
            <Bot className="size-4" aria-hidden />
            Devolver al agente
          </SubmitButton>
        ) : null}
        {canWrite && !closed ? (
          <Button
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={busy}
            onClick={() => {
              actionMutation.reset()
              setConfirming("resolve")
            }}
          >
            <CheckCircle2 className="size-4" aria-hidden />
            Resolver
          </Button>
        ) : null}
        {onToggleContext && (
          <Button
            variant={contextOpen ? "secondary" : "outline"}
            size="sm"
            className="min-h-11 sm:min-h-8"
            aria-pressed={contextOpen}
            onClick={onToggleContext}
            title="Mostrar el contexto del contacto (persona, oportunidades, agente)"
          >
            <PanelRight className="size-4" />
            Contexto
          </Button>
        )}
        {/* Quien ya tiene su ficha no se registra otra vez: su enlace es para un familiar. */}
        {canRegister && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={registrationMutation.isPending}
            onClick={() => registrationMutation.mutate(detail.contact.id)}
            title="Genera un enlace y prepara el mensaje para revisión; no se envía solo"
          >
            {registrationMutation.isPending ? (
              <Spinner className="size-6" aria-hidden />
            ) : (
              <UserPlus className="size-4" />
            )}
            {detail.contact.isPatient ? "Enviar registro de un familiar" : "Enviarle su enlace"}
          </Button>
        )}
        {canWrite && (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex min-h-11 items-center rounded-4xl bg-secondary px-3 text-sm font-medium transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:min-h-0">
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
        {canWrite ? (
          <RowActions
            label="Más acciones de la conversación"
            items={
              closed
                ? [{ key: "reabrir", label: "Reabrir", disabled: busy, onSelect: () => actionMutation.mutate({ path: "/reopen" }) }]
                : [
                    {
                      key: "cerrar",
                      label: "Cerrar sin resolver",
                      disabled: busy,
                      onSelect: () => {
                        actionMutation.reset()
                        setConfirming("close")
                      },
                    },
                  ]
            }
          />
        ) : null}
        </div>
        {actionError && confirming === null ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {actionError}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming === "resolve"}
        title="¿Resolver la conversación?"
        description={
          resolveText?.description ??
          (previewError ? "No se pudo consultar qué pasará al resolverla." : "Consultando qué pasará al resolverla…")
        }
        confirmLabel="Resolver"
        variant="default"
        pending={busy}
        confirmDisabled={!preview}
        onClose={() => setConfirming(null)}
        onConfirm={() => actionMutation.mutate({ path: "/resolve" })}
      >
        {/* La misma pieza que completar la tarea de un caso en Tareas y en «Contexto». */}
        {preview ? <ResolvePreviewDetails name={name} preview={preview} /> : null}
        {previewError || (confirming === "resolve" && actionError) ? (
          <p role="alert" className="text-sm text-destructive">
            {confirming === "resolve" && actionError ? actionError : previewError}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === "close"}
        title="¿Cerrar sin resolver?"
        description={closeWithoutResolvingWords(name)}
        confirmLabel="Cerrar sin resolver"
        variant="default"
        pending={busy}
        // Cerrar no le escribe nada: si no se pudo consultar qué más se cierra, se dice y se deja cerrar.
        confirmDisabled={!preview && !previewError}
        onClose={() => setConfirming(null)}
        onConfirm={() => actionMutation.mutate({ path: "/close" })}
      >
        {closeAlso.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {closeAlso.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {!preview && !previewError ? (
          <p className="text-sm text-muted-foreground" role="status">
            Consultando qué más se cierra…
          </p>
        ) : null}
        {previewError || (confirming === "close" && actionError) ? (
          <p role="alert" className="text-sm text-destructive">
            {confirming === "close" && actionError ? actionError : previewError}
          </p>
        ) : null}
      </ConfirmDialog>

      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        {/* El historial conserva siempre un alto útil: la zona de escritura (p. ej. los
            mensajes aprobados) no puede dejarlo en cero. */}
        <MessageScroller className="min-h-32 flex-1">
          <MessageScrollerViewport preserveScrollOnPrepend className="bg-canvas/60 p-4">
            {(olderCursor ?? detail.messagesCursor) && (
              <Button
                variant="ghost"
                size="sm"
                className="mb-2 w-fit"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? (
                  <>
                    <Spinner className="size-6" aria-hidden />
                    Cargar anteriores
                  </>
                ) : (
                  "Cargar anteriores"
                )}
              </Button>
            )}
            <MessageScrollerContent className="gap-2">
              {messages.map((msg) => (
                <MessageScrollerItem key={msg.id} messageId={msg.id}>
                  <MessageBubble
                    msg={msg}
                    conversationId={id}
                    orgSlug={orgSlug}
                    onShowTrace={
                      traceByMessage.has(msg.id) ? () => setOpenTrace(traceByMessage.get(msg.id) ?? null) : undefined
                    }
                  />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
            {closure ? (
              <div className="mt-3 flex justify-center">
                <p className="rounded-full border bg-card px-3 py-1 text-center text-xs font-medium text-muted-foreground">
                  {closureBand(closure)}
                </p>
              </div>
            ) : null}
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      <CaseBriefDrawer
        conversationId={briefFor === conv.id ? conv.id : null}
        name={detail.contact.displayName}
        canTake={canTakeCase}
        inConversation
        onClose={() => setBriefFor(null)}
        onClaimed={() => void detailQuery.refetch()}
      />
      <AnswerTraceDrawer
        trace={openTrace}
        onClose={() => setOpenTrace(null)}
        canMark={canCorrectAgent}
        onOpenLesson={
          canManageAgent
            ? (id) => {
                setOpenTrace(null)
                setLessonId(id)
              }
            : undefined
        }
        onCorrect={
          canCorrectAgent
            ? (trace) => {
                // La pregunta es el último mensaje del interlocutor antes de esa respuesta.
                const at = messages.findIndex((item) => item.id === trace.messageId)
                const asked = at > 0 ? [...messages.slice(0, at)].reverse().find((item) => item.direction === "in") : undefined
                setOpenTrace(null)
                setCorrecting({ traceId: trace.id, question: trace.question ?? asked?.body ?? "", reply: trace.replyText, teamReply: null, basis: trace.basis })
              }
            : undefined
        }
      />
      <CorrectDrawer target={correcting} onClose={() => setCorrecting(null)} />
      <LessonDrawer lessonId={lessonId} canWrite={canManageAgent} onClose={() => setLessonId(null)} />
      <AgentPendingBand conversationId={id} attention={threadAttention} canSeeProposals={canSeeProposals} />
      {/* Como mucho el 60 % del hilo y con su propio desplazamiento: con la ventana de WhatsApp
          cerrada, el aviso y los mensajes aprobados no se comen el historial (antes quedaba en 0 px). */}
      <ScrollArea className="flex max-h-[60%] min-h-0 flex-col border-t [&_[data-slot=scroll-area-viewport]]:h-auto [&_[data-slot=scroll-area-viewport]]:min-h-0 [&_[data-slot=scroll-area-viewport]]:flex-1">
      <div className="flex flex-col p-3">
        {detail.contact.isActive === false && (
          <p className="mb-2 text-xs text-muted-foreground">
            Contacto archivado: las conversaciones siguen accesibles, pero reactívalo para iniciar
            nuevos envíos o crear relaciones.
          </p>
        )}
        {registrationError && (
          <p className="mb-2 text-sm text-destructive" role="alert">
            {registrationError}
          </p>
        )}
        {registrationLink && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
            <span className="min-w-0 flex-1 truncate" title={registrationLink.url}>
              {detail.contact.isPatient ? "Enlace de registro" : "Su enlace"} listo para revisar antes de enviar: {registrationLink.url}
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
        {closed && canWrite ? (
          <p className="mb-2 text-xs text-muted-foreground">Está cerrada: si le escribes, se vuelve a abrir.</p>
        ) : null}
        {!canWrite ? (
          <p className="text-sm text-muted-foreground">
            Sin permiso de escritura de conversaciones.
          </p>
        ) : windowShut ? (
          // Pasaron las 24 horas de WhatsApp: se dice antes de escribir y se ofrecen los mensajes aprobados.
          <InboxApprovedMessages
            // Otra conversación es otra elección: no arrastra lo elegido ni el error de la anterior.
            key={id}
            conversationId={id}
            contactName={detail.contact.displayName}
            lastInboundAt={detail.whatsappWindow?.lastInboundAt}
            draft={composer}
            onSent={invalidate}
          />
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
                    lang={activeOrgLocale() ?? "es"}
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
              <p className="text-sm text-destructive" role="alert">
                {sendError}
              </p>
            )}
          </div>
        )}
      </div>
      </ScrollArea>
    </div>
  )
}

function statusIcon(status: string) {
  if (status === "read") return <CheckCheck className="size-3.5 text-primary" />
  if (status === "delivered" || status === "sent")
    return <CheckCheck className="size-3.5 text-muted-foreground" />
  if (status === "unknown") return <AlertCircle className="size-3.5 text-warning" />
  if (status === "failed") return <AlertCircle className="size-3.5 text-destructive" />
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
  onShowTrace,
}: {
  msg: ChatMessage
  conversationId: string
  orgSlug: string
  /** Presente solo si el mensaje tiene traza: abre «En qué se basó». */
  onShowTrace?: () => void
}) {
  const out = msg.direction === "out"
  const byAgent = msg.senderKind === "agent"
  // La línea del Administrador solo la abre quien puede ver el agente.
  const canOpenLine = usePermission("agent.read")
  return (
    <Message from={out ? "user" : "assistant"}>
      <MessageContent
        className={
          !out
            ? "rounded-2xl rounded-bl-md border bg-card px-4 py-2.5"
            : byAgent
              ? "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:border group-[.is-user]:border-agent-border group-[.is-user]:bg-agent-soft group-[.is-user]:py-2.5"
              : "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:py-2.5"
        }
      >
        {byAgent && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold text-primary-soft-foreground">
            <span className="flex items-center gap-1">
              <Bot className="size-3.5" aria-hidden /> {msg.automatic ? `Automático · ${msg.automatic.name}` : "Agente"}
            </span>
            {/* Un mensaje automático no es una respuesta de la conversación: dice de qué línea salió. */}
            {msg.automatic && canOpenLine ? (
              <Link to="/agent/administrador" search={{ linea: msg.automatic.key }} className="font-normal underline-offset-2 hover:underline">
                Por qué salió
              </Link>
            ) : null}
          </div>
        )}
        {/* WhatsApp muestra la media arriba y el texto (caption o transcripción) abajo. */}
        <MessageAttachments msg={msg} conversationId={conversationId} orgSlug={orgSlug} />
        {msg.contentType === "template" ? (
          // Con el texto armado se ve lo que la persona recibió; los anteriores a eso no lo guardaron.
          msg.body ? (
            <p className="whitespace-pre-wrap">{msg.body}</p>
          ) : (
            <span className="italic opacity-80">
              Mensaje aprobado por WhatsApp{(msg.templateParams ?? []).length > 0 ? `: ${(msg.templateParams ?? []).join(" · ")}` : ""}
            </span>
          )
        ) : (
          msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>
        )}
        <div
          className={`flex items-center gap-1 text-xs text-muted-foreground ${out ? "justify-end" : ""}`}
        >
          {/* Fecha cuando no es de hoy y siempre en la zona de la clínica; el título la dice completa. */}
          <time dateTime={msg.createdAt} title={fullWhenWords(msg.createdAt)}>
            {messageTimeWords(msg.createdAt)}
          </time>
          {out && statusIcon(msg.status)}
        </div>
        {onShowTrace ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto min-h-11 justify-end self-end p-0 text-xs font-semibold sm:min-h-0"
            onClick={onShowTrace}
          >
            En qué se basó
          </Button>
        ) : null}
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
