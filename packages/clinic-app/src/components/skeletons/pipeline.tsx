/**
 * Esqueleto de Oportunidades, con las clases de `routes/_org/pipeline.tsx`: los
 * cuatro pasos fijos del tablero (el último, «Decidió», con sus dos mitades), que
 * en el teléfono se cortan al borde igual que el tablero real, o la tabla de la
 * vista lista.
 */
import { buttonVariants, Skeleton } from "@odentia/ui"
import type { FilterDef } from "@odentia/ui-patterns"
import { FilterBar, PageHeader, PageShell, SkeletonRegion, useListSearch, ViewTabs } from "@odentia/ui-patterns"
import { Columns3, List } from "lucide-react"
import type { ComponentProps } from "react"
import { useCan, usePermission } from "../../lib/crm"
import { pipelinePrimary } from "../../lib/screen-rules"
import { LabeledTableSkeleton, RowActionsSkeleton } from "./labeled-table"

/** Los filtros fijos de la pantalla: los comparte con su esqueleto para no repetirlos. */
export const PIPELINE_FILTERS: FilterDef[] = [
  {
    key: "asignado",
    label: "Quién la lleva",
    type: "select",
    options: [
      { value: "todas", label: "Todas" },
      { value: "mias", label: "Las mías" },
      { value: "recepcion", label: "Recepción, sin tomar" },
    ],
  },
  {
    key: "movio",
    label: "Quién lo movió",
    type: "select",
    options: [
      { value: "todas", label: "Todas" },
      { value: "agente", label: "Movidas por el agente" },
    ],
  },
  {
    key: "tarea",
    label: "Tarea",
    type: "select",
    options: [
      { value: "todas", label: "Todas" },
      { value: "vencida", label: "Con la tarea vencida" },
    ],
  },
]

const COLUMN_WIDTH_CLASS = "w-[min(17rem,82vw)] shrink-0 lg:w-auto lg:min-w-[17rem] lg:max-w-[26rem] lg:flex-1 lg:basis-0"

/** Una tarjeta del tablero: quién y qué, por qué está ahí, su tarea, su valor y de quién es. */
export function OpportunityCardSkeleton() {
  // El asa de arrastre es de quien puede mover la oportunidad.
  const canMove = usePermission("crm.write")
  return (
    <div className="shrink-0 rounded-xl border border-border/50 bg-card p-4 text-sm shadow-sm">
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <div className="-mr-2 -mt-1 flex shrink-0 items-center">
            {canMove ? (
              <span className="flex size-8 items-center justify-center">
                <Skeleton className="size-4 rounded-full" />
              </span>
            ) : null}
            <RowActionsSkeleton />
          </div>
        </div>
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="size-7 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  )
}

function ColumnHead() {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 rounded-t-xl bg-muted px-2 pb-4 pt-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Skeleton className="size-2.5 shrink-0 rounded-full" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-5 w-6 rounded-md" />
        </div>
        <Skeleton className="mt-2 ml-4.5 h-3 w-28" />
      </div>
    </div>
  )
}

function BoardSkeleton() {
  return (
    // El tablero real se desplaza de lado; aquí se corta, para no desbordar la página.
    <div className="min-h-0 flex-1 overflow-hidden rounded-2xl">
      <div className="flex h-full min-w-full items-stretch gap-4 pb-3">
        {[3, 2, 2].map((cards, step) => (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: columnas de relleno, siempre las mismas.
            key={step}
            className={`flex min-w-0 flex-col rounded-2xl border border-transparent bg-muted/45 p-2 ${COLUMN_WIDTH_CLASS}`}
          >
            <ColumnHead />
            <div className="relative flex min-h-32 flex-1 flex-col gap-3 px-0.5 pb-1">
              {Array.from({ length: cards }, (_, card) => (
                <OpportunityCardSkeleton key={card} />
              ))}
            </div>
          </section>
        ))}
        {/* «Decidió»: una columna con Ganadas arriba y Perdidas abajo. */}
        <div className={`flex min-w-0 flex-col gap-3 ${COLUMN_WIDTH_CLASS}`}>
          {[0, 1].map((half) => (
            <section key={half} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-transparent bg-muted/45 p-2">
              <ColumnHead />
              <div className="relative flex min-h-32 flex-1 flex-col gap-3 overflow-hidden px-0.5 pb-1">
                <OpportunityCardSkeleton />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** La vista lista: las mismas columnas de `PipelineListView`. */
export function PipelineListSkeleton() {
  const line = (width: string) => <Skeleton className={`h-3.5 ${width}`} />
  return (
    <LabeledTableSkeleton
      columns={[
        {
          label: "Oportunidad",
          cell: (
            <div className="flex min-w-0 max-w-sm flex-col md:min-w-48">
              {line("my-[3px] w-48 max-w-full")}
              <span className="flex min-h-11 items-center">{line("w-28")}</span>
            </div>
          ),
        },
        { label: "Paso", cell: <Skeleton className="h-5 w-24 rounded-full" /> },
        { label: "Por qué está aquí", cell: line("w-40") },
        { label: "Tarea", cell: line("w-32") },
        { label: "Valor", cell: line("w-16") },
        { label: "Quién la lleva", cell: line("w-24") },
        { label: "Acciones", cell: <RowActionsSkeleton /> },
      ]}
      title={
        <span className="flex flex-col">
          {line("my-[3px] w-3/4")}
          <span className="flex min-h-11 items-center">{line("w-28")}</span>
        </span>
      }
      summary={
        <>
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="my-1 h-3 w-28" />
        </>
      }
      actions={<RowActionsSkeleton />}
    />
  )
}

/** Tablero o lista, según la vista elegida. */
export function PipelineSkeleton({ vista }: { vista?: string }) {
  if (vista !== "lista") return <BoardSkeleton />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-wrap gap-2">
        {["Todas", "Abiertas", "Ganadas", "Perdidas"].map((label) => (
          <span key={label} className={`${buttonVariants({ variant: "outline", size: "sm" })} text-muted-foreground`}>
            {label}
          </span>
        ))}
      </div>
      <PipelineListSkeleton />
    </div>
  )
}

export function PipelinePageSkeleton({ primary }: { primary?: ComponentProps<typeof PageHeader>["primary"] } = {}) {
  const { get, setParam } = useListSearch()
  const vista = get("vista")
  const can = useCan()
  return (
    <PageShell fill className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader title="Oportunidades" primary={primary ?? pipelinePrimary(can)} />
      <div className="flex items-center gap-2 rounded-xl bg-card p-2">
        <FilterBar
          className="min-w-0 flex-1 rounded-none bg-transparent p-1"
          filters={PIPELINE_FILTERS}
          sortOptions={[]}
          searchPlaceholder="Buscar por persona o interés…"
          searchLabel="Buscar en oportunidades"
          resetKeys={["q", "asignado", "tarea", "movio"]}
        />
        <ViewTabs
          label="Vista de oportunidades"
          className="shrink-0"
          value={vista === "lista" ? "lista" : "tablero"}
          options={[
            { value: "tablero", label: "Tablero", icon: <Columns3 aria-hidden /> },
            { value: "lista", label: "Lista", icon: <List aria-hidden /> },
          ]}
          onValueChange={(next) => setParam("vista", next === "lista" ? "lista" : undefined)}
        />
      </div>
      <SkeletonRegion message="Cargando el tablero…" className="flex min-h-0 flex-1 flex-col">
        <PipelineSkeleton vista={vista} />
      </SkeletonRegion>
    </PageShell>
  )
}
