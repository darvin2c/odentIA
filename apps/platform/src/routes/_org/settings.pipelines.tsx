import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  MasterDetail,
  PageHeader,
  PageShell,
  RowActions,
  useDetailMode,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { type Pipeline, type Stage, useCanWrite } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/pipelines")({
  component: PipelinesPage,
})

const stageSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre"),
  kind: z.enum(["open", "won", "lost"]),
})

function PipelinesPage() {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const mode = useDetailMode()
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Stage | null>(null)
  const [deleting, setDeleting] = useState<Stage | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })

  const pipelines = listQuery.data?.data ?? []
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0] ?? null
  const stages = pipeline?.stages ?? []

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["pipelines"] })

  const fail = (e: unknown) => {
    setError(
      e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación",
    )
  }

  const createMutation = useMutation({
    mutationFn: (values: { name: string; kind: string }) =>
      apiFetch(`/api/pipelines/${pipeline?.id}/stages`, {
        method: "POST",
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      closeStageForm()
      void invalidate()
    },
    onError: fail,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiFetch(`/api/pipelines/stages/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setEditing(null)
      void invalidate()
    },
    onError: fail,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/pipelines/stages/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null)
      void invalidate()
    },
    onError: (e) => {
      setDeleting(null)
      fail(e)
    },
  })

  const reorderMutation = useMutation({
    mutationFn: (stageIds: string[]) =>
      apiFetch(`/api/pipelines/${pipeline?.id}/reorder`, {
        method: "POST",
        body: JSON.stringify({ stageIds }),
      }),
    onSuccess: () => void invalidate(),
    onError: fail,
  })

  const form = useForm({
    defaultValues: { name: "", kind: "open" as "open" | "won" | "lost" },
    validators: { onSubmit: stageSchema },
    onSubmit: ({ value }) => createMutation.mutate(value),
  })

  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => state.isDirty)

  /** Cierra y deja el formulario prístino: sin el reset, el dirty sobrevive al
   *  cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeStageForm() {
    setFormOpen(false)
    form.reset()
  }

  function move(index: number, delta: -1 | 1) {
    if (!pipeline) return
    const ids = stages.map((s) => s.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    const current = ids[index]
    if (current === undefined) return
    ids.splice(index, 1)
    ids.splice(target, 0, current)
    reorderMutation.mutate(ids)
  }

  const columns = useMemo<ColumnDef<Stage>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Etapa",
        cell: ({ row }) => {
          const stage = row.original
          if (editing?.id === stage.id) {
            return (
              <Input
                defaultValue={stage.name}
                aria-label="Nombre de etapa"
                id={`stage-${stage.id}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const input = e.currentTarget
                    if (input.value.trim())
                      updateMutation.mutate({ id: stage.id, patch: { name: input.value.trim() } })
                  }
                }}
              />
            )
          }
          return <span className="text-sm font-medium">{stage.name}</span>
        },
      },
      {
        accessorKey: "kind",
        header: "Tipo",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const stage = row.original
          if (editing?.id === stage.id) {
            return (
              <select
                aria-label="Tipo"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                defaultValue={stage.kind}
                onChange={(e) =>
                  updateMutation.mutate({ id: stage.id, patch: { kind: e.target.value } })
                }
              >
                <option value="open">Abierta</option>
                <option value="won">Ganada</option>
                <option value="lost">Perdida</option>
              </select>
            )
          }
          return (
            <Badge
              variant={
                stage.kind === "won"
                  ? "success"
                  : stage.kind === "lost"
                    ? "destructive"
                    : "secondary"
              }
            >
              {stage.kind}
            </Badge>
          )
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const stage = row.original
          const index = row.index
          if (editing?.id === stage.id) {
            return (
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Listo
              </Button>
            )
          }
          return (
            <RowActions
              label={`Acciones de ${stage.name}`}
              items={[
                {
                  key: "up",
                  label: "Subir",
                  disabled: index === 0,
                  onSelect: () => move(index, -1),
                },
                {
                  key: "down",
                  label: "Bajar",
                  disabled: index === stages.length - 1,
                  onSelect: () => move(index, 1),
                },
                {
                  key: "rename",
                  label: "Renombrar",
                  onSelect: () => setEditing(stage),
                },
                {
                  key: "delete",
                  label: "Eliminar",
                  tone: "danger",
                  onSelect: () => setDeleting(stage),
                },
              ]}
            />
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, stages.length],
  )

  const table = useReactTable({
    data: stages,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canWrite) {
    return (
      <PageShell>
        <EmptyState title="Sin acceso" description="Solo owner/admin pueden editar pipelines." />
      </PageShell>
    )
  }

  const formFields = (
    <div className="flex flex-col gap-4">
      <form.Field name="name">
        {(field) => (
          <Field>
            <FieldLabel>Nombre</FieldLabel>
            <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="kind">
        {(field) => (
          <Field>
            <FieldLabel>Tipo</FieldLabel>
            <select
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value as "open" | "won" | "lost")}
            >
              <option value="open">Abierta</option>
              <option value="won">Ganada</option>
              <option value="lost">Perdida</option>
            </select>
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeStageForm,
    title: "Nueva etapa",
    isDirty,
    isSubmitting: createMutation.isPending,
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
          title="Pipelines"
          subtitle="Etapas del kanban de ventas"
          actions={
            pipelines.length > 1 ? (
              <select
                aria-label="Pipeline"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={pipeline?.id ?? ""}
                onChange={(e) => setPipelineId(e.target.value)}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : undefined
          }
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        {/* Sin FilterBar: las etapas se muestran en el orden de posición del pipeline y ese orden es el dato
            (subir/bajar lo edita); no hay nada que filtrar ni ordenar. */}
        {/* La fila marcada aquí es la que se está renombrando en línea, no el panel. */}
        <DataTable table={table} isRowActive={(row) => editing?.id === row.id} />
        <div>
          <Button type="button" className="min-h-11" onClick={() => setFormOpen(true)}>
            <Plus aria-hidden />
            Nueva etapa
          </Button>
        </div>
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Eliminar ${deleting?.name ?? ""}`}
        description="Solo si ningún contacto la usa."
        confirmLabel="Eliminar"
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
      />
    </PageShell>
  )
}
