import { toast } from "@odentia/ui"
import { DataTable, FormDrawer, PageHeader, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { z } from "zod"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { apiFetch } from "../../lib/api"
import { type Pipeline, SALE_MOMENT_HINT, type Stage, usePermission } from "../../lib/crm"
import { PipelinesPageSkeleton, PipelinesSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/pipelines")({
  pendingComponent: PipelinesPageSkeleton,
  component: SalesStagesPage,
})

const TITLE = "Etapas de venta"
const SUBTITLE = "Los cuatro pasos por los que avanza sola cada oportunidad. Puedes cambiarles el nombre."

const stageSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del paso")
    .max(120, "El nombre del paso no puede superar 120 caracteres"),
})

/**
 * Etapas de venta (ADR 0028): cuatro pasos fijos —Interesado, Evaluación
 * agendada, Presupuesto enviado y Decidió—, cada uno con lo que hace llegar a
 * él la oportunidad. Solo se renombran: añadir o quitar pasos impediría que la
 * oportunidad avance sola. Los renombra quien configura y quien trabaja con
 * oportunidades (`crm.write`), la misma regla que aplica el servidor.
 */
function SalesStagesPage() {
  const queryClient = useQueryClient()
  const canConfigure = usePermission("settings.read")
  const canSell = usePermission("crm.read")
  const canRead = canConfigure || canSell
  const canWrite = usePermission("crm.write")
  const [funnelId, setFunnelId] = useState<string | null>(null)
  const sideForm = useSideForm<Stage>()
  const openForm = sideForm.open

  const listQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
    enabled: canRead,
    retry: 1,
  })
  const funnels = listQuery.data?.data ?? []
  const funnel = funnels.find((item) => item.id === funnelId) ?? funnels[0] ?? null
  const stages = useMemo(() => funnel?.stages ?? [], [funnel])

  // biome-ignore lint/correctness/useExhaustiveDependencies: las acciones leen el estado vigente; las columnas se rearman con el permiso.
  const columns = useMemo<ColumnDef<Stage>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Paso",
        meta: { view: { role: "title" } },
        cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
      },
      {
        id: "llega",
        header: "Cuándo llega sola",
        meta: { view: { primary: true } },
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{SALE_MOMENT_HINT[row.original.moment]}</span>,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canWrite ? (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[{ key: "rename", label: "Cambiar el nombre", onSelect: () => openForm(row.original) }]}
            />
          ) : null,
      },
    ],
    [canWrite],
  )
  const table = useReactTable({ data: stages, columns, getCoreRowModel: getCoreRowModel() })

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
        subtitle={
          funnels.length > 1 ? (
            <>
              <p className="min-w-0">{SUBTITLE}</p>
              <ChoiceSelect aria-label="Embudo de ventas" value={funnel?.id ?? ""} onChange={(event) => setFunnelId(event.target.value)}>
                {funnels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </ChoiceSelect>
            </>
          ) : (
            SUBTITLE
          )
        }
      />
      {listQuery.isPending ? (
        <PipelinesSkeleton />
      ) : neverLoaded ? (
        <SettingsLoadError what="las etapas de venta" onRetry={() => void listQuery.refetch()} />
      ) : (
        <>
          {listQuery.isError ? <SettingsLoadError stale what="las etapas de venta" onRetry={() => void listQuery.refetch()} /> : null}
          <DataTable
            table={table}
            {...(canWrite ? { onRowClick: (stage: Stage) => openForm(stage) } : {})}
            isRowActive={(row) => sideForm.form?.target?.id === row.id}
            isFetching={listQuery.isFetching}
            refreshMessage="Actualizando las etapas…"
          />
        </>
      )}
      {canWrite && sideForm.form?.target ? (
        <RenameStageForm
          key={sideForm.form.opening}
          stage={sideForm.form.target}
          onDirtyChange={sideForm.setDirty}
          onClose={sideForm.close}
          onSaved={() => {
            sideForm.close()
            void queryClient.invalidateQueries({ queryKey: ["pipelines"] })
          }}
        />
      ) : null}
      <DiscardDraftDialog form={sideForm} what="otro paso" />
    </div>
  )
}

/** Cambiar el nombre de un paso, con su «Guardar». El paso y cuándo llega sola no cambian. */
function RenameStageForm({
  stage,
  onDirtyChange,
  onClose,
  onSaved,
}: {
  stage: Stage
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onSaved: () => void
}) {
  const save = useMutation({
    mutationFn: (value: string) => apiFetch(`/api/pipelines/stages/${stage.id}`, { method: "PATCH", body: JSON.stringify({ name: value }) }),
  })
  const form = useAppForm({
    defaultValues: { name: stage.name },
    validators: { onSubmit: stageSchema },
    onSubmit: async ({ value }) => {
      const name = value.name.trim()
      await save.mutateAsync(name)
      toast.success(`Paso «${name}» guardado`)
      onSaved()
    },
  })
  const surface = useFormSurface(form)
  useReportDirty(surface.isDirty, onDirtyChange)
  return (
    <FormDrawer {...surface} open onClose={onClose} title="Cambiar el nombre del paso">
      <div className="flex flex-col gap-4">
        <form.AppField name="name">
          {(field) => <field.TextField label="Nombre" maxLength={120} description={SALE_MOMENT_HINT[stage.moment]} />}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
