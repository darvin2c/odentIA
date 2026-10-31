import { cn, ScrollArea, tabsListVariants, tabsTriggerClassName } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import type { AgentOverview } from "../lib/agent"
import { apiFetch } from "../lib/api"
import { useCan, usePermission } from "../lib/crm"
import { agentTabsFor } from "../lib/screen-rules"

/**
 * Secciones del agente como pestañas de página. Son rutas, no paneles de una
 * misma vista: se anuncian como navegación con `aria-current`, y cada pestaña
 * aparece solo con el permiso que su ruta ya exige en el servidor
 * (`agentTabsFor`, la misma regla que su esqueleto).
 *
 * Se dibujan con el mismo control que Pacientes (`tabsTriggerClassName`): la
 * activa es la píldora blanca y lo que espera a una persona va después del
 * nombre, con «·».
 *
 * Aprender y Conocimiento dicen cuánto espera a una persona. Los números salen
 * del mismo resumen que «Necesita de ti» (`/api/agent/overview`, consulta
 * compartida con esa pantalla) y suman el número del menú «Agente». Lo que
 * espera el sí de la persona y los casos que el agente pasó al equipo no están
 * aquí: se ven en la Bandeja y en el panel del agente (ADR 0118).
 *
 * `learnPending`: «Aprender» concilia su lista al cargarla, así que esa pantalla
 * pasa lo que ya muestra y la pestaña no dice otra cosa mientras el resumen se
 * pone al día.
 */
export function AgentTabs({ learnPending }: { learnPending?: number } = {}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const canRead = usePermission("agent.read")
  const can = useCan()
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
    ? { "/agent/learn": needs.review + needs.lessons, "/agent/knowledge": needs.gaps }
    : {}
  if (learnPending !== undefined) pending["/agent/learn"] = learnPending
  const visible = agentTabsFor(can)
  if (visible.length === 0) return null
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
              className={cn(tabsTriggerClassName, "shrink-0 min-h-11 sm:min-h-9")}
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
