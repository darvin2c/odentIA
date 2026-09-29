import { Badge, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { DataTable, EmptyState, KpiCard, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/agent/")({
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
  ok: "Correctas",
  handoff: "Derivadas",
  error: "Con error",
  omitida: "Omitidas",
}

function AgentSupervisionPage() {
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const [conversationId, setConversationId] = useState("")
  const [draft, setDraft] = useState("")

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
      <PageHeader title="Agente" subtitle="Supervisión de corridas reales, métricas y simulación" />
      <div className="grid min-w-0 gap-3 sm:grid-cols-4">
        <KpiCard title="Corridas" value={stats?.total ?? "—"} />
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
        <div className="rounded-md bg-card p-6">
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
        <div className="rounded-md bg-card p-6">
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
      <div className="rounded-md bg-card p-6">
        <div className="font-heading text-base font-medium">Últimas corridas</div>
        {runs.length === 0 ? (
          <EmptyState title="Últimas corridas" description="Aún no hay corridas registradas." />
        ) : (
          <DataTable table={runsTable} />
        )}
      </div>
      {canWrite ? (
        <div className="flex flex-col gap-3 rounded-md bg-card p-6">
          <div className="font-heading text-base font-medium">Simular instrucciones</div>
          <p className="text-sm text-muted-foreground">
            Corre el modelo configurado con las instrucciones vigentes sin enviar mensajes ni crear citas,
            tareas o derivaciones. No se guarda nada.
          </p>
          <Field>
            <FieldLabel htmlFor="sim-conversacion">ID de conversación</FieldLabel>
            <Input
              id="sim-conversacion"
              value={conversationId}
              onChange={(e) => setConversationId(e.target.value)}
              placeholder="UUID de la conversación"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sim-mensaje">Mensaje hipotético del paciente</FieldLabel>
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
