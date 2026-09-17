import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui"
import {
  common,
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  MasterDetail,
  PageHeader,
  PageShell,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import type { TaskItem } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/tasks")({
  component: TasksPage,
})

const orgRouteApi = getRouteApi("/_org")

const taskSchema = z.object({
  title: z.string().min(1, "Ingresa el título"),
  dueAt: z.string(),
  assigneeUserId: z.string(),
})

type TaskFormValues = z.infer<typeof taskSchema>

const emptyValues: TaskFormValues = { title: "", dueAt: "", assigneeUserId: "" }

function TasksPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const listSearch = useListSearch()
  // El backend filtra por `status`; en la URL el filtro vive como `estado`.
  const estado = listSearch.get("estado") ?? "open"
  // SearchInput (FilterBar) escribe la búsqueda en `q` con debounce propio.
  const q = listSearch.get("q") ?? ""
  const sort = listSearch.get("sort")
  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)

  const tasksQuery = useQuery({
    queryKey: ["tasks", estado],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=${estado}`),
  })

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] })
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tasks"] })

  const toggleMutation = useMutation({
    mutationFn: (task: TaskItem) =>
      apiFetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: task.status === "done" ? "open" : "done" }),
      }),
    onSuccess: () => void invalidate(),
  })

  const saveMutation = useMutation({
    mutationFn: async (values: TaskFormValues) => {
      await apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: values.title,
          dueAt: values.dueAt || undefined,
          assigneeUserId: values.assigneeUserId || null,
        }),
      })
    },
    onSuccess: () => {
      closeTaskForm()
      void invalidate()
    },
  })

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: taskSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  })

  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => state.isDirty)

  /** Cierra y deja el formulario prístino: sin el reset, el dirty sobrevive al
   *  cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeTaskForm() {
    setFormOpen(false)
    form.reset()
  }

  const columns = useMemo<ColumnDef<TaskItem>[]>(
    () => [
      { accessorKey: "title", header: "Título" },
      {
        id: "assignee",
        header: "Asignado",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const member = org.members.find((m) => m.userId === row.original.assigneeUserId)
          return member ? member.user.name : <span className="text-muted-foreground">—</span>
        },
      },
      {
        accessorKey: "dueAt",
        header: "Vence",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.dueAt
            ? new Date(row.original.dueAt).toLocaleDateString("es-PE", {
                day: "numeric",
                month: "short",
              })
            : "—",
      },
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.status === "done" ? "success" : "secondary"}>
            {row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: "createdBy",
        header: "Origen",
        cell: ({ row }) =>
          row.original.createdBy === "agent" ? (
            <Badge variant="secondary">Agente</Badge>
          ) : (
            "Operador"
          ),
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
                  key: "toggle",
                  label: task.status === "done" ? "Reabrir" : "Completar",
                  disabled: toggleMutation.isPending,
                  onSelect: () => toggleMutation.mutate(task),
                },
              ]}
            />
          )
        },
      },
    ],
    [org.members, toggleMutation],
  )

  // La búsqueda `q` y el orden `sort` se aplican en cliente sobre lo ya
  // filtrado por estado en el servidor.
  const visibleTasks = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = (tasksQuery.data?.data ?? []).filter((task) =>
      needle ? task.title.toLowerCase().includes(needle) : true,
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
  }, [tasksQuery.data, q, sort])
  const hasActiveCriteria = q.trim() !== "" || estado !== "open" || Boolean(sort)

  const table = useReactTable({
    data: visibleTasks,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const formFields = (
    <div className="flex flex-col gap-4">
      <form.Field name="title">
        {(field) => (
          <Field>
            <FieldLabel>Título</FieldLabel>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Llamar al paciente"
            />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="dueAt">
        {(field) => (
          <Field>
            <FieldLabel>Vence (opcional)</FieldLabel>
            <Input
              type="date"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="assigneeUserId">
        {(field) => (
          <Field>
            <FieldLabel>Asignado (opcional)</FieldLabel>
            <select
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            >
              <option value="">Sin asignar</option>
              {org.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.name}
                </option>
              ))}
            </select>
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeTaskForm,
    title: "Nueva tarea",
    isDirty,
    isSubmitting: saveMutation.isPending,
    submitLabel: "Crear",
    cancelLabel: "Cancelar",
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      void form.handleSubmit()
    },
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Tareas"
          subtitle="Seguimientos creados por operadores y el agente"
          actions={
            <Button type="button" className="min-h-11" onClick={() => setFormOpen(true)}>
              <Plus aria-hidden />
              Nueva tarea
            </Button>
          }
        />
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
          ]}
          sortOptions={[
            { value: "vence", label: "Vence" },
            { value: "titulo", label: "Título" },
            { value: "estado", label: "Estado" },
          ]}
          searchPlaceholder="Buscar tarea"
        />
        {visibleTasks.length === 0 && !tasksQuery.isLoading ? (
          <EmptyState
            title={hasActiveCriteria ? common.filters.noResults : "Sin tareas"}
            description={
              hasActiveCriteria
                ? "No hay tareas que coincidan con los filtros aplicados."
                : "Crea la primera con el botón Nueva tarea."
            }
          />
        ) : (
          <DataTable table={table} />
        )}
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
    </PageShell>
  )
}
