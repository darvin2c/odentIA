import {
  Button,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import { EmptyState, ErrorState, PageHeader, PageShell, SkeletonRegion, useListSearch } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { BranchSwitcher } from "../../components/branch-switcher"
import { CountView } from "../../components/inventory/count-view"
import {
  type InventoryOpeners,
  InventoryProvider,
  type InventoryScope,
  type PurchasePreset,
  type StockActionKind,
} from "../../components/inventory/inventory-scope"
import { MovementsTab } from "../../components/inventory/movements-tab"
import { PasteListDrawer } from "../../components/inventory/paste-list"
import { ProductFormDrawer } from "../../components/inventory/product-form"
import { ProductPanel } from "../../components/inventory/product-panel"
import { ProductsTab } from "../../components/inventory/products-tab"
import { PurchaseFormDrawer } from "../../components/inventory/purchase-form"
import { PurchasePanel } from "../../components/inventory/purchase-panel"
import { PurchasePaymentDrawer } from "../../components/inventory/purchase-payment-drawer"
import { PurchasesTab } from "../../components/inventory/purchases-tab"
import { ReceiveDrawer } from "../../components/inventory/receive-form"
import { StockActionDrawer } from "../../components/inventory/stock-actions"
import { SupplierFormDrawer } from "../../components/inventory/supplier-form"
import { SuppliersTab } from "../../components/inventory/suppliers-tab"
import { InventoryBodySkeleton, InventoryPageSkeleton } from "../../components/skeletons/inventory"
import { useActiveBranch } from "../../lib/active-branch"
import { apiFetch } from "../../lib/api"
import { useCan, usePermission } from "../../lib/crm"
import { inventoryAccess, inventoryCounting, inventoryHeader } from "../../lib/screen-rules"
import { hasPrices, type ProductDetail, type PurchaseOrderDetail, type PurchaseOrderView, type SupplierItem } from "../../lib/inventory"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { useOrgProfile } from "../../lib/org"

/**
 * Inventario por sede (ADR 0067; lienzo de Inventario, tableros 2 a 16 y 20).
 * Productos · Compras · Movimientos · Proveedores, con la sede bajo el título.
 * Todo vive en la dirección: la pestaña (`tab`), la sede (`branch`), el filtro
 * (`ver`), la búsqueda (`q`), el producto (`producto`) y la compra (`orden`)
 * abiertos al lado y el conteo (`contar=si`; un «1» el router lo guarda entre comillas). Inicio y los avisos llevan aquí
 * con esos mismos datos.
 */
interface InventorySearch {
  tab?: string
  branch?: string
  q?: string
  /** Productos: `hacen_falta` | `por_vencer`. Compras: `por_llegar` | `por_pagar` | `borradores` | `todas`. */
  ver?: string
  /** Enlaces anteriores de Finanzas y Reportes: `pago=por_pagar`. */
  pago?: string
  producto?: string
  orden?: string
  contar?: string
  proveedor?: string
  productoId?: string
  tipo?: string
  periodo?: string
}

const SEARCH_KEYS: Array<keyof InventorySearch> = ["tab", "branch", "q", "ver", "pago", "producto", "orden", "contar", "proveedor", "productoId", "tipo", "periodo"]

export const Route = createFileRoute("/_org/inventory")({
  /** La pantalla los lee con `useListSearch`; aquí solo se tipan para los enlaces. */
  validateSearch: (search: Record<string, unknown>): InventorySearch => {
    const out: Record<string, unknown> = { ...search }
    for (const key of SEARCH_KEYS) {
      const value = search[key]
      out[key] = typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined
    }
    return out as InventorySearch
  },
  pendingComponent: InventoryPageSkeleton,
  component: InventoryPage,
})

type Tab = "productos" | "compras" | "movimientos" | "proveedores"

/** La pestaña de la dirección; las de antes («catalogos», «alertas») abren su sitio nuevo. */
function tabOf(value: string | undefined): Tab {
  if (value === "compras" || value === "movimientos" || value === "proveedores") return value
  if (value === "catalogos") return "proveedores"
  return "productos"
}

function InventoryPage() {
  const canRead = usePermission("inventory.read")
  const canStock = usePermission("inventory.stock")
  if (!canRead && !canStock) {
    return (
      <PageShell className="flex flex-col gap-4">
        <PageHeader title="Inventario" />
        <EmptyState title="Sin acceso a inventario" description="Tu rol no ve el inventario de la clínica. Pídeselo a quien la administra." />
      </PageShell>
    )
  }
  return <InventoryWorkspace />
}

function InventoryWorkspace() {
  const access = inventoryAccess(useCan())
  const { prices: canPrices, write: canWrite, receive: canReceive } = access
  const canPay = usePermission("finance.write")
  const canFinance = usePermission("finance.read")
  const canClinical = usePermission("clinical.read")
  const canPeople = usePermission("patients.read")
  const canSettings = usePermission("settings.write")
  const navigate = useNavigate()
  const { get, setParams } = useListSearch()
  const sede = useActiveBranch()
  // La misma consulta de `useActiveBranch`: aquí solo se mira si ya llegó.
  const branchesQuery = useQuery({
    queryKey: ["branches", "activas"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string; isActive: boolean }> }>("/api/branches"),
    staleTime: 60_000,
  })
  const profile = useOrgProfile()
  const branchId = sede.branchId ?? sede.branches[0]?.id ?? ""
  const branchName = sede.branches.find((item) => item.id === branchId)?.name ?? ""
  const tab = tabOf(get("tab"))
  const counting = inventoryCounting(get("contar"), access)

  const [productForm, setProductForm] = React.useState<{ product: ProductDetail | null; seq: number } | null>(null)
  // Lo que se abre al lado queda en la sede donde se abrió: cambiar de sede en la página no lo mueve.
  type SedeAtOpen = { id: string; name: string }
  const [action, setAction] = React.useState<{ kind: StockActionKind; preset: { productId?: string; lotId?: string }; seq: number; sede: SedeAtOpen } | null>(null)
  const [purchase, setPurchase] = React.useState<{ preset?: PurchasePreset; order?: PurchaseOrderView; seq: number; sede: SedeAtOpen } | null>(null)
  const [receiving, setReceiving] = React.useState<string | null>(null)
  const [pasting, setPasting] = React.useState<SedeAtOpen | null>(null)
  const [supplierForm, setSupplierForm] = React.useState<{ supplier: SupplierItem | null; onSaved?: (saved: SupplierItem) => void; seq: number } | null>(null)
  const [paying, setPaying] = React.useState<PurchaseOrderDetail | null>(null)
  const seq = React.useRef(0)
  const sedeNow = React.useRef<SedeAtOpen>({ id: "", name: "" })
  const nextSeq = React.useCallback(() => {
    seq.current += 1
    return seq.current
  }, [])

  const open = React.useMemo<InventoryOpeners>(
    () => ({
      product: (id) => setParams({ producto: id, orden: undefined }),
      order: (id) => setParams({ orden: id, producto: undefined }),
      productForm: (product) => setProductForm({ product: product ?? null, seq: nextSeq() }),
      action: (kind, preset) => setAction({ kind, preset: preset ?? {}, seq: nextSeq(), sede: sedeNow.current }),
      purchase: (preset) => setPurchase({ preset, seq: nextSeq(), sede: sedeNow.current }),
      editPurchase: (order) => setPurchase({ order, seq: nextSeq(), sede: sedeNow.current }),
      receive: (orderId) => setReceiving(orderId),
      paste: () => setPasting(sedeNow.current),
      supplier: (supplier, onSaved) => setSupplierForm({ supplier: supplier ?? null, onSaved, seq: nextSeq() }),
      movementsOf: (productId) =>
        setParams({ tab: "movimientos", productoId: productId, periodo: "todo", producto: undefined, orden: undefined, q: undefined, tipo: undefined, ver: undefined }),
      ordersOf: (supplierId, view) =>
        setParams({ tab: "compras", proveedor: supplierId, ver: view ?? "todas", pago: undefined, q: undefined, producto: undefined, orden: undefined }),
      count: () => setParams({ contar: "si", q: undefined, ver: undefined, producto: undefined, orden: undefined }),
    }),
    [setParams, nextSeq],
  )

  sedeNow.current = { id: branchId, name: branchName }
  const prof = profile.data ?? null
  const scope: InventoryScope = {
    branchId,
    branchName,
    branches: sede.branches,
    locale: prof?.locale ?? activeOrgLocale() ?? "es",
    currency: prof?.currency ?? null,
    timeZone: prof?.timezone ?? activeOrgTimeZone(),
    clinicName: prof?.tradeName ?? "",
    can: { prices: canPrices, receive: canReceive, write: canWrite, pay: canPay, finance: canFinance, clinical: canClinical, people: canPeople },
    open,
  }

  const subtitle =
    sede.branches.length > 0 && branchId ? (
      <BranchSwitcher branches={sede.branches} value={branchId} fallbackName={sede.branches[0]?.name ?? ""} onChange={(id) => sede.choose(id, { producto: undefined, orden: undefined })} />
    ) : undefined

  if (!branchId) {
    return (
      <PageShell className="flex flex-col gap-4">
        {/* La acción de la pestaña sigue a la vista, deshabilitada, mientras llega la sede: no aparece, se va y vuelve. */}
        <PageHeader title="Inventario" {...(branchesQuery.isPending ? inventoryHeader(tab, access) : {})} />
        {branchesQuery.isError ? (
          <ErrorState
            title="No pudimos cargar las sedes"
            message="Comprueba tu conexión y vuelve a intentarlo."
            onRetry={() => void branchesQuery.refetch()}
          />
        ) : branchesQuery.isPending ? (
          <SkeletonRegion message="Cargando la sede…">
            <InventoryBodySkeleton tab={tab} />
          </SkeletonRegion>
        ) : (
          <EmptyState
            title="Aún no hay sedes activas"
            description={
              canSettings
                ? "El inventario es de cada sede: hace falta al menos una."
                : "El inventario es de cada sede: hace falta al menos una. Pídesela a quien administra la clínica."
            }
            {...(canSettings ? { actionLabel: "Ir a Sedes", onAction: () => void navigate({ to: "/settings/branches" }) } : {})}
          />
        )}
      </PageShell>
    )
  }

  // Lo que la pestaña de Productos ofrece aparte de su acción principal va al menú ⋯.
  // La acción principal es crear lo que cada pestaña lista (producto, compra o proveedor).
  const { primary: headerPrimary, menu } = inventoryHeader(tab, access, {
    manyBranches: sede.branches.length > 1,
    run: {
      product: () => open.productForm(),
      purchase: () => open.purchase(),
      supplier: () => open.supplier(),
      count: open.count,
      adjust: () => open.action("ajustar"),
      transfer: () => open.action("trasladar"),
      use: () => open.action("uso"),
      add: () => open.action("agregar"),
      paste: open.paste,
    },
  })

  return (
    <InventoryProvider value={scope}>
      <PageShell className="flex flex-col gap-4">
        {counting ? (
          <CountView key={branchId} subtitle={subtitle} onExit={() => setParams({ contar: undefined, q: undefined }, { replace: true })} />
        ) : (
          <>
            <PageHeader
              title="Inventario"
              subtitle={subtitle}
              primary={headerPrimary}
              menu={menu}
            />
            {profile.isError && !profile.data ? (
              // Sin el perfil no se sabe la moneda: no se confunde con «configura la moneda».
              <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                No pudimos cargar los datos de la clínica (moneda y zona horaria).
                <Button type="button" size="sm" variant="outline" onClick={() => void profile.refetch()}>
                  Reintentar
                </Button>
              </p>
            ) : null}
            <Tabs
              className="gap-4"
              value={tab}
              onValueChange={(value) => {
                const next = tabOf(String(value))
                setParams({
                  tab: next === "productos" ? undefined : next,
                  q: undefined,
                  ver: undefined,
                  pago: undefined,
                  tipo: undefined,
                  periodo: undefined,
                  productoId: undefined,
                  proveedor: undefined,
                })
              }}
            >
              <ScrollArea horizontal className="min-w-0 max-w-full">
                <TabsList aria-label="Secciones de Inventario">
                  <TabsTrigger value="productos">Productos</TabsTrigger>
                  <TabsTrigger value="compras">Compras</TabsTrigger>
                  <TabsTrigger value="movimientos">Movimientos</TabsTrigger>
                  <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
                </TabsList>
              </ScrollArea>
              <TabsContent value={tab}>
                {tab === "productos" ? <ProductsTab key={branchId} /> : null}
                {tab === "compras" ? <PurchasesTab key={branchId} /> : null}
                {tab === "movimientos" ? <MovementsTab key={branchId} /> : null}
                {tab === "proveedores" ? <SuppliersTab /> : null}
              </TabsContent>
            </Tabs>
          </>
        )}

        <ProductPanel productId={get("producto") ?? null} onClose={() => setParams({ producto: undefined })} />
        <PurchasePanel orderId={get("orden") ?? null} onClose={() => setParams({ orden: undefined })} />

        {productForm ? (
          <ProductFormDrawer
            key={productForm.seq}
            product={productForm.product}
            onClose={() => setProductForm(null)}
            onSaved={(id) => {
              const isNew = productForm.product === null
              setProductForm(null)
              if (isNew) open.product(id)
            }}
          />
        ) : null}
        {action ? (
          <InventoryProvider value={{ ...scope, branchId: action.sede.id || branchId, branchName: action.sede.name || branchName }}>
            <StockActionDrawer key={action.seq} kind={action.kind} preset={action.preset} onClose={() => setAction(null)} />
          </InventoryProvider>
        ) : null}
        {purchase ? (
          <InventoryProvider value={{ ...scope, branchId: purchase.sede.id || branchId, branchName: purchase.sede.name || branchName }}>
            <PurchaseFormDrawer
              key={purchase.seq}
              preset={purchase.preset}
              order={purchase.order}
              onClose={() => setPurchase(null)}
              onSaved={(order, pay) => {
                setPurchase(null)
                open.order(order.id)
                if (pay && hasPrices(order)) setPaying(order)
              }}
            />
          </InventoryProvider>
        ) : null}
        {receiving ? <ReceiveDrawer key={receiving} orderId={receiving} onClose={() => setReceiving(null)} /> : null}
        {pasting ? (
          <InventoryProvider value={{ ...scope, branchId: pasting.id || branchId, branchName: pasting.name || branchName }}>
            <PasteListDrawer onClose={() => setPasting(null)} />
          </InventoryProvider>
        ) : null}
        {supplierForm ? (
          <SupplierFormDrawer key={supplierForm.seq} supplier={supplierForm.supplier} onSaved={supplierForm.onSaved} onClose={() => setSupplierForm(null)} />
        ) : null}
        {paying ? <PurchasePaymentDrawer order={paying} locale={scope.locale} timeZone={scope.timeZone} open onClose={() => setPaying(null)} /> : null}
      </PageShell>
    </InventoryProvider>
  )
}
