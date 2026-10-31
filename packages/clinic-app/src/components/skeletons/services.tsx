/**
 * Los esqueletos de Servicios y precios: la lista por especialidad, «Agregar
 * servicios» y Promociones. Cada página trae su `PageHeader` dentro del layout,
 * que ya puso el `PageShell` y el nav de sección: por eso el encabezado va aquí.
 */
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { PageHeader, PageShell, SectionNav, type SectionNavItem } from "@odentia/ui-patterns"
import { useRouterState } from "@tanstack/react-router"
import { BadgePercent, Library, Tag } from "lucide-react"
import { useCan } from "../../lib/crm"
import { RouterLink } from "../../lib/router-link"
import { hasPlaces, libraryHeading, libraryPrimary, promotionsPrimary, servicesAccess, servicesHeader } from "../../lib/screen-rules"
import { LabeledTableSkeleton, RowActionsSkeleton } from "./labeled-table"
import { FilterBarShell, TextLine, TextLines } from "./list-bar"
import { PageLoading } from "./page-loading"

function ServiceCell() {
  return <TextLines widths={["w-52", "w-28"]} />
}

/** Una especialidad: su nombre y su tabla (filas en el teléfono). */
function ServiceGroup({ rows, optional }: { rows: number; optional: { select: boolean; code: boolean; places: boolean; materials: boolean; actions: boolean } }) {
  return (
    <section>
      <TextLine width="w-32" className="mb-2" />
      <LabeledTableSkeleton
        rowCount={rows}
        columns={[
          ...(optional.select ? [{ label: " ", cell: <Skeleton className="size-4 rounded-sm" /> }] : []),
          { label: "Servicio", cell: <ServiceCell /> },
          ...(optional.code ? [{ label: "Código interno", cell: <TextLine width="w-16" /> }] : []),
          ...(optional.places ? [{ label: "Ámbito", cell: <TextLine width="w-16" /> }] : []),
          { label: "Precio", cell: <TextLine width="w-16" /> },
          { label: "Se cobra", cell: <TextLine width="w-24" /> },
          ...(optional.materials ? [{ label: "Materiales", cell: <TextLine width="w-24" /> }] : []),
          ...(optional.actions ? [{ label: "  ", cell: <RowActionsSkeleton /> }] : []),
        ]}
        title={
          <div className="flex min-w-0 items-start gap-2.5">
            {optional.select ? <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" /> : null}
            <ServiceCell />
          </div>
        }
        summary={
          <>
            <TextLine width="w-16" />
            <TextLine width="w-24" />
          </>
        }
      />
    </section>
  )
}

/** La lista de servicios, por especialidad, y su pie. Las columnas opcionales las dice quien la conoce. */
export function ServicesListSkeleton({
  select = false,
  code = false,
  places = false,
  materials = false,
  actions = true,
}: {
  select?: boolean
  code?: boolean
  places?: boolean
  materials?: boolean
  actions?: boolean
}) {
  const optional = { select, code, places, materials, actions }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ServiceGroup rows={4} optional={optional} />
      <ServiceGroup rows={3} optional={optional} />
      <TextLine width="w-44" />
    </div>
  )
}

function ServicesListPage() {
  const can = useCan()
  const access = servicesAccess(can)
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Servicios y precios" subtitle={<TextLine width="w-72" />} {...servicesHeader(can)} />
      <FilterBarShell searchLabel="Buscar en servicios" searchPlaceholder="Buscar por nombre o código interno" filters={["Especialidad", "Estado"]} sort />
      {/* «Código interno» depende de los datos: se ve al llegar, como en la pantalla. */}
      <ServicesListSkeleton select={access.manage} places={hasPlaces()} materials={access.seesMaterials} actions={access.manage} />
    </div>
  )
}

export function ServicesListPageSkeleton() {
  return (
    <PageLoading title="Servicios y precios">
      <ServicesListPage />
    </PageLoading>
  )
}

/** La tabla de la biblioteca: la casilla, el nombre, cómo se cobra, la duración y el precio. */
export function LibraryRowsSkeleton({ canIncorporate = true }: { canIncorporate?: boolean }) {
  if (!canIncorporate) {
    return (
      <LabeledTableSkeleton
        columns={[
          { label: "Tratamiento", cell: <ServiceCell /> },
          { label: "En la clínica", cell: <TextLine width="w-24" /> },
        ]}
        title={<ServiceCell />}
        summary={<TextLine width="w-24" />}
      />
    )
  }
  return (
    <LabeledTableSkeleton
      columns={[
        { label: " ", cell: <Skeleton className="size-4 rounded-sm" /> },
        { label: "Servicio, con el nombre que usará la clínica", cell: <ServiceCell /> },
        { label: "Se cobra", cell: <TextLine width="w-24" /> },
        { label: "Duración", cell: <TextLine width="w-14" /> },
        { label: "Precio", cell: <Skeleton className="h-9 w-28" /> },
      ]}
      title={
        <div className="flex min-w-0 items-start gap-2.5">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
          <ServiceCell />
        </div>
      }
      summary={
        <>
          <TextLine width="w-24" />
          <TextLine width="w-14" />
          <Skeleton className="h-9 w-28" />
        </>
      }
    />
  )
}

/** Filtros, de dónde elegir y la tabla: la pantalla lo usa también mientras llega la moneda de la clínica. */
export function LibraryBodySkeleton({ canIncorporate = true }: { canIncorporate?: boolean }) {
  return (
    <>
      <FilterBarShell searchLabel="Buscar en la biblioteca" filters={["Tipo"]} />
      {canIncorporate ? (
        <Tabs value="mas-usados">
          <TabsList aria-label="De dónde elegir">
            <TabsTrigger value="mas-usados">Más usados</TabsTrigger>
            <TabsTrigger value="biblioteca" disabled>Toda la biblioteca</TabsTrigger>
          </TabsList>
          <TabsContent value="mas-usados">
            <LibraryRowsSkeleton />
          </TabsContent>
        </Tabs>
      ) : (
        <LibraryRowsSkeleton canIncorporate={false} />
      )}
    </>
  )
}

function LibraryPage() {
  const can = useCan()
  const { canIncorporate, title, subtitle } = libraryHeading(can)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader title={title} subtitle={subtitle} primary={libraryPrimary(can)} />
      <LibraryBodySkeleton canIncorporate={canIncorporate} />
    </div>
  )
}

export function LibraryPageSkeleton() {
  return (
    <PageLoading title="Agregar servicios">
      <LibraryPage />
    </PageLoading>
  )
}

function PromotionGroup({ title, rows }: { title: string; rows: number }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <LabeledTableSkeleton
        rowCount={rows}
        columns={[
          { label: "Promoción", cell: <TextLines widths={["w-56", "w-72"]} /> },
          { label: "Vigencia", cell: <TextLine width="w-36" /> },
          { label: "Uso", cell: <TextLines widths={["w-20", "w-28"]} /> },
        ]}
        title={<TextLines widths={["w-52", "w-64"]} />}
        summary={
          <>
            <TextLine width="w-36" />
            <TextLine width="w-20" />
          </>
        }
      />
    </section>
  )
}

/** Las vigentes y las terminadas, cada una con su tabla. */
export function PromotionsListSkeleton() {
  return (
    <>
      <PromotionGroup title="Vigentes" rows={3} />
      <PromotionGroup title="Terminadas" rows={2} />
    </>
  )
}

function PromotionsPage() {
  const can = useCan()
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader title="Promociones" subtitle={<TextLine width="w-96" />} primary={promotionsPrimary(can)} />
      <PromotionsListSkeleton />
    </div>
  )
}

export function PromotionsPageSkeleton() {
  return (
    <PageLoading title="Promociones">
      <PromotionsPage />
    </PageLoading>
  )
}

const SECTIONS: SectionNavItem[] = [
  { label: "Servicios y precios", to: "/services", icon: Tag },
  { label: "Agregar servicios", to: "/services/biblioteca", icon: Library },
  { label: "Promociones", to: "/services/promotions", icon: BadgePercent },
]

/** Mientras llega el código del layout: el `PageShell`, el nav de sección y la página de la dirección. */
export function ServicesLayoutSkeleton() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <PageShell>
      <SectionNav label="Servicios y precios" items={SECTIONS} pathname={pathname} LinkComponent={RouterLink}>
        <PageLoading title="Servicios y precios">
          {pathname.endsWith("/biblioteca") ? <LibraryPage /> : pathname.endsWith("/promotions") ? <PromotionsPage /> : <ServicesListPage />}
        </PageLoading>
      </SectionNav>
    </PageShell>
  )
}
