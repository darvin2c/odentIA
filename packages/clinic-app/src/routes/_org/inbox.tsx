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
  Tabs,
  TabsTrigger,
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
import {
  AgentMark,
  ConfirmDialog,
  DataRefreshMarker,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  PageShell,
  personInitials,
  RowActions,
  ScrollingTabsList,
  SideDockScopeProvider,
  SpeechInput,
  SubmitButton,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import {
  AlertCircle,
  Ban,
  Bot,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  Copy,
  Hand,
  MapPin,
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
  type InboxTopic,
  type PersonChannel,
  previewWords,
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
import { CapReachedNotice, ReceptionOffNotice } from "../../components/agent/reception-off-notice"
import { CorrectDrawer, type CorrectionTarget } from "../../components/agent/correct-drawer"
import type { AnswerTrace } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { ContactWorkspace } from "../../components/crm/contact-workspace"
import { ResolvePreviewDetails } from "../../components/crm/resolve-preview"
import { InboxApprovedMessages } from "../../components/integrations/whatsapp/inbox-approved-messages"
import { ACTION_LABEL, type AgentProposal, permissionForAction, proposalErrorMessage } from "../../lib/agent"
import { channelIcon, channelLabel } from "../../lib/channels"
import { NewConversationDialog } from "../../components/inbox-new-conversation"
import {
  BlockPersonDialog,
  ContactScreenBanner,
  conversationTarget,
  type ScreenTarget,
  UnblockDialog,
  useContactScreenActions,
} from "../../components/inbox-contact-screen"
import { screenReasonWords } from "../../lib/contact-screen"
import { isReceiptOnly, useOrgEvents } from "../../lib/org-events"
import { createPersonalLinkForContact, createRegistrationLink } from "../../lib/patient-registration"
import { filiationGapsText } from "../../lib/patients"
import { activeOrgLocale } from "../../lib/locale"
import {
  channelsWords,
  clockWords,
  closeWithoutResolvingWords,
  closureBand,
  type ConversationWords,
  conversationWords,
  dayWords,
  fullWhenWords,
  listTimeWords,
  messageDayKey,
  topicQuote,
  topicWords,
  pendingWords,
  replyWindowWords,
} from "../../lib/conversation-state"

export const Route = createFileRoute("/_org/inbox")({
  validateSearch: (search: Record<string, unknown>) => ({
    conversation: typeof search.conversation === "string" ? search.conversation : undefined,
    ...(search.prepareRegistration === true || search.prepareRegistration === "true"
      ? { prepareRegistration: true as const }
      : {}),
    ...(typeof search.q === "string" ? { q: search.q } : {}),
    ...(typeof search.channel === "string" ? { channel: search.channel } : {}),
    ...(search.mine === "1" || search.mine === 1 ? { mine: "1" } : {}),
    ...(typeof search.view === "string" ? { view: search.view } : {}),
    ...(search.contexto === true || search.contexto === "true"
      ? { contexto: true as const }
      : {}),
  }),
  component: InboxPage,
})
const orgRouteApi = getRouteApi("/_org")

/**
 * La fila de la lista es la persona (fase 4 del pulido): sigue elegida al abrir
 * cualquiera de sus conversaciones, también desde un enlace viejo.
 */
function isRowOf(item: ConversationListItem, id: string | null): boolean {
  return id !== null && (item.id === id || (item.conversationIds ?? []).includes(id))
}

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
 * Las cuatro pestañas de la Bandeja (ADR 0050): no se superponen, así cada
 * conversación está en una sola y los números suman. Sin vista en la URL se
 * abre «Por atender», lo único que pide a una persona. Solo valen las que
 * tienen pestaña: una vista sin control visible dejaría la lista filtrada sin
 * forma de verlo ni de salir.
 */
const VIEW_CHIPS = [
  { value: "attend", label: "Por atender", total: "attend" },
  // Su texto dice el nombre del agente de recepción de la clínica: `chipLabel`.
  { value: "agent", label: "Las atiende", total: "agent" },
  { value: "awaiting_patient", label: "Esperan al paciente", total: "awaitingPatient" },
  { value: "closed", label: "Cerradas", total: "closed" },
] as const satisfies readonly { value: string; label: string; total: keyof InboxSummary }[]
const CHIP_VIEWS: readonly string[] = VIEW_CHIPS.map((chip) => chip.value)
const chipLabel = (chip: (typeof VIEW_CHIPS)[number], receptionName: string) =>
  chip.value === "agent" ? `${chip.label} ${receptionName}` : chip.label
/**
 * Spam y Bloqueados (ADR 0054): dos listas aparte, junto a las pestañas y sin
 * contar en sus totales. Spam lleva su número; Bloqueados, no: no es trabajo.
 */
const SIDE_VIEWS = ["spam", "blocked"] as const
type SideView = (typeof SIDE_VIEWS)[number]
const isSideView = (value: string | null | undefined): value is SideView =>
  value === "spam" || value === "blocked"
const DEFAULT_VIEW = "attend"
const DEFAULT_SUBTITLE = "Todas las conversaciones de la clínica"

/** Lo abierto y lo que pide a una persona; con filtros activos la cifra la da la pestaña, no el subtítulo. */
function waitingSubtitle(summary: InboxSummary | undefined): string {
  if (!summary) return DEFAULT_SUBTITLE
  const open = summary.open === 1 ? "1 abierta" : `${summary.open} abiertas`
  if (summary.attend === 0) return `${open} · nada por atender`
  return `${open} · ${summary.attend} por atender`
}

function InboxPage() {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
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
  // «Solo las mías»: los temas de quien mira y los que nadie tomó (ADR 0050).
  const mine = listSearch.get("mine") === "1"
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
    if (mine) params.set("mine", "1")
    if (search.trim()) params.set("q", search.trim())
    return params.toString()
  }, [channel, mine, search])
  const activeView = view && (CHIP_VIEWS.includes(view) || isSideView(view)) ? view : DEFAULT_VIEW
  const sideView = isSideView(activeView) ? activeView : null
  // El subtítulo habla de toda la bandeja: con filtros no afirma un total parcial.
  const narrowed = Boolean(channel) || mine || search.trim() !== ""
  const listParams = useMemo(() => {
    const params = new URLSearchParams(filterParams)
    // Cada pestaña es abierta o cerrada: «Cerradas» pide las cerradas; las demás, las abiertas.
    // Spam y Bloqueados muestran todo lo de esas personas, abierto o cerrado.
    if (!isSideView(activeView)) params.set("status", activeView === "closed" ? "closed" : "open")
    params.set("view", activeView)
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

  // «No es spam» y «Desbloquear» desde la fila de Spam y Bloqueados (ADR 0054).
  const screenActions = useContactScreenActions()
  const [unblockTarget, setUnblockTarget] = useState<ScreenTarget | null>(null)
  const rowScreenAction = (item: ConversationListItem) => {
    const target = conversationTarget(item.id, item.contact.displayName)
    if (item.contact.screen === "blocked") setUnblockTarget(target)
    else screenActions.notSpam.mutate(target)
  }

  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const handleOrgEvent = useCallback(
    (kind: string, data: unknown) => {
      const current = selectedRef.current
      if (isReceiptOnly(kind, data)) {
        // Solo el acuse: la lista no cambia; el hilo abierto muestra «Entregado» o «Leído».
        if (current) void queryClient.invalidateQueries({ queryKey: ["conversation"] })
        return
      }
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
        // El hilo junta los canales de la persona y puede responder por otro: se refresca cualquiera abierto.
        void queryClient.invalidateQueries({ queryKey: ["conversation"] })
        void queryClient.invalidateQueries({ queryKey: ["agent-answer-traces"] })
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
  // «Siguiente tema por atender»: la siguiente fila de «Por atender» que aún tiene un tema.
  const nextTopicId =
    activeView === "attend"
      ? (items.find((item) => !isRowOf(item, selectedId) && (item.attention?.topics?.length ?? 0) > 0)?.id ?? null)
      : null
  // Con el teclado: J y K pasan entre conversaciones, R lleva a la caja de texto (fuera de un campo).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
      if (document.querySelector("[role=dialog]")) return
      const key = event.key.toLowerCase()
      if (key !== "j" && key !== "k" && key !== "r") return
      if (key === "r") {
        const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensaje"]')
        if (!box) return
        event.preventDefault()
        box.focus()
        return
      }
      if (items.length === 0) return
      event.preventDefault()
      const at = items.findIndex((item) => isRowOf(item, selectedId))
      const next = key === "j" ? Math.min(items.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1)
      const target_ = items[next]
      if (target_) selectConversation(target_.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [items, selectedId, selectConversation])

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
  const selectedItem = items.find((item) => isRowOf(item, selectedId)) ?? null
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
      openId={selectedId}
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
      row={selectedItem ? { id: selectedItem.id, status: selectedItem.status } : undefined}
      canSeeProposals={canDecideAgent || canReadAgent}
      startOnTopic={activeView === "attend"}
      onNextTopic={nextTopicId ? () => selectConversation(nextTopicId) : undefined}
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
        bare={mode !== "panel"}
        onClose={mode === "panel" ? requestCloseContext : undefined}
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
      {/* En el celular, con una conversación abierta, la pantalla es de la conversación:
          la cabecera de la Bandeja vuelve con la lista (tablero 3 del pulido). */}
      {mode === "panel" || !selectedId ? (
        <PageHeader
          title="Bandeja"
          subtitle={narrowed ? DEFAULT_SUBTITLE : waitingSubtitle(summary)}
          primary={
            canWrite && canReadCrm
              ? { label: "Nueva conversación", icon: <SquarePen className="size-4" aria-hidden />, onClick: () => setNewConversation(true) }
              : undefined
          }
        />
      ) : (
        <h1 className="sr-only">Bandeja</h1>
      )}
      <NewConversationDialog
        open={newConversation}
        onClose={() => setNewConversation(false)}
        initialQuery={search.trim()}
      />
      {/* Pestañas a la izquierda y filtros a la derecha, en una sola fila (bajan a otra si no caben).
          En angosto, con un hilo abierto, la pantalla es del hilo: vuelven con la lista. */}
      {mode === "panel" || !selectedId ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {/* Cambiar de vista es siempre pestaña: cambia la lista entera. Spam y Bloqueados son vistas, al final y aparte. */}
          <Tabs
            value={activeView}
            onValueChange={(next) => listSearch.setParam("view", String(next) === DEFAULT_VIEW ? undefined : String(next), { replace: true })}
            className="min-w-0 max-sm:w-full"
          >
            <ScrollingTabsList aria-label="Vista de la bandeja">
              {VIEW_CHIPS.map((chip) => (
                <TabsTrigger key={chip.value} value={chip.value} className="shrink-0 min-h-11 sm:min-h-9">
                  {chipLabel(chip, receptionName)}
                  {summary ? <span className="tabular-nums opacity-80"> {summary[chip.total]}</span> : null}
                </TabsTrigger>
              ))}
              <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
              <TabsTrigger
                value="spam"
                className="shrink-0 min-h-11 text-muted-foreground sm:min-h-9"
                title={`Publicidad y envíos automáticos: ${receptionName} no los responde y no se cobran`}
              >
                Spam
                {summary?.spam ? <span className="tabular-nums opacity-80"> {summary.spam}</span> : null}
              </TabsTrigger>
              <TabsTrigger
                value="blocked"
                className="shrink-0 min-h-11 text-muted-foreground sm:min-h-9"
                title={`Personas bloqueadas: nadie les escribe y ${receptionName} no les responde`}
              >
                <Ban className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">Bloqueados</span>
              </TabsTrigger>
            </ScrollingTabsList>
          </Tabs>
          {/* Los filtros tienen su propia fila, bajo las pestañas: acotan la lista y no compiten con las vistas. */}
          <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2">
            <FilterBar
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
                // Acota la lista que ya se ve: se combina con el canal y se quita con ×.
                {
                  key: "mine",
                  label: "Temas",
                  type: "select",
                  options: [{ value: "1", label: "Solo las mías" }],
                },
              ]}
              className="w-full"
              sortOptions={[]}
              searchPlaceholder="Buscar por nombre o teléfono" searchLabel="Buscar en la Bandeja"
              searchPending={listQuery.isFetching && !listQuery.isFetchingNextPage}
              resetKeys={["channel", "mine", "q"]}
            />
          </div>
        </div>
      ) : null}
      {/* Con el agente apagado en toda la clínica, lo dice junto a la lista; en angosto, con un hilo abierto, la pantalla es del hilo. */}
      {mode === "panel" || !selectedId ? <CapReachedNotice className="shrink-0" /> : null}
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
              myUserId={myUserId}
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
              sideView={sideView}
              onRowAction={sideView === "spam" ? (canWrite ? rowScreenAction : undefined) : canRegister ? rowScreenAction : undefined}
              onBackToTabs={() => listSearch.setParam("view", undefined, { replace: true })}
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
          {!selectedId || !thread ? (
            <ConversationList
              items={items}
              myUserId={myUserId}
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
              sideView={sideView}
              onRowAction={sideView === "spam" ? (canWrite ? rowScreenAction : undefined) : canRegister ? rowScreenAction : undefined}
              onBackToTabs={() => listSearch.setParam("view", undefined, { replace: true })}
            />
          ) : (
            thread
          )}
          {/* «Contexto» en angosto: el cajón estándar de los formularios, encima del hilo; cerrarlo vuelve a la conversación. */}
          <DetailDrawer
            open={showContext && !!selectedId}
            onClose={closeContextMobile}
            isDirty={wsDraft}
            title="Contexto"
            closeLabel="Volver a la conversación"
          >
            {workspace ??
              (!canReadCrm ? (
                <EmptyState title="Sin acceso al contexto" description="Tu rol no ve los datos de la persona en el CRM." />
              ) : contactFallbackQuery.isError ? (
                <ErrorState
                  message="No se pudo cargar el contexto de la persona."
                  onRetry={() => void contactFallbackQuery.refetch()}
                />
              ) : (
                <LoadingState message="Cargando contexto…" />
              ))}
          </DetailDrawer>
        </div>
      )}
      <UnblockDialog
        target={unblockTarget}
        pending={screenActions.unblock.isPending}
        onClose={() => setUnblockTarget(null)}
        onConfirm={() => {
          if (unblockTarget) screenActions.unblock.mutate(unblockTarget, { onSettled: () => setUnblockTarget(null) })
        }}
      />
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
  // Color con un solo significado (ADR 0050): ámbar lo que pide a una persona,
  // rojo solo «Ahora», gris esperar o cerrada; siempre con su frase.
  const tone =
    words.tone === "urgent"
      ? "font-semibold text-destructive"
      : words.tone === "team" || words.tone === "waiting"
        ? "font-semibold text-warning"
        : "text-muted-foreground"
  const mark =
    words.tone === "urgent"
      ? "size-2 shrink-0 rounded-full bg-destructive"
      : words.tone === "team" || words.tone === "waiting"
        ? "size-2 shrink-0 rounded-[2px] bg-warning"
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
  personName,
}: {
  conversationId: string
  /** Lo que dice la lista; ausente si el hilo se abrió por enlace y no está en la página cargada. */
  attention: ConversationAttention | undefined
  canSeeProposals: boolean
  /** De quién se espera el sí: se dice su nombre de pila, nunca «el interlocutor». */
  personName: string
}) {
  const { setOpen } = useAgentPanel()
  const receptionName = useReceptionName()
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
  const firstName = personName.split(/\s+/)[0] || personName
  const outcome =
    total === 1
      ? `Espera el sí de ${firstName} en esta conversación.`
      : `Esperan el sí de ${firstName} en esta conversación.`
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
      id="cita-espera"
      role="status"
      tabIndex={-1}
      className="flex flex-wrap items-center gap-2.5 border-t border-agent-border bg-agent-soft px-3.5 py-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentMark size="sm" />
      <p className="min-w-0 flex-1 basis-48">
        {receptionName} propuso <span className="font-semibold">{what}</span>. {outcome}
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
  myUserId,
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
  sideView = null,
  onRowAction,
  onBackToTabs,
}: {
  items: ConversationListItem[]
  /** Quien mira: un tema suyo se dice «Lo tienes tú». */
  myUserId: string
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
  /** Spam o Bloqueados (ADR 0054): cada fila dice su motivo y trae su botón. */
  sideView?: SideView | null
  /** «No es spam» o «Desbloquear» de la fila; ausente sin permiso. */
  onRowAction?: (item: ConversationListItem) => void
  /** El vacío de Spam y Bloqueados lleva de vuelta a las pestañas. */
  onBackToTabs?: () => void
}) {
  const receptionName = useReceptionName()
  return (
    // El desplazamiento de la lista es el de la aplicación (ScrollArea), no la barra nativa.
    <ScrollArea className="elevated min-h-0 flex-1 rounded-xl border bg-card">
    <div className="flex flex-col divide-y">
      {sideView ? (
        <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
          <span className="text-sm font-semibold">{sideView === "spam" ? "Spam · últimos 30 días" : "Bloqueados"}</span>
          <span className="text-xs text-muted-foreground">
            {sideView === "spam"
              ? `${receptionName} no responde lo que está aquí, y no se cobra.`
              : `Nadie les escribe y ${receptionName} no les responde. Para volver a atenderlos, desbloquéalos.`}
          </span>
        </div>
      ) : null}
      {items.map((item) => {
        const selected = isRowOf(item, selectedId)
        const initials = personInitials(item.contact.displayName)
        // La fila es la persona: un icono por canal, primero el de la conversación que muestra.
        const rowChannels = item.channels?.length ? item.channels : [item.connection.channel]
        const words = conversationWords({ ...item, myUserId, receptionName })
        // Con un tema abierto, la fila dice la pregunta que hay que contestar, no el último mensaje (ADR 0050).
        const topic = item.attention?.topics?.[0]
        const preview = topic
          ? `${!topic.assigneeUserId || topic.assigneeUserId === myUserId ? "Te toca: " : ""}«${topicQuote(topic)}»`
          : previewWords(item.preview)
        const screen = item.contact.screen ?? null
        const row = (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          aria-current={selected ? "true" : undefined}
          className={`relative flex min-w-0 flex-1 gap-2.5 px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
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
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{listTimeWords(item.lastMessageAt ?? item.preview?.createdAt ?? null)}</span>
            </span>
            <span className={`truncate text-[13px] ${topic ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {preview}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              {rowChannels.map((rowChannel) => {
                const ChannelIcon = channelIcon(rowChannel)
                return <ChannelIcon key={rowChannel} className="size-3.5 shrink-0" aria-hidden />
              })}
              {/* Con el estado a la vista, los canales quedan en sus iconos: el estado no debe recortarse. */}
              <span className={words || screen ? "sr-only" : "truncate"}>{channelsWords(rowChannels)}</span>
              {item.isTest ? <Badge variant="secondary" className="shrink-0">Prueba</Badge> : null}
              {/* En Spam y Bloqueados la fila dice por qué; el estado de atención no aplica. */}
              {screen ? (
                <span className="truncate">{screenReasonWords(screen, item.contact.screenReason)}</span>
              ) : words ? (
                <StateLabel words={words} />
              ) : null}
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
        if (!sideView || !screen || !onRowAction) return row
        return (
          <div key={item.id} className="flex items-center gap-2 pr-3">
            {row}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 shrink-0 rounded-full sm:min-h-8"
              onClick={() => onRowAction(item)}
            >
              {screen === "blocked" ? "Desbloquear" : "No es spam"}
            </Button>
          </div>
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
      {!isError && !hasItems && !isLoading && sideView && !searching ? (
        <EmptyState
          title={sideView === "spam" ? "Nada en spam" : "Nadie bloqueado"}
          description={
            sideView === "spam"
              ? `Si llega publicidad o un envío automático, ${receptionName} no lo responde y aparece aquí.`
              : "Para bloquear a alguien que acosa o amenaza, abre su conversación y elige «Bloquear a esta persona…» en el menú ⋯."
          }
          actionLabel={onBackToTabs ? "Ver «Por atender»" : undefined}
          onAction={onBackToTabs}
        />
      ) : null}
      {!isError && !hasItems && !isLoading && !(sideView && !searching) && (
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
  openId,
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
  row,
  canSeeProposals,
  startOnTopic = false,
  onNextTopic,
}: {
  /** La conversación con que se abrió; «Responder por» puede pasar a otro canal de la persona. */
  openId: string
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
  /** La conversación que muestra la fila de la persona: la cabecera dice su estado aunque se responda por otro canal. */
  row?: { id: string; status: string }
  canSeeProposals: boolean
  /** Desde «Por atender» el hilo abre en «Solo este tema» (ADR 0050). */
  startOnTopic?: boolean
  /** Abre el siguiente tema por atender; ausente si no hay otro. */
  onNextTopic?: () => void
}) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  // La conversación que responde (decisión 6 del pulido): la abierta, o la del
  // canal elegido en «Responder por». El historial es el de toda la persona.
  const [id, setId] = useState(openId)
  const switchingRef = useRef(false)
  // Si el último cambio de `id` fue «Responder por»: lo leen los efectos que vienen después.
  const lastSwitchRef = useRef(false)
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
    // Al cambiar de canal sigue a la vista la misma persona mientras llega el otro.
    placeholderData: keepPreviousData,
  })

  const detail = detailQuery.data?.data
  const messages = useMemo(() => [...older, ...(detail?.messages ?? [])], [older, detail?.messages])
  // Los canales de la persona (fase 4 del pulido); sin el dato, solo este.
  const personChannels: PersonChannel[] = detail?.person?.channels ?? []
  const personIds = personChannels.length > 0 ? personChannels.map((item) => item.conversationId) : [id]

  // En qué se basó cada respuesta del agente, en todos sus canales: solo se ofrece en los mensajes que la tienen.
  const tracesQuery = useQuery({
    queryKey: ["agent-answer-traces", id, personIds.join(",")],
    queryFn: async () => ({
      data: (
        await Promise.all(
          personIds.map((conversationId) =>
            apiFetch<{ data: AnswerTrace[] }>(`/api/agent/answer-traces?conversationId=${conversationId}`),
          ),
        )
      ).flatMap((page) => page.data),
    }),
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
  // Temas (ADR 0050): a qué mensaje responde la caja (undefined = el tema pendiente
  // más antiguo de quien mira; null = mensaje nuevo, sin tema), si se ve solo el
  // tema y si el último envío lo dejó resuelto.
  const [replyTo, setReplyTo] = useState<string | null | undefined>(undefined)
  // «Es spam» y «Bloquear a esta persona…» (ADR 0054).
  const screenActions = useContactScreenActions()
  const [blocking, setBlocking] = useState(false)
  const [onlyTopic, setOnlyTopic] = useState(startOnTopic)
  const [doneTopic, setDoneTopic] = useState(false)
  const keepPendingRef = useRef(false)
  // Pasadas las 24 horas: elegir un mensaje aprobado en vez de responder el tema
  // (R1), o escribirle por WhatsApp desde Instagram o Messenger (tablero 4b).
  const [useApproved, setUseApproved] = useState(false)
  const [viaWhatsapp, setViaWhatsapp] = useState(false)
  // La conversación de WhatsApp a la que fue la respuesta: el hilo de Instagram lo dice.
  const [sentToWhatsapp, setSentToWhatsapp] = useState<string | null>(null)

  useEffect(() => {
    // Cambiar de canal con «Responder por» conserva lo escrito y el historial ya cargado: es la misma persona.
    const switching = switchingRef.current
    switchingRef.current = false
    lastSwitchRef.current = switching
    if (!switching) {
      setOlder([])
      setOlderCursor(null)
      setComposer("")
      // El enlace ya preparado es de la persona: al cambiar de canal se vuelve a usar.
      setRegistrationLink(null)
      setRegistrationError(null)
      setCopied(false)
    }
    setWindowClosed(false)
    setMarkedRef(null)
    setSendError(null)
    setOpenTrace(null)
    setCorrecting(null)
    setConfirming(null)
    setReplyTo(undefined)
    setDoneTopic(false)
    setBlocking(false)
    setUseApproved(false)
    setViaWhatsapp(false)
    setSentToWhatsapp(null)
  }, [id])
  // Desde «Por atender» cada hilo abre en «Solo este tema» (ADR 0050).
  useEffect(() => {
    setOnlyTopic(startOnTopic)
  }, [startOnTopic])

  // Abrirla la deja leída en todos sus canales.
  const unread = detail ? (detail.person?.unreadCount ?? detail.conversation.unreadCount) : 0
  useEffect(() => {
    if (detail && unread > 0 && markedRef !== id) {
      setMarkedRef(id)
      void apiFetch(`/api/conversations/${id}/read`, { method: "POST" }).then(() =>
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      )
    }
  }, [detail, unread, id, markedRef, queryClient])

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
      setRegistrationLink(result.data)
      setRegistrationError(null)
      setCopied(false)
      pasteRegistrationLink(result.data.url)
    },
    onError: (error) => {
      setRegistrationError(error instanceof ApiError ? error.message : "No se pudo crear el enlace")
    },
  })

  // Preparar el borrador en el composer existente; el operador revisa y envía.
  // Nunca se envía automáticamente al generar el enlace. Quien ya es paciente
  // lo recibe para registrar a un familiar: el enlace no le ofrece registrarse.
  function pasteRegistrationLink(url: string) {
    setComposer(
      detail?.contact.isPatient
        ? `Aquí puedes registrar a tu hijo o a un familiar en ${orgName}: ${url}`
        : `Aquí puedes elegir tu cita y dejarnos tus datos en ${orgName}: ${url}`,
    )
  }

  // A la paciente le faltan datos: su enlace se escribe en el mensaje y quien
  // atiende lo revisa y lo envía (nunca sale solo). Dentro de la conversación
  // abierta no hace falta mensaje aprobado.
  const [linkPasted, setLinkPasted] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de persona, no de canal.
  useEffect(() => {
    if (!lastSwitchRef.current) setLinkPasted(false)
  }, [id])
  const ownLinkMutation = useMutation({
    mutationFn: (input: { contactId: string; patientId: string }) =>
      createPersonalLinkForContact(input.contactId, id, input.patientId),
    onSuccess: (result) => {
      const firstName = detail?.contact.displayName.split(" ")[0] ?? ""
      setComposer(`${firstName ? `${firstName}, c` : "C"}ompleta tus datos aquí (toma 2 minutos): ${result.data.url}`)
      setLinkPasted(true)
      setRegistrationError(null)
    },
    onError: (error) => {
      setRegistrationError(error instanceof ApiError ? error.message : "No se pudo preparar su enlace")
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
    mutationFn: (input: { text: string; replyToMessageId: string | null; keepPending: boolean; viaWhatsapp?: boolean }) =>
      apiFetch<{ data: ChatMessage & { topicResolved: boolean; conversationId?: string } }>(`/api/conversations/${id}/messages${input.viaWhatsapp ? "/whatsapp" : ""}`, {
        method: "POST",
        body: JSON.stringify({
          text: input.text,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.keepPending ? { keepPending: true } : {}),
        }),
      }),
    onSuccess: (result, input) => {
      setComposer("")
      setWindowClosed(false)
      setSendError(null)
      setReplyTo(undefined)
      if (input.viaWhatsapp) {
        setViaWhatsapp(false)
        setSentToWhatsapp(result.data.conversationId ?? null)
        toast.success(
          result.data.held ? "Quedó en su WhatsApp: le llega con «Ver respuesta»." : "Se le envió por WhatsApp.",
        )
      }
      if (result.data.topicResolved) setDoneTopic(true)
      invalidate()
      invalidateAgentPanelQueries(queryClient)
    },
    onError: sendFailed,
  })

  // «Tomar este tema», «Pasar este tema a…» y «Marcar resuelto» (ADR 0050).
  const topicMutation = useMutation({
    retry: false,
    mutationFn: ({ topicId, path, body }: { topicId: string; path: "take" | "resolve"; body?: unknown }) =>
      apiFetch(`/api/conversations/${id}/topics/${topicId}/${path}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: (_result, variables) => {
      if (variables.path === "resolve") setDoneTopic(true)
      invalidate()
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-case-brief", "crm-context", "workspace-home"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
    onError: (error) => {
      toast.error(error instanceof ApiError && error.shape.message ? error.shape.message : "No se pudo completar la acción. Inténtalo de nuevo.")
    },
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
    // Todavía se ve el canal anterior: se conserva lo escrito y se envía cuando llegue.
    if (detailQuery.isPlaceholderData) throw new Error("Cambiando de canal")
    setUploading(true)
    try {
      if (text) {
        await sendMutation.mutateAsync({
          text,
          replyToMessageId: effectiveReplyTo,
          keepPending: keepPendingRef.current,
          ...(viaWhatsapp ? { viaWhatsapp: true } : {}),
        })
      }
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
      keepPendingRef.current = false
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
  const [confirming, setConfirming] = useState<"close" | "deleteTest" | null>(null)
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
  // La cabecera dice el estado de la persona, el de su fila, también al responder por otro canal (fase 4).
  const words =
    row && row.id !== id && attention
      ? conversationWords({ status: row.status, attention, closure: listClosure ?? null, myUserId, receptionName })
      : conversationWords({ status: conv.status, attention: threadAttention, closure, myUserId, receptionName })
  // Spam o bloqueada (ADR 0054): el aviso, el menú y la caja de texto lo leen de aquí.
  const screenView = detail.screen
  const blocked = screenView?.screen === "blocked"
  // Temas del hilo (ADR 0050): primero los de quien mira y los que nadie tomó.
  const topics = threadAttention?.topics ?? []
  const forMe = (topic: InboxTopic) => !topic.assigneeUserId || topic.assigneeUserId === myUserId
  const orderedTopics = [...topics.filter(forMe), ...topics.filter((topic) => !forMe(topic))]
  const defaultTopic = [...topics.filter(forMe)].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
  // La caja responde por defecto a la pregunta pendiente más antigua de quien mira.
  const effectiveReplyTo = replyTo === undefined ? (defaultTopic?.source?.id ?? null) : replyTo
  const replyMessage = effectiveReplyTo ? (messages.find((item) => item.id === effectiveReplyTo) ?? null) : null
  const replyTopic = effectiveReplyTo
    ? (topics.find((topic) => topic.source?.id === effectiveReplyTo || topic.askedMessageIds.includes(effectiveReplyTo)) ?? null)
    : null
  const replyText = replyMessage?.body ?? (replyTopic ? topicQuote(replyTopic) : null)
  // Pasadas las 24 horas de WhatsApp, responder una pregunta se sigue
  // escribiendo: queda por entregar y le llega con «Ver respuesta» (R1).
  const holdReply = windowShut && effectiveReplyTo !== null && !useApproved
  // Instagram y Messenger, pasadas las 24 horas: no admiten mensajes aprobados (tablero 4b).
  const metaWindow = detail.lateReply?.metaWindow ?? null
  const metaShut = metaWindow !== null && !metaWindow.open
  const firstName = detail.contact.displayName.split(/\s+/)[0] ?? detail.contact.displayName
  const metaChannel = detail.connection.provider === "messenger" ? "Messenger" : "Instagram"
  // Mensajes del tema: los que lo originaron o volvieron a preguntar por él.
  const topicMessageIds = new Set(topics.flatMap((topic) => [topic.source?.id, ...topic.askedMessageIds].filter((item): item is string => !!item)))
  const askedIds = new Set(topics.flatMap((topic) => topic.askedMessageIds))
  const focusTopic = defaultTopic ?? orderedTopics[0] ?? null
  const showOnlyTopic = onlyTopic && focusTopic !== null
  const shown = showOnlyTopic && focusTopic ? foldOutsideTopic(messages, focusTopic) : messages.map((msg) => ({ kind: "message" as const, msg }))
  const jumpTo = (messageId: string) => {
    if (showOnlyTopic && focusTopic && !foldOutsideTopic(messages, focusTopic).some((item) => item.kind === "message" && item.msg.id === messageId)) {
      setOnlyTopic(false)
    }
    window.setTimeout(() => document.getElementById(`mensaje-${messageId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50)
  }
  const focusComposer = () => window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensaje"]')?.focus(), 0)
  // Promete responder después: se sugiere dejar el tema pendiente.
  const promises = replyTopic !== null && /\b(te (confirmo|aviso|escribo|respondo|cuento|averiguo)|consult|averigu|lo veo)/i.test(composer)
  // Caja también, para devolverle un pago (decisión 3): `TopicBand` se lo ofrece solo en los pagos.
  const conversers = members.filter((member) => ["owner", "admin", "reception", "clinician", "cashier"].includes(member.role))
  // «Responder por» (decisión 6 del pulido): otro canal de la persona, sin perder lo escrito.
  const switchTo = (next: string) => {
    if (next === id) return
    switchingRef.current = true
    setId(next)
  }
  const multiChannel = personChannels.length > 1
  // Lo que se ve es todavía el canal anterior: no se actúa hasta que llegue el elegido.
  const switching = detailQuery.isPlaceholderData
  // Dos conversaciones del mismo canal (dos hilos de correo) se distinguen por su cuenta o su hora.
  const channelName = (item: PersonChannel) => {
    const twins = personChannels.filter((other) => other.channel === item.channel)
    if (twins.length < 2) return channelLabel(item.channel)
    const sameAccount = twins.some((other) => other !== item && other.connectionName === item.connectionName)
    return `${channelLabel(item.channel)} · ${sameAccount ? listTimeWords(item.lastMessageAt) : item.connectionName}`
  }
  const channelOf = (conversationId: string | undefined) =>
    personChannels.find((item) => item.conversationId === conversationId)?.channel ?? detail.connection.channel
  const activeChannel = personChannels.find((item) => item.conversationId === id) ?? null
  // Un tema de otro canal se responde por ese canal: se dice y se ofrece pasar a él.
  const otherTopics = personChannels.filter((item) => item.conversationId !== id && item.topics > 0)
  const busy = actionMutation.isPending || switching
  const name = detail.contact.displayName
  const preview = previewQuery.data?.data
  const closeAlso = preview ? pendingWords(preview.handoffs, preview.pendingContact, "cerrar", receptionName) : []
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
        <div className="min-w-[12rem] flex-1">
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
          <div className="flex min-w-0 items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">
              {multiChannel ? channelsWords(personChannels.map((item) => item.channel)) : channelLabel(detail.connection.channel)}
            </span>
            {conv.isTest ? <Badge variant="secondary" title="Prueba del chat web: no se cobra ni cuenta, y se borra a los 7 días">Prueba · no se cobra</Badge> : null}
            {words ? <StateLabel words={words} className="min-w-0" /> : null}
            {detail.contact.isActive === false && <Badge variant="secondary">Archivado</Badge>}
          </div>
        </div>
        {/* Un botón principal por estado vive en el tema (ADR 0050); aquí solo lo de la conversación. */}
        <div className="flex flex-wrap items-center gap-1.5">
        {onToggleContext && !showBack && (
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
        {canWrite || canRegister || onToggleContext || topics.length > 0 || threadAttention?.handoffPriority ? (
          <RowActions
            label="Más acciones de la conversación"
            items={[
              // En el celular «Contexto» no cabe junto al nombre: va primero en «…».
              ...(onToggleContext && showBack ? [{ key: "contexto", label: "Contexto", onSelect: onToggleContext }] : []),
              ...(topics.length > 0 || threadAttention?.handoffPriority
                ? [{ key: "resumen", label: "Resumen del caso", onSelect: () => setBriefFor(conv.id) }]
                : []),
              // Quien ya tiene su ficha no se registra otra vez: su enlace es para un familiar.
              ...(canRegister
                ? [{
                    key: "enlace",
                    label: detail.contact.isPatient ? "Enviar enlace de registro" : "Enviarle su enlace",
                    disabled: registrationMutation.isPending,
                    // El enlace ya preparado en esta conversación se vuelve a usar: tocar dos veces no crea otro.
                    onSelect: () =>
                      registrationLink ? pasteRegistrationLink(registrationLink.url) : registrationMutation.mutate(detail.contact.id),
                  }]
                : []),
              // Una prueba del chat web se borra entera (fase 6 del pulido).
              ...(canWrite && conv.isTest ? [{ key: "borrar-prueba", label: "Borrar esta prueba", onSelect: () => setConfirming("deleteTest") }] : []),
              ...(!canWrite
                ? []
                : closed
                  ? [{ key: "reabrir", label: "Reabrir", disabled: busy, onSelect: () => actionMutation.mutate({ path: "/reopen" }) }]
                  : [{
                      key: "cerrar",
                      label: "Cerrar sin resolver",
                      disabled: busy,
                      onSelect: () => {
                        actionMutation.reset()
                        setConfirming("close")
                      },
                    }]),
              // Spam y Bloquear (ADR 0054): nunca para un paciente; Bloquear va al final y en rojo.
              ...(canWrite && screenView && screenView.screen === null && !screenView.isPatient
                ? [{
                    key: "spam",
                    label: "Es spam",
                    disabled: screenActions.spam.isPending,
                    onSelect: () => screenActions.spam.mutate(conversationTarget(id, name)),
                  }]
                : []),
              ...(canRegister && screenView && screenView.screen !== "blocked" && !screenView.isPatient
                ? [{
                    key: "bloquear",
                    label: "Bloquear a esta persona…",
                    tone: "danger" as const,
                    onSelect: () => setBlocking(true),
                  }]
                : []),
            ]}
          />
        ) : null}
        </div>
        {actionError && confirming === null ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {actionError}
          </p>
        ) : null}
      </div>
      <ContactScreenBanner
        target={conversationTarget(id, name)}
        view={screenView}
        canWrite={canWrite}
        canBlock={canRegister}
      />
      <BlockPersonDialog
        target={blocking ? conversationTarget(id, name) : null}
        onClose={() => setBlocking(false)}
      />
      <ConfirmDialog
        open={confirming === "deleteTest"}
        title="¿Borrar esta prueba?"
        description="Se borra la conversación de prueba con todo lo que dejó: sus mensajes y sus temas. No se puede deshacer."
        confirmLabel="Borrar esta prueba"
        variant="destructive"
        pending={busy}
        onClose={() => setConfirming(null)}
        onConfirm={() =>
          actionMutation.mutate(
            { path: "/delete-test" },
            {
              onSuccess: () => {
                toast.success("Prueba borrada.")
                onBack()
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={confirming === "close"}
        title="¿Cerrar sin resolver?"
        description={closeWithoutResolvingWords(name, receptionName)}
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

      {orderedTopics.length > 0 && !closed ? (
        <TopicBand
          topics={orderedTopics}
          unreachable={threadAttention?.unreachable === true}
          myUserId={myUserId}
          // «Lo que ya se le dijo» es de este canal: lo de otro no responde este tema.
          messages={messages.filter((item) => (item.conversationId ?? id) === id)}
          members={conversers}
          canWrite={canWrite}
          onlyTopic={showOnlyTopic}
          pending={topicMutation.isPending || switching}
          onToggleOnlyTopic={() => setOnlyTopic((value) => !value)}
          onAnswer={(topic) => {
            setReplyTo(topic.source?.id ?? null)
            setDoneTopic(false)
            focusComposer()
          }}
          onJump={jumpTo}
          onTake={(topic) => topicMutation.mutate({ topicId: topic.id, path: "take" })}
          onPass={(topic, userId) => topicMutation.mutate({ topicId: topic.id, path: "take", body: { toUserId: userId } })}
          onResolve={(topic) => topicMutation.mutate({ topicId: topic.id, path: "resolve" })}
        />
      ) : null}
      {otherTopics.map((item) => (
        <div
          key={item.conversationId}
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-warning-soft/40 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1">
            {item.topics === 1 ? "Tiene un tema por responder" : `Tiene ${item.topics} temas por responder`} en{" "}
            {channelLabel(item.channel)}: se responde por ahí.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 px-2 py-1 text-xs font-semibold text-primary sm:min-h-0"
            onClick={() => switchTo(item.conversationId)}
          >
            Responder por {channelLabel(item.channel)}
          </Button>
        </div>
      ))}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        {/* El historial conserva siempre un alto útil: la zona de escritura (p. ej. los
            mensajes aprobados) no puede dejarlo en cero. */}
        <MessageScroller className="min-h-32 flex-1 basis-1/2">
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
              {shown.map((item, index) => {
                // Un separador cada vez que cambia el día, en la zona de la clínica.
                const at = item.kind === "message" ? item.msg.createdAt : null
                const before = shown.slice(0, index).reverse().find((other) => other.kind === "message")
                const newDay =
                  at !== null && (!before || before.kind !== "message" || messageDayKey(before.msg.createdAt) !== messageDayKey(at))
                const separator =
                  newDay && at ? (
                    <MessageScrollerItem key={`dia-${messageDayKey(at)}`} messageId={`dia-${messageDayKey(at)}`}>
                      <div className="flex justify-center py-1">
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                          {dayWords(at)}
                        </span>
                      </div>
                    </MessageScrollerItem>
                  ) : null
                return [
                  separator,
                item.kind === "fold" ? (
                  <MessageScrollerItem key={`plegado-${item.firstId}`} messageId={`plegado-${item.firstId}`}>
                    <div className="flex justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 rounded-full border-dashed text-xs sm:min-h-8"
                        onClick={() => setOnlyTopic(false)}
                      >
                        {item.count === 1 ? "1 mensaje más de la conversación · ver" : `${item.count} mensajes más de la conversación · ver`}
                      </Button>
                    </div>
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={item.msg.id} messageId={item.msg.id}>
                    <div id={`mensaje-${item.msg.id}`}>
                      <MessageBubble
                        msg={item.msg}
                        conversationId={item.msg.conversationId ?? id}
                        channel={multiChannel ? channelOf(item.msg.conversationId) : null}
                        orgSlug={orgSlug}
                        highlight={topicMessageIds.has(item.msg.id) ? (askedIds.has(item.msg.id) ? "asked" : "topic") : undefined}
                        quote={quoteOf(item.msg, messages, jumpTo)}
                        senderName={item.msg.senderUserId ? (members.find((member) => member.userId === item.msg.senderUserId)?.user.name ?? null) : null}
                        personFirstName={detail.contact.displayName.split(/\s+/)[0]}
                        onShowTrace={
                          traceByMessage.has(item.msg.id) ? () => setOpenTrace(traceByMessage.get(item.msg.id) ?? null) : undefined
                        }
                      />
                    </div>
                  </MessageScrollerItem>
                ),
                ]
              })}
            </MessageScrollerContent>
            {screenView?.screen === "spam" ? (
              <div className="mt-3 flex justify-center">
                <p className="rounded-full border border-dashed bg-card px-3 py-1 text-center text-xs font-medium text-muted-foreground">
                  {receptionName} no respondió: spam
                </p>
              </div>
            ) : null}
            {closure ? (
              <div className="mt-3 flex justify-center">
                <p className="rounded-full border bg-card px-3 py-1 text-center text-xs font-medium text-muted-foreground">
                  {closureBand(closure, receptionName)}
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
      <AgentPendingBand
        conversationId={id}
        attention={threadAttention}
        canSeeProposals={canSeeProposals}
        personName={detail.contact.displayName}
      />
      {/* Como mucho el 45 % del hilo y con su propio desplazamiento: con la ventana de WhatsApp
          cerrada, el aviso y los mensajes aprobados no se comen el historial (antes quedaba en 0 px). */}
      <ScrollArea className="flex max-h-[45%] min-h-0 flex-col border-t [&_[data-slot=scroll-area-viewport]]:h-auto [&_[data-slot=scroll-area-viewport]]:min-h-0 [&_[data-slot=scroll-area-viewport]]:flex-1">
      <div className="flex flex-col p-3">
        {multiChannel && canWrite && !blocked ? (
          <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span>Responder por:</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Responder por ${activeChannel ? channelName(activeChannel) : channelLabel(detail.connection.channel)}, ${replyWindowWords(activeChannel?.replyWindow ?? null)}. Cambiar de canal`}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                {activeChannel ? channelName(activeChannel) : channelLabel(detail.connection.channel)}
                <span className="font-normal text-muted-foreground">· {replyWindowWords(activeChannel?.replyWindow ?? null)}</span>
                <ChevronDown className="size-3.5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto">
                {/* Base UI: el elemento del menú responde a `onClick`. */}
                {personChannels.map((item) => (
                  <DropdownMenuItem key={item.conversationId} onClick={() => switchTo(item.conversationId)}>
                    <span className="whitespace-nowrap">
                      <span className="font-medium">{channelName(item)}</span>
                      <span className="text-muted-foreground">
                        {" "}· {replyWindowWords(item.replyWindow)}
                        {item.topics > 0 ? " · tema por responder" : ""}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
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
        ) : blocked ? (
          // A una persona bloqueada no le escribe nadie: se desbloquea desde el aviso de arriba.
          <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            No puedes escribirle mientras esté bloqueado.
          </p>
        ) : windowShut && !holdReply ? (
          <div className="flex flex-col gap-1.5">
            {defaultTopic?.source ? (
              // Hay una pregunta sin responder: se le puede responder igual y le llega con «Ver respuesta» (R1).
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 w-fit sm:min-h-8"
                onClick={() => {
                  setUseApproved(false)
                  setReplyTo(defaultTopic.source?.id ?? null)
                }}
              >
                Responder su pregunta
              </Button>
            ) : null}
            {/* Pasaron las 24 horas de WhatsApp: se dice antes de escribir y se ofrecen los mensajes aprobados. */}
            <InboxApprovedMessages
              // Otra conversación es otra elección: no arrastra lo elegido ni el error de la anterior.
              key={id}
              conversationId={id}
              contactName={detail.contact.displayName}
              lastInboundAt={detail.whatsappWindow?.lastInboundAt}
              draft={composer}
              onSent={invalidate}
            />
          </div>
        ) : metaShut && !viaWhatsapp ? (
          // Instagram y Messenger pasadas las 24 horas: no dejan escribirle; si tiene WhatsApp, por ahí (tablero 4b).
          <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
            <p>
              Pasaron 24 horas desde que {firstName} escribió por {metaChannel}. {metaChannel} no deja escribirle hasta que vuelva a escribir.
            </p>
            {sentToWhatsapp ? (
              <p role="status" className="flex flex-wrap items-center gap-x-2">
                <CheckCircle2 className="size-4 text-success" aria-hidden />
                Tu respuesta salió por su WhatsApp.
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto min-h-11 p-0 font-semibold sm:min-h-0"
                  onClick={() => switchTo(sentToWhatsapp)}
                >
                  Seguir por WhatsApp
                </Button>
              </p>
            ) : null}
            {metaWindow?.whatsapp ? (
              <Button type="button" variant="outline" size="sm" className="min-h-11 w-fit sm:min-h-8" onClick={() => setViaWhatsapp(true)}>
                Escribirle por WhatsApp
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {holdReply ? (
              <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs">
                <span className="min-w-0 flex-1">
                  {detail.lateReply?.answerReady === false
                    ? `Pasaron 24 horas desde su último mensaje: tu respuesta queda guardada y le llega cuando Meta apruebe «Ver respuesta» o cuando ${firstName} vuelva a escribir.`
                    : `Pasaron 24 horas desde su último mensaje: tu respuesta queda por entregar y le llega a ${firstName} con «Ver respuesta».`}
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-auto min-h-11 px-2 py-1 text-xs font-semibold text-primary sm:min-h-0" onClick={() => setUseApproved(true)}>
                  Enviar un mensaje aprobado
                </Button>
              </div>
            ) : null}
            {viaWhatsapp ? (
              <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs">
                <span className="min-w-0 flex-1">
                  {metaWindow?.whatsappOpen
                    ? `Le llega a su WhatsApp: ${firstName} escribió por ahí en las últimas 24 horas.`
                    : `Le llega a su WhatsApp con «Ver respuesta»: ${firstName} lo toca y ve tu respuesta.`}
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-auto min-h-11 px-2 py-1 text-xs font-semibold text-primary sm:min-h-0" onClick={() => setViaWhatsapp(false)}>
                  Cancelar
                </Button>
              </div>
            ) : null}
            {doneTopic ? (
              <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success-soft px-3 py-2 text-sm">
                <CheckCircle2 className="size-4 text-success" aria-hidden />
                <span className="min-w-0 flex-1">Tema resuelto. {receptionName} sigue con lo demás.</span>
                {onNextTopic ? (
                  <Button size="sm" className="min-h-11 sm:min-h-8" onClick={onNextTopic}>
                    Siguiente tema por atender
                  </Button>
                ) : null}
              </div>
            ) : null}
            {threadAttention?.teamLive && threadAttention.agentAttending ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <Bot className="size-3.5 shrink-0" aria-hidden />
                Estás conversando en vivo: {receptionName} espera 15 minutos después del último mensaje del equipo y luego sigue con lo demás.
              </p>
            ) : null}
            {canRegister && detail.missingData && !linkPasted && detail.whatsappWindow?.open !== false && !windowClosed ? (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border-l-4 border-primary bg-primary/5 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  A {detail.contact.displayName.split(" ")[0]} le faltan datos: {filiationGapsText(detail.missingData.missing).toLowerCase()}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto shrink-0 px-2 py-1 text-xs font-semibold text-primary"
                  disabled={ownLinkMutation.isPending}
                  onClick={() => {
                    if (detail.missingData) ownLinkMutation.mutate({ contactId: detail.contact.id, patientId: detail.missingData.patientId })
                  }}
                >
                  Pegar su enlace
                </Button>
              </div>
            ) : null}
            {effectiveReplyTo !== null || topics.length > 0 ? (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border-l-4 border-warning bg-warning-soft/60 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {effectiveReplyTo !== null && replyText ? (
                    <>
                      <span className="font-semibold">Respondiendo a: </span>«{replyText}»
                    </>
                  ) : (
                    <span className="font-semibold">Mensaje nuevo, sin tema</span>
                  )}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger className="shrink-0 rounded-md px-2 py-1 font-semibold text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                    Cambiar
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {orderedTopics.map((topic) =>
                      topic.source ? (
                        <DropdownMenuItem key={topic.id} onClick={() => setReplyTo(topic.source?.id ?? null)}>
                          «{topicQuote(topic, 60)}»
                        </DropdownMenuItem>
                      ) : null,
                    )}
                    {[...messages].reverse().filter((item) => item.direction === "in" && (item.conversationId ?? id) === id && !topicMessageIds.has(item.id)).slice(0, 4).map((item) => (
                      <DropdownMenuItem key={item.id} onClick={() => setReplyTo(item.id)}>
                        «{(item.body ?? "Adjunto").slice(0, 60)}»
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={() => setReplyTo(null)}>Mensaje nuevo, sin tema</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
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
                  {/* Una respuesta por entregar es solo texto: un adjunto no espera a «Ver respuesta». */}
                  {holdReply || viaWhatsapp ? null : (
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger aria-label="Adjuntar archivo" />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments label="Adjuntar archivo" />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                  )}
                  <SpeechInput
                    lang={activeOrgLocale() ?? "es"}
                    size="icon-sm"
                    aria-label="Dictar"
                    onTranscriptionChange={(text) =>
                      setComposer((previous) => (previous ? `${previous} ` : "") + text)
                    }
                  />
                </PromptInputTools>
                <div className="flex items-center gap-1.5">
                  {effectiveReplyTo !== null ? (
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={sendMutation.isPending || uploading || switching}
                      onClick={() => {
                        keepPendingRef.current = true
                      }}
                    >
                      Enviar, sigue pendiente
                    </Button>
                  ) : null}
                  <PromptInputSubmit
                    aria-label={replyTopic ? "Enviar y resolver" : "Enviar"}
                    title={replyTopic ? "Enviar y resolver (Enter)" : "Enviar (Enter)"}
                    disabled={sendMutation.isPending || uploading || switching}
                  />
                </div>
              </PromptInputFooter>
            </PromptInput>
            {promises ? (
              <p className="text-xs text-warning" role="status">
                Prometes responder después: usa «Enviar, sigue pendiente» para que el tema no se dé por resuelto.
              </p>
            ) : replyTopic ? (
              <p className="text-xs text-muted-foreground">
                {name} lo verá como respuesta a su mensaje. Con Enter se envía y el tema queda resuelto.
              </p>
            ) : null}
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

/** Un mensaje del hilo o una tanda plegada de mensajes ajenos al tema. */
type ShownItem = { kind: "message"; msg: ChatMessage } | { kind: "fold"; count: number; firstId: string }

/**
 * «Solo este tema» (ADR 0050): quedan a la vista el mensaje que originó el tema,
 * las veces que volvió a preguntar, lo que se le respondió citándolos, lo que
 * escribió el equipo desde que se abrió y la respuesta del agente justo después
 * de cada pregunta repetida. Lo demás se pliega en una línea.
 */
function foldOutsideTopic(messages: ChatMessage[], topic: InboxTopic): ShownItem[] {
  const keep = new Set([topic.source?.id, ...topic.askedMessageIds].filter((item): item is string => !!item))
  const since = topic.source?.createdAt ?? topic.createdAt
  messages.forEach((msg, index) => {
    if (msg.replyToMessageId && keep.has(msg.replyToMessageId)) keep.add(msg.id)
    if (msg.senderKind === "user" && msg.createdAt >= since) keep.add(msg.id)
    const previous = messages[index - 1]
    if (previous && topic.askedMessageIds.includes(previous.id) && msg.direction === "out") keep.add(msg.id)
  })
  const shown: ShownItem[] = []
  for (const msg of messages) {
    if (keep.has(msg.id)) {
      shown.push({ kind: "message", msg })
      continue
    }
    const last = shown[shown.length - 1]
    if (last?.kind === "fold") last.count += 1
    else shown.push({ kind: "fold", count: 1, firstId: msg.id })
  }
  return shown
}

/** La cita de un mensaje que responde a otro: su texto y cómo llegar a él, o que ya no está cargado. */
function quoteOf(
  msg: ChatMessage,
  messages: ChatMessage[],
  onJump: (messageId: string) => void,
): { text: string; onJump: () => void } | "missing" | undefined {
  if (!msg.replyToMessageId) return undefined
  const quoted = messages.find((item) => item.id === msg.replyToMessageId)
  if (!quoted) return "missing"
  return { text: (quoted.body ?? "Adjunto").replace(/\s+/g, " ").slice(0, 140), onJump: () => onJump(quoted.id) }
}

/**
 * Lo que hay que contestar en este hilo (ADR 0050), arriba del historial: la
 * pregunta citada, quién la tiene y desde cuándo, lo que ya se le dijo y un
 * solo botón principal, «Responder». Tomar, pasar a otra persona y marcar
 * resuelto van en «…». Con varios temas, primero los de quien mira.
 */
function TopicBand({
  topics,
  unreachable,
  myUserId,
  messages,
  members,
  canWrite,
  onlyTopic,
  pending,
  onToggleOnlyTopic,
  onAnswer,
  onJump,
  onTake,
  onPass,
  onResolve,
}: {
  topics: InboxTopic[]
  /** Chat web sin dónde avisarle (R4): si cierra la pestaña, la respuesta no le llega. */
  unreachable: boolean
  myUserId: string
  messages: ChatMessage[]
  members: Member[]
  canWrite: boolean
  onlyTopic: boolean
  pending: boolean
  onToggleOnlyTopic: () => void
  onAnswer: (topic: InboxTopic) => void
  onJump: (messageId: string) => void
  onTake: (topic: InboxTopic) => void
  onPass: (topic: InboxTopic, userId: string) => void
  onResolve: (topic: InboxTopic) => void
}) {
  const [first, ...rest] = topics
  const [showRest, setShowRest] = useState(false)
  // «Lo que ya se le dijo» queda plegado: la franja mide tres líneas y el hilo se ve (tablero 2 del pulido).
  const [toldOpen, setToldOpen] = useState<string | null>(null)
  const receptionName = useReceptionName()
  if (!first) return null
  const visible = showRest ? topics : [first]
  return (
    <section aria-label="Lo que te toca contestar" className="flex flex-col gap-2 border-b bg-warning-soft/50 px-3.5 py-2">
      {unreachable ? (
        <p className="text-xs font-semibold text-foreground">
          Sin forma de avisarle: no hay un WhatsApp ni un correo suyo por donde llegarle. Si cierra la pestaña del chat, no le llega la respuesta.
        </p>
      ) : null}
      {visible.map((topic) => {
        const mine = topic.assigneeUserId === myUserId
        const free = !topic.assigneeUserId
        // Quien lo tiene escribió hace poco: tomarlo no se bloquea, pero se dice.
        const lastByOwner = topic.assigneeUserId
          ? [...messages].reverse().find((item) => item.senderKind === "user" && item.senderUserId === topic.assigneeUserId)
          : undefined
        const ownerLive = lastByOwner ? Date.now() - Date.parse(lastByOwner.createdAt) < 15 * 60_000 : false
        const told = topic.source
          ? messages.filter((item) => item.direction === "out" && Date.parse(item.createdAt) > Date.parse(topic.source?.createdAt ?? "")).slice(-2)
          : []
        const showTold = toldOpen === topic.id || !canWrite
        const since = topic.source ? timeAgo(topic.source.createdAt) : ""
        return (
          <div key={topic.id} className="flex flex-col gap-1 text-[13px]">
            <div className="flex min-w-0 items-start gap-2">
              <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5">
                <span className={`font-semibold ${topic.urgent ? "text-destructive" : "text-warning"}`}>
                  {mine || free ? "Te toca contestar" : topicWords(topic, myUserId, receptionName)}
                </span>
                <span className="text-muted-foreground">
                  {free ? (topic.urgent ? "· Ahora · nadie lo tomó" : "· nadie lo tomó") : mine ? "· lo tienes tú" : ""}
                  {since ? ` · ${since}` : ""}
                  {topic.askedAgainAt ? ` · volvió a preguntar ${timeAgo(topic.askedAgainAt)}` : ""}
                </span>
              </p>
              {/* «…» del tema arriba a la derecha, como el de la conversación: la fila de botones no se parte en el celular. */}
              {canWrite ? (
            <RowActions
              label="Más acciones del tema"
              items={[
                ...(topic.source
                  ? [{ key: "ver", label: "Ver en la conversación", onSelect: () => onJump(topic.source?.id ?? "") }]
                  : []),
                { key: "vista", label: onlyTopic ? "Ver toda la conversación" : "Ver solo este tema", onSelect: onToggleOnlyTopic },
                ...members
                  // Caja solo recibe pagos (decisión 3); el servidor también lo exige.
                  .filter((member) => member.userId !== topic.assigneeUserId && (member.role !== "cashier" || topic.kind === "pago"))
                  .map((member) => ({
                    key: `pasar-${member.userId}`,
                    label: member.userId === myUserId ? "Pasármelo" : `Pasar este tema a ${member.user.name}`,
                    disabled: pending,
                    onSelect: () => (member.userId === myUserId ? onTake(topic) : onPass(topic, member.userId)),
                  })),
                { key: "resuelto", label: "Marcar resuelto", disabled: pending, onSelect: () => onResolve(topic) },
              ]}
            />
              ) : null}
            </div>
            <p className="line-clamp-2 min-w-0 font-medium">«{topicQuote(topic, 200)}»</p>
            {showTold && told.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Ya se le dijo: {told.map((item) => `${item.senderKind === "agent" ? receptionName : "el equipo"}, «${(item.body ?? "").slice(0, 80)}»`).join(" · ")}
              </p>
            ) : null}
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {mine || free ? (
                  <Button size="sm" className="min-h-11 sm:min-h-8" disabled={pending} onClick={() => onAnswer(topic)}>
                    Responder
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={pending} onClick={() => onTake(topic)}>
                    <Hand className="size-4" aria-hidden />
                    Tomar este tema
                  </Button>
                )}
                {told.length > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11 text-primary sm:min-h-8"
                    aria-expanded={toldOpen === topic.id}
                    onClick={() => setToldOpen((value) => (value === topic.id ? null : topic.id))}
                  >
                    Lo que ya se le dijo
                    <ChevronDown className={`size-4 transition-transform motion-reduce:transition-none ${toldOpen === topic.id ? "rotate-180" : ""}`} aria-hidden />
                  </Button>
                ) : null}
                {ownerLive && !mine && topic.assigneeName ? (
                  <span className="text-xs text-muted-foreground">{topic.assigneeName} le escribió {timeAgo(lastByOwner?.createdAt ?? null)}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
      {rest.length > 0 ? (
        <Button variant="link" size="sm" className="h-auto self-start p-0 text-xs" onClick={() => setShowRest((value) => !value)}>
          {showRest ? "Mostrar solo el primero" : rest.length === 1 ? "1 tema más en esta conversación" : `${rest.length} temas más en esta conversación`}
        </Button>
      ) : null}
    </section>
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
        if (att.mimeType.startsWith("video/")) {
          return (
            // biome-ignore lint/a11y/useMediaCaption: el video lo manda la persona; no trae subtítulos.
            <video key={index} src={url} controls preload="metadata" className="max-h-80 max-w-64 rounded-md bg-black" />
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
  channel,
  orgSlug,
  onShowTrace,
  highlight,
  quote,
  senderName,
  personFirstName,
}: {
  msg: ChatMessage
  conversationId: string
  /** Por qué canal llegó o salió, cuando la persona escribe por varios (fase 4 del pulido). */
  channel?: string | null
  orgSlug: string
  /** Presente solo si el mensaje tiene traza: abre «En qué se basó». */
  onShowTrace?: () => void
  /** Es del tema que hay que contestar: lo originó (`topic`) o volvió a preguntar (`asked`). */
  highlight?: "topic" | "asked"
  /** El mensaje al que responde, citado como en WhatsApp. */
  quote?: { text: string; onJump: () => void } | "missing"
  /** Quién del equipo lo escribió. */
  senderName?: string | null
  /** El nombre de pila de la persona, para decir de quién es la reacción. */
  personFirstName?: string
}) {
  const out = msg.direction === "out"
  const byAgent = msg.senderKind === "agent"
  const receptionName = useReceptionName()
  // La línea de Argos solo la abre quien puede ver el agente.
  const canOpenLine = usePermission("agent.read")
  return (
    <Message from={out ? "user" : "assistant"}>
      <MessageContent
        className={
          !out
            ? `rounded-2xl rounded-bl-md border bg-card px-4 py-2.5 ${highlight ? "ring-2 ring-warning" : ""}`
            : byAgent
              ? "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:border group-[.is-user]:border-agent-border group-[.is-user]:bg-agent-soft group-[.is-user]:py-2.5"
              : "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:py-2.5"
        }
      >
        {byAgent && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold text-primary-soft-foreground">
            <span className="flex items-center gap-1">
              <Bot className="size-3.5" aria-hidden />{" "}
              {msg.automatic
                ? `Automático · ${msg.automatic.name}`
                : msg.contentType === "template"
                  ? "Mensaje automático"
                  : receptionName}
            </span>
            {/* Un mensaje automático no es una respuesta de la conversación: dice de qué línea salió. */}
            {msg.automatic && canOpenLine ? (
              <Link to="/agent/administrador" search={{ linea: msg.automatic.key }} className="font-normal underline-offset-2 hover:underline">
                Por qué salió
              </Link>
            ) : null}
          </div>
        )}
        {highlight ? (
          <span className="text-xs font-semibold text-warning">{highlight === "asked" ? "Sobre el tema" : "Tema · te toca"}</span>
        ) : null}
        {out && !byAgent && senderName ? <span className="text-xs font-semibold text-muted-foreground">{senderName}</span> : null}
        {/* Coexistencia: lo respondió alguien del equipo desde la app del celular. */}
        {out && !byAgent && !senderName && msg.fromBusinessApp ? (
          <span className="text-xs font-semibold text-muted-foreground">Desde el celular</span>
        ) : null}
        {/* Reenviado: no lo escribió la persona (fase 7). */}
        {msg.forwarded ? <span className="text-xs italic text-muted-foreground">Reenviado</span> : null}
        {quote === "missing" ? (
          <span className="rounded-md border-l-2 border-muted-foreground/40 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
            Respondió a un mensaje anterior que no está cargado
          </span>
        ) : quote ? (
          <button
            type="button"
            onClick={quote.onJump}
            className="rounded-md border-l-2 border-primary bg-background/70 px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          >
            «{quote.text}»
          </button>
        ) : null}
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
        ) : msg.redactedAt ? (
          <span className="italic text-muted-foreground">Mensaje de spam borrado a los 90 días</span>
        ) : msg.location ? (
          <LocationCard location={msg.location} />
        ) : (
          msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>
        )}
        <div
          className={`flex items-center gap-1 text-xs text-muted-foreground ${out ? "justify-end" : ""}`}
        >
          {channel ? <span>{channelLabel(channel)} ·</span> : null}
          {/* Fecha cuando no es de hoy y siempre en la zona de la clínica; el título la dice completa. */}
          <time dateTime={msg.createdAt} title={fullWhenWords(msg.createdAt)}>
            {clockWords(msg.createdAt)}
          </time>
          {/* Respuesta pasadas las 24 horas (R1): espera a que la persona toque «Ver respuesta». */}
          {out && msg.status === "held" ? <span className="font-semibold">· Por entregar</span> : null}
          {out && msg.held && msg.status !== "held" && msg.sentAt ? <span>· Entregada {clockWords(msg.sentAt)}</span> : null}
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
      {/* La reacción de la persona, pegada al mensaje: no confirma nada (decisión 7). */}
      {msg.contactReaction ? (
        <span
          className={`-mt-1 w-fit rounded-full border bg-card px-2 py-0.5 text-xs ${out ? "self-end" : "self-start"}`}
          title={`${personFirstName ?? "La persona"} reaccionó con ${msg.contactReaction}`}
        >
          {msg.contactReaction} {personFirstName}
        </span>
      ) : null}
    </Message>
  )
}

/** Una ubicación que mandó la persona: lo que dice y el enlace al mapa (sin servicio de mapas en la página). */
function LocationCard({ location }: { location: NonNullable<ChatMessage["location"]> }) {
  const named = [location.name, location.address].filter(Boolean).join(", ")
  const query = `${location.latitude},${location.longitude}`
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-semibold">
        <MapPin className="size-4 shrink-0" aria-hidden />
        Ubicación
      </span>
      {named ? <span>{named}</span> : null}
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-sm font-medium text-primary underline-offset-2 hover:underline"
      >
        Ver en el mapa
      </a>
    </span>
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
