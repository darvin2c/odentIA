import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { DataTable, EmptyState, KpiCard, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { ANSWER_CHECK_LABEL, type AnswerBasisItem, type AnswerCheck } from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type ConversationListItem, usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/agent/registro")({
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
  totalCachedInputTokens: number | null
  totalLlmCalls: number | null
  runsWithLlmCalls: number
  conversationsWithLlmCalls: number
  topTools: Array<{ tool: string; uses: number }>
  byRoute: Array<{ path: string; runs: number; avgLlmCalls: number | null; avgInputTokens: number | null }>
}

/** Camino que eligió el modelo de decisión antes del turno, dicho para quien mide. */
const ROUTE_LABEL: Record<string, string> = {
  derivar: "Pasó a una persona sin redactar",
  informacion: "Información",
  saludo: "Saludo o cierre",
  cita: "Pedir una cita",
  cambio_cita: "Cambiar o cancelar una cita",
  clinico: "Consulta clínica",
  abierto: "Abierto (dudó o no aplica)",
  sin_camino: "Sin elección de camino",
}

const MODE_LABEL: Record<string, string> = {
  shadow: "En sombra",
  retrieval: "Eligió conocimiento",
  route: "Eligió el camino",
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
  cachedInputTokens: number | null
  llmCalls: number | null
  toolsUsed: string[]
  error: string | null
}

interface DecisionItem {
  id: string
  conversationId: string | null
  point: string
  mode: string
  provider: string
  model: string | null
  answers: Array<{ id: string; kind: string; probability?: number; choice?: string; score?: number; confidence?: number | null }>
  outcome: Record<string, unknown> | null
  latencyMs: number | null
  error: string | null
  createdAt: string
}

const PROVIDER_LABEL: Record<string, string> = {
  baseline: "Línea base",
  jev: "Jev",
  fake: "Demostración",
}

/** Resumen legible de una decisión: el camino elegido, si lo hubo, y respuesta y confianza por pregunta. */
function describeAnswers(item: DecisionItem): string {
  if (item.error) return `Sin respuesta: ${item.error}`
  const pct = (value: number) => `${Math.round(value * 100)} %`
  const path = item.mode === "route" && typeof item.outcome?.path === "string" ? item.outcome.path : null
  const lead = path ? `Camino: ${(ROUTE_LABEL[path] ?? path).toLowerCase()} · ` : ""
  return lead + item.answers
    .map((a) => {
      if (a.kind === "yesno" && typeof a.probability === "number") return `${a.id}: ${a.probability >= 0.5 ? "sí" : "no"} (${pct(a.probability)})`
      if (a.kind === "choice") return `${a.id}: ${a.choice}${typeof a.confidence === "number" ? ` (${pct(a.confidence)})` : ""}`
      if (a.kind === "score" && typeof a.score === "number") return `${a.id}: nivel ${Math.round(a.score)}${typeof a.confidence === "number" ? ` (${pct(a.confidence)})` : ""}`
      return `${a.id}: sin respuesta`
    })
    .join(" · ")
}

interface Simulation {
  reply: string
  replied: boolean
  toolsUsed: string[]
  handedOff: boolean
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
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
  sin_respuesta: "Terminó sin responder",
}

/** Estados que alguien del equipo debe revisar. */
const NEEDS_REVIEW = new Set(["error", "sin_respuesta"])

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
  useOrgEvents(["agent.run.recorded", "agent.decision.recorded", "conversation.updated", "message.created", "stream.reconnected"], () => {
    for (const key of ["agent-runs", "agent-run-stats", "agent-decisions", "simulation-conversations"]) {
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
  const decisionsQuery = useQuery({
    queryKey: ["agent-decisions"],
    queryFn: () => apiFetch<{ data: DecisionItem[] }>("/api/agent/decisions?limit=50"),
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
          <Badge variant={NEEDS_REVIEW.has(row.original.status) ? "destructive" : "secondary"}>
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
          row.original.inputTokens != null
            ? `${row.original.inputTokens}/${row.original.outputTokens ?? 0}${row.original.cachedInputTokens != null ? ` · ${row.original.cachedInputTokens} en caché` : ""}`
            : "—",
      },
      {
        accessorKey: "llmCalls",
        header: "Llamadas al modelo",
        cell: ({ row }) => row.original.llmCalls ?? "—",
      },
      {
        id: "herramientas",
        header: "Herramientas",
        cell: ({ row }) => (row.original.toolsUsed.length > 0 ? row.original.toolsUsed.join(", ") : "—"),
      },
      {
        accessorKey: "error",
        header: "Error",
        // Una corrida omitida no es un fallo: su motivo se explica, no se alarma.
        cell: ({ row }) =>
          !row.original.error ? (
            "—"
          ) : row.original.status === "omitida" ? (
            <span className="text-muted-foreground">
              {row.original.error === "burst-covered"
                ? "Atendido en la corrida de otro mensaje del hilo"
                : row.original.error}
            </span>
          ) : (
            <span className="text-destructive">{row.original.error}</span>
          ),
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
      <PageHeader title="Registro técnico" subtitle="Ejecuciones registradas y simulación sin cambios; una ejecución correcta no equivale a un caso resuelto." />
      <Link to="/agent" className="-mt-3 inline-flex min-h-11 w-fit items-center text-sm font-semibold text-primary hover:underline sm:min-h-0">
        Volver al resumen del agente
      </Link>
      {statsQuery.isPending ? <LoadingState /> : statsQuery.isError ? <div role="alert"><p>No pudimos cargar la actividad del agente.</p><Button variant="outline" onClick={() => void statsQuery.refetch()}>Volver a intentar</Button></div> : null}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          title="Ejecuciones"
          value={stats?.total ?? "—"}
          description={
            stats?.totalLlmCalls != null
              ? `${stats.totalLlmCalls} ${stats.totalLlmCalls === 1 ? "llamada" : "llamadas"} al modelo en ${stats.runsWithLlmCalls} ${stats.runsWithLlmCalls === 1 ? "ejecución medida" : "ejecuciones medidas"}`
              : undefined
          }
        />
        <KpiCard
          title="Por conversación"
          value={
            stats && stats.conversationsWithLlmCalls > 0 && stats.totalLlmCalls != null
              ? `${(stats.totalLlmCalls / stats.conversationsWithLlmCalls).toFixed(1)} llamadas`
              : "—"
          }
          description={
            stats && stats.conversationsWithLlmCalls > 0
              ? `${
                  stats.totalInputTokens != null
                    ? `${Math.round((stats.totalInputTokens + (stats.totalOutputTokens ?? 0)) / stats.conversationsWithLlmCalls)} tokens de media · `
                    : ""
                }${stats.conversationsWithLlmCalls} ${stats.conversationsWithLlmCalls === 1 ? "conversación medida" : "conversaciones medidas"}`
              : "Aún no hay conversaciones con llamadas al modelo."
          }
        />
        <KpiCard
          title="Latencia media"
          value={stats?.avgLatencyMs == null ? "—" : `${(stats.avgLatencyMs / 1000).toFixed(1)} s`}
        />
        <KpiCard
          title="Tokens (entrada/salida)"
          value={stats?.totalInputTokens == null ? "—" : `${stats.totalInputTokens}/${stats.totalOutputTokens ?? 0}`}
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
      {stats && stats.byRoute.some((row) => row.path !== "sin_camino") ? (
        <section aria-label="Llamadas por camino" className="elevated rounded-xl border bg-card p-6">
          <h2 className="font-heading text-base font-medium">Llamadas por camino</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cuántas veces llama al modelo que escribe una ejecución, según el camino que eligió antes el modelo de decisión.
            Compara con «Sin elección de camino» para ver si baja el gasto; pocas ejecuciones no prueban nada.
          </p>
          <ul className="mt-3 flex flex-col divide-y text-sm">
            {stats.byRoute.map((row) => (
              <li key={row.path} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 flex-1 basis-48 font-medium">{ROUTE_LABEL[row.path] ?? row.path}</span>
                <span className="text-muted-foreground">
                  {row.runs} {row.runs === 1 ? "ejecución" : "ejecuciones"}
                </span>
                <span className="tabular-nums">
                  {row.avgLlmCalls != null ? `${row.avgLlmCalls.toFixed(1)} llamadas por ejecución` : "sin llamadas medidas"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Decisiones del modelo de decisión" className="elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Decisiones del modelo de decisión</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Lo que decidió sobre cada mensaje entrante y con qué confianza. Elegir el camino o el conocimiento sí cambia la
          respuesta; «en sombra» solo se registra. Ninguna acredita acierto por sí sola.
        </p>
        {decisionsQuery.isPending ? <LoadingState /> : decisionsQuery.isError ? <div role="alert"><p>No pudimos cargar las decisiones.</p><Button variant="outline" onClick={() => void decisionsQuery.refetch()}>Volver a intentar</Button></div> : decisionsQuery.data.data.length === 0 ? (
          <EmptyState title="Sin decisiones registradas" description="Elige un modelo de decisión en Configuración › Integraciones › Modelo del agente; cada mensaje entrante dejará aquí lo que decidió." />
        ) : (
          <ul className="mt-3 flex flex-col divide-y">
            {decisionsQuery.data.data.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{PROVIDER_LABEL[item.provider] ?? item.provider}</Badge>
                  <Badge variant={item.mode === "shadow" ? "secondary" : "default"}>{MODE_LABEL[item.mode] ?? item.mode}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {item.point}{item.model ? ` · ${item.model}` : ""}{item.latencyMs != null ? ` · ${item.latencyMs} ms` : ""}
                  </span>
                  {item.conversationId ? (
                    <Link to="/inbox" search={{ conversation: item.conversationId }} className="text-xs text-primary underline">
                      Abrir conversación
                    </Link>
                  ) : null}
                </div>
                <p className={item.error ? "text-destructive" : undefined}>{describeAnswers(item)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canWrite ? (
        <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
          <div className="font-heading text-base font-medium">Simular instrucciones</div>
          <p className="text-sm text-muted-foreground">
            Simula la respuesta a un solo mensaje con el mismo modelo efectivo que la atención de esta organización, sin enviar mensajes
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
            {conversationsQuery.isPending ? <LoadingState message="Cargando conversaciones…" /> : conversationsQuery.isError ? <p role="alert" className="text-sm">No pudimos cargar las conversaciones. <button type="button" className="underline" onClick={() => void conversationsQuery.refetch()}>Volver a intentar</button></p> : conversations.length === 0 ? <p className="text-sm text-muted-foreground">No hay conversaciones para esta búsqueda.</p> : null}
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
              {!simulation.replied && !simulation.handedOff && (
                <p role="status" className="text-sm font-medium text-destructive">
                  El modelo no usó la herramienta de envío: en una conversación real este texto no llegaría al interlocutor y la ejecución quedaría como «Terminó sin responder».
                </p>
              )}
              {simulation.checks.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {simulation.checks.map((check) => (
                    <li key={`${check.kind}-${check.value}`} className={check.ok ? "" : "font-medium text-destructive"}>
                      {ANSWER_CHECK_LABEL[check.kind]} «{check.value}»:{" "}
                      {check.ok ? `está en ${check.source ?? "lo consultado"}` : "no está en lo consultado; esta respuesta no saldría"}
                    </li>
                  ))}
                </ul>
              ) : null}
              {simulation.basis.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Consultó: {simulation.basis.map((item) => item.label).join(" · ")}
                </p>
              ) : null}
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
