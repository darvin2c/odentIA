import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  MasterDetail,
  PageHeader,
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
import { type Pipeline, type Stage, usePermission } from "../../lib/crm"
import { PageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/pipelines")({
  component: PipelinesPage,
})

const stageSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre"),
  kind: z.enum(["open", "won", "lost"]),
})

/** Tipos de etapa: etiqueta única para los dos selects de la página. */
const STAGE_KINDS = [
  { value: "open", label: "Abierta" },
  { value: "won", label: "Ganada" },
  { value: "lost", label: "Perdida" },
] as const

function PipelinesPage() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("crm.write")
  const canRead = usePermission("crm.read")
  const mode = useDetailMode()
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Stage | null>(null)
  const [deleting, setDeleting] = useState<Stage | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
    enabled: canRead,
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
  const isDirty = useStore(form.store, (state) => !state.isDefaultValue)

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
              <Select
                value={stage.kind}
                items={Object.fromEntries(STAGE_KINDS.map((k) => [k.value, k.label]))}
                onValueChange={(value) =>
                  updateMutation.mutate({ id: stage.id, patch: { kind: value } })
                }
              >
                <SelectTrigger aria-label="Tipo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGE_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          if (!canWrite) return null
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
    [editing, stages.length, canWrite],
  )

  const table = useReactTable({
    data: stages,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canRead) {
    return (
      <div>
        <EmptyState title="Sin acceso" description="Sin permiso de lectura del CRM." />
      </div>
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
            <FieldLabel htmlFor="etapa-tipo">Tipo</FieldLabel>
            <Select
              value={field.state.value}
              items={Object.fromEntries(STAGE_KINDS.map((k) => [k.value, k.label]))}
              onValueChange={(value) => field.handleChange(value as "open" | "won" | "lost")}
            >
              <SelectTrigger id="etapa-tipo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGE_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
    <div className="flex flex-col gap-6">
      <PageDraftGuard dirty={formOpen && isDirty} />
      <MasterDetail
        panel={
          canWrite && mode === "panel" && formOpen ? (
            <FormPanel {...formProps}>{formFields}</FormPanel>
          ) : null
        }
      >
        <PageHeader
          title="Pipelines"
          subtitle="Etapas del kanban de ventas"
          actions={
            <>
              {pipelines.length > 1 ? (
                <Select
                  value={pipeline?.id ?? ""}
                  items={Object.fromEntries(pipelines.map((p) => [p.id, p.name]))}
                  onValueChange={setPipelineId}
                >
                  <SelectTrigger aria-label="Pipeline">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pipelines.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {canWrite && (
                <Button type="button" className="min-h-11" onClick={() => setFormOpen(true)}>
                  <Plus aria-hidden />
                  Nueva etapa
                </Button>
              )}
            </>
          }
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {/* Sin FilterBar: las etapas se muestran en el orden de posición del pipeline y ese orden es el dato
            (subir/bajar lo edita); no hay nada que filtrar ni ordenar. */}
        {/* La fila marcada aquí es la que se está renombrando en línea, no el panel. */}
        {listQuery.isPending ? (
          <DataTableSkeleton columnCount={3} rowCount={4} label="Cargando etapas…" />
        ) : (
          <DataTable table={table} isRowActive={(row) => editing?.id === row.id} isFetching={listQuery.isFetching} refreshMessage="Actualizando etapas…" />
        )}
      </MasterDetail>
    
      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {canWrite && mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
      {canWrite && (
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          title={`Eliminar ${deleting?.name ?? ""}`}
          description="Solo si ninguna oportunidad la usa."
          confirmLabel="Eliminar"
          onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        />
      )}
    </div>
  )
}
