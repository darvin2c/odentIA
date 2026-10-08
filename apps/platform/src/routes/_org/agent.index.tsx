import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { DataTable, EmptyState, KpiCard, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { AgentTabs } from "../../components/agent-tabs"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type ConversationListItem, usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/agent/")({
  validateSearch: (search: Record<string, unknown>): { conversation?: string } => ({
    conversation: typeof search.conversation === "string" ? search.conversation : undefined,
  }),
  component: AgentSupervisionPage,
})

interface RunStats {
  total: number
  byStatus: Record<string, number>
  avgLatencyMs: number | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
  totalCostMicros: number | null
  topTools: Array<{ tool: string; uses: number }>
}

interface RunItem {
  id: string
  conversationId: string | null
  model: string
  status: string
  startedAt: string
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  costMicros: number | null
  toolsUsed: string[]
  error: string | null
}

interface Simulation {
  reply: string
  toolsUsed: string[]
  handedOff: boolean
  inputTokens: number | null
  outputTokens: number | null
  model: string
  latencyMs: number
}

const STATUS_LABEL: Record<string, string> = {
  ok: "Ejecución correcta",
  handoff: "Pidió atención del equipo",
  error: "Con error",
  omitida: "Sin ejecutar",
}

function AgentSupervisionPage() {
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const conversationId = search.conversation ?? ""
  const [conversationSearch, setConversationSearch] = useState("")
  const [draft, setDraft] = useState("")
  const queryClient = useQueryClient()
  const conversationsQuery = useInfiniteQuery({
    queryKey: ["simulation-conversations", conversationSearch],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "30" })
      if (conversationSearch.trim()) params.set("q", conversationSearch.trim())
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: ConversationListItem[]; nextCursor: string | null }>(`/api/conversations?${params}`)
    },
    getNextPageParam: page => page.nextCursor,
    enabled: canWrite,
  })
  const conversations = conversationsQuery.data?.pages.flatMap(page => page.data) ?? []
  useOrgEvents(["conversation.updated", "message.created", "stream.reconnected"], () => {
    for (const key of ["agent-runs", "agent-run-stats", "simulation-conversations"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  })

  const statsQuery = useQuery({
    queryKey: ["agent-run-stats"],
    queryFn: () => apiFetch<{ data: RunStats }>("/api/agent/runs/stats"),
    enabled: canRead,
  })
  const runsQuery = useQuery({
    queryKey: ["agent-runs"],
    queryFn: () => apiFetch<{ data: RunItem[] }>("/api/agent/runs?limit=50"),
    enabled: canRead,
  })
  const simulateMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ data: Simulation }>("/api/agent/simulate", {
        method: "POST",
        body: JSON.stringify({ conversationId, text: draft }),
      }),
  })

  const runColumns = useMemo<ColumnDef<RunItem>[]>(
    () => [
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.status === "error" ? "destructive" : "secondary"}>
            {STATUS_LABEL[row.original.status] ?? row.original.status}
          </Badge>
        ),
      },
      { accessorKey: "model", header: "Modelo" },
      {
        id: "conversation",
        header: "Caso",
        cell: ({ row }) => row.original.conversationId
          ? <Link to="/inbox" search={{ conversation: row.original.conversationId }} className="text-primary underline">Abrir conversación</Link>
          : "Sin conversación",
      },
      {
        accessorKey: "latencyMs",
        header: "Latencia",
        cell: ({ row }) =>
          row.original.latencyMs != null ? `${(row.original.latencyMs / 1000).toFixed(1)} s` : "—",
      },
      {
        id: "tokens",
        header: "Tokens",
        cell: ({ row }) =>
          row.original.inputTokens != null ? `${row.original.inputTokens}/${row.original.outputTokens ?? 0}` : "—",
      },
      {
        id: "herramientas",
        header: "Herramientas",
        cell: ({ row }) => (row.original.toolsUsed.length > 0 ? row.original.toolsUsed.join(", ") : "—"),
      },
      {
        accessorKey: "error",
        header: "Error",
        cell: ({ row }) =>
          row.original.error ? <span className="text-destructive">{row.original.error}</span> : "—",
      },
    ],
    [],
  )
  const runs = runsQuery.data?.data ?? []
  const runsTable = useReactTable({ data: runs, columns: runColumns, getCoreRowModel: getCoreRowModel() })

  if (!canRead) {
    return (
      <PageShell>
        <EmptyState title="Sin acceso" description="No tienes acceso a la supervisión del agente." />
      </PageShell>
    )
  }

  const stats = statsQuery.data?.data ?? null
  const simulation = simulateMutation.data?.data ?? null
  const simError =
    simulateMutation.error instanceof ApiError
      ? (simulateMutation.error.shape.message ?? "No pudimos simular")
      : simulateMutation.error
        ? "No pudimos simular"
        : null

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Agente" subtitle="Ejecuciones registradas y simulación sin cambios; una ejecución correcta no equivale a un caso resuelto." />
      <AgentTabs />
      {statsQuery.isPending ? <LoadingState /> : statsQuery.isError ? <div role="alert"><p>No pudimos cargar la actividad del agente.</p><Button variant="outline" onClick={() => void statsQuery.refetch()}>Volver a intentar</Button></div> : null}
      <div className="grid min-w-0 gap-3 sm:grid-cols-4">
        <KpiCard title="Ejecuciones" value={stats?.total ?? "—"} />
        <KpiCard
          title="Latencia media"
          value={stats?.avgLatencyMs == null ? "—" : `${(stats.avgLatencyMs / 1000).toFixed(1)} s`}
        />
        <KpiCard
          title="Tokens (entrada/salida)"
          value={stats?.totalInputTokens == null ? "—" : `${stats.totalInputTokens}/${stats.totalOutputTokens ?? 0}`}
          description={
            stats?.totalCostMicros != null ? `Costo acumulado $${(stats.totalCostMicros / 1_000_000).toFixed(2)}` : undefined
          }
        />
        <div className="elevated rounded-xl border bg-card p-6">
          <div className="text-sm font-medium text-muted-foreground">Por estado</div>
          <div className="mt-3 flex flex-wrap gap-1">
            {stats
              ? Object.entries(stats.byStatus).map(([status, total]) => (
                  <Badge key={status} variant="secondary">
                    {STATUS_LABEL[status] ?? status}: {total}
                  </Badge>
                ))
              : "—"}
          </div>
        </div>
      </div>
      {stats && stats.topTools.length > 0 ? (
        <div className="elevated rounded-xl border bg-card p-6">
          <div className="text-sm font-medium text-muted-foreground">Herramientas más usadas</div>
          <div className="mt-3 flex flex-wrap gap-1">
            {stats.topTools.map((t) => (
              <Badge key={t.tool} variant="secondary">
                {t.tool}: {t.uses}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div className="elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Últimas 50 ejecuciones</h2>
        {runsQuery.isPending ? <LoadingState /> : runsQuery.isError ? <div role="alert"><p>No pudimos cargar las ejecuciones.</p><Button variant="outline" onClick={() => void runsQuery.refetch()}>Volver a intentar</Button></div> : runs.length === 0 ? (
          <EmptyState title="Sin ejecuciones" description="Aún no hay actividad registrada." />
        ) : (
          <DataTable table={runsTable} />
        )}
      </div>
      {canWrite ? (
        <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
          <div className="font-heading text-base font-medium">Simular instrucciones</div>
          <p className="text-sm text-muted-foreground">
            Simula un solo turno con el mismo modelo efectivo que la atención de esta organización, sin enviar mensajes
            ni cambiar citas, oportunidades, tareas o derivaciones. No reproduce activaciones ni derivaciones previas ni la
            memoria de la atención real: el resultado es orientativo, no una equivalencia total. El resultado muestra el modelo usado.
          </p>
          <Field>
            <FieldLabel htmlFor="sim-busqueda">Buscar conversación por persona</FieldLabel>
            <Input id="sim-busqueda" type="search" value={conversationSearch} onChange={event => setConversationSearch(event.target.value)} placeholder="Nombre del interlocutor…" />
          </Field>
          <Field>
            <FieldLabel htmlFor="sim-conversacion">Conversación y canal</FieldLabel>
            <select id="sim-conversacion" className="min-w-0 rounded-md border bg-background p-2 text-sm" value={conversationId} onChange={event => {
              simulateMutation.reset()
              void navigate({ search: { conversation: event.target.value || undefined }, replace: true })
            }}>
              <option value="">Elige una conversación…</option>
              {conversationId && !conversations.some(item => item.id === conversationId) && <option value={conversationId}>Caso seleccionado desde la bandeja</option>}
              {conversations.map(item => <option key={item.id} value={item.id}>{item.contact.displayName} · {channelLabel(item.connection.channel)} · {item.connection.displayName}</option>)}
            </select>
            {conversationsQuery.isPending ? <p className="text-sm text-muted-foreground">Cargando conversaciones…</p> : conversationsQuery.isError ? <p role="alert" className="text-sm">No pudimos cargar las conversaciones. <button type="button" className="underline" onClick={() => void conversationsQuery.refetch()}>Volver a intentar</button></p> : conversations.length === 0 ? <p className="text-sm text-muted-foreground">No hay conversaciones para esta búsqueda.</p> : null}
            {conversationsQuery.hasNextPage && <Button type="button" variant="outline" disabled={conversationsQuery.isFetchingNextPage} onClick={() => void conversationsQuery.fetchNextPage()}>Cargar más conversaciones</Button>}
            {conversationId && <Link to="/inbox" search={{ conversation: conversationId }} className="text-sm text-primary underline">Abrir el caso real</Link>}
          </Field>
          <Field>
            <FieldLabel htmlFor="sim-mensaje">Mensaje hipotético del interlocutor</FieldLabel>
            <Textarea
              id="sim-mensaje"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Hola, ¿tienen cita mañana?"
            />
          </Field>
          {simError ? <p role="alert" className="text-sm text-destructive">{simError}</p> : null}
          <div>
            <SubmitButton
              type="button"
              onClick={() => simulateMutation.mutate()}
              pending={simulateMutation.isPending}
              disabled={!conversationId || !draft.trim()}
            >
              Simular
            </SubmitButton>
          </div>
          {simulation ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm">
              <p className="whitespace-pre-wrap">{simulation.reply}</p>
              {simulation.model === "fake" && <p className="text-sm text-muted-foreground">Demostración determinista: no acredita inteligencia ni calidad de un proveedor real.</p>}
              <p className="text-xs text-muted-foreground">
                Modelo {simulation.model} · {(simulation.latencyMs / 1000).toFixed(1)} s
                {simulation.inputTokens != null
                  ? ` · ${simulation.inputTokens}/${simulation.outputTokens ?? 0} tokens`
                  : " · el proveedor no reportó tokens"}
                {simulation.toolsUsed.length > 0 ? ` · herramientas: ${simulation.toolsUsed.join(", ")}` : ""}
                {simulation.handedOff ? " · derivaría a humano" : ""}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </PageShell>
  )
}
