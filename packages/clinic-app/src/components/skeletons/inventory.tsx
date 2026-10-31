/**
 * Los esqueletos de Inventario: Productos, Compras, Movimientos, Proveedores y
 * el conteo, con las mismas clases que cada pestaña. Las filas las usa la
 * pantalla real mientras espera; la pestaña entera, la ruta.
 */
import { ParamTabs } from "./param-tabs"
import { ScrollArea, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { ViewTabs } from "@odentia/ui-patterns"
import { useCan } from "../../lib/crm"
import { appWords } from "../../lib/product-words"
import { inventoryAccess, inventoryCountPrimary, inventoryCounting, inventoryHeader, purchaseViews } from "../../lib/screen-rules"
import { LabeledTableSkeleton, RowActionsSkeleton } from "./labeled-table"
import { FilterPill, SearchShell, TextLine, TextLines, useSearchValue } from "./list-bar"
import { PageLoading } from "./page-loading"

export type InventoryTab = "productos" | "compras" | "movimientos" | "proveedores"

/** `ViewTabs` no se elige mientras carga: la pestaña de arriba es la que manda. */
function noChange() {}

function Right({ width = "w-14" }: { width?: string }) {
  return (
    <div className="flex h-5 items-center justify-end">
      <Skeleton className={`h-3.5 ${width}`} />
    </div>
  )
}

function Chip({ width = "w-20" }: { width?: string }) {
  return <Skeleton className={`h-6 rounded-full ${width}`} />
}

/** Qué hay en la sede: producto, cuánto, mínimo, estado y su acción. */
export function ProductRowsSkeleton() {
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "Producto", cell: <TextLine width="w-48" /> },
        { label: "Hay", cell: <Right width="w-20" /> },
        { label: "Mínimo", cell: <Right width="w-8" /> },
        { label: "Estado", cell: <Chip /> },
        {
          label: " ",
          cell: (
            <div className="flex justify-end">
              <RowActionsSkeleton />
            </div>
          ),
        },
      ]}
      title={<TextLine width="w-44" height="h-11" />}
      summary={
        <>
          <TextLine width="w-20" />
          <TextLine width="w-12" />
          <Chip />
        </>
      }
    />
  )
}

/** Lo que falta que llegue y lo que falta pagar. */
export function PurchaseRowsSkeleton({ prices = true }: { prices?: boolean }) {
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "Compra", cell: <TextLines widths={["w-52", "w-36"]} /> },
        { label: "Llegó", cell: <Chip /> },
        ...(prices ? [{ label: "Pago", cell: <Chip width="w-24" /> }] : []),
      ]}
      title={<TextLines widths={["w-52", "w-36"]} />}
      summary={
        <>
          <Chip />
          {prices ? <Chip width="w-24" /> : null}
        </>
      }
    />
  )
}

/** Lo que entra y sale: cuándo, qué producto, qué pasó, cuánto y quién. */
export function MovementRowsSkeleton() {
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "Cuándo", cell: <TextLine width="w-28" /> },
        { label: "Producto", cell: <TextLine width="w-40" /> },
        { label: "Qué pasó", cell: <TextLine width="w-52" /> },
        { label: "Cantidad", cell: <Right width="w-12" /> },
        { label: "Quién", cell: <TextLine width="w-24" /> },
      ]}
      title={<TextLine width="w-44" height="h-11" />}
      summary={
        <>
          <TextLine width="w-28" />
          <TextLine width="w-40" />
          <TextLine width="w-12" />
        </>
      }
    />
  )
}

/** Quién es, cuántas compras y su saldo. */
export function SupplierRowsSkeleton({ prices = true, write = true }: { prices?: boolean; write?: boolean }) {
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "Proveedor", cell: <TextLines widths={["w-44", "w-56"]} /> },
        { label: "Compras", cell: <TextLine width="w-8" /> },
        ...(prices ? [{ label: "Saldo", cell: <Chip width="w-24" /> }] : []),
        ...(write
          ? [
              {
                label: " ",
                cell: (
                  <div className="flex justify-end">
                    <RowActionsSkeleton />
                  </div>
                ),
              },
            ]
          : []),
      ]}
      title={<TextLines widths={["w-44", "w-56"]} />}
      summary={
        <>
          <TextLine width="w-20" />
          {prices ? <Chip width="w-24" /> : null}
        </>
      }
    />
  )
}

/** El conteo: lo que dice el sistema, lo contado y la diferencia. */
export function CountRowsSkeleton({ systemLabel }: { systemLabel: string }) {
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "Producto", cell: <TextLine width="w-48" /> },
        { label: systemLabel, cell: <Right width="w-20" /> },
        {
          label: "Contaste",
          cell: (
            <div className="flex justify-end">
              <Skeleton className="h-9 w-32" />
            </div>
          ),
        },
        { label: "Diferencia", cell: <Right width="w-16" /> },
      ]}
      title={<TextLine width="w-44" />}
      summary={
        <>
          <TextLine width="w-28" />
          <Skeleton className="h-9 w-32" />
          <TextLine width="w-16" />
        </>
      }
    />
  )
}

const BAR = "flex flex-wrap items-center gap-2 rounded-md bg-card p-3"

function ProductsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className={BAR}>
        <SearchShell placeholder="Buscar en productos" />
        <ViewTabs
          label="Qué productos ver"
          value="todos"
          options={[
            { value: "todos", label: "Todos" },
            { value: "hacen_falta", label: "Hacen falta", disabled: true },
            { value: "por_vencer", label: "Por vencer", disabled: true },
          ]}
          onValueChange={noChange}
        />
      </div>
      <ProductRowsSkeleton />
    </div>
  )
}

function PurchasesSkeleton() {
  const access = inventoryAccess(useCan())
  return (
    <div className="flex flex-col gap-3">
      <div className={BAR}>
        <ViewTabs
          label="Qué compras ver"
          value="por_llegar"
          options={purchaseViews(access).map((option) => (option.value === "por_llegar" ? option : { ...option, disabled: true }))}
          onValueChange={noChange}
        />
      </div>
      <PurchaseRowsSkeleton prices={access.prices} />
    </div>
  )
}

function MovementsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className={BAR}>
        <SearchShell placeholder="Buscar en movimientos" />
        <FilterPill>Qué pasó: todo</FilterPill>
        <FilterPill>Últimos 30 días</FilterPill>
      </div>
      <MovementRowsSkeleton />
      <p className="text-xs text-muted-foreground">Los movimientos no se borran. Si algo quedó mal, se corrige con un ajuste que dice por qué.</p>
    </div>
  )
}

function SuppliersSkeleton() {
  const access = inventoryAccess(useCan())
  return (
    <div className="flex flex-col gap-3">
      <div className={BAR}>
        <SearchShell placeholder="Buscar en proveedores" />
      </div>
      <SupplierRowsSkeleton prices={access.prices} write={access.write} />
    </div>
  )
}

/** Pestañas fijas y la pestaña elegida. La pantalla lo usa también mientras llega la sede. */
export function InventoryBodySkeleton({ tab }: { tab: InventoryTab }) {
  return (
    <ParamTabs param="tab" fallback="productos" className="gap-4" value={tab}>
      <ScrollArea horizontal className="min-w-0 max-w-full">
        <TabsList aria-label="Secciones de Inventario">
          <TabsTrigger value="productos">Productos</TabsTrigger>
          <TabsTrigger value="compras">Compras</TabsTrigger>
          <TabsTrigger value="movimientos">Movimientos</TabsTrigger>
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
        </TabsList>
      </ScrollArea>
      <TabsContent value={tab}>
        {tab === "compras" ? <PurchasesSkeleton /> : tab === "movimientos" ? <MovementsSkeleton /> : tab === "proveedores" ? <SuppliersSkeleton /> : <ProductsSkeleton />}
      </TabsContent>
    </ParamTabs>
  )
}

/** Mientras llega el código de Inventario: la pestaña de la dirección, con su título y su sede. */
export function InventoryPageSkeleton() {
  const wanted = useSearchValue("tab")
  const tab: InventoryTab = wanted === "compras" || wanted === "movimientos" || wanted === "proveedores" ? wanted : wanted === "catalogos" ? "proveedores" : "productos"
  const access = inventoryAccess(useCan())
  const contar = useSearchValue("contar")
  if (inventoryCounting(contar, access)) {
    return (
      <PageLoading title="Contar lo que hay" primary={inventoryCountPrimary()}>
        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <TextLine width="w-32" />
          </div>
          <CountRowsSkeleton systemLabel={`${appWords().name} tiene`} />
        </div>
      </PageLoading>
    )
  }
  const header = inventoryHeader(tab, access)
  return (
    <PageLoading title="Inventario" primary={header.primary} menu={header.menu}>
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TextLine width="w-32" />
        </div>
        <InventoryBodySkeleton tab={tab} />
      </div>
    </PageLoading>
  )
}
