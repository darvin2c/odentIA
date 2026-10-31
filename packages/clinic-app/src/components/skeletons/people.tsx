/**
 * Esqueletos de la lista de Pacientes y de las historias bloqueadas. Las clases
 * son las de `routes/_org/people.index.tsx`, `routes/_org/people.locked.tsx` y
 * `components/person/locked-record.tsx`.
 */
import { ParamTabs } from "./param-tabs"
import { Button, Skeleton, Tabs, TabsTrigger } from "@odentia/ui"
import { FilterBar, type PageHeaderProps, PageShell, ScrollingTabsList, SkeletonRegion } from "@odentia/ui-patterns"
import { Lock } from "lucide-react"
import { PageLoading } from "./page-loading"
import { HeaderShape, Line, TableShape } from "./person-parts"

/** La celda «Persona»: su avatar y dos líneas, con el mismo alto que la real. */
function PersonCell() {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <span className="flex min-w-0 flex-col">
        <Line className="w-36" />
        <Line className="w-52" />
      </span>
    </span>
  )
}

const PATIENT_COLUMNS = ["Persona", "Próxima cita", "Última visita", "Qué sigue"]

/**
 * Las filas de una lista de personas: tabla desde `md`, filas por debajo, y su
 * paginación. Quien la usa pasa los rótulos de la vista abierta.
 */
export function PeopleSkeleton({ columns = PATIENT_COLUMNS }: { columns?: readonly string[] }) {
  return (
    <>
      <TableShape
        columns={columns}
        rows={8}
        cell={(column) => (column === 0 ? <PersonCell /> : <Line className={column === columns.length - 1 ? "w-40" : "w-20"} />)}
        listTitle={<PersonCell />}
        listSummary={<Line className="w-40" />}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <Line size="xs" className="w-32" />
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled>
            Anterior
          </Button>
          <Button type="button" size="sm" variant="outline" disabled>
            Siguiente
          </Button>
        </div>
      </div>
    </>
  )
}

/** La pantalla entera mientras llega su código: lo que el rol ve arriba, las pestañas de quien entra, el buscador y las filas. */
export function PeoplePageSkeleton({
  views,
  active,
  subtitle,
  primary,
  menu,
}: {
  views: ReadonlyArray<{ id: string; label: string }>
  active: string
  subtitle: string
  primary?: PageHeaderProps["primary"]
  menu?: PageHeaderProps["menu"]
}) {
  return (
    <PageLoading title="Pacientes" className="" primary={primary} menu={menu}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <p className="min-w-0">{subtitle}</p>
      </div>
      <div className="flex flex-col gap-2 py-4">
        <ParamTabs param="ver" fallback="pacientes" value={active}>
          <ScrollingTabsList aria-label="Qué personas ver">
            {views.map((item) => (
              <TabsTrigger key={item.id} value={item.id} className="shrink-0 min-h-11 sm:min-h-9">
                {item.label}
              </TabsTrigger>
            ))}
          </ScrollingTabsList>
        </ParamTabs>
        <FilterBar
          filters={[]}
          sortOptions={[]}
          searchPlaceholder="Buscar por nombre, teléfono o documento"
          searchLabel="Buscar en pacientes"
        />
        <p className="text-xs text-muted-foreground">Una sola búsqueda en toda la clínica.</p>
      </div>
      <PeopleSkeleton />
    </PageLoading>
  )
}

/** Las filas de «Historias bloqueadas», con la explicación que las acompaña. */
export function LockedRecordsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Pidieron borrar sus datos: lo no clínico se borró y su historia se guarda porque la ley lo pide. Ábrela con motivo
        desde su página.
      </p>
      <ul className="flex max-w-3xl flex-col divide-y rounded-lg border">
        {[0, 1, 2].map((row) => (
          <li key={row} className="flex min-h-14 flex-wrap items-center gap-3 p-3">
            <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <Line className="w-40" />
              <Line className="w-52" />
            </span>
            <Line className="w-48" />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LockedRecordsPageSkeleton() {
  return (
    <PageLoading title="Historias bloqueadas" className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">Volver a Pacientes</p>
        <LockedRecordsSkeleton />
      </div>
    </PageLoading>
  )
}

/** Una historia bloqueada abierta por Administración, antes de saber de quién es. */
export function LockedRecordPageSkeleton() {
  return (
    <PageShell className="flex flex-col gap-6">
      <SkeletonRegion message="Cargando…" className="flex flex-col gap-6">
        <div className="flex flex-col">
          <HeaderShape />
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Line className="w-72" />
          </div>
        </div>
        <section className="flex max-w-3xl flex-col gap-2 rounded-xl border bg-muted/40 p-5 text-sm">
          <Line size="base" className="w-80" />
          <p className="text-muted-foreground">
            Se conserva porque la ley pide guardar la historia clínica durante años. No sale en búsquedas, agenda, listas ni
            reportes, y el agente no la ve.
          </p>
          <Line className="w-40" />
        </section>
        <section className="flex max-w-3xl flex-col gap-4 rounded-xl border p-5 text-sm">
          <div>
            <h2 className="text-base font-semibold">Abrirla con motivo</h2>
            <p className="text-muted-foreground">
              Solo Administración. Queda en «Consultas a la historia» y en la Actividad del equipo, con quién y cuándo.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-9 w-32 rounded-full" />
            <Skeleton className="h-9 w-28 rounded-full" />
            <Skeleton className="h-9 w-24 rounded-full" />
          </div>
        </section>
      </SkeletonRegion>
    </PageShell>
  )
}
