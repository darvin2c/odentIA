import { cn, ScrollArea, tabsListVariants, tabsTriggerClassName } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import type { AgentOverview, AgentPanelSummary } from "../lib/agent"
import { apiFetch } from "../lib/api"
import { usePermission } from "../lib/crm"

const TABS = [
  { label: "Resumen", to: "/agent", permission: "read" },
  { label: "Esperan su sí", to: "/agent/pendientes", permission: "decide", phoneLast: true },
  { label: "Aprender", to: "/agent/learn", permission: "read" },
  { label: "Conocimiento", to: "/agent/knowledge", permission: "write" },
] as const

/**
 * Secciones del agente como pestañas de página. Son rutas, no paneles de una
 * misma vista: se anuncian como navegación con `aria-current`, y cada pestaña
 * aparece solo con el permiso que su ruta ya exige en el servidor.
 *
 * Se dibujan con el mismo control que Pacientes (`tabsTriggerClassName`): la
 * activa es la píldora blanca y lo que espera a una persona va después del
 * nombre, con «·».
 *
 * Aprender y Conocimiento dicen cuánto espera a una persona. Los números salen
 * del mismo resumen que «Necesita de ti» (`/api/agent/overview`, consulta
 * compartida con esa pantalla): no hay otra cuenta. «Esperan su sí» cuenta
 * solo las citas propuestas que esperan respuesta (`awaitingAnswer` del panel
 * del agente): los casos se cuentan en «Te espera» y en el menú. En teléfono
 * «Esperan su sí» pasa al final de la fila (`phoneLast`): ahí el recorrido es
 * Resumen, Aprender, Conocimiento. El orden del documento, y con él el del
 * teclado, es el mismo en todos los anchos.
 *
 * `learnPending`: «Aprender» concilia su lista al cargarla, así que esa pantalla
 * pasa lo que ya muestra y la pestaña no dice otra cosa mientras el resumen se
 * pone al día.
 */
export function AgentTabs({ learnPending }: { learnPending?: number } = {}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const canRead = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canWrite = usePermission("agent.write")
  // Sin escucha propia de eventos: se refresca al navegar y cuando una pantalla
  // invalida el resumen tras decidir algo. Sin el permiso de lectura no hay números.
  const overview = useQuery({
    queryKey: ["agent-overview"],
    queryFn: () => apiFetch<{ data: AgentOverview }>("/api/agent/overview"),
    enabled: canRead,
    retry: false,
    staleTime: 30_000,
  })
  // La misma consulta que el panel del agente: la leen también quienes solo deciden.
  const panel = useQuery({
    queryKey: ["agent-panel"],
    queryFn: () => apiFetch<{ data: AgentPanelSummary }>("/api/agent/panel"),
    enabled: canDecide || canRead,
    retry: false,
    staleTime: 30_000,
  })
  const needs = overview.data?.data.needsYou
  const pending: Record<string, number> = needs
    ? { "/agent/learn": needs.review + needs.lessons, "/agent/knowledge": needs.gaps }
    : {}
  const awaiting = panel.data?.data.awaitingAnswer
  if (awaiting !== undefined) pending["/agent/pendientes"] = awaiting
  if (learnPending !== undefined) pending["/agent/learn"] = learnPending
  const visible = TABS.filter((tab) =>
    tab.permission === "decide"
      ? canDecide || canRead
      : tab.permission === "read"
        ? canRead
        : canWrite,
  )
  if (visible.length < 2) return null
  return (
    <ScrollArea horizontal className="-mt-2 min-w-0">
      <nav aria-label="Secciones del agente" className={cn(tabsListVariants(), "h-11 max-w-full justify-start")}>
        {visible.map((tab) => {
          const active = pathname === tab.to
          const count = pending[tab.to] ?? 0
          return (
            <Link
              key={tab.to}
              to={tab.to}
              activeOptions={{ exact: true }}
              aria-current={active ? "page" : undefined}
              data-active={active ? "" : undefined}
              className={cn(
                tabsTriggerClassName,
                "shrink-0 min-h-11 sm:min-h-9",
                "phoneLast" in tab && "max-sm:order-1",
              )}
            >
              {tab.label}
              {count > 0 ? (
                <span className="tabular-nums">
                  {` · ${count}`}
                  <span className="sr-only"> {count === 1 ? "pendiente" : "pendientes"}</span>
                </span>
              ) : null}
            </Link>
          )
        })}
      </nav>
    </ScrollArea>
  )
}
