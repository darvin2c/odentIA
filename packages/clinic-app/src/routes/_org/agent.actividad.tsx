import { Badge } from "@odentia/ui"
import { EmptyState, PageHeader, PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { AgentTabs } from "../../components/agent-tabs"
import { AgentActivityPageSkeleton, AgentActivitySkeleton } from "../../components/skeletons/agent"
import type { AgentActivityItem } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { QueryErrorState } from "../../lib/query-error"

/**
 * Agente › «Actividad»: lo que el agente envió, propuso o le pasó al equipo.
 * Para saber, no para hacer: lo que espera a una persona está en «Te espera».
 * Se refresca con los eventos que escucha el layout.
 */
export const Route = createFileRoute("/_org/agent/actividad")({
  pendingComponent: AgentActivityPageSkeleton,
  component: AgentActivityPage,
})

const STATUS_WORDS: Record<string, string> = {
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

const when = (iso: string) =>
  new Date(iso).toLocaleString(activeOrgLocale(), {
    timeZone: activeOrgTimeZone(),
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })

function AgentActivityPage() {
  const canSupervise = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canRead = canSupervise || canDecide
  const query = useQuery({
    queryKey: ["agent-activity"],
    queryFn: () => apiFetch<{ data: AgentActivityItem[] }>("/api/agent/activity?limit=50"),
    enabled: canRead,
  })
  const items = query.data?.data
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Agente" subtitle="Lo que envió, propuso y le pasó a tu equipo." />
      <AgentTabs />
      {!canRead ? (
        <EmptyState title="Sin acceso" description="No tienes acceso a la actividad del agente. Pídelo a quien administra la clínica." />
      ) : query.isPending ? (
        <SkeletonRegion message="Cargando…">
          <AgentActivitySkeleton />
        </SkeletonRegion>
      ) : query.isError || !items ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Sin actividad" description="Aquí verás lo que el agente envió, propuso o derivó." />
      ) : (
        <ul className="elevated flex flex-col divide-y rounded-xl border bg-card px-4 sm:px-6">
          {items.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="flex flex-col gap-1 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{when(item.at)}</span>
                {item.status ? <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>{STATUS_WORDS[item.status] ?? item.status}</Badge> : null}
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
                  className="inline-flex min-h-11 items-center self-start text-xs font-semibold text-primary hover:underline sm:min-h-0"
                >
                  Ver la conversación
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}
