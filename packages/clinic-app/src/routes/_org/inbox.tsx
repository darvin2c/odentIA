import {
  Button,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tabs,
  TabsTrigger,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  PageShell,
  ScrollingTabsList,
  SideDockScopeProvider,
  useDetailMode,
  useListSearch,
  useMediaQuery,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router"
import { Ban, SquarePen } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  useAgentPanel,
  useAgentPanelDockBlocker,
  useAgentPanelFitsBesideContext,
} from "../../components/agent-panel"
import { CapReachedNotice, ReceptionOffNotice } from "../../components/agent/reception-off-notice"
import { ContactWorkspace, type ContextSection } from "../../components/crm/contact-workspace"
import { NewConversationDialog } from "../../components/inbox-new-conversation"
import { conversationTarget, type ScreenTarget, UnblockDialog, useContactScreenActions } from "../../components/inbox-contact-screen"
import { ConversationList, isRowOf, type SideView } from "../../components/inbox/conversation-list"
import { ThreadView } from "../../components/inbox/thread-view"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import {
  type ConversationDetail,
  type ConversationListItem,
  type InboxSummary,
  usePermission,
  useMyUserId,
} from "../../lib/crm"
import { isReceiptOnly, useOrgEvents } from "../../lib/org-events"

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
const isSideView = (value: string | null | undefined): value is SideView =>
  value === "spam" || value === "blocked"
const DEFAULT_VIEW = "attend"

/** «Contexto» queda como lo dejaste: se recuerda en este navegador y empieza cerrado. */
const CONTEXT_OPEN_KEY = "inbox.context.open"
function rememberedContextOpen(): boolean {
  try {
    return window.localStorage.getItem(CONTEXT_OPEN_KEY) === "1"
  } catch {
    return false
  }
}

function InboxPage() {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const { org } = orgRouteApi.useRouteContext()
  const myUserId = useMyUserId()
  const canRead = usePermission("conversations.read")
  const canWrite = usePermission("conversations.write")
  const canRegister = usePermission("crm.write")
  const canOpenPeople = usePermission("patients.read")
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
  const routeSearch = Route.useSearch()
  const showContext = routeSearch.contexto === true
  // La selección deriva solo de la URL: navegar es lo único que cambia el
  // hilo, así el bloqueador del workspace intercepta antes de desmontar.
  // Limpiar el search (undefined) también limpia la selección.
  const selectedId = routeSearch.conversation ?? null
  // El panel de contexto de escritorio: queda como lo dejaste y no se reabre solo con cada hilo.
  const [contextOpen, setContextOpenState] = useState(rememberedContextOpen)
  const setContextOpen = useCallback((open: boolean) => {
    setContextOpenState(open)
    try {
      window.localStorage.setItem(CONTEXT_OPEN_KEY, open ? "1" : "0")
    } catch {
      // Sin almacenamiento, vale para esta visita.
    }
  }, [])
  const [contextSection, setContextSection] = useState<ContextSection | null>(null)
  // Borrador del workspace (vía onDraftChange): cerrar el panel en escritorio
  // es estado local y no navega, así que se guarda aquí con confirmación.
  const [wsDraft, setWsDraft] = useState(false)
  const [confirmContextClose, setConfirmContextClose] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de conversación, nada más.
  useEffect(() => {
    setContextSection(null)
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
  }, [wsDraft, setContextOpen])

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
        void queryClient.invalidateQueries({ queryKey: ["agent-actions"] })
        void queryClient.invalidateQueries({ queryKey: ["conversation-context"] })
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
      "appointment.updated",
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
  // Con poco ancho, «Contexto» no cabe junto al hilo: se abre encima, en el cajón estándar.
  const contextFits = useMediaQuery("(min-width: 1500px)")

  // Contacto del hilo seleccionado: sale de la lista; en enlace directo se
  // resuelve con el detalle ya cacheado por ThreadView (misma queryKey).
  const selectedItem = items.find((item) => isRowOf(item, selectedId)) ?? null
  const selectedDetail = useQuery({
    queryKey: ["conversation", selectedId ?? "ninguna"],
    queryFn: () =>
      apiFetch<{ data: ConversationDetail }>(`/api/conversations/${selectedId}`),
    enabled: canRead && !!selectedId,
  })
  // Sin leer el CRM, «Contexto» solo existe para quien ya es paciente: odontología no ve a los demás.
  const contextAllowed = canReadCrm || (canOpenPeople && selectedDetail.data?.data.contact.isPatient === true)

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
        !contextAllowed
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
      onOpenContext={
        contextAllowed
          ? (section) => {
              setContextSection(section)
              if (mode === "panel") {
                setContextOpen(true)
                if (agentCoversContext) agentPanel.setOpen(false)
              } else openContextMobile()
            }
          : undefined
      }
      onNextTopic={nextTopicId ? () => selectConversation(nextTopicId) : undefined}
    />
  ) : null

  const refreshAfterWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    if (selectedRef.current) {
      void queryClient.invalidateQueries({ queryKey: ["conversation", selectedRef.current] })
    }
  }, [queryClient])

  const workspace = selectedId ? (
    <ContactWorkspace
      key={selectedId}
      conversationId={selectedId}
      section={contextSection}
      onSectionChange={setContextSection}
      bare={mode !== "panel" || !contextFits}
      onClose={mode === "panel" && contextFits ? requestCloseContext : undefined}
      onRefresh={refreshAfterWorkspace}
      onDraftChange={setWsDraft}
    />
  ) : null

  if (!canRead) {
    return (
      <PageShell fill className="gap-3 sm:p-4">
        <PageHeader title="Bandeja" />
        <EmptyState title="Sin acceso" description="Sin permiso de lectura de conversaciones." />
      </PageShell>
    )
  }

  return (
    // La Bandeja ya reparte la ventana en lista, hilo y «Contexto»: lo que se
    // abre desde aquí va en cajón, no en la columna lateral.
    <SideDockScopeProvider value="fixed">
    <PageShell fill className={`gap-3 sm:p-4 ${mode !== "panel" && selectedId ? "max-sm:p-1.5" : ""}`}>
      {/* En el celular, con una conversación abierta, la pantalla es de la conversación:
          la cabecera de la Bandeja vuelve con la lista (tablero 3 del pulido). */}
      {mode === "panel" || !selectedId ? (
        <PageHeader
          title="Bandeja"
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
        <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:gap-3">
          {/* Cambiar de vista es siempre pestaña: cambia la lista entera. Spam y Bloqueados son vistas, al final y aparte. */}
          <Tabs
            value={activeView}
            onValueChange={(next) => listSearch.setParam("view", String(next) === DEFAULT_VIEW ? undefined : String(next), { replace: true })}
            className="min-w-0 shrink-0 max-md:w-full md:max-w-[70%]"
          >
            <ScrollingTabsList aria-label="Vista de la bandeja">
              {VIEW_CHIPS.map((chip) => (
                <TabsTrigger key={chip.value} value={chip.value} className="shrink-0 min-h-11 px-3 sm:min-h-9">
                  {chipLabel(chip, receptionName)}
                  {summary ? <span className="tabular-nums opacity-80"> {summary[chip.total]}</span> : null}
                </TabsTrigger>
              ))}
              <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
              <TabsTrigger
                value="spam"
                className="shrink-0 min-h-11 px-3 text-muted-foreground sm:min-h-9"
                title={`Publicidad y envíos automáticos: ${receptionName} no los responde y no se cobran`}
              >
                Spam
                {summary?.spam ? <span className="tabular-nums opacity-80"> {summary.spam}</span> : null}
              </TabsTrigger>
              <TabsTrigger
                value="blocked"
                className="shrink-0 min-h-11 px-3 text-muted-foreground sm:min-h-9"
                title={`Personas bloqueadas: nadie les escribe y ${receptionName} no les responde`}
              >
                <Ban className="size-4" aria-hidden />
                <span className="sr-only">Bloqueados</span>
              </TabsTrigger>
            </ScrollingTabsList>
          </Tabs>
          {/* En la misma fila que las pestañas: acotan la lista y no compiten con ellas. */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
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
              ]}
              className="min-w-0 flex-1 bg-transparent p-0 [&>[data-filter-row=desktop]]:justify-end min-[1536px]:[&_[data-filter-row=desktop]>div:first-child]:w-52 [&_[data-filter-row=desktop]>div:first-child]:w-10 [&_[data-filter-row=desktop]>div:first-child]:focus-within:w-56"
              sortOptions={[]}
              searchPlaceholder="Buscar por nombre o teléfono" searchLabel="Buscar en la Bandeja"
              searchPending={listQuery.isFetching && !listQuery.isFetchingNextPage}
              resetKeys={["channel", "q"]}
            />
            {/* Es de uso diario: un botón a la vista. Los temas de quien mira y los que nadie tomó (ADR 0050). */}
            <Button
              type="button"
              variant={mine ? "default" : "outline"}
              className="min-h-11 shrink-0 sm:min-h-9"
              aria-pressed={mine}
              onClick={() => listSearch.setParam("mine", mine ? undefined : "1", { replace: true })}
            >
              Solo las mías
            </Button>
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
            defaultSize="22rem"
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
          <ResizableHandle withHandle className="w-3 bg-transparent" />
          <ResizablePanel id="hilo" minSize="28rem" className="flex min-h-0 min-w-0 flex-col">
            {thread ?? (
              <EmptyState
                title="Selecciona una conversación"
                description="Elige un hilo de la lista para verlo aquí."
              />
            )}
          </ResizablePanel>
          {workspace && contextAllowed && contextVisible && contextFits && (
            <>
              <ResizableHandle withHandle className="w-3 bg-transparent" />
              <ResizablePanel
                id="contexto"
                defaultSize="24.5rem"
                minSize="22rem"
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
            open={contextAllowed && showContext && !!selectedId}
            onClose={closeContextMobile}
            isDirty={wsDraft}
            title="Contexto"
            closeLabel="Volver a la conversación"
          >
            {workspace}
          </DetailDrawer>
        </div>
      )}
      {mode === "panel" && !contextFits ? (
        <DetailDrawer
          open={contextAllowed && contextVisible && !agentPanel.open && !!selectedId}
          onClose={requestCloseContext}
          isDirty={wsDraft}
          title="Contexto"
          closeLabel="Volver a la conversación"
        >
          {workspace}
        </DetailDrawer>
      ) : null}
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

