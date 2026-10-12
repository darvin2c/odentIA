import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Field,
  FieldLabel,
  Input,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useIsMobile,
} from "@odentia/ui"
import {
  AgentMark,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  SideColumn,
  SideDockSlot,
  SubmitButton,
  useSideColumnWidth,
  useSideDock,
  useSidebarWidth,
} from "@odentia/ui-patterns"
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  ACTION_LABEL,
  type AgentActivityItem,
  type AgentHandoff,
  type AgentPanelSummary,
  type AgentProposal,
  approvalOutcomeMessage,
  permissionForAction,
  proposalErrorMessage,
} from "../lib/agent"
import { ApiError, apiFetch } from "../lib/api"
import { channelLabel } from "../lib/channels"
import { usePermission } from "../lib/crm"
import { activeOrgLocale } from "../lib/locale"

/**
 * Panel lateral global del agente: decidir, ver derivadas y actividad desde
 * cualquier pantalla. En pantalla grande es una columna fija a la derecha y la
 * página sigue usable al lado; cuando no cabe se superpone, sin cerrar la
 * página ni sus borradores, con el mismo cajón que los formularios: lateral en
 * escritorio y hoja inferior con asa en móvil.
 *
 * El layout de la organización monta el panel una sola vez y suscribe estos
 * eventos en su única conexión SSE; aquí solo se declara qué invalidar.
 */
export const AGENT_PANEL_EVENTS = [
  "agent.proposal.created",
  "agent.proposal.decided",
  "agent.proposal.executed",
  "agent.handoff.created",
  "agent.run.recorded",
  "task.updated",
  "stream.reconnected",
]

const PANEL_KEYS = [
  "agent-panel",
  "agent-panel-proposals",
  "agent-panel-handoffs",
  "agent-panel-activity",
  "agent-proposals",
  "agent-handoffs",
  "workspace-home",
  "tasks",
]

export function invalidateAgentPanelQueries(queryClient: QueryClient): void {
  for (const key of PANEL_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

export type AgentPanelTab = "decidir" | "derivadas" | "actividad"

/**
 * Desde este ancho el panel (384 px) cabe como columna junto a la página con el
 * sidebar abierto; por debajo se superpone como cajón.
 */
const DOCK_QUERY = "(min-width: 1536px)"
/** Ancho mínimo que la columna deja a la página (lista y hilo de la Bandeja). */
const PAGE_MIN_WIDTH = 848
/** Ancho que necesita la Bandeja para mostrar además «Contexto». */
const PAGE_WITH_CONTEXT_WIDTH = 1248
const PANEL_ID = "panel-del-agente"
/** Ancho de la columna en px: ajustable con el tirador y recordado en este navegador. */
const DOCK_WIDTH = { initial: 384, min: 320, max: 640 }
const DOCK_WIDTH_KEY = "odentia.agent-panel.width"

const useEffectBeforePaint: typeof useEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

/** Media query en cliente, resuelta antes de pintar para no parpadear. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const media = window.matchMedia(query)
    const apply = () => setMatches(media.matches)
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [query])
  return matches
}

interface AgentPanelState {
  open: boolean
  /** Abierto como columna fija: la página sigue usable al lado. */
  docked: boolean
  /** Ancho elegido para la columna, en px. */
  dockWidth: number
  setDockWidth: (width: number) => void
  /** Abre o cierra; al abrir puede elegir la pestaña (por defecto «Por decidir»). */
  setOpen: (open: boolean, tab?: AgentPanelTab) => void
  tab: AgentPanelTab
  setTab: (tab: AgentPanelTab) => void
  /** Botón de cabecera, para devolverle el foco al cerrar el panel. */
  buttonRef: RefObject<HTMLButtonElement | null>
  /** Control desde el que se abrió (cabecera, banda del hilo, Inicio): recibe el foco al cerrar. */
  openerRef: RefObject<HTMLElement | null>
  /** Páginas que ahora mismo piden cajón en vez de columna. */
  dockBlockers: RefObject<number>
}

const AgentPanelContext = createContext<AgentPanelState>({
  open: false,
  docked: false,
  dockWidth: DOCK_WIDTH.initial,
  setDockWidth: () => {},
  setOpen: () => {},
  tab: "decidir",
  setTab: () => {},
  buttonRef: { current: null },
  openerRef: { current: null },
  dockBlockers: { current: 0 },
})

/** Abrir o cerrar el panel desde otra superficie (banda del hilo, Inicio). */
export function useAgentPanel(): Pick<AgentPanelState, "open" | "docked" | "setOpen"> {
  const { open, docked, setOpen } = useContext(AgentPanelContext)
  return { open, docked, setOpen }
}

/** La Bandeja pregunta si, con la columna a su ancho actual, cabe además «Contexto». */
export function useAgentPanelFitsBesideContext(): boolean {
  const { dockWidth } = useContext(AgentPanelContext)
  const sidebar = useSidebarWidth()
  return useMediaQuery(`(min-width: ${sidebar + PAGE_WITH_CONTEXT_WIDTH + dockWidth}px)`)
}

/**
 * Mientras `blocked`, el panel se abre como cajón aunque quepa como columna: la
 * página tiene a la derecha algo que la columna desplazaría y que no debe
 * desmontarse (un borrador sin guardar).
 */
export function useAgentPanelDockBlocker(blocked: boolean): void {
  const { dockBlockers } = useContext(AgentPanelContext)
  useEffect(() => {
    if (!blocked) return
    dockBlockers.current += 1
    return () => {
      dockBlockers.current -= 1
    }
  }, [blocked, dockBlockers])
}

/** Decidir o tomar un caso cambia lo que la bandeja muestra de ese hilo; no se espera al aviso en vivo. */
function invalidateAfterAgentDecision(queryClient: QueryClient): void {
  invalidateAgentPanelQueries(queryClient)
  void queryClient.invalidateQueries({ queryKey: ["conversations"] })
  void queryClient.invalidateQueries({ queryKey: ["conversation"] })
}

/** Conversación abierta en la Bandeja, si es la pantalla que hay debajo del panel. */
function useOpenConversationId(): string | null {
  return useRouterState({
    select: (state) => {
      const conversation = (state.location.search as Record<string, unknown>).conversation
      return state.location.pathname.endsWith("/inbox") && typeof conversation === "string"
        ? conversation
        : null
    },
  })
}

export function useAgentPanelSummary(enabled: boolean) {
  return useQuery({
    queryKey: ["agent-panel"],
    queryFn: () => apiFetch<{ data: AgentPanelSummary }>("/api/agent/panel"),
    enabled,
    refetchInterval: 60_000,
  })
}

export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  const [tab, setTab] = useState<AgentPanelTab>("decidir")
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const dockBlockers = useRef(0)
  const wide = useMediaQuery(DOCK_QUERY)
  const wideRef = useRef(wide)
  wideRef.current = wide
  // La presentación se decide al abrir y no cambia sola (salvo que la ventana
  // se estreche): pasar de cajón a columna a mitad de una decisión desmontaría
  // el motivo de rechazo a medio escribir.
  const [docked, setDocked] = useState(false)
  const dockedRef = useRef(docked)
  dockedRef.current = docked
  const [dockWidth, setDockWidth] = useSideColumnWidth(DOCK_WIDTH_KEY, DOCK_WIDTH)
  // La columna del layout es una sola: si una página ya tiene ahí un formulario
  // o un detalle, el agente se abre como cajón; y si lo abre con el agente en
  // la columna, el agente le cede el sitio.
  const { occupied } = useSideDock()
  const occupiedRef = useRef(occupied)
  occupiedRef.current = occupied
  const setOpen = useCallback((next: boolean, nextTab?: AgentPanelTab) => {
    if (next) {
      const active = document.activeElement
      const inPanel = active instanceof HTMLElement && active.closest(`#${PANEL_ID}`) !== null
      if (!inPanel) {
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
      }
      setTab(nextTab ?? "decidir")
      setDocked(wideRef.current && dockBlockers.current === 0 && !occupiedRef.current)
    }
    setOpenState(next)
  }, [])
  useEffect(() => {
    if (!wide) setDocked(false)
  }, [wide])
  useEffect(() => {
    if (occupied && dockedRef.current) setOpenState(false)
  }, [occupied])
  // Los enlaces del panel no lo cierran al clic: si la página protege un
  // borrador y el usuario elige seguir editando, el panel sigue tal cual. El
  // cajón se cierra cuando la navegación se confirma (cambia la ubicación); la
  // columna fija no tapa la página y acompaña la navegación.
  const href = useRouterState({ select: (state) => state.location.href })
  const lastHref = useRef(href)
  useEffect(() => {
    if (lastHref.current !== href) {
      lastHref.current = href
      if (!dockedRef.current) setOpen(false)
    }
  }, [href, setOpen])
  return (
    <AgentPanelContext.Provider
      value={{
        open,
        docked,
        dockWidth,
        setDockWidth,
        setOpen,
        tab,
        setTab,
        buttonRef,
        openerRef,
        dockBlockers,
      }}
    >
      {/* La estructura no cambia al abrir o cerrar: la página nunca se remonta. */}
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        <SideDockSlot />
        <DockedAgentPanel />
      </div>
      <AgentPanelDrawer />
    </AgentPanelContext.Provider>
  )
}

function useCanSeePanel(): boolean {
  const canRead = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  return canRead || canDecide
}

/** Botón «Agente · N» de la cabecera: abre el panel desde cualquier página. */
export function AgentPanelButton() {
  const canSee = useCanSeePanel()
  const { open, docked, setOpen, buttonRef } = useContext(AgentPanelContext)
  const summary = useAgentPanelSummary(canSee)
  if (!canSee) return null
  const pending = summary.data?.data.pendingProposals ?? 0
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={open ? "default" : "outline"}
      className="elevated relative h-11 gap-2 rounded-full px-2 sm:pr-4"
      onClick={() => setOpen(!open)}
      aria-label={`Agente${pending > 0 ? `, ${pending} por decidir` : ""}`}
      aria-expanded={open}
      aria-controls={open && docked ? PANEL_ID : undefined}
    >
      <span
        className={`flex size-7 items-center justify-center rounded-full ${open ? "bg-background text-primary" : "bg-primary text-primary-foreground"}`}
      >
        <Bot className="size-4" aria-hidden />
      </span>
      <span className="hidden sm:inline">
        Agente{pending > 0 ? ` · ${pending} por decidir` : ""}
      </span>
      {pending > 0 ? (
        <span className="sm:hidden absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-background px-1 text-xs font-bold text-primary ring-2 ring-primary">
          {pending > 99 ? "99+" : pending}
        </span>
      ) : null}
    </Button>
  )
}

type WhenFormatter = (iso: string) => string

/** Fechas en la zona y el idioma de la organización, como en Inicio. */
function whenFormatter(summary: AgentPanelSummary | undefined): WhenFormatter {
  const locale = summary?.locale ?? activeOrgLocale()
  const timeZone = summary?.timezone
  return (iso) =>
    new Date(iso).toLocaleString(locale, {
      timeZone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
}

function headerStatus(data: AgentPanelSummary): string {
  const parts = [
    data.enabled ? "Activo" : "Pausado",
    `${data.interventionsToday} ${data.interventionsToday === 1 ? "intervención" : "intervenciones"} hoy`,
  ]
  if (data.failedToday > 0) parts.push(`${data.failedToday} con error`)
  return parts.join(" · ")
}

/**
 * Cajón: cuando el panel no cabe como columna, y siempre en móvil. Mismo
 * contenedor y gestos que `FormDrawer`, para que todo lo que se superpone a la
 * página se abra y se cierre igual.
 */
function AgentPanelDrawer() {
  const { open, docked, setOpen, buttonRef, openerRef } = useContext(AgentPanelContext)
  const isMobile = useIsMobile()
  const canSee = useCanSeePanel()
  const shown = open && !docked
  const summary = useAgentPanelSummary(shown && canSee)
  const data = summary.data?.data
  return (
    <Drawer
      open={shown}
      swipeDirection={isMobile ? "down" : "right"}
      showSwipeHandle={isMobile}
      onOpenChange={(next) => setOpen(next)}
    >
      <DrawerContent
        id={shown ? PANEL_ID : undefined}
        finalFocus={() => (openerRef.current?.isConnected ? openerRef.current : buttonRef.current)}
        className="data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-1rem-env(safe-area-inset-top))] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem-env(safe-area-inset-top))]"
        aria-label="Agente"
      >
        <PanelHeader data={data} overlay />
        {shown ? <PanelBody summary={data} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

/** Columna fija a la derecha: no es modal, la página sigue usable al lado. */
function DockedAgentPanel() {
  const {
    open,
    docked,
    setOpen,
    buttonRef,
    openerRef,
    dockWidth: width,
    setDockWidth: resize,
  } = useContext(AgentPanelContext)
  const canSee = useCanSeePanel()
  const shown = open && docked && canSee
  const summary = useAgentPanelSummary(shown)
  const data = summary.data?.data
  const ref = useRef<HTMLElement | null>(null)
  // Al abrir, el foco entra en la columna: queda después de la página en el
  // orden de tabulación y quien usa teclado no debe recorrerla entera.
  useEffect(() => {
    if (shown) ref.current?.focus({ preventScroll: true })
  }, [shown])
  if (!shown) return null
  const close = () => {
    const target = openerRef.current?.isConnected ? openerRef.current : buttonRef.current
    setOpen(false)
    // Tras el repintado: lo que la página vuelve a mostrar al cerrar (el
    // «Contexto» de la Bandeja enfoca su título al montarse) no se queda el foco.
    requestAnimationFrame(() => target?.focus())
  }
  return (
    <SideColumn
      ref={ref}
      id={PANEL_ID}
      aria-label="Agente"
      tabIndex={-1}
      width={width}
      onResize={resize}
      bounds={DOCK_WIDTH}
      // La página conserva lo que necesitan la lista y el hilo de la Bandeja.
      pageMinWidth={PAGE_MIN_WIDTH}
      resizeLabel="Ancho del panel del agente"
      onKeyDown={(event) => {
        // Solo Esc pulsado dentro de la columna; los diálogos que abre viven en un portal.
        if (event.key !== "Escape" || event.defaultPrevented) return
        if (!event.currentTarget.contains(event.target as Node)) return
        close()
      }}
    >
      <PanelHeader data={data} onClose={close} />
      <PanelBody summary={data} />
    </SideColumn>
  )
}

function PanelHeader({
  data,
  overlay = false,
  onClose,
}: {
  data: AgentPanelSummary | undefined
  /** Dentro del cajón: título y descripción son los del diálogo. */
  overlay?: boolean
  onClose?: () => void
}) {
  const { setOpen } = useContext(AgentPanelContext)
  const close = onClose ?? (() => setOpen(false))
  const status = (
    <>
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${data?.enabled ? "bg-success" : "bg-muted-foreground"}`}
      />
      {data ? headerStatus(data) : "Cargando…"}
    </>
  )
  return (
    <div className="flex items-center gap-3 border-b p-4 sm:p-5">
      <AgentMark />
      <div className="min-w-0 flex-1 leading-tight">
        {overlay ? (
          <>
            <DrawerTitle className="text-[17px] font-bold tracking-tight">Agente</DrawerTitle>
            <DrawerDescription className="flex items-center gap-1.5 text-xs">
              {status}
            </DrawerDescription>
          </>
        ) : (
          <>
            <h2 className="text-[17px] font-bold tracking-tight">Agente</h2>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{status}</p>
          </>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        aria-label="Cerrar el panel del agente"
        onClick={close}
      >
        <span aria-hidden className="text-lg leading-none">
          ×
        </span>
      </Button>
    </div>
  )
}

function PanelBody({ summary }: { summary: AgentPanelSummary | undefined }) {
  const { tab, setTab } = useContext(AgentPanelContext)
  const pending = summary?.pendingProposals ?? 0
  const openHandoffs = summary?.openHandoffs ?? 0
  const when = whenFormatter(summary)
  return (
    // Controlada: con la columna abierta, la página puede pedir otra pestaña.
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as AgentPanelTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList className="mx-4 mt-3 grid grid-cols-3 sm:mx-5">
        <TabsTrigger value="decidir">Por decidir{pending > 0 ? ` · ${pending}` : ""}</TabsTrigger>
        <TabsTrigger value="derivadas">
          Derivadas{openHandoffs > 0 ? ` · ${openHandoffs}` : ""}
        </TabsTrigger>
        <TabsTrigger value="actividad">Actividad</TabsTrigger>
      </TabsList>
      {/* Pestañas montadas: cambiar de pestaña no pierde un rechazo a medio escribir. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4 sm:p-5">
          <TabsContent value="decidir" keepMounted>
            <ProposalsTab when={when} />
          </TabsContent>
          <TabsContent value="derivadas" keepMounted>
            <HandoffsTab when={when} />
          </TabsContent>
          <TabsContent value="actividad" keepMounted>
            <ActivityTab when={when} />
          </TabsContent>
        </div>
      </ScrollArea>
      <div className="border-t p-4 sm:p-5">
        <Link
          to="/agent/approvals"
          className="flex min-h-11 items-center justify-center rounded-full border font-semibold hover:bg-accent/60"
        >
          Ver todas las aprobaciones
        </Link>
      </div>
    </Tabs>
  )
}

/** Enlace secundario con objetivo táctil suficiente en móvil. */
const INLINE_LINK = "inline-flex min-h-11 items-center font-semibold text-primary hover:underline sm:min-h-0"
/** Botones compactos en escritorio, de 44 px en móvil. */
const TOUCH_SM = "min-h-11 sm:min-h-8"

function ProposalsTab({ when }: { when: WhenFormatter }) {
  const queryClient = useQueryClient()
  const openConversationId = useOpenConversationId()
  const canDecide = usePermission("agent.decide")
  const canConversations = usePermission("conversations.write")
  const canAgenda = usePermission("appointments.write")
  const canCrm = usePermission("crm.write")
  const [approving, setApproving] = useState<AgentProposal | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [outcome, setOutcome] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["agent-panel-proposals"],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>("/api/agent/proposals?status=propuesta&limit=50"),
  })
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: "aprobada" | "rechazada"; reason?: string }) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${input.id}/decision`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (response) => {
      const proposal = response.data
      // Un desenlace que ya no figura en la lista se dice, no se silencia.
      setOutcome(
        proposal.status === "fallida" || proposal.status === "expirada"
          ? `La propuesta quedó ${proposal.status}.${proposalErrorMessage(proposal) ? ` ${proposalErrorMessage(proposal)}` : ""} Gestiona la acción desde el caso.`
          : proposal.status === "rechazada"
            ? "Propuesta rechazada."
            : approvalOutcomeMessage(proposal),
      )
      setApproving(null)
      setRejecting(null)
      setReason("")
      invalidateAfterAgentDecision(queryClient)
    },
  })
  const error =
    decide.error instanceof ApiError
      ? decide.error.shape.message
      : decide.error
        ? "No pudimos registrar la decisión. No se muestra como ejecutada."
        : null
  const authorized = (action: string) => {
    if (!canDecide) return false
    const permission = permissionForAction(action)
    return permission === "conversations.write"
      ? canConversations
      : permission === "appointments.write"
        ? canAgenda
        : canCrm
  }
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar las propuestas.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  // El equipo decide todo lo que no exige confirmación del interlocutor; esas
  // se muestran aparte para que no parezcan decisiones pendientes de nadie.
  // Lo del hilo que hay abierto debajo va primero: es lo que se está mirando.
  const proposals = query.data.data
  const ofOpenThread = (p: AgentProposal) => openConversationId !== null && p.conversationId === openConversationId
  const decidedByTeam = (p: AgentProposal) => p.mode !== "confirmar_usuario"
  const fromOpenThread = proposals.filter(ofOpenThread)
  const forTeam = proposals.filter((p) => decidedByTeam(p) && !ofOpenThread(p))
  const forContact = proposals.filter((p) => !decidedByTeam(p) && !ofOpenThread(p))
  const nothingForTeam = !proposals.some(decidedByTeam)
  const renderProposal = (proposal: AgentProposal, decidable: boolean) => {
    const here = ofOpenThread(proposal)
    const person = proposal.context.contactName ?? "Interlocutor no disponible"
    const patient =
      proposal.context.patientName && proposal.context.patientName !== proposal.context.contactName
        ? proposal.context.patientName
        : null
    return (
      <li
        key={proposal.id}
        className={`flex flex-col gap-3 rounded-2xl border p-4 ${decidable ? "border-primary/30 bg-primary-soft/40" : "bg-card"}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {here ? <Badge>De esta conversación</Badge> : null}
          <Badge variant={decidable ? "soft" : "secondary"}>
            {decidable ? "Espera tu aprobación" : "Espera al interlocutor"}
          </Badge>
          <span className="text-muted-foreground">{when(proposal.createdAt)}</span>
        </div>
        <h3 className="text-[15px] font-bold tracking-tight">
          {ACTION_LABEL[proposal.action] ?? proposal.action}
        </h3>
        <div className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm">
          <p className="font-semibold">
            {person}
            {proposal.context.channel ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {channelLabel(proposal.context.channel)}
              </span>
            ) : null}
          </p>
          {patient ? <p>Paciente: {patient}</p> : null}
          {proposal.context.opportunityTitle ? (
            <p className="text-muted-foreground">{proposal.context.opportunityTitle}</p>
          ) : null}
          {proposal.context.beforeSummary ? (
            <p className="text-xs text-muted-foreground">
              Al proponer: {proposal.context.beforeSummary}
            </p>
          ) : null}
          <p>{proposal.context.afterSummary}</p>
          {proposal.reason ? <p className="text-muted-foreground">Motivo: {proposal.reason}</p> : null}
          {proposal.context.isStale ? (
            <p role="alert" className="text-destructive">
              La situación cambió desde que se propuso; revisa el caso antes de decidir.
            </p>
          ) : null}
        </div>
        {decidable && authorized(proposal.action) ? (
          rejecting === proposal.id ? (
            <div className="flex flex-col gap-2">
              <Field>
                <FieldLabel htmlFor={`panel-rechazo-${proposal.id}`}>Motivo del rechazo</FieldLabel>
                <Input
                  id={`panel-rechazo-${proposal.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                  autoFocus
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <SubmitButton
                  size="sm"
                  variant="outline"
                  className={TOUCH_SM}
                  pending={decide.isPending}
                  disabled={!reason.trim()}
                  onClick={() => decide.mutate({ id: proposal.id, decision: "rechazada", reason })}
                >
                  Confirmar rechazo
                </SubmitButton>
                <Button
                  size="sm"
                  variant="ghost"
                  className={TOUCH_SM}
                  onClick={() => {
                    setRejecting(null)
                    setReason("")
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className={`flex-1 rounded-full ${TOUCH_SM}`}
                disabled={decide.isPending}
                onClick={() => {
                  decide.reset()
                  setApproving(proposal)
                }}
              >
                Revisar y aprobar
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className={`rounded-full ${TOUCH_SM}`}
                onClick={() => {
                  decide.reset()
                  setRejecting(proposal.id)
                }}
              >
                Rechazar…
              </Button>
            </div>
          )
        ) : null}
        {here ? null : proposal.conversationId ? (
          <Link
            to="/inbox"
            search={{ conversation: proposal.conversationId }}
            className={`text-sm ${INLINE_LINK}`}
          >
            {decidable ? "Abrir caso" : "Abrir conversación"}
          </Link>
        ) : typeof proposal.payload.opportunityId === "string" ? (
          // Trabajo proactivo sin hilo: el caso es la oportunidad; el hilo se abre al aprobar.
          <Link
            to="/opportunities/$opportunityId"
            params={{ opportunityId: proposal.payload.opportunityId }}
            className={`text-sm ${INLINE_LINK}`}
          >
            Abrir oportunidad
          </Link>
        ) : null}
      </li>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {outcome ? (
        <p role="status" className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
          {outcome}{" "}
          <button type="button" className="underline" onClick={() => setOutcome(null)}>
            Descartar
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {nothingForTeam ? (
        <EmptyState
          title="Nada por decidir"
          description="Cuando el agente prepare un cambio que necesite tu aprobación, aparecerá aquí."
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {fromOpenThread.map((p) => renderProposal(p, decidedByTeam(p)))}
        {forTeam.map((p) => renderProposal(p, true))}
      </ul>
      {forContact.length > 0 ? (
        <section aria-label="Esperan al interlocutor" className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Esperan al interlocutor · {forContact.length}
          </h3>
          <ul className="flex flex-col gap-3">{forContact.map((p) => renderProposal(p, false))}</ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={approving !== null}
        title="Aprobar y ejecutar el cambio"
        description={
          approving
            ? `${approving.context.patientName && approving.context.patientName !== approving.context.contactName ? `Paciente: ${approving.context.patientName} · Interlocutor: ` : ""}${approving.context.contactName ?? "Interlocutor"}: ${approving.context.afterSummary}`
            : ""
        }
        confirmLabel="Aprobar y ejecutar"
        variant="default"
        pending={decide.isPending}
        onClose={() => {
          if (!decide.isPending) setApproving(null)
        }}
        onConfirm={() => approving && decide.mutate({ id: approving.id, decision: "aprobada" })}
      />
    </div>
  )
}

function HandoffsTab({ when }: { when: WhenFormatter }) {
  const queryClient = useQueryClient()
  const canTasks = usePermission("tasks.write")
  const query = useQuery({
    queryKey: ["agent-panel-handoffs"],
    queryFn: () => apiFetch<{ data: AgentHandoff[] }>("/api/agent/handoffs?open=1&limit=50"),
  })
  const claim = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: AgentHandoff }>(`/api/agent/handoffs/${id}/claim`, { method: "POST" }),
    onSuccess: () => invalidateAfterAgentDecision(queryClient),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar las derivaciones.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  const handoffs = query.data.data
  const error =
    claim.error instanceof ApiError
      ? claim.error.shape.message
      : claim.error
        ? "No pudimos tomar el caso."
        : null
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {handoffs.length === 0 ? (
        <EmptyState
          title="Sin derivaciones abiertas"
          description="Los casos que el agente pase al equipo esperan aquí hasta que alguien los tome y resuelva."
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {handoffs.map((handoff) => {
          const high = handoff.priority === "alta"
          return (
            <li
              key={handoff.id}
              className="flex flex-col gap-2 rounded-2xl border bg-card p-4 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  aria-hidden
                  className={
                    high ? "size-2 rounded-full bg-destructive" : "size-2 rounded-[2px] bg-warning"
                  }
                />
                <span
                  className={`text-xs font-semibold ${high ? "text-destructive" : "text-warning"}`}
                >
                  Prioridad {handoff.priority}
                </span>
                <Badge variant="secondary">
                  {handoff.status === "tomada" ? "Responsable asignado" : "En cola por recoger"}
                </Badge>
              </div>
              <p className="font-semibold">
                {handoff.contactName ?? "Interlocutor no disponible"}
                {handoff.channel ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {channelLabel(handoff.channel)}
                  </span>
                ) : null}
              </p>
              <p>{handoff.reason}</p>
              {handoff.dueAt ? (
                <p className="text-xs text-muted-foreground">Vence {when(handoff.dueAt)}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {handoff.status === "abierta" && canTasks ? (
                  <SubmitButton
                    size="sm"
                    className={`rounded-full ${TOUCH_SM}`}
                    pending={claim.isPending}
                    onClick={() => claim.mutate(handoff.id)}
                  >
                    Tomar caso
                  </SubmitButton>
                ) : null}
                {handoff.conversationId ? (
                  <Link
                    to="/inbox"
                    search={{ conversation: handoff.conversationId }}
                    className={INLINE_LINK}
                  >
                    Abrir conversación
                  </Link>
                ) : null}
                {handoff.taskId ? (
                  <Link to="/tasks" search={{ task: handoff.taskId }} className={INLINE_LINK}>
                    Abrir pendiente
                  </Link>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const ACTIVITY_STATUS: Record<string, string> = {
  propuesta: "pendiente",
  aprobada: "aprobada",
  rechazada: "rechazada",
  ejecutada: "ejecutada",
  fallida: "fallida",
  expirada: "expirada",
  abierta: "en cola",
  tomada: "tomada",
  resuelta: "resuelta",
  // Entrega de mensajes: lo que el proveedor confirmó, no lo que se intentó.
  queued: "pendiente de envío",
  sent: "enviado",
  delivered: "entregado",
  read: "leído",
  failed: "no se envió",
  unknown: "entrega incierta",
}

function ActivityTab({ when }: { when: WhenFormatter }) {
  const query = useQuery({
    queryKey: ["agent-panel-activity"],
    queryFn: () => apiFetch<{ data: AgentActivityItem[] }>("/api/agent/activity?limit=50"),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar la actividad.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  const items = query.data.data
  if (items.length === 0)
    return (
      <EmptyState
        title="Sin actividad"
        description="Aquí verás lo que el agente envió, propuso o derivó."
      />
    )
  return (
    <ul className="flex flex-col divide-y">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="flex flex-col gap-1 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{when(item.at)}</span>
            {item.status ? (
              <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
                {ACTIVITY_STATUS[item.status] ?? item.status}
              </Badge>
            ) : null}
          </div>
          <p>
            <span className="font-semibold">{item.title}</span>
            {item.contactName ? ` · ${item.contactName}` : ""}
          </p>
          {item.detail ? <p className="text-muted-foreground">{item.detail}</p> : null}
          {item.conversationId ? (
            <Link
              to="/inbox"
              search={{ conversation: item.conversationId }}
              className={`text-xs ${INLINE_LINK}`}
            >
              Abrir conversación
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
