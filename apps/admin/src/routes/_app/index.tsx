import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { z } from "zod"
import { api } from "../../lib/api"

export const Route = createFileRoute("/_app/")({ component: AdminHome })
const overviewSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      description: z.string(),
      path: z.enum(["/support", "/billing", "/commissions", "/organizations", "/users"]),
    }),
  ),
})

function AdminHome() {
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: async () => overviewSchema.parse(await api<unknown>("/api/admin/overview")),
  })
  const pending = overview.data?.items.filter((item) => item.count > 0) ?? []
  return (
    <PageShell className="space-y-6">
      <PageHeader title="Hoy" subtitle="Lo que necesita atención del equipo de odentIA" />
      {overview.isPending ? (
        <LoadingState message="Consultando pendientes…" />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : pending.length === 0 ? (
        <EmptyState
          title="No hay pendientes en estas colas"
          description="Puedes consultar organizaciones y casos de soporte desde el menú."
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {pending.map((item) => (
            <li key={item.key}>
              <Link
                to={item.path}
                className="flex items-center gap-4 p-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.label}</span>
                  <span className="block text-sm text-muted-foreground">{item.description}</span>
                </span>
                <span className="text-lg font-semibold tabular-nums">{item.count}</span>
                <ArrowRight className="size-4 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}
