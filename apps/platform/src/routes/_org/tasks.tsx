import { Badge, Button, Spinner } from "@odentia/ui"
import {
  common,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ExpandableText,
  ErrorState,
  FilterBar,
  PageHeader,
  PageShell,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Check, Plus } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { HandoffUrgency } from "../../components/agent/handoff-badges"
import { dueWords, formatDueAt, isOverdue } from "../../components/crm/crm-helpers"
import { useCompleteTask } from "../../components/crm/resolve-preview"
import { TaskDrawer } from "../../components/crm/task-drawer"
import { PersonLink } from "../../components/person-link"
import { agentCaseRow } from "../../lib/agent"
import { ADMIN_NAME, useReceptionName, withReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { TASK_AREA_LABEL, type TaskItem, useMemberName, usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/tasks")({
  /** La vista y el alcance los lee `useListSearch`; aquí solo se tipan para los enlaces (Inicio abre la tarea). */
  validateSearch: (search: Record<string, unknown>): { task?: string; vista?: string; alcance?: string } => ({
    ...search,
    task: typeof search.task === "string" ? search.task : undefined,
  }),
  component: TasksPage,
})

/** Las vistas de Tareas: se excluyen entre sí (no hay «vencidas hechas»). */
const VIEWS = [
  { value: undefined, label: "Mías y de mi área", api: "abiertas" },
  { value: "vencidas", label: "Vencidas", api: "vencidas" },
  { value: "hechas", label: "Hechas", api: "hechas" },
] as const

const PAGE = 30

/** Quién dejó la tarea, con palabras. */
function originWords(task: TaskItem, receptionName: string): string {
  if (task.createdBy === "admin") return `La dejó ${ADMIN_NAME}`
  if (task.createdBy === "agent") return `La dejó ${receptionName}`
  if (task.createdBy === "sistema") return "La dejó el sistema"
  return "La dejó el equipo"
}

/** El título guardado de un caso empieza por «Te lo pasó …: » (antes «el agente», ahora el nombre). */
const CASE_PREFIX = /^Te lo pasó [^:]{1,60}: /

/**
 * Tareas: la lista completa de lo que hay que hacer, con páginas, búsqueda y
 * orden en el servidor. Se abre en «Mías y de mi área» (las de quien mira y
 * las sin responsable de su parte del equipo); «Toda la clínica» solo la ven
 * el propietario y el administrador, y el servidor también lo limita. Cada
 * tarea dice de quién es y enlaza a la persona; la que se cerró sola dice por
 * qué. «Te espera», en Inicio, muestra lo de hoy.
 */
function TasksPage() {
  const queryClient = useQueryClient()
  const memberName = useMemberName()
  const receptionName = useReceptionName()
  const canWrite = usePermission("tasks.write")
  const canAll = usePermission("tasks.all")
  const canReadCrm = usePermission("crm.read")
  const listSearch = useListSearch()
  const viewParam = listSearch.get("vista")
  const view = VIEWS.find((item) => item.value === viewParam) ?? VIEWS[0]
  const wholeClinic = canAll && listSearch.get("alcance") === "clinica"
  const q = listSearch.get("q") ?? ""
  const sort = view.api === "hechas" ? undefined : listSearch.get("sort")?.replace(/^-/, "")
  const focusId = listSearch.get("task") ?? ""
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  const [focusHandled, setFocusHandled] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const tasksQuery = useInfiniteQuery({
    queryKey: ["tasks", "page", view.api, wholeClinic, q.trim(), sort ?? "vence"],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams({ view: view.api, limit: String(PAGE) })
      if (wholeClinic) params.set("scope", "clinica")
      if (q.trim()) params.set("q", q.trim())
      if (sort === "recientes") params.set("sort", "recientes")
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: TaskItem[]; nextCursor: string | null; total: number }>(`/api/tasks?${params}`)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const tasks = useMemo(() => tasksQuery.data?.pages.flatMap((page) => page.data) ?? [], [tasksQuery.data])
  const total = tasksQuery.data?.pages[0]?.total ?? 0

  useEffect(() => {
    if (!focusId) {
      setFocusHandled(null)
      return
    }
    if (focusHandled === focusId) return
    setFocusHandled(focusId)
    setDrawerOpen(false)
    setEditTaskId(focusId)
  }, [focusId, focusHandled])

  useOrgEvents(["task.updated", "opportunity.updated", "conversation.updated", "contact.updated", "stream.reconnected"], () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] })
  })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tasks"] })

  // Reabrir es directo; completar pasa por `useCompleteTask`, que antes muestra
  // lo mismo que «Resolver» si la tarea es la de un caso del agente.
  const reopenMutation = useMutation({
    mutationFn: (task: TaskItem) => apiFetch(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }),
    onSuccess: () => {
      setActionError(null)
      void invalidate()
    },
    onError: (err: Error) => setActionError(err.message),
  })
  const completion = useCompleteTask(() => setActionError(null))
  const completeRef = useRef(completion.complete)
  completeRef.current = completion.complete
  const busy = reopenMutation.isPending || completion.pendingId !== null

  const columns = useMemo<ColumnDef<TaskItem>[]>(
    () => [
      {
        id: "tarea",
        header: "Tarea",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const task = row.original
          // La etiqueta ya explica el origen; el título guardado no se modifica.
          const title = task.agentCase ? task.title.replace(CASE_PREFIX, "") : task.title
          return (
            <div className="flex min-w-0 max-w-sm flex-col items-start gap-1 whitespace-normal [overflow-wrap:anywhere]">
              <ExpandableText text={title} label="título de la tarea" className="font-medium" />
              {task.agentCase ? (
                <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  {agentCaseRow(receptionName)} <HandoffUrgency priority={task.agentCase.priority} />
                </span>
              ) : null}
              {task.settledReason ? (
                <ExpandableText text={`${task.status === "cancelled" ? "Descartada" : "Se cerró sola"}: ${task.settledReason}`} label="motivo del cierre" className="text-sm text-muted-foreground" />
              ) : task.reason ? (
                <ExpandableText text={withReceptionName(task.reason, receptionName)} label="contexto de la tarea" className="text-sm text-muted-foreground" />
              ) : null}
            </div>
          )
        },
      },
      {
        id: "de",
        header: "De quién",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const task = row.original
          const name = task.patientName ?? task.contactName
          if (!name && !task.opportunityTitle) return <span className="text-muted-foreground">—</span>
          return (
            <span className="flex min-w-0 max-w-48 flex-col items-start gap-0.5 whitespace-normal [overflow-wrap:anywhere]">
              {name ? (
                <PersonLink patientId={task.patientId} contactId={task.contactId}>
                  {name}
                </PersonLink>
              ) : null}
              {task.opportunityId && task.opportunityTitle && canReadCrm ? (
                <Link
                  to="/pipeline"
                  search={{ oportunidad: task.opportunityId }}
                  className="text-sm text-muted-foreground hover:underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  Oportunidad «{task.opportunityTitle}»
                </Link>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "quien",
        header: "Quién la lleva",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const task = row.original
          if (task.assigneeUserId) return memberName(task.assigneeUserId)
          return task.area ? TASK_AREA_LABEL[task.area] : <span className="text-muted-foreground">Sin responsable</span>
        },
      },
      {
        id: "vence",
        header: "Vence",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const task = row.original
          if (!task.dueAt) return <span className="text-muted-foreground">Sin fecha</span>
          const overdue = isOverdue(task.dueAt) && task.status === "open"
          return (
            <span className={overdue ? "font-medium text-destructive" : undefined} title={formatDueAt(task.dueAt)}>
              {overdue ? "Venció " : ""}
              {dueWords(task.dueAt)}
            </span>
          )
        },
      },
      {
        id: "origen",
        header: "Origen",
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{originWords(row.original, receptionName)}</span>,
      },
      {
        id: "actions",
        header: "",
        meta: { view: { role: "actions" } },
        cell: ({ row }) => {
          const task = row.original
          return (
            <span className="flex items-center justify-end gap-1">
              {task.status === "open" && canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    void completeRef.current(task.id)
                  }}
                >
                  <Check aria-hidden />
                  Hecha
                </Button>
              ) : task.status === "done" ? (
                <Badge variant="success">Hecha</Badge>
              ) : null}
              <RowActions
                label={`Acciones de ${task.title}`}
                items={[
                  { key: "ver", label: "Abrir", onSelect: () => listSearch.setParam("task", task.id) },
                  ...(canWrite && task.status !== "open"
                    ? [{ key: "reabrir", label: "Reabrir", disabled: busy, onSelect: () => reopenMutation.mutate(task) }]
                    : []),
                ]}
              />
            </span>
          )
        },
      },
    ],
    [memberName, receptionName, busy, canWrite, canReadCrm, listSearch, reopenMutation],
  )

  const table = useReactTable({ data: tasks, columns, getCoreRowModel: getCoreRowModel() })
  const filtered = q.trim() !== ""

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Tareas"
        subtitle={wholeClinic ? "Las de toda la clínica" : `Las tuyas y las de tu parte del equipo, las deje una persona, ${receptionName} o ${ADMIN_NAME}`}
        actions={
          canWrite ? (
            <Button type="button" className="min-h-11" onClick={() => { setEditTaskId(null); setDrawerOpen(true) }}>
              <Plus aria-hidden />
              Nueva tarea
            </Button>
          ) : undefined
        }
      />
      {actionError || completion.error ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          No se pudo actualizar la tarea: {actionError ?? completion.error}
        </p>
      ) : null}
      {completion.dialog}
      <div className="flex flex-col gap-2">
        <fieldset className="flex min-w-0 flex-wrap gap-1.5">
          <legend className="sr-only">Qué tareas ver</legend>
          {VIEWS.map((item) => {
            const pressed = view.value === item.value
            return (
              <Button
                key={item.label}
                type="button"
                size="sm"
                variant={pressed ? "default" : "outline"}
                aria-pressed={pressed}
                className="min-h-11 rounded-full sm:min-h-9"
                onClick={() => listSearch.setParams({ vista: item.value, sort: undefined }, { replace: true })}
              >
                {item.label}
              </Button>
            )
          })}
          {canAll ? (
            <Button
              type="button"
              size="sm"
              variant={wholeClinic ? "default" : "outline"}
              aria-pressed={wholeClinic}
              className="min-h-11 rounded-full sm:min-h-9"
              onClick={() => listSearch.setParam("alcance", wholeClinic ? undefined : "clinica", { replace: true })}
            >
              Toda la clínica
            </Button>
          ) : null}
        </fieldset>
        <FilterBar
          filters={[]}
          sortOptions={view.api === "hechas" ? [] : [
            { value: "vence", label: "Vence primero" },
            { value: "recientes", label: "Más recientes" },
          ]}
          searchPlaceholder="Buscar por tarea, persona u oportunidad" searchLabel="Buscar en tareas"
          searchPending={tasksQuery.isFetching && !tasksQuery.isFetchingNextPage && filtered}
        />
      </div>
      {tasksQuery.isLoading && tasks.length === 0 ? (
        <DataTableSkeleton />
      ) : tasksQuery.isError && tasks.length === 0 ? (
        <ErrorState error={tasksQuery.error instanceof Error ? tasksQuery.error : String(tasksQuery.error)} onRetry={() => void tasksQuery.refetch()} />
      ) : tasks.length === 0 ? (
        <EmptyState
          title={filtered ? common.filters.noResults : view.api === "hechas" ? "Nada hecho todavía" : view.api === "vencidas" ? "Nada vencido" : "Sin tareas pendientes"}
          description={
            filtered
              ? "Ninguna tarea coincide con lo que buscas."
              : view.api === "abiertas"
                ? "No tienes tareas abiertas ni las hay sin responsable en tu parte del equipo."
                : "Cuando haya, aparecen aquí."
          }
          {...(canWrite && !filtered && view.api === "abiertas"
            ? { actionLabel: "Nueva tarea", onAction: () => { setEditTaskId(null); setDrawerOpen(true) } }
            : {})}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable className="[&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]" table={table} isFetching={tasksQuery.isFetching && !tasksQuery.isFetchingNextPage} onRowClick={(task: TaskItem) => listSearch.setParam("task", task.id)} />
          {tasksQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conservan las tareas cargadas.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void tasksQuery.refetch()}>
                Reintentar solo la lista
              </Button>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground" role="status">
              Mostrando {tasks.length} de {total} tarea{total === 1 ? "" : "s"}
            </p>
            {tasksQuery.hasNextPage ? (
              <Button type="button" variant="outline" size="sm" disabled={tasksQuery.isFetchingNextPage} onClick={() => void tasksQuery.fetchNextPage()}>
                {tasksQuery.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
                Cargar más
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <TaskDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onSaved={invalidate} />
      <TaskDrawer
        open={editTaskId !== null}
        taskId={editTaskId ?? undefined}
        onClose={() => {
          setEditTaskId(null)
          listSearch.setParam("task", undefined)
        }}
        onSaved={invalidate}
      />
    </PageShell>
  )
}
