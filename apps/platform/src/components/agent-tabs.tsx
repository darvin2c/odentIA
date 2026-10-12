import { cn } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import type { AgentOverview } from "../lib/agent"
import { apiFetch } from "../lib/api"
import { usePermission } from "../lib/crm"

const TABS = [
  { label: "Resumen", to: "/agent", permission: "read" },
  { label: "Aprobaciones", to: "/agent/approvals", permission: "decide", phoneLast: true },
  { label: "Aprender", to: "/agent/learn", permission: "read" },
  { label: "Conocimiento", to: "/agent/knowledge", permission: "write" },
] as const

/**
 * Secciones del agente como pestañas de página. Son rutas, no paneles de una
 * misma vista: se anuncian como navegación con `aria-current`, y cada pestaña
 * aparece solo con el permiso que su ruta ya exige en el servidor.
 *
 * Cada pestaña dice cuánto espera a una persona. Los números salen del mismo
 * resumen que «Necesita de ti» (`/api/agent/overview`, consulta compartida con
 * esa pantalla): no hay otra cuenta. En teléfono se dibujan como píldoras y
 * «Aprobaciones» pasa al final de la fila (`phoneLast`): ahí el recorrido es
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
  const needs = overview.data?.data.needsYou
  const pending: Record<string, number> = needs
    ? { "/agent/approvals": needs.approvals, "/agent/learn": needs.review + needs.lessons, "/agent/knowledge": needs.gaps }
    : {}
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
    <nav aria-label="Secciones del agente" className="relative -mt-2 flex gap-1.5 overflow-x-auto max-sm:pb-1 sm:gap-1 sm:border-b">
      {visible.map((tab) => {
        const active = pathname === tab.to
        const count = pending[tab.to] ?? 0
        return (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: true }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "max-sm:rounded-full max-sm:border max-sm:px-3.5 sm:-mb-px sm:border-b-2 sm:px-3 sm:focus-visible:ring-inset",
              "phoneLast" in tab && "max-sm:order-1",
              active
                ? "border-primary font-semibold text-primary-soft-foreground max-sm:border-2 max-sm:bg-primary-soft"
                : "font-medium text-muted-foreground hover:text-foreground max-sm:border-border max-sm:bg-card sm:border-transparent",
            )}
          >
            {tab.label}
            {count > 0 ? (
              <span
                className={cn(
                  "font-bold tabular-nums sm:inline-flex sm:h-5 sm:min-w-5 sm:items-center sm:justify-center sm:rounded-full sm:px-1.5 sm:text-xs",
                  active ? "sm:bg-primary-soft" : "text-foreground sm:bg-muted",
                )}
              >
                {count}
                <span className="sr-only"> {count === 1 ? "pendiente" : "pendientes"}</span>
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
