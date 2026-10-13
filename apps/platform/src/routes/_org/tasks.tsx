import { Badge, Button } from "@odentia/ui"
import {
  common,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  PageShell,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { TaskDrawer } from "../../components/crm/task-drawer"
import { formatDueAt, isOverdue } from "../../components/crm/crm-helpers"
import { apiFetch } from "../../lib/api"
import { TASK_AREA_LABEL, type TaskItem, useMyUserId, usePermission } from "../../lib/crm"
import { PortalRequestsSection } from "../../components/portal/portal-requests-panel"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/tasks")({
  validateSearch: (search: Record<string, unknown>): { task?: string } => ({
    task: typeof search.task === "string" ? search.task : undefined,
  }),
  component: TasksPage,
})

const orgRouteApi = getRouteApi("/_org")

const STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  done: "Hecha",
  cancelled: "Cancelada",
}

function TasksPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const myUserId = useMyUserId()
  const canReadCrm = usePermission("crm.read")
  const canReadConversations = usePermission("conversations.read")
  const canWrite = usePermission("tasks.write")
  const listSearch = useListSearch()
  // El backend filtra por `status`; en la URL el filtro vive como `estado`.
  const estado = listSearch.get("estado") ?? "open"
  // Vista de trabajo: todas, mis seguimientos o vencidas (filtros servidor).
  const vista = listSearch.get("vista") ?? "todas"
  // SearchInput (FilterBar) escribe la búsqueda en `q` con debounce propio.
  const q = listSearch.get("q") ?? ""
  const sort = listSearch.get("sort")
  // El detalle se consulta por id, incluso si la tarea está fuera de los filtros.
  const focusId = listSearch.get("task") ?? ""
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  const [focusHandled, setFocusHandled] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // La API devuelve la lista completa sin cursor ({data: TaskItem[]}): un
  // solo fetch con filtros SQL y orden/búsqueda en cliente sobre TODO el
  // resultado (la API no ordena ni pagina tareas).
  const tasksQuery = useQuery({
    queryKey: ["tasks", estado, vista, myUserId],
    queryFn: () => {
      const params = new URLSearchParams()
      if (estado) params.set("status", estado)
      if (vista === "mias" && myUserId) params.set("assignee", myUserId)
      if (vista === "vencidas") params.set("overdue", "true")
      return apiFetch<{ data: TaskItem[] }>(`/api/tasks?${params}`)
    },
  })
  const allTasks = useMemo(() => tasksQuery.data?.data ?? [], [tasksQuery.data])

  useEffect(() => {
    if (!focusId) { setFocusHandled(null); return }
    if (focusHandled === focusId) return
    setFocusHandled(focusId)
    setDrawerOpen(false)
    setEditTaskId(focusId)
  }, [focusId, focusHandled])

  useOrgEvents(
    [
      "message.created",
      "conversation.updated",
      "task.updated",
      "opportunity.updated",
      "contact.updated",
      "stream.reconnected",
    ],
    () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] })
    },
  )

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tasks"] })

  const toggleMutation = useMutation({
    mutationFn: (task: TaskItem) =>
      apiFetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: task.status === "done" ? "open" : "done" }),
      }),
    onSuccess: () => {
      setActionError(null)
      void invalidate()
    },
    onError: (err: Error) => setActionError(err.message),
  })

  const columns = useMemo<ColumnDef<TaskItem>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Título",
        // Lo que deja el Administrador dice por qué se creó, bajo el título.
        cell: ({ row }) =>
          row.original.reason ? (
            <span className="flex flex-col">
              <span>{row.original.title}</span>
              <span className="text-sm text-muted-foreground">{row.original.reason}</span>
            </span>
          ) : (
            row.original.title
          ),
      },
      {
        id: "contexto",
        header: "Contexto",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const task = row.original
          if ((!canReadCrm || (!task.contactId && !task.opportunityId)) && (!canReadConversations || !task.conversationId)) return "—"
          return (
            <span className="flex flex-wrap items-center gap-1.5">
              {canReadCrm && task.contactId ? (
                <Link
                  to="/contacts/$contactId"
                  params={{ contactId: task.contactId }}
                  className="hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {task.contactName ?? "Contacto"}
                </Link>
              ) : null}
              {canReadCrm && task.opportunityId ? (
                <Link
                  to="/opportunities/$opportunityId"
                  params={{ opportunityId: task.opportunityId }}
                  className="hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="outline">{task.opportunityTitle ?? "Oportunidad"}</Badge>
                </Link>
              ) : null}
              {canReadConversations && task.conversationId ? (
                <Link
                  to="/inbox"
                  search={{ conversation: task.conversationId }}
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Abrir hilo
                </Link>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "assignee",
        header: "Asignado",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const member = org.members.find((m) => m.userId === row.original.assigneeUserId)
          if (member) return member.user.name
          // Sin responsable, dice a qué parte del equipo va.
          return row.original.area ? TASK_AREA_LABEL[row.original.area] : <span className="text-muted-foreground">—</span>
        },
      },
      {
        accessorKey: "dueAt",
        header: "Vence",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          if (!row.original.dueAt) return "—"
          const overdue = isOverdue(row.original.dueAt) && row.original.status === "open"
          return (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              {overdue ? "Vencida · " : ""}
              {formatDueAt(row.original.dueAt)}
            </span>
          )
        },
      },
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.status === "done" ? "success" : "secondary"}>
            {STATUS_LABEL[row.original.status] ?? row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: "createdBy",
        header: "Origen",
        cell: ({ row }) => {
          if (row.original.kind === "opportunity_follow_up") {
            return <Badge variant="secondary">Seguimiento</Badge>
          }
          if (row.original.createdBy === "admin") return <Badge variant="soft">Administrador</Badge>
          return row.original.createdBy === "agent" ? (
            <Badge variant="secondary">Agente</Badge>
          ) : (
            "Operador"
          )
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const task = row.original
          return (
            <RowActions
              label={`Acciones de ${task.title}`}
              items={[
                {
                  key: "ver",
                  label: "Ver / editar",
                  onSelect: () => listSearch.setParam("task", task.id),
                },
                ...(canWrite && (task.kind !== "opportunity_follow_up" || task.status === "open") ? [{
                  key: "toggle",
                  label: task.status === "done" ? "Reabrir" : "Completar",
                  disabled: toggleMutation.isPending,
                  onSelect: () => toggleMutation.mutate(task),
                }] : []),
              ]}
            />
          )
        },
      },
    ],
    [org.members, toggleMutation, canReadCrm, canReadConversations, canWrite, listSearch],
  )

  // Búsqueda y orden en cliente sobre el resultado completo del servidor (la
  // API de tareas no filtra por texto ni ordena): nunca se ordena por página
  // porque no hay páginas.
  const visibleTasks = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = allTasks.filter((task) =>
      needle
        ? task.title.toLowerCase().includes(needle) ||
          (task.contactName ?? "").toLowerCase().includes(needle) ||
          (task.opportunityTitle ?? "").toLowerCase().includes(needle)
        : true,
    )
    if (!sort) return rows
    const descending = sort.startsWith("-")
    const field = descending ? sort.slice(1) : sort
    const sorted = [...rows]
    if (field === "vence") {
      sorted.sort((a, b) => {
        const av = a.dueAt ? Date.parse(a.dueAt) : null
        const bv = b.dueAt ? Date.parse(b.dueAt) : null
        if (av === null && bv === null) return 0
        if (av === null) return descending ? -1 : 1
        if (bv === null) return descending ? 1 : -1
        return descending ? bv - av : av - bv
      })
    } else if (field === "titulo") {
      sorted.sort((a, b) =>
        descending ? b.title.localeCompare(a.title, "es") : a.title.localeCompare(b.title, "es"),
      )
    } else if (field === "estado") {
      sorted.sort((a, b) =>
        descending
          ? b.status.localeCompare(a.status, "es")
          : a.status.localeCompare(b.status, "es"),
      )
    }
    return sorted
  }, [allTasks, q, sort])
  const hasActiveCriteria = q.trim() !== "" || estado !== "open" || vista !== "todas" || Boolean(sort)

  const table = useReactTable({
    data: visibleTasks,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Tareas"
        subtitle="Seguimientos creados por operadores y el agente"
        actions={canWrite ? (
          <Button type="button" className="min-h-11" onClick={() => { setEditTaskId(null); setDrawerOpen(true) }}>
            <Plus aria-hidden />
            Nueva tarea
          </Button>
        ) : undefined}
      />
      <PortalRequestsSection />
      {actionError ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          No se pudo actualizar la tarea: {actionError}
        </p>
      ) : null}
      <FilterBar
        filters={[
          {
            key: "estado",
            label: "Estado",
            type: "select",
            options: [
              { value: "open", label: "Abiertas" },
              { value: "done", label: "Hechas" },
              { value: "cancelled", label: "Canceladas" },
            ],
          },
          {
            key: "vista",
            label: "Vista",
            type: "select",
            options: [
              { value: "todas", label: "Todas" },
              { value: "mias", label: "Mis seguimientos" },
              { value: "vencidas", label: "Vencidos" },
            ],
          },
        ]}
        sortOptions={[
          { value: "vence", label: "Vence" },
          { value: "titulo", label: "Título" },
          { value: "estado", label: "Estado" },
        ]}
        searchPlaceholder="Buscar tarea"
      />
      {tasksQuery.isLoading && visibleTasks.length === 0 ? (
        <DataTableSkeleton />
      ) : tasksQuery.isError && visibleTasks.length === 0 ? (
        <ErrorState
          error={tasksQuery.error instanceof Error ? tasksQuery.error : String(tasksQuery.error)}
          onRetry={() => void tasksQuery.refetch()}
        />
      ) : visibleTasks.length === 0 ? (
        <EmptyState
          title={hasActiveCriteria ? common.filters.noResults : "Sin tareas"}
          description={
            hasActiveCriteria
              ? "No hay tareas que coincidan con los filtros aplicados."
              : "Crea la primera con el botón Nueva tarea."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {/* La búsqueda `q` filtra en cliente sobre lo ya cargado: no hay
              fetch de búsqueda que representar, solo el refetch de la lista. */}
          <DataTable table={table} isFetching={tasksQuery.isFetching} />
          {tasksQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conservan las tareas cargadas.{" "}
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => void tasksQuery.refetch()}
              >
                Reintentar solo la lista
              </Button>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground" role="status">
            Mostrando {visibleTasks.length} tarea{visibleTasks.length === 1 ? "" : "s"}
          </p>
        </div>
      )}
      <TaskDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={invalidate}
      />
      <TaskDrawer
        open={editTaskId !== null}
        taskId={editTaskId ?? undefined}
        onClose={() => { setEditTaskId(null); listSearch.setParam("task", undefined) }}
        onSaved={invalidate}
      />
    </PageShell>
  )
}
