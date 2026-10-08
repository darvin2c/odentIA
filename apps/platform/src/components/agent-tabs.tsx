import { cn } from "@odentia/ui"
import { Link, useRouterState } from "@tanstack/react-router"
import { usePermission } from "../lib/crm"

const TABS = [
  { label: "Aprobaciones", to: "/agent/approvals", permission: "decide" },
  { label: "Actividad", to: "/agent", permission: "read" },
  { label: "Conocimiento", to: "/agent/knowledge", permission: "write" },
] as const

/**
 * Secciones del agente como pestañas de página. Son rutas, no paneles de una
 * misma vista: se anuncian como navegación con `aria-current`, y cada pestaña
 * aparece solo con el permiso que su ruta ya exige en el servidor.
 */
export function AgentTabs() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const canRead = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canWrite = usePermission("agent.write")
  const visible = TABS.filter((tab) =>
    tab.permission === "decide"
      ? canDecide || canRead
      : tab.permission === "read"
        ? canRead
        : canWrite,
  )
  if (visible.length < 2) return null
  return (
    <nav aria-label="Secciones del agente" className="-mt-2 flex gap-1 overflow-x-auto border-b">
      {visible.map((tab) => {
        const active = pathname === tab.to
        return (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: true }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active
                ? "border-primary font-semibold text-primary-soft-foreground"
                : "border-transparent font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
