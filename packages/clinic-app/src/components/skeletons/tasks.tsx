/**
 * Esqueleto de Tareas: desde `md` la tabla con sus columnas; en el teléfono, las
 * filas de la vista lista. Las pestañas y la búsqueda se pintan reales.
 */
import { ParamTabs } from "./param-tabs"
import { Skeleton, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { FilterBar, useListSearch } from "@odentia/ui-patterns"
import { useCan, usePermission } from "../../lib/crm"
import { tasksFilters, tasksPrimary } from "../../lib/screen-rules"
import { LabeledTableSkeleton, RowActionsSkeleton } from "./labeled-table"
import { PageLoading } from "./page-loading"

/** Los rótulos de `VIEWS` en `routes/_org/tasks.tsx`. */
const TABS = [
  { value: "abiertas", label: "Mías y de mi área" },
  { value: "vencidas", label: "Vencidas" },
  { value: "hechas", label: "Hechas" },
]

export function TasksSkeleton() {
  // «Hecha» es de quien escribe en las tareas; «Abrir», de todos.
  const canWrite = usePermission("tasks.write")
  const ACTIONS = (
    <span className="flex items-center justify-end gap-1">
      {canWrite ? <Skeleton className="h-8 w-20 rounded-full" /> : null}
      <RowActionsSkeleton />
    </span>
  )
  return (
    <LabeledTableSkeleton
      columns={[
        {
          label: "Tarea",
          cell: (
            <div className="flex min-w-0 max-w-sm flex-col items-start gap-2">
              <Skeleton className="h-3.5 w-56 max-w-full" />
              <Skeleton className="h-3 w-40 max-w-full" />
            </div>
          ),
        },
        { label: "De quién", cell: <Skeleton className="h-3.5 w-28" /> },
        { label: "Quién la lleva", cell: <Skeleton className="h-3.5 w-24" /> },
        { label: "Vence", cell: <Skeleton className="h-3.5 w-20" /> },
        { label: "Origen", cell: <Skeleton className="h-3.5 w-24" /> },
        { label: "", cell: ACTIONS },
      ]}
      title={
        <span className="flex flex-col gap-2 py-0.5">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3 w-3/5" />
        </span>
      }
      summary={
        <>
          <Skeleton className="my-1 h-3 w-24" />
          <Skeleton className="my-1 h-3 w-20" />
          <Skeleton className="my-1 h-3 w-16" />
        </>
      }
      actions={ACTIONS}
    />
  )
}

export function TasksPageSkeleton() {
  const { get } = useListSearch()
  const vista = get("vista")
  const can = useCan()
  return (
    <PageLoading title="Tareas" className="flex flex-col gap-6" primary={tasksPrimary(can)}>
      <div className="flex flex-col gap-6">
        {/* El subtítulo nombra al agente de la clínica: espera. En el teléfono ocupa dos líneas. */}
        <div className="flex min-w-0 flex-col gap-1.5 py-0.5">
          <Skeleton className="h-3.5 w-[34rem] max-w-full" />
          <Skeleton className="h-3.5 w-2/3 sm:hidden" />
        </div>
        <div className="flex flex-col gap-2">
          <ParamTabs param="vista" fallback="abiertas" value={TABS.some((tab) => tab.value === vista) ? vista : "abiertas"}>
            <TabsList
              aria-label="Qué tareas ver"
              className="max-w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="shrink-0 min-h-11 sm:min-h-9">
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </ParamTabs>
          <FilterBar
            filters={tasksFilters(can)}
            sortOptions={
              vista === "hechas"
                ? []
                : [
                    { value: "vence", label: "Vence primero" },
                    { value: "recientes", label: "Más recientes" },
                  ]
            }
            searchPlaceholder="Buscar por tarea, persona u oportunidad"
            searchLabel="Buscar en tareas"
          />
        </div>
        <TasksSkeleton />
      </div>
    </PageLoading>
  )
}
