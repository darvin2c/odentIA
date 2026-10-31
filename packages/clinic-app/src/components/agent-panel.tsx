import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DropdownMenuItem,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useIsMobile,
} from "@odentia/ui"
import {
  AgentMark,
  EmptyState,
  LoadingState,
  SideColumn,
  SideDockSlot,
  SubmitButton,
  useHeaderCompact,
  useSideColumnWidth,
  useSideDock,
  useSidebarWidth,
} from "@odentia/ui-patterns"
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import { CaseBriefDrawer } from "./agent/case-brief"
import { HandoffNotice } from "./agent/handoff-badges"
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
  AGENT_CASES_TITLE,
  type AgentActivityItem,
  type AgentHandoff,
  type AgentPanelSummary,
  type AgentProposal,
} from "../lib/agent"
import { useReceptionName } from "../lib/agent-names"
import { ApiError, apiFetch } from "../lib/api"
import { channelLabel } from "../lib/channels"
import { usePermission } from "../lib/crm"
import { activeOrgLocale } from "../lib/locale"

/**
 * Panel lateral global del agente: los casos del agente, las citas que esperan
 * el sí del paciente y la actividad, desde
 * cualquier pantalla. En pantalla grande es una columna fija a la derecha y la
 * página sigue usable al lado; cuando no cabe se superpone, sin cerrar la
 * página ni sus borradores, con el mismo cajón que los formularios: lateral en
 * escritorio y hoja inferior con asa en móvil.
 *
 * La misma columna (o el mismo cajón) muestra los Avisos de la campana: uno a
 * la vez, con la misma cabecera y el mismo «×» (issue 93).
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

export type AgentPanelTab = "derivadas" | "paciente" | "actividad"

/**
 * Lo que ocupa la columna de la cabecera: el Agente o los Avisos (issue 93).
 * Es una sola columna: abrir una cierra la otra.
 */
export type HeaderPanelSurface = "agente" | "avisos"

/** Marco que recibe el contenido de Avisos: el mismo de la columna o del cajón. */
export interface HeaderPanelFrame {
  /** Dentro del cajón: título y descripción son los del diálogo. */
  overlay: boolean
  onClose: () => void
}

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
  /** Qué muestra la columna mientras está abierta. */
  surface: HeaderPanelSurface
  /** Abre o cierra el Agente; al abrir puede elegir la pestaña (por defecto «Derivadas»). */
  setOpen: (open: boolean, tab?: AgentPanelTab) => void
  /** Abre o cierra los Avisos en la misma columna. */
  setNoticesOpen: (open: boolean) => void
  /** Contenido de Avisos, que aporta el layout. */
  notices: ((frame: HeaderPanelFrame) => ReactNode) | undefined
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
  surface: "agente",
  setOpen: () => {},
  setNoticesOpen: () => {},
  notices: undefined,
  tab: "derivadas",
  setTab: () => {},
  buttonRef: { current: null },
  openerRef: { current: null },
  dockBlockers: { current: 0 },
})

/**
 * Abrir o cerrar el panel desde otra superficie (banda del hilo, Inicio).
 * `open` y `docked` dicen si la columna de la cabecera está ocupada, sea por el
 * Agente o por los Avisos: la Bandeja le cede «Contexto» igual en los dos casos.
 */
export function useAgentPanel(): Pick<AgentPanelState, "open" | "docked" | "setOpen"> {
  const { open, docked, setOpen } = useContext(AgentPanelContext)
  return { open, docked, setOpen }
}

/** La campana: si los Avisos están abiertos y cómo abrirlos o cerrarlos. */
export function useNoticesPanel(): { open: boolean; setOpen: (open: boolean) => void } {
  const { open, surface, setNoticesOpen } = useContext(AgentPanelContext)
  return { open: open && surface === "avisos", setOpen: setNoticesOpen }
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

export function AgentPanelProvider({
  children,
  notices,
}: {
  children: ReactNode
  /** Contenido de Avisos; sin él, la campana no tiene dónde abrirse. */
  notices?: (frame: HeaderPanelFrame) => ReactNode
}) {
  const [open, setOpenState] = useState(false)
  const [surface, setSurface] = useState<HeaderPanelSurface>("agente")
  const [tab, setTab] = useState<AgentPanelTab>("derivadas")
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const dockBlockers = useRef(0)
  const wide = useMediaQuery(DOCK_QUERY)
  const wideRef = useRef(wide)
  wideRef.current = wide
  // La presentación se decide al abrir y no cambia sola (salvo que la ventana
  // se estreche): pasar de cajón a columna a mitad de una tarea desmontaría lo
  // que se estaba mirando.
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
  const openRef = useRef(open)
  openRef.current = open
  const show = useCallback((next: boolean, nextSurface: HeaderPanelSurface) => {
    if (next) {
      const active = document.activeElement
      const inPanel = active instanceof HTMLElement && active.closest(`#${PANEL_ID}`) !== null
      if (!inPanel) {
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
      }
      setSurface(nextSurface)
      // Si ya está abierta, la otra superficie toma su mismo lugar (columna o cajón).
      if (!openRef.current) setDocked(wideRef.current && dockBlockers.current === 0 && !occupiedRef.current)
    }
    setOpenState(next)
  }, [])
  const setOpen = useCallback(
    (next: boolean, nextTab?: AgentPanelTab) => {
      if (next) setTab(nextTab ?? "derivadas")
      show(next, "agente")
    },
    [show],
  )
  const setNoticesOpen = useCallback((next: boolean) => show(next, "avisos"), [show])
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
        surface,
        setOpen,
        setNoticesOpen,
        notices,
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

/**
 * Botón «Agente» de la cabecera: abre el panel desde cualquier página. Lleva
 * el número de los casos que el agente pasó a quien mira (lo que nadie tomó
 * más lo suyo): se toman en este panel (ADR 0118), como en «Te espera».
 */
export function AgentPanelButton() {
  const canSee = useCanSeePanel()
  const { open: columnOpen, surface, docked, setOpen, buttonRef } = useContext(AgentPanelContext)
  const compact = useHeaderCompact()
  const cases = useAgentPanelSummary(canSee).data?.data.openHandoffs ?? 0
  const open = columnOpen && surface === "agente"
  if (!canSee) return null
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={open ? "default" : "outline"}
      className={`elevated relative h-9 gap-2 rounded-full px-2 max-md:hidden ${compact ? "w-9 justify-center gap-0 px-0" : "md:pr-3"}`}
      onClick={() => setOpen(!open)}
      aria-label={`Agente${cases ? `: ${cases} ${cases === 1 ? "caso" : "casos"} por tomar` : ""}`}
      aria-expanded={open}
      aria-controls={open && docked ? PANEL_ID : undefined}
    >
      <span
        className={`flex size-7 items-center justify-center rounded-full ${open ? "bg-background text-primary" : "bg-primary text-primary-foreground"}`}
      >
        <Bot className="size-4" aria-hidden />
      </span>
      {compact ? null : <span className="hidden md:inline">Agente</span>}
      {cases > 0 ? (
        <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-xs font-semibold text-background ring-2 ring-canvas">
          {cases > 99 ? "99+" : cases}
        </span>
      ) : null}
    </Button>
  )
}

/**
 * «Agente» en el menú ⋯, solo en el teléfono: ahí el botón no cabe en la fila.
 * El panel recuerda como origen el botón ⋯ (no la opción, que desaparece): así,
 * al cerrarlo, el foco vuelve a ⋯ y no se pierde.
 */
export function AgentPanelMenuItem() {
  const canSee = useCanSeePanel()
  const { setOpen } = useContext(AgentPanelContext)
  const cases = useAgentPanelSummary(canSee).data?.data.openHandoffs ?? 0
  if (!canSee) return null
  return (
    <DropdownMenuItem
      className="md:hidden"
      onClick={() => {
        const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"][aria-expanded="true"]')
        requestAnimationFrame(() => {
          trigger?.focus()
          setOpen(true)
        })
      }}
    >
      <Bot aria-hidden />
      Agente
      {cases > 0 ? (
        <span className="ml-auto tabular-nums text-muted-foreground">
          {cases}
          <span className="sr-only"> {cases === 1 ? "caso por tomar" : "casos por tomar"}</span>
        </span>
      ) : null}
    </DropdownMenuItem>
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
  const { open, docked, surface, setOpen, setNoticesOpen, notices, buttonRef, openerRef } =
    useContext(AgentPanelContext)
  const isMobile = useIsMobile()
  const canSee = useCanSeePanel()
  const shown = open && !docked
  const agent = surface === "agente"
  const summary = useAgentPanelSummary(shown && agent && canSee)
  const data = summary.data?.data
  return (
    <Drawer
      open={shown}
      swipeDirection={isMobile ? "down" : "right"}
      showSwipeHandle={isMobile}
      onOpenChange={(next) => (agent ? setOpen(next) : setNoticesOpen(next))}
    >
      <DrawerContent
        id={shown ? PANEL_ID : undefined}
        finalFocus={() => (openerRef.current?.isConnected ? openerRef.current : buttonRef.current)}
        className="data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-1rem-env(safe-area-inset-top))] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem-env(safe-area-inset-top))]"
        aria-label={agent ? "Agente" : "Avisos"}
      >
        {agent ? (
          <>
            <PanelHeader data={data} overlay />
            {shown ? <PanelBody summary={data} /> : null}
          </>
        ) : (
          notices?.({ overlay: true, onClose: () => setNoticesOpen(false) })
        )}
      </DrawerContent>
    </Drawer>
  )
}

/** Columna fija a la derecha: no es modal, la página sigue usable al lado. Muestra el Agente o los Avisos. */
function DockedAgentPanel() {
  const {
    open,
    docked,
    surface,
    setOpen,
    notices,
    buttonRef,
    openerRef,
    dockWidth: width,
    setDockWidth: resize,
  } = useContext(AgentPanelContext)
  const canSee = useCanSeePanel()
  const agent = surface === "agente"
  const shown = open && docked && (agent ? canSee : notices !== undefined)
  const summary = useAgentPanelSummary(shown && agent)
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
      aria-label={agent ? "Agente" : "Avisos"}
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
      {agent ? (
        <>
          <PanelHeader data={data} onClose={close} />
          <PanelBody summary={data} />
        </>
      ) : (
        notices?.({ overlay: false, onClose: close })
      )}
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
  const awaiting = summary?.awaitingContact ?? 0
  const when = whenFormatter(summary)
  return (
    // Controlada: con la columna abierta, la página puede pedir otra pestaña.
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as AgentPanelTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/*
        Nombres cortos y cada pestaña del ancho de su texto (issue 92): en la
        columna más angosta (320 px) y a 200 % de zoom caben sin pisarse. El
        nombre completo queda como nombre accesible y en el título.
      */}
      <TabsList className="mx-4 mt-3 max-w-[calc(100%-2rem)] sm:mx-5 sm:max-w-[calc(100%-2.5rem)]">
        {/* Sin número: el único contador de los casos está en el menú. */}
        <TabsTrigger value="derivadas" className="flex-none" aria-label={AGENT_CASES_TITLE} title={AGENT_CASES_TITLE}>
          Casos
        </TabsTrigger>
        <TabsTrigger
          value="paciente"
          className="flex-none"
          aria-label={`Esperan al paciente${awaiting > 0 ? ` · ${awaiting}` : ""}`}
          title="Esperan al paciente"
        >
          Esperan{awaiting > 0 ? ` · ${awaiting}` : ""}
        </TabsTrigger>
        <TabsTrigger value="actividad" className="flex-none">
          Actividad
        </TabsTrigger>
      </TabsList>
      {/* Pestañas montadas: cambiar de pestaña no pierde lo que se estaba mirando. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4 sm:p-5">
          <TabsContent value="derivadas" keepMounted>
            <HandoffsTab when={when} />
          </TabsContent>
          <TabsContent value="paciente" keepMounted>
            <AwaitingTab when={when} />
          </TabsContent>
          <TabsContent value="actividad" keepMounted>
            <ActivityTab when={when} />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}

/** Enlace secundario con objetivo táctil suficiente en móvil. */
const INLINE_LINK = "inline-flex min-h-11 items-center font-semibold text-primary hover:underline sm:min-h-0"
/** Botones compactos en escritorio, de 44 px en móvil. */
const TOUCH_SM = "min-h-11 sm:min-h-8"

/**
 * Lo que espera el sí del paciente: las citas que el agente propuso en un hilo.
 * El equipo no las aprueba ni las rechaza (ADR 0023); las ve y abre la
 * conversación. Lo del hilo que hay abierto debajo va primero.
 */
function AwaitingTab({ when }: { when: WhenFormatter }) {
  const openConversationId = useOpenConversationId()
  const receptionName = useReceptionName()
  const query = useQuery({
    queryKey: ["agent-panel-proposals"],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>("/api/agent/proposals?status=propuesta&limit=50"),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar lo que espera al paciente.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Volver a intentar
        </Button>
      </div>
    )
  const ofOpenThread = (p: AgentProposal) => openConversationId !== null && p.conversationId === openConversationId
  const proposals = [...query.data.data.filter(ofOpenThread), ...query.data.data.filter((p) => !ofOpenThread(p))]
  if (proposals.length === 0)
    return (
      <EmptyState
        title="Nada espera al paciente"
        description={`Cuando ${receptionName} proponga una cita en una conversación, espera aquí el sí del paciente.`}
      />
    )
  return (
    <ul className="flex flex-col gap-3">
      {proposals.map((proposal) => {
        const here = ofOpenThread(proposal)
        const person = proposal.context.contactName ?? "Interlocutor no disponible"
        const patient =
          proposal.context.patientName && proposal.context.patientName !== proposal.context.contactName
            ? proposal.context.patientName
            : null
        return (
          <li key={proposal.id} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {here ? <Badge>De esta conversación</Badge> : null}
              <Badge variant="secondary">Espera al paciente</Badge>
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
              <p>{proposal.context.afterSummary}</p>
              {proposal.context.isStale ? (
                <p role="alert" className="text-destructive">
                  La situación cambió desde que se propuso; revisa el caso.
                </p>
              ) : null}
            </div>
            {here ? null : (
              <Link
                to="/inbox"
                search={{ conversation: proposal.conversationId }}
                className={`text-sm ${INLINE_LINK}`}
              >
                Abrir conversación
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * «Tomar este tema» (pulido de la Bandeja, tablero 4d): se toma el tema, no la
 * conversación, como en la Bandeja. El agente sigue con lo demás y el cierre
 * de la conversación no se detiene. Un caso sin conversación se toma como caso.
 */
export function takeCase(handoff: Pick<AgentHandoff, "id" | "conversationId">): Promise<unknown> {
  return handoff.conversationId
    ? apiFetch(`/api/workspace/topics/${handoff.id}/take`, { method: "POST" })
    : apiFetch(`/api/agent/handoffs/${handoff.id}/claim`, { method: "POST" })
}

/** Quién puede tomarlo: la conversación pide `conversations.write`; un caso suelto, `tasks.write`. */
export function canTakeCase(handoff: Pick<AgentHandoff, "conversationId">, canConversations: boolean, canTasks: boolean): boolean {
  return handoff.conversationId ? canConversations : canTasks
}

function HandoffsTab({ when }: { when: WhenFormatter }) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const canTasks = usePermission("tasks.write")
  const canConversations = usePermission("conversations.write")
  const [briefFor, setBriefFor] = useState<AgentHandoff | null>(null)
  const query = useQuery({
    queryKey: ["agent-panel-handoffs"],
    // Los urgentes y los que más llevan esperando primero: el tope nunca deja fuera a los más viejos.
    queryFn: () => apiFetch<{ data: AgentHandoff[] }>("/api/agent/handoffs?open=1&limit=100&order=urgencia"),
  })
  const claim = useMutation({
    mutationFn: (handoff: AgentHandoff) => takeCase(handoff),
    onSuccess: () => invalidateAfterAgentDecision(queryClient),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p>No pudimos cargar los casos del agente.</p>
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
          title="Ningún caso del agente espera"
          description={`Lo que ${receptionName} te pase espera aquí y en «Te espera» hasta que alguien lo tome y lo resuelva.`}
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {handoffs.map((handoff) => {
          return (
            <li
              key={handoff.id}
              className="flex flex-col gap-2 rounded-2xl border bg-card p-4 text-sm"
            >
              <HandoffNotice handoff={handoff} onOpenCase={setBriefFor}>
                <span className="text-xs text-muted-foreground">
                  {handoff.status === "tomada" ? "Ya lo tomaron" : "Nadie lo ha tomado"}
                  {handoff.dueAt ? ` · vence ${when(handoff.dueAt)}` : ""}
                </span>
                {handoff.status === "abierta" && canTakeCase(handoff, canConversations, canTasks) ? (
                  <SubmitButton
                    size="sm"
                    className={`rounded-full ${TOUCH_SM}`}
                    pending={claim.isPending}
                    onClick={() => claim.mutate(handoff)}
                  >
                    {handoff.conversationId ? "Tomar este tema" : "Tomar"}
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
                    Abrir la tarea
                  </Link>
                ) : null}
              </HandoffNotice>
            </li>
          )
        })}
      </ul>
      {handoffs.length >= 100 ? (
        <p className="text-sm text-muted-foreground">
          Se muestran los 100 más urgentes y antiguos. Cada caso es también una tarea de Recepción en{" "}
          <Link to="/tasks" search={{ task: undefined, vista: "todas" }} className={INLINE_LINK}>
            Tareas
          </Link>
          .
        </p>
      ) : null}
      <CaseBriefDrawer
        conversationId={briefFor?.conversationId ?? null}
        name={briefFor?.contactName ?? "Interlocutor"}
        canTake={canConversations}
        onClose={() => setBriefFor(null)}
        onClaimed={() => invalidateAfterAgentDecision(queryClient)}
      />
    </div>
  )
}

const ACTIVITY_STATUS: Record<string, string> = {
  propuesta: "pendiente",
  aprobada: "aprobada",
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
