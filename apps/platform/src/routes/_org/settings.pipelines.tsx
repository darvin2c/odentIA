import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  FormDrawer,
  PageHeader,
  RowActions,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useId, useMemo, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ApiError, apiFetch } from "../../lib/api"
import { type Pipeline, type Stage, usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/pipelines")({
  component: SalesStagesPage,
})

const TITLE = "Etapas de venta"
const SUBTITLE = "Los pasos por los que avanza cada oportunidad, en su orden."

type StageKind = "open" | "won" | "lost"

/** El tipo de etapa, dicho con palabras: la misma frase en la lista y en el formulario. */
const STAGE_KINDS: Array<{ value: StageKind; label: string; hint: string }> = [
  { value: "open", label: "En curso", hint: "La oportunidad sigue abierta mientras está en esta etapa." },
  { value: "won", label: "Cierra como ganada", hint: "Al llegar a esta etapa la oportunidad se cierra como venta, con su motivo." },
  { value: "lost", label: "Cierra como perdida", hint: "Al llegar a esta etapa la oportunidad se cierra sin venta, con su motivo." },
]
const KIND_ITEMS = Object.fromEntries(STAGE_KINDS.map((kind) => [kind.value, kind.label]))
const KIND_BADGE = { open: "secondary", won: "success", lost: "destructive" } as const

function kindOf(stage: Stage): StageKind {
  return stage.kind === "won" || stage.kind === "lost" ? stage.kind : "open"
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/**
 * Etapas de venta: las columnas del tablero de oportunidades, en su orden. La
 * lista se edita en la superficie lateral; subir y bajar guardan al momento.
 * Configurar las etapas es de quien administra la clínica (`settings.*`), la
 * misma regla que abre el apartado y que aplica el servidor.
 */
function SalesStagesPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const [funnelId, setFunnelId] = useState<string | null>(null)
  // Al lado: una etapa nueva o la que se edita.
  const sideForm = useSideForm<Stage>()
  const openForm = sideForm.open
  const [deleting, setDeleting] = useState<Stage | null>(null)

  const listQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
    enabled: canRead,
    retry: 1,
  })

  const funnels = listQuery.data?.data ?? []
  const funnel = funnels.find((item) => item.id === funnelId) ?? funnels[0] ?? null
  const stages = useMemo(() => funnel?.stages ?? [], [funnel])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["pipelines"] })

  const deleteMutation = useMutation({
    mutationFn: (stage: Stage) => apiFetch(`/api/pipelines/stages/${stage.id}`, { method: "DELETE" }),
    onSuccess: (_result, stage) => {
      setDeleting(null)
      toast.success(`Etapa «${stage.name}» eliminada`)
      void invalidate()
    },
    onError: (error) => {
      setDeleting(null)
      toast.error(errorText(error, "No pudimos eliminar la etapa. Vuelve a intentarlo."))
    },
  })

  const reorderMutation = useMutation({
    mutationFn: (stageIds: string[]) =>
      apiFetch(`/api/pipelines/${funnel?.id}/reorder`, {
        method: "POST",
        body: JSON.stringify({ stageIds }),
      }),
    onSuccess: () => {
      toast.success("Orden guardado")
      void invalidate()
    },
    onError: (error) => toast.error(errorText(error, "No pudimos guardar el orden. Vuelve a intentarlo.")),
  })

  function move(index: number, delta: -1 | 1) {
    if (!funnel || reorderMutation.isPending) return
    const ids = stages.map((stage) => stage.id)
    const target = index + delta
    const current = ids[index]
    if (target < 0 || target >= ids.length || current === undefined) return
    ids.splice(index, 1)
    ids.splice(target, 0, current)
    reorderMutation.mutate(ids)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: las acciones leen el estado vigente; las columnas se rearman con las etapas, el permiso y el orden en curso.
  const columns = useMemo<ColumnDef<Stage>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Etapa",
        meta: { view: { role: "title" } },
        cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: "kind",
        header: "Tipo de etapa",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const kind = kindOf(row.original)
          return <Badge variant={KIND_BADGE[kind]}>{KIND_ITEMS[kind]}</Badge>
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          if (!canWrite) return null
          const stage = row.original
          const index = row.index
          return (
            <RowActions
              label={`Acciones de ${stage.name}`}
              items={[
                { key: "edit", label: "Editar", onSelect: () => openForm(stage) },
                { key: "up", label: "Subir", disabled: index === 0, onSelect: () => move(index, -1) },
                {
                  key: "down",
                  label: "Bajar",
                  disabled: index === stages.length - 1,
                  onSelect: () => move(index, 1),
                },
                { key: "delete", label: "Eliminar", tone: "danger", onSelect: () => setDeleting(stage) },
              ]}
            />
          )
        },
      },
    ],
    [stages, canWrite, reorderMutation.isPending],
  )

  const table = useReactTable({
    data: stages,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const neverLoaded = listQuery.isError && listQuery.data === undefined

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
            {funnels.length > 1 ? (
              <Select
                value={funnel?.id ?? ""}
                items={Object.fromEntries(funnels.map((item) => [item.id, item.name]))}
                onValueChange={(value: string | null) => setFunnelId(value)}
              >
                <SelectTrigger aria-label="Embudo de ventas">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {funnels.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {canWrite && funnel ? (
              <Button type="button" className="min-h-11" onClick={() => openForm(null)}>
                <Plus aria-hidden />
                Nueva etapa
              </Button>
            ) : null}
          </>
        }
      />

      {/* Sin filtros: las etapas se muestran en su orden y ese orden es el dato (subir y bajar lo editan). */}
      {listQuery.isPending ? (
        <DataTableSkeleton columnCount={3} rowCount={5} label="Cargando las etapas de venta…" />
      ) : neverLoaded ? (
        <SettingsLoadError what="las etapas de venta" onRetry={() => void listQuery.refetch()} />
      ) : (
        <>
          {listQuery.isError ? (
            <SettingsLoadError stale what="las etapas de venta" onRetry={() => void listQuery.refetch()} />
          ) : null}
          {stages.length === 0 ? (
            <EmptyState
              title="Aún no hay etapas"
              description="Sin etapas, las oportunidades no tienen por dónde avanzar en el tablero."
              {...(canWrite && funnel
                ? { actionLabel: "Agrega la primera etapa", onAction: () => openForm(null) }
                : {})}
            />
          ) : (
            <DataTable
              table={table}
              {...(canWrite ? { onRowClick: (stage: Stage) => openForm(stage) } : {})}
              isRowActive={(row) => sideForm.form?.target?.id === row.id}
              isFetching={listQuery.isFetching || reorderMutation.isPending}
              refreshMessage="Actualizando las etapas…"
            />
          )}
        </>
      )}

      {canWrite && funnel && sideForm.form ? (
        <StageForm
          key={sideForm.form.opening}
          funnelId={funnel.id}
          stage={sideForm.form.target}
          onDirtyChange={sideForm.setDirty}
          onClose={sideForm.close}
          onSaved={() => {
            sideForm.close()
            void invalidate()
          }}
        />
      ) : null}
      <DiscardDraftDialog form={sideForm} what="otra etapa" />

      {canWrite ? (
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          title={`Eliminar la etapa «${deleting?.name ?? ""}»`}
          description="Deja de ser una columna del tablero de oportunidades. Solo se puede eliminar si ninguna oportunidad está en ella: muévelas antes a otra etapa."
          confirmLabel="Eliminar"
          pending={deleteMutation.isPending}
          onConfirm={() => deleting && deleteMutation.mutate(deleting)}
        />
      ) : null}
    </div>
  )
}

/** Una etapa nueva o la que se edita: nombre y tipo, con su «Guardar». */
function StageForm({
  funnelId,
  stage,
  onDirtyChange,
  onClose,
  onSaved,
}: {
  funnelId: string
  stage: Stage | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onSaved: () => void
}) {
  const ids = useId()
  const initialKind = stage ? kindOf(stage) : "open"
  const [name, setName] = useState(stage?.name ?? "")
  const [kind, setKind] = useState<StageKind>(initialKind)
  const [nameError, setNameError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (values: { name: string; kind: StageKind }) =>
      stage
        ? apiFetch(`/api/pipelines/stages/${stage.id}`, { method: "PATCH", body: JSON.stringify(values) })
        : apiFetch(`/api/pipelines/${funnelId}/stages`, { method: "POST", body: JSON.stringify(values) }),
    onSuccess: (_result, values) => {
      toast.success(`Etapa «${values.name}» guardada`)
      onSaved()
    },
  })

  const isDirty = name !== (stage?.name ?? "") || kind !== initialKind
  useReportDirty(isDirty, onDirtyChange)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={stage ? "Editar etapa" : "Nueva etapa"}
      isDirty={isDirty}
      isSubmitting={save.isPending}
      error={save.isError ? errorText(save.error, "No pudimos guardar la etapa. Vuelve a intentarlo.") : null}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) {
          setNameError("Escribe el nombre de la etapa")
          return
        }
        setNameError(null)
        save.mutate({ name: trimmed, kind })
      }}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-nombre`}>Nombre</FieldLabel>
          <Input
            id={`${ids}-nombre`}
            value={name}
            maxLength={120}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? <FieldError>{nameError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-tipo`}>Tipo de etapa</FieldLabel>
          <Select value={kind} items={KIND_ITEMS} onValueChange={(value) => setKind((value as StageKind | null) ?? "open")}>
            <SelectTrigger id={`${ids}-tipo`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGE_KINDS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{STAGE_KINDS.find((item) => item.value === kind)?.hint}</FieldDescription>
        </Field>
      </div>
    </FormDrawer>
  )
}
