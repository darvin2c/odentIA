import { Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, toast } from "@odentia/ui"
import { DataTable, DatePickerButton, EmptyState, ErrorState, FilterBar, type FilterDef, FormDrawer, LoadingState, PageHeader, PageShell, RowActions, type RowActionItem, useListSearch } from "@odentia/ui-patterns"
import { formatMoneyInput, parseMoney } from "@odentia/clinical"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { AlertTriangle, Package, Plus } from "lucide-react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import * as React from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { MOVEMENT_KIND_LABELS, ORDER_STATUS_LABELS, type InventoryAlerts, type InventoryProduct, type PurchaseOrderDetail, type PurchaseOrderItem, type StockMovementItem, type SupplierItem, type WarehouseItem } from "../../lib/inventory"
import { useOrgProfile } from "../../lib/org"
import { isAmbiguousMutationError, mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { usePageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/inventory")({
  component: InventoryPage,
})

type Tab = "productos" | "compras" | "movimientos" | "catalogos" | "alertas"

function errorMessage(error: unknown): string {
  return mutationErrorMessage(error) ?? "No se guardaron los cambios. Revisa los campos antes de continuar."
}

function InventoryPage() {
  const canRead = usePermission("inventory.read")
  const canWrite = usePermission("inventory.write")
  const queryClient = useQueryClient()
  const { get } = useListSearch()
  const [tab, setTab] = React.useState<Tab>("productos")
  const [drawer, setDrawer] = React.useState<"product" | "order" | "movement" | "supplier" | "warehouse" | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [receptionDirty, setReceptionDirty] = React.useState(false)
  const draftGuard = usePageDraftGuard(receptionDirty)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["inventory"] })
  }

  if (!canRead) {
    return (
      <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
        <ErrorState title="Sin acceso" message="Tu rol no tiene permiso de lectura de inventario. Solicita acceso a la administración." />
      </PageShell>
    )
  }

  return (
    <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
      {draftGuard.dialog}
      <PageHeader
        title="Inventario"
        subtitle="Productos, compras con recepción parcial, movimientos y alertas por sede."
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              {tab === "productos" && (
                <Button size="sm" onClick={() => { setFormError(null); setDrawer("product") }}>
                  <Plus className="mr-1 h-4 w-4" /> Producto
                </Button>
              )}
              {tab === "compras" && (
                <Button size="sm" onClick={() => { setFormError(null); setDrawer("order") }}>
                  <Plus className="mr-1 h-4 w-4" /> Orden de compra
                </Button>
              )}
              {tab === "movimientos" && (
                <Button size="sm" onClick={() => { setFormError(null); setDrawer("movement") }}>
                  <Plus className="mr-1 h-4 w-4" /> Movimiento
                </Button>
              )}
              {tab === "catalogos" && (
                <>
                  <Button size="sm" variant="outline" onClick={() => { setFormError(null); setDrawer("supplier") }}>
                    <Plus className="mr-1 h-4 w-4" /> Proveedor
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setFormError(null); setDrawer("warehouse") }}>
                    <Plus className="mr-1 h-4 w-4" /> Almacén
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="flex gap-1 border-b" role="tablist" aria-label="Secciones de inventario">
        {(["productos", "compras", "movimientos", "catalogos", "alertas"] as Tab[]).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              if (tab !== value) draftGuard.requestLeave(() => setTab(value))
            }}
            className={`px-3 pb-2 text-sm capitalize ${tab === value ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
          >
            {value === "catalogos" ? "catálogos" : value}
          </button>
        ))}
      </div>

      {tab === "productos" && <ProductsSection search={get("q") ?? ""} lowStock={get("lowStock") ?? null} kind={get("kind") ?? null} />}
      {tab === "compras" && <OrdersSection status={get("status") ?? null} canWrite={canWrite} onDirtyChange={setReceptionDirty} requestLeave={draftGuard.requestLeave} />}
      {tab === "movimientos" && <MovementsSection kind={get("kind") ?? null} />}
      {tab === "catalogos" && <CatalogsSection canWrite={canWrite} />}
      {tab === "alertas" && <AlertsSection />}

      {drawer === "product" && (
        <ProductFormDrawer formError={formError} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); invalidate() }} onError={setFormError} />
      )}
      {drawer === "order" && (
        <OrderFormDrawer formError={formError} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); invalidate() }} onError={setFormError} />
      )}
      {drawer === "movement" && (
        <MovementFormDrawer formError={formError} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); invalidate() }} onError={setFormError} />
      )}
      {drawer === "supplier" && (
        <SupplierFormDrawer formError={formError} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); invalidate() }} onError={setFormError} />
      )}
      {drawer === "warehouse" && (
        <WarehouseFormDrawer formError={formError} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); invalidate() }} onError={setFormError} />
      )}
    </PageShell>
  )
}

/* ---------------- productos ---------------- */

function ProductsSection({ search, lowStock, kind }: { search: string; lowStock: string | null; kind: string | null }) {
  const filters: FilterDef[] = React.useMemo(
    () => [
      {
        key: "kind",
        label: "Tipo",
        type: "select",
        options: [
          { value: "insumo", label: "Insumos" },
          { value: "producto", label: "Productos" },
        ],
      },
      {
        key: "lowStock",
        label: "Stock",
        type: "select",
        options: [{ value: "true", label: "Solo stock bajo" }],
      },
    ],
    [],
  )
  const query = useQuery({
    retry: false,
    queryKey: ["inventory", "products", search, lowStock, kind],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search.trim()) params.set("q", search.trim())
      if (lowStock) params.set("lowStock", lowStock)
      if (kind) params.set("kind", kind)
      const suffix = params.size ? `?${params}` : ""
      return apiFetch<{ data: InventoryProduct[] }>(`/api/inventory/products${suffix}`)
    },
  })
  const rows = query.data?.data ?? []
  const columns = React.useMemo<ColumnDef<InventoryProduct>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Producto",
        cell: ({ row }) => (
          <Link to="/inventory/$productId" params={{ productId: row.original.id }} className="font-medium hover:underline">
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "sku",
        header: "SKU",
        cell: ({ row }) => row.original.sku,
      },
      {
        accessorKey: "onHand",
        header: "Saldo",
        cell: ({ row }) => `${row.original.onHand} ${row.original.unit} (mín. ${row.original.minStock})`,
      },
      {
        id: "estado",
        header: "Estado",
        cell: ({ row }) =>
          row.original.lowStock ? (
            <Badge variant="destructive">
              <AlertTriangle className="mr-1 h-3 w-3" /> Bajo mínimo
            </Badge>
          ) : null,
      },
    ],
    [],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <div className="flex flex-col gap-3">
      <FilterBar filters={filters} sortOptions={[]} searchPlaceholder="Buscar por nombre o SKU…" resetKeys={["kind", "lowStock"]} />
      {query.isPending ? (
        <LoadingState message="Cargando productos…" />
      ) : query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => { void query.refetch() }} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Package} title={search || lowStock || kind ? "Sin resultados" : "Sin productos"} description={search || lowStock || kind ? "Prueba otros filtros para encontrar productos." : "Crea el primero con el botón Producto."} />
      ) : (
        <DataTable table={table} />
      )}
    </div>
  )
}

function ProductFormDrawer({ formError, onClose, onDone, onError }: { formError: string | null; onClose: () => void; onDone: () => void; onError: (message: string | null) => void }) {
  const mutation = useMutation({
    retry: false,
    mutationFn: (values: Record<string, unknown>) =>
      apiFetch("/api/inventory/products", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => { onError(null); toast.success("Producto creado"); onDone() },
    onError: (error) => onError(errorMessage(error)),
  })
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || isAmbiguousMutationError(mutation.error)) return
    const form = new FormData(event.currentTarget as HTMLFormElement)
    mutation.mutate({
      sku: String(form.get("sku") ?? ""),
      name: String(form.get("name") ?? ""),
      kind: String(form.get("kind") ?? "insumo"),
      unit: String(form.get("unit") ?? "unidad"),
      minStock: Number(form.get("minStock") ?? 0),
    })
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Nuevo producto"
      description="La unidad se declara tal cual; el sistema no convierte unidades."
      error={formError}
      isSubmitting={mutation.isPending}
      submitDisabled={isAmbiguousMutationError(mutation.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      onSubmit={handleSubmit}
    >
      <div><Label htmlFor="inv-sku">SKU</Label><Input id="inv-sku" name="sku" required maxLength={60} /></div>
      <div><Label htmlFor="inv-name">Nombre</Label><Input id="inv-name" name="name" required maxLength={200} /></div>
      <div>
        <Label htmlFor="inv-kind">Tipo</Label>
        <Select name="kind" defaultValue="insumo">
          <SelectTrigger id="inv-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="insumo">Insumo</SelectItem>
            <SelectItem value="producto">Producto</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div><Label htmlFor="inv-unit">Unidad declarada</Label><Input id="inv-unit" name="unit" defaultValue="unidad" required maxLength={60} /></div>
      <div><Label htmlFor="inv-min">Stock mínimo</Label><Input id="inv-min" name="minStock" type="number" min={0} defaultValue={0} /></div>
    </FormDrawer>
  )
}

/* ---------------- compras ---------------- */

function OrdersSection({ status, canWrite, onDirtyChange, requestLeave }: {
  status: string | null
  canWrite: boolean
  onDirtyChange: (dirty: boolean) => void
  requestLeave: (action: () => void) => void
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const filters: FilterDef[] = React.useMemo(
    () => [
      {
        key: "status",
        label: "Estado",
        type: "select",
        options: Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label })),
      },
    ],
    [],
  )
  const query = useQuery({
    retry: false,
    queryKey: ["inventory", "orders", status],
    queryFn: () => {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : ""
      return apiFetch<{ data: PurchaseOrderItem[] }>(`/api/inventory/purchase-orders${suffix}`)
    },
  })
  const confirm = useMutation({
    retry: false,
    mutationFn: (id: string) => apiFetch(`/api/inventory/purchase-orders/${id}/confirm`, { method: "POST" }),
    onSuccess: () => { toast.success("Orden confirmada"); void queryClient.invalidateQueries({ queryKey: ["inventory"] }) },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const cancel = useMutation({
    retry: false,
    mutationFn: (id: string) => apiFetch(`/api/inventory/purchase-orders/${id}/cancel`, { method: "POST" }),
    onSuccess: () => { toast.success("Orden cancelada"); void queryClient.invalidateQueries({ queryKey: ["inventory"] }) },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const rows = query.data?.data ?? []
  const columns = React.useMemo<ColumnDef<PurchaseOrderItem>[]>(
    () => [
      {
        accessorKey: "supplierName",
        header: "Proveedor",
        cell: ({ row }) => (
          <button
            type="button"
            className="text-left font-medium hover:underline"
            onClick={() => requestLeave(() => setExpanded((current) => (current === row.original.id ? null : row.original.id)))}
            aria-expanded={expanded === row.original.id}
          >
            {row.original.supplierName ?? "Proveedor"}
          </button>
        ),
      },
      {
        accessorKey: "warehouseName",
        header: "Almacén",
        cell: ({ row }) => row.original.warehouseName ?? row.original.warehouseId,
      },
      {
        accessorKey: "status",
        header: "Estado",
        cell: ({ row }) => <Badge>{ORDER_STATUS_LABELS[row.original.status] ?? row.original.status}</Badge>,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const order = row.original
          const items: RowActionItem[] = [
            {
              key: "detalle",
              label: expanded === order.id ? "Ocultar detalle" : "Ver detalle",
              onSelect: () => requestLeave(() => setExpanded((current) => (current === order.id ? null : order.id))),
            },
          ]
          if (canWrite && order.status === "borrador") {
            items.push({
              key: "confirmar",
              label: "Confirmar",
              disabled: confirm.isPending || cancel.isPending || isAmbiguousMutationError(confirm.error) || isAmbiguousMutationError(cancel.error),
              onSelect: () => confirm.mutate(order.id),
            })
          }
          if (canWrite && (order.status === "borrador" || order.status === "confirmada")) {
            items.push({
              key: "cancelar",
              label: "Cancelar",
              tone: "danger",
              disabled: confirm.isPending || cancel.isPending || isAmbiguousMutationError(confirm.error) || isAmbiguousMutationError(cancel.error),
              onSelect: () => requestLeave(() => {
                setExpanded(null)
                cancel.mutate(order.id)
              }),
            })
          }
          return (
            <div className="text-right">
              <RowActions label={`Acciones de la orden de ${order.supplierName ?? "Proveedor"}`} items={items} />
            </div>
          )
        },
      },
    ],
    [canWrite, cancel, confirm, expanded, requestLeave],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <div className="flex flex-col gap-3">
      <FilterBar filters={filters} sortOptions={[]} showSearch={false} resetKeys={["status"]} />
      {confirm.isError || cancel.isError ? <ErrorState title="No pudimos confirmar la operación" message={errorMessage(confirm.error ?? cancel.error)} onRetry={() => { void query.refetch().then(result => { if (result.isSuccess) { confirm.reset(); cancel.reset() } }) }} retryLabel="Consultar estado actual" /> : null}
      {query.isPending ? (
        <LoadingState message="Cargando órdenes…" />
      ) : query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => { void query.refetch() }} />
      ) : rows.length === 0 ? (
        <EmptyState title={status ? "Sin resultados" : "Sin órdenes de compra"} description={status ? "Prueba otro estado para encontrar órdenes." : "Registra la primera con el botón Orden de compra."} />
      ) : (
        <DataTable table={table} />
      )}
      {expanded && <OrderDetail key={expanded} orderId={expanded} canWrite={canWrite} onDirtyChange={onDirtyChange} />}
      <p className="text-xs text-muted-foreground">
        Las órdenes registran compromiso comercial referencial; nunca equivalen a un pago ni tocan caja.
      </p>
    </div>
  )
}

function OrderDetail({ orderId, canWrite, onDirtyChange }: {
  orderId: string
  canWrite: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [receiveError, setReceiveError] = React.useState<string | null>(null)
  // Clave UUID por recepción: persiste a reintentos hasta el éxito y rota
  // después, para que dos entregas idénticas legítimas nunca se confundan.
  const [receptionKey, setReceptionKey] = React.useState(() => crypto.randomUUID())
  const [draft, setDraft] = React.useState<Record<string, { quantity: string; lotCode: string; expiresAt: string }>>({})
  const dirty = Object.values(draft).some((line) => Number(line.quantity) !== 0 || line.lotCode !== "" || line.expiresAt !== "")
  React.useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  function setLine(productId: string, field: "quantity" | "lotCode" | "expiresAt", value: string) {
    setDraft((current) => ({
      ...current,
      [productId]: { ...(current[productId] ?? { quantity: "0", lotCode: "", expiresAt: "" }), [field]: value },
    }))
  }
  const detailQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "order", orderId],
    queryFn: () => apiFetch<{ data: PurchaseOrderDetail }>(`/api/inventory/purchase-orders/${orderId}`),
  })
  const receive = useMutation({
    retry: false,
    mutationFn: (lines: Array<{ productId: string; quantity: number; lotCode?: string | null; expiresAt?: string | null }>) =>
      apiFetch(`/api/inventory/purchase-orders/${orderId}/receive`, {
        method: "POST",
        body: JSON.stringify({ lines, idempotencyKey: receptionKey }),
      }),
    onSuccess: () => {
      setReceiveError(null)
      setReceptionKey(crypto.randomUUID())
      setDraft({})
      toast.success("Recepción registrada: lotes y saldos actualizados")
      void queryClient.invalidateQueries({ queryKey: ["inventory"] })
    },
    onError: (error) => setReceiveError(errorMessage(error)),
  })
  const detail = detailQuery.data?.data
  if (detailQuery.isPending) return <LoadingState message="Cargando detalle…" />
  if (detailQuery.isError || !detail) return <QueryErrorState error={detailQuery.error} onRetry={() => { void detailQuery.refetch() }} notFound="La orden de compra ya no está disponible." />
  const pending = detail.lines.filter((line) => line.receivedQuantity < line.quantity)
  function handleReceive(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (receive.isPending || isAmbiguousMutationError(receive.error)) return
    const lines = pending
      .map((line) => ({
        productId: line.productId,
        quantity: Number(draft[line.productId]?.quantity ?? 0),
        lotCode: draft[line.productId]?.lotCode.trim() || null,
        expiresAt: draft[line.productId]?.expiresAt || null,
      }))
      .filter((line) => line.quantity > 0)
    if (lines.length === 0) {
      setReceiveError("Indica una cantidad positiva en al menos una línea.")
      return
    }
    receive.mutate(lines)
  }
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md bg-muted/40 p-3">
      <ul className="flex flex-col gap-1 text-sm">
        {detail.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap justify-between gap-2">
            <span>{line.productName ?? line.productId} <span className="text-muted-foreground">({line.productUnit ?? ""})</span></span>
            <span>recibido {line.receivedQuantity} de {line.quantity}</span>
          </li>
        ))}
      </ul>
      {canWrite && (detail.status === "confirmada" || detail.status === "parcialmente_recibida") && pending.length > 0 && (
        <form onSubmit={handleReceive} className="flex flex-col gap-2">
          <fieldset disabled={receive.isPending} className="contents">
          <h3 className="text-sm font-semibold">Recepción parcial (crea lotes con vencimiento)</h3>
          {receiveError && <p className="text-sm text-destructive" role="alert">{receiveError}</p>}
          {pending.map((line) => (
            <div key={line.productId} className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="col-span-2 md:col-span-1">
                <Label htmlFor={`qty-${line.productId}`}>{line.productSku ?? line.productName} (faltan {line.quantity - line.receivedQuantity})</Label>
                <Input id={`qty-${line.productId}`} name={`qty-${line.productId}`} type="number" min={0} max={line.quantity - line.receivedQuantity} value={draft[line.productId]?.quantity ?? "0"} onChange={(event) => setLine(line.productId, "quantity", event.target.value)} />
              </div>
              <div>
                <Label htmlFor={`lot-${line.productId}`}>Código de lote</Label>
                <Input id={`lot-${line.productId}`} name={`lot-${line.productId}`} maxLength={120} placeholder="Opcional" value={draft[line.productId]?.lotCode ?? ""} onChange={(event) => setLine(line.productId, "lotCode", event.target.value)} />
              </div>
              <div>
                <Label htmlFor={`exp-${line.productId}`}>Vence</Label>
                <DatePickerButton id={`exp-${line.productId}`} className="w-full" value={draft[line.productId]?.expiresAt ?? ""} emptyLabel="Sin vencimiento" onChange={(next) => setLine(line.productId, "expiresAt", next)} />
              </div>
            </div>
          ))}
          <Button size="sm" type="submit" disabled={receive.isPending || isAmbiguousMutationError(receive.error)} className="w-fit">
            Registrar recepción
          </Button>
          </fieldset>
        </form>
      )}
    </div>
  )
}

function OrderFormDrawer({ formError, onClose, onDone, onError }: { formError: string | null; onClose: () => void; onDone: () => void; onError: (message: string | null) => void }) {
  const suppliersQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "suppliers", "active"],
    queryFn: () => apiFetch<{ data: SupplierItem[] }>("/api/inventory/suppliers?onlyActive=true"),
  })
  const warehousesQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "warehouses", "active"],
    queryFn: () => apiFetch<{ data: WarehouseItem[] }>("/api/inventory/warehouses?onlyActive=true"),
  })
  const productsQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "products", "active"],
    queryFn: () => apiFetch<{ data: InventoryProduct[] }>("/api/inventory/products?onlyActive=true"),
  })
  const mutation = useMutation({
    retry: false,
    mutationFn: (values: Record<string, unknown>) =>
      apiFetch("/api/inventory/purchase-orders", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => { onError(null); toast.success("Orden creada en borrador"); onDone() },
    onError: (error) => onError(errorMessage(error)),
  })
  // La orden nace en la moneda de la clínica: el costo se escribe y se lee con
  // sus decimales (ISO 4217) y con el formato de la clínica, no siempre con dos.
  const profile = useOrgProfile().data
  const currency = profile?.currency
  const locale = profile?.locale
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || isAmbiguousMutationError(mutation.error)) return
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const productId = String(form.get("productId") ?? "")
    const quantity = Number(form.get("quantity") ?? 0)
    if (!productId || !(quantity > 0)) {
      onError("Elige un producto y una cantidad positiva.")
      return
    }
    const costText = String(form.get("unitCost") ?? "").trim()
    let unitCost = 0
    if (costText) {
      if (!currency || !locale) {
        onError("Configura el país y la moneda de la clínica antes de registrar importes.")
        return
      }
      try {
        unitCost = parseMoney(costText, currency, locale)
      } catch (error) {
        onError(error instanceof Error ? `${error.message} (costo unitario).` : "El costo unitario no es un importe válido.")
        return
      }
    }
    mutation.mutate({
      supplierId: String(form.get("supplierId") ?? ""),
      warehouseId: String(form.get("warehouseId") ?? ""),
      notes: String(form.get("notes") ?? "") || null,
      lines: [{ productId, quantity, unitCostCents: unitCost }],
    })
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Nueva orden de compra"
      description="La orden registra el compromiso comercial: no equivale a un pago."
      error={formError}
      isSubmitting={mutation.isPending}
      submitDisabled={isAmbiguousMutationError(mutation.error) || !suppliersQuery.isSuccess || !warehousesQuery.isSuccess || !productsQuery.isSuccess}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      onSubmit={handleSubmit}
    >
      {suppliersQuery.isPending ? <LoadingState message="Cargando proveedores…" /> : suppliersQuery.isError ? <QueryErrorState error={suppliersQuery.error} onRetry={() => { void suppliersQuery.refetch() }} /> : suppliersQuery.data.data.length === 0 ? <EmptyState title="Sin proveedores activos" description="Registra o activa un proveedor en Catálogos." /> : null}
      {warehousesQuery.isPending ? <LoadingState message="Cargando almacenes…" /> : warehousesQuery.isError ? <QueryErrorState error={warehousesQuery.error} onRetry={() => { void warehousesQuery.refetch() }} /> : warehousesQuery.data.data.length === 0 ? <EmptyState title="Sin almacenes activos" description="Registra o activa un almacén en Catálogos." /> : null}
      {productsQuery.isPending ? <LoadingState message="Cargando productos…" /> : productsQuery.isError ? <QueryErrorState error={productsQuery.error} onRetry={() => { void productsQuery.refetch() }} /> : productsQuery.data.data.length === 0 ? <EmptyState title="Sin productos activos" description="Registra un producto antes de crear la orden." /> : null}
      <div>
        <Label htmlFor="ord-sup">Proveedor (catálogo único compartido con Finanzas)</Label>
        <Select name="supplierId" required>
          <SelectTrigger id="ord-sup"><SelectValue placeholder="Elige proveedor" /></SelectTrigger>
          <SelectContent>
            {(suppliersQuery.data?.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="ord-wh">Almacén destino</Label>
        <Select name="warehouseId" required>
          <SelectTrigger id="ord-wh"><SelectValue placeholder="Elige almacén" /></SelectTrigger>
          <SelectContent>
            {(warehousesQuery.data?.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="ord-prod">Producto</Label>
        <Select name="productId" required>
          <SelectTrigger id="ord-prod"><SelectValue placeholder="Elige producto" /></SelectTrigger>
          <SelectContent>
            {(productsQuery.data?.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>{item.sku} · {item.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="ord-qty">Cantidad</Label><Input id="ord-qty" name="quantity" type="number" min={1} required /></div>
        <div><Label htmlFor="ord-cost">{currency ? `Costo unitario (${currency})` : "Costo unitario"}</Label><Input id="ord-cost" name="unitCost" inputMode="decimal" autoComplete="off" placeholder={currency && locale ? formatMoneyInput(0, currency, locale) : undefined} /></div>
      </div>
      <div><Label htmlFor="ord-notes">Notas</Label><Textarea id="ord-notes" name="notes" maxLength={2000} /></div>
    </FormDrawer>
  )
}

/* ---------------- movimientos ---------------- */

function MovementsSection({ kind }: { kind: string | null }) {
  const filters: FilterDef[] = React.useMemo(
    () => [
      {
        key: "kind",
        label: "Tipo",
        type: "select",
        options: Object.entries(MOVEMENT_KIND_LABELS).map(([value, label]) => ({ value, label })),
      },
    ],
    [],
  )
  const query = useQuery({
    retry: false,
    queryKey: ["inventory", "movements", kind],
    queryFn: () => {
      const suffix = kind ? `?kind=${encodeURIComponent(kind)}` : ""
      return apiFetch<{ data: StockMovementItem[] }>(`/api/inventory/movements${suffix}`)
    },
  })
  const rows = query.data?.data ?? []
  const columns = React.useMemo<ColumnDef<StockMovementItem>[]>(
    () => [
      {
        accessorKey: "kind",
        header: "Tipo",
        cell: ({ row }) => <Badge variant="outline">{MOVEMENT_KIND_LABELS[row.original.kind] ?? row.original.kind}</Badge>,
      },
      {
        accessorKey: "productName",
        header: "Producto",
        cell: ({ row }) => row.original.productName ?? row.original.productId,
      },
      {
        accessorKey: "quantityDelta",
        header: "Cantidad",
        cell: ({ row }) => (
          <span className={row.original.quantityDelta < 0 ? "text-destructive" : "text-success"}>
            {row.original.quantityDelta > 0 ? "+" : ""}{row.original.quantityDelta} {row.original.productUnit ?? ""}
          </span>
        ),
      },
      {
        accessorKey: "reason",
        header: "Detalle",
        cell: ({ row }) => (
          <span>
            {row.original.reason}
            {row.original.patientName ? ` · Paciente: ${row.original.patientName}` : ""}
            {row.original.lotCode ? ` · Lote ${row.original.lotCode}` : ""} · {row.original.warehouseName ?? ""}
          </span>
        ),
      },
    ],
    [],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <div className="flex flex-col gap-3">
      <FilterBar filters={filters} sortOptions={[]} showSearch={false} resetKeys={["kind"]} />
      {query.isPending ? (
        <LoadingState message="Cargando movimientos…" />
      ) : query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => { void query.refetch() }} />
      ) : rows.length === 0 ? (
        <EmptyState title={kind ? "Sin resultados" : "Sin movimientos"} description={kind ? "Prueba otro tipo de movimiento." : "Todavía no se han registrado movimientos."} />
      ) : (
        <DataTable table={table} />
      )}
      <p className="text-xs text-muted-foreground">
        Ledger inmutable: los movimientos no se editan ni borran; los errores se corrigen con un ajuste inverso.
      </p>
    </div>
  )
}

function MovementFormDrawer({ formError, onClose, onDone, onError }: { formError: string | null; onClose: () => void; onDone: () => void; onError: (message: string | null) => void }) {
  const productsQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "products", "active"],
    queryFn: () => apiFetch<{ data: InventoryProduct[] }>("/api/inventory/products?onlyActive=true"),
  })
  const warehousesQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "warehouses", "active"],
    queryFn: () => apiFetch<{ data: WarehouseItem[] }>("/api/inventory/warehouses?onlyActive=true"),
  })
  const [productId, setProductId] = React.useState("")
  const [kind, setKind] = React.useState("ingreso")
  const lotsQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "lots", productId],
    enabled: productId !== "",
    queryFn: () => apiFetch<{ data: { lots: Array<{ id: string; code: string; quantityOnHand: number }> } }>(`/api/inventory/products/${productId}`),
  })
  const mutation = useMutation({
    retry: false,
    mutationFn: (values: Record<string, unknown>) =>
      apiFetch("/api/inventory/movements", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => {
      onError(null)
      toast.success("Movimiento registrado")
      onDone()
    },
    onError: (error) => onError(errorMessage(error)),
  })
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || isAmbiguousMutationError(mutation.error)) return
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const rawQuantity = Number(form.get("quantity") ?? 0)
    mutation.mutate({
      productId: String(form.get("productId") ?? ""),
      kind: String(form.get("kind") ?? "ingreso"),
      quantity: kind === "ajuste" ? rawQuantity : Math.abs(rawQuantity),
      lotId: String(form.get("lotId") ?? "") || null,
      destWarehouseId: String(form.get("destWarehouseId") ?? "") || null,
      reason: String(form.get("reason") ?? ""),
      patientId: String(form.get("patientId") ?? "") || null,
      idempotencyKey: `ui:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    })
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Nuevo movimiento"
      description="Todo movimiento exige motivo y queda en el ledger inmutable."
      error={formError}
      isSubmitting={mutation.isPending}
      submitDisabled={isAmbiguousMutationError(mutation.error) || !productsQuery.isSuccess || !lotsQuery.isSuccess || (kind === "traslado" && !warehousesQuery.isSuccess)}
      submitLabel="Registrar"
      cancelLabel="Cancelar"
      onSubmit={handleSubmit}
    >
      {productsQuery.isPending ? <LoadingState message="Cargando productos…" /> : productsQuery.isError ? <QueryErrorState error={productsQuery.error} onRetry={() => { void productsQuery.refetch() }} /> : productsQuery.data.data.length === 0 ? <EmptyState title="Sin productos activos" description="Registra un producto antes de registrar movimientos." /> : null}
      {kind === "traslado" && (warehousesQuery.isPending ? <LoadingState message="Cargando almacenes…" /> : warehousesQuery.isError ? <QueryErrorState error={warehousesQuery.error} onRetry={() => { void warehousesQuery.refetch() }} /> : warehousesQuery.data.data.length === 0 ? <EmptyState title="Sin almacenes activos" description="Activa un almacén de destino en Catálogos." /> : null)}
      {productId && (lotsQuery.isPending ? <LoadingState message="Cargando lotes…" /> : lotsQuery.isError ? <QueryErrorState error={lotsQuery.error} onRetry={() => { void lotsQuery.refetch() }} /> : lotsQuery.data.data.lots.length === 0 ? <EmptyState title="Sin lotes" description="Registra una recepción para este producto antes de mover existencias." /> : null)}
      <div>
        <Label htmlFor="mov-prod">Producto</Label>
        <Select name="productId" required value={productId} onValueChange={(value) => setProductId(value ?? "")}>
          <SelectTrigger id="mov-prod"><SelectValue placeholder="Elige producto" /></SelectTrigger>
          <SelectContent>
            {(productsQuery.data?.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>{item.sku} · {item.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="mov-kind">Tipo</Label>
          <Select name="kind" value={kind} onValueChange={(value) => setKind(value ?? "ingreso")}>
            <SelectTrigger id="mov-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ingreso">Ingreso</SelectItem>
              <SelectItem value="consumo">Consumo (exige paciente)</SelectItem>
              <SelectItem value="ajuste">Ajuste (admite negativo)</SelectItem>
              <SelectItem value="traslado">Traslado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label htmlFor="mov-qty">Cantidad</Label><Input id="mov-qty" name="quantity" type="number" required /></div>
      </div>
      <div>
        <Label htmlFor="mov-lot">Lote{kind === "traslado" ? " origen" : ""}</Label>
        <Select name="lotId" required>
          <SelectTrigger id="mov-lot"><SelectValue placeholder={productId ? "Elige lote" : "Primero el producto"} /></SelectTrigger>
          <SelectContent>
            {(lotsQuery.data?.data.lots ?? []).map((lot) => (
              <SelectItem key={lot.id} value={lot.id}>{lot.code} (saldo {lot.quantityOnHand})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {kind === "traslado" && (
        <div>
          <Label htmlFor="mov-dest">Almacén destino</Label>
          <Select name="destWarehouseId" required>
            <SelectTrigger id="mov-dest"><SelectValue placeholder="Elige destino" /></SelectTrigger>
            <SelectContent>
              {(warehousesQuery.data?.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div><Label htmlFor="mov-patient">Paciente (solo consumo clínico, UUID)</Label><Input id="mov-patient" name="patientId" placeholder="UUID del paciente atendido" /></div>
      <div><Label htmlFor="mov-reason">Motivo</Label><Textarea id="mov-reason" name="reason" required maxLength={2000} /></div>
    </FormDrawer>
  )
}

/* ---------------- catálogos ---------------- */

function CatalogsSection({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const [editingSupplier, setEditingSupplier] = React.useState<SupplierItem | null>(null)
  const [editingWarehouse, setEditingWarehouse] = React.useState<WarehouseItem | null>(null)
  const [supplierError, setSupplierError] = React.useState<string | null>(null)
  const [warehouseError, setWarehouseError] = React.useState<string | null>(null)
  const suppliersQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "suppliers"],
    queryFn: () => apiFetch<{ data: SupplierItem[] }>("/api/inventory/suppliers"),
  })
  const warehousesQuery = useQuery({
    retry: false,
    queryKey: ["inventory", "warehouses"],
    queryFn: () => apiFetch<{ data: WarehouseItem[] }>("/api/inventory/warehouses"),
  })
  const toggleSupplier = useMutation({
    retry: false,
    mutationFn: (item: SupplierItem) =>
      apiFetch(`/api/inventory/suppliers/${item.id}/activation`, {
        method: "POST",
        body: JSON.stringify({ isActive: !item.isActive }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onError: (error) => toast.error(errorMessage(error)),
  })
  const toggleWarehouse = useMutation({
    retry: false,
    mutationFn: (item: WarehouseItem) =>
      apiFetch(`/api/inventory/warehouses/${item.id}/activation`, {
        method: "POST",
        body: JSON.stringify({ isActive: !item.isActive }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onError: (error) => toast.error(errorMessage(error)),
  })
  const supplierRows = suppliersQuery.data?.data ?? []
  const warehouseRows = warehousesQuery.data?.data ?? []
  const supplierColumns = React.useMemo<ColumnDef<SupplierItem>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Proveedor",
        cell: ({ row }) => row.original.name,
      },
      {
        id: "contacto",
        header: "Contacto",
        cell: ({ row }) => (
          <span>
            {[row.original.docType, row.original.docNumber].filter(Boolean).join(" ")}
            {row.original.email ? ` · ${row.original.email}` : ""}
            {row.original.phone ? ` · ${row.original.phone}` : ""}
          </span>
        ),
      },
      {
        accessorKey: "isActive",
        header: "Estado",
        cell: ({ row }) => (row.original.isActive ? null : <Badge variant="outline">Desactivado</Badge>),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const item = row.original
          if (!canWrite) return null
          return (
            <div className="text-right">
              <RowActions
                label={`Acciones del proveedor ${item.name}`}
                items={[
                  { key: "editar", label: "Editar", onSelect: () => { setSupplierError(null); setEditingSupplier(item) } },
                  {
                    key: "activacion",
                    label: item.isActive ? "Desactivar" : "Reactivar",
                    tone: item.isActive ? "danger" : undefined,
                    disabled: toggleSupplier.isPending || isAmbiguousMutationError(toggleSupplier.error),
                    onSelect: () => toggleSupplier.mutate(item),
                  },
                ]}
              />
            </div>
          )
        },
      },
    ],
    [canWrite, toggleSupplier],
  )
  const warehouseColumns = React.useMemo<ColumnDef<WarehouseItem>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Almacén",
        cell: ({ row }) => row.original.name,
      },
      {
        accessorKey: "branchName",
        header: "Sede",
        cell: ({ row }) => row.original.branchName ?? row.original.branchId,
      },
      {
        accessorKey: "isActive",
        header: "Estado",
        cell: ({ row }) => (row.original.isActive ? null : <Badge variant="outline">Desactivado</Badge>),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const item = row.original
          if (!canWrite) return null
          return (
            <div className="text-right">
              <RowActions
                label={`Acciones del almacén ${item.name}`}
                items={[
                  { key: "editar", label: "Editar", onSelect: () => { setWarehouseError(null); setEditingWarehouse(item) } },
                  {
                    key: "activacion",
                    label: item.isActive ? "Desactivar" : "Reactivar",
                    tone: item.isActive ? "danger" : undefined,
                    disabled: toggleWarehouse.isPending || isAmbiguousMutationError(toggleWarehouse.error),
                    onSelect: () => toggleWarehouse.mutate(item),
                  },
                ]}
              />
            </div>
          )
        },
      },
    ],
    [canWrite, toggleWarehouse],
  )
  const suppliersTable = useReactTable({ data: supplierRows, columns: supplierColumns, getCoreRowModel: getCoreRowModel() })
  const warehousesTable = useReactTable({ data: warehouseRows, columns: warehouseColumns, getCoreRowModel: getCoreRowModel() })
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Proveedores</h2>
        {toggleSupplier.isError ? <ErrorState title="No pudimos confirmar el cambio" message={errorMessage(toggleSupplier.error)} onRetry={() => { void suppliersQuery.refetch().then(result => { if (result.isSuccess) toggleSupplier.reset() }) }} retryLabel="Consultar estado actual" /> : null}
        {suppliersQuery.isPending ? <LoadingState message="Cargando proveedores…" /> : suppliersQuery.isError ? <QueryErrorState error={suppliersQuery.error} onRetry={() => { void suppliersQuery.refetch() }} /> : supplierRows.length === 0 ? <EmptyState title="Sin proveedores" description="Registra el primero con el botón Proveedor." /> : <DataTable table={suppliersTable} />}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Almacenes</h2>
        {toggleWarehouse.isError ? <ErrorState title="No pudimos confirmar el cambio" message={errorMessage(toggleWarehouse.error)} onRetry={() => { void warehousesQuery.refetch().then(result => { if (result.isSuccess) toggleWarehouse.reset() }) }} retryLabel="Consultar estado actual" /> : null}
        {warehousesQuery.isPending ? <LoadingState message="Cargando almacenes…" /> : warehousesQuery.isError ? <QueryErrorState error={warehousesQuery.error} onRetry={() => { void warehousesQuery.refetch() }} /> : warehouseRows.length === 0 ? <EmptyState title="Sin almacenes" description="Registra el primero con el botón Almacén." /> : <DataTable table={warehousesTable} />}
      </section>

      {editingSupplier && (
        <SupplierFormDrawer
          key={editingSupplier.id}
          initial={editingSupplier}
          formError={supplierError}
          onClose={() => setEditingSupplier(null)}
          onDone={() => { setEditingSupplier(null); void queryClient.invalidateQueries({ queryKey: ["inventory"] }) }}
          onError={setSupplierError}
        />
      )}
      {editingWarehouse && (
        <WarehouseFormDrawer
          key={editingWarehouse.id}
          initial={editingWarehouse}
          formError={warehouseError}
          onClose={() => setEditingWarehouse(null)}
          onDone={() => { setEditingWarehouse(null); void queryClient.invalidateQueries({ queryKey: ["inventory"] }) }}
          onError={setWarehouseError}
        />
      )}
    </div>
  )
}

type DrawerBaseProps = {
  formError: string | null
  onClose: () => void
  onDone: () => void
  onError: (message: string | null) => void
}

function SupplierFormDrawer({ initial, formError, onClose, onDone, onError }: DrawerBaseProps & { initial?: SupplierItem }) {
  const mutation = useMutation({
    retry: false,
    mutationFn: (values: Record<string, unknown>) =>
      initial
        ? apiFetch(`/api/inventory/suppliers/${initial.id}`, { method: "PATCH", body: JSON.stringify(values) })
        : apiFetch("/api/inventory/suppliers", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => { onError(null); toast.success(initial ? "Proveedor actualizado" : "Proveedor creado"); onDone() },
    onError: (error) => onError(errorMessage(error)),
  })
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || isAmbiguousMutationError(mutation.error)) return
    const form = new FormData(event.currentTarget as HTMLFormElement)
    mutation.mutate({
      name: String(form.get("name") ?? ""),
      docType: String(form.get("docType") ?? "") || null,
      docNumber: String(form.get("docNumber") ?? "") || null,
      email: String(form.get("email") ?? "") || null,
      phone: String(form.get("phone") ?? "") || null,
      address: String(form.get("address") ?? "") || null,
    })
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={initial ? "Editar proveedor" : "Nuevo proveedor"}
      description={initial ? undefined : "Catálogo único de proveedores, compartido con Finanzas."}
      error={formError}
      isSubmitting={mutation.isPending}
      submitDisabled={isAmbiguousMutationError(mutation.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      onSubmit={handleSubmit}
    >
      <div><Label htmlFor="sup-name">Nombre</Label><Input id="sup-name" name="name" required maxLength={200} defaultValue={initial?.name ?? ""} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="sup-doctype">Tipo de documento</Label><Input id="sup-doctype" name="docType" maxLength={20} defaultValue={initial?.docType ?? ""} /></div>
        <div><Label htmlFor="sup-doc">Número</Label><Input id="sup-doc" name="docNumber" maxLength={50} defaultValue={initial?.docNumber ?? ""} /></div>
      </div>
      <div><Label htmlFor="sup-email">Correo</Label><Input id="sup-email" name="email" type="email" maxLength={200} defaultValue={initial?.email ?? ""} /></div>
      <div><Label htmlFor="sup-phone">Teléfono</Label><Input id="sup-phone" name="phone" maxLength={50} defaultValue={initial?.phone ?? ""} /></div>
      <div><Label htmlFor="sup-addr">Dirección</Label><Textarea id="sup-addr" name="address" maxLength={500} defaultValue={initial?.address ?? ""} /></div>
    </FormDrawer>
  )
}

function WarehouseFormDrawer({ initial, formError, onClose, onDone, onError }: DrawerBaseProps & { initial?: WarehouseItem }) {
  const branchesQuery = useQuery({
    retry: false,
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
  })
  const mutation = useMutation({
    retry: false,
    mutationFn: (values: Record<string, unknown>) =>
      initial
        ? apiFetch(`/api/inventory/warehouses/${initial.id}`, { method: "PATCH", body: JSON.stringify(values) })
        : apiFetch("/api/inventory/warehouses", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => { onError(null); toast.success(initial ? "Almacén actualizado" : "Almacén creado"); onDone() },
    onError: (error) => onError(errorMessage(error)),
  })
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || isAmbiguousMutationError(mutation.error)) return
    const form = new FormData(event.currentTarget as HTMLFormElement)
    mutation.mutate({
      name: String(form.get("name") ?? ""),
      ...(initial ? {} : { branchId: String(form.get("branchId") ?? "") }),
    })
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={initial ? "Editar almacén" : "Nuevo almacén"}
      description={initial ? undefined : "Cada almacén pertenece a una sede."}
      error={formError}
      isSubmitting={mutation.isPending}
      submitDisabled={isAmbiguousMutationError(mutation.error) || (!initial && !branchesQuery.isSuccess)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      onSubmit={handleSubmit}
    >
      {!initial && (branchesQuery.isPending ? <LoadingState message="Cargando sedes…" /> : branchesQuery.isError ? <QueryErrorState error={branchesQuery.error} onRetry={() => { void branchesQuery.refetch() }} /> : branchesQuery.data.data.length === 0 ? <EmptyState title="Sin sedes" description="Registra una sede en Configuración antes de crear el almacén." /> : null)}
      <div><Label htmlFor="wh-name">Nombre</Label><Input id="wh-name" name="name" required maxLength={200} defaultValue={initial?.name ?? ""} /></div>
      {!initial && (
        <div>
          <Label htmlFor="wh-branch">Sede</Label>
          <Select name="branchId" required>
            <SelectTrigger id="wh-branch"><SelectValue placeholder="Elige sede" /></SelectTrigger>
            <SelectContent>
              {(branchesQuery.data?.data ?? []).map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </FormDrawer>
  )
}

/* ---------------- alertas ---------------- */

function AlertsSection() {
  const query = useQuery({
    retry: false,
    queryKey: ["inventory", "alerts"],
    queryFn: () => apiFetch<{ data: InventoryAlerts }>("/api/inventory/alerts?expiryDays=30"),
  })
  const alerts = query.data?.data
  if (query.isPending) return <LoadingState message="Cargando alertas…" />
  if (query.isError || !alerts) return <QueryErrorState error={query.error} onRetry={() => { void query.refetch() }} />
  const total = alerts.lowStock.length + alerts.expiring.length + alerts.expired.length
  if (total === 0) return <EmptyState title="Todo en orden" description="Sin stock bajo mínimos ni vencimientos próximos." />
  return (
    <div className="flex flex-col gap-4">
      {alerts.lowStock.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Stock bajo mínimo ({alerts.lowStock.length})</h2>
          <LowStockTable rows={alerts.lowStock} />
        </section>
      )}
      {alerts.expired.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Vencidos con saldo ({alerts.expired.length})</h2>
          <ExpiryTable rows={alerts.expired} verb="venció" />
        </section>
      )}
      {alerts.expiring.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Por vencer en 30 días ({alerts.expiring.length})</h2>
          <ExpiryTable rows={alerts.expiring} verb="vence" />
        </section>
      )}
    </div>
  )
}

function LowStockTable({ rows }: { rows: InventoryAlerts["lowStock"] }) {
  const columns = React.useMemo<ColumnDef<InventoryAlerts["lowStock"][number]>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Producto",
        cell: ({ row }) => (
          <Link to="/inventory/$productId" params={{ productId: row.original.productId }} className="font-medium hover:underline">
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "sku",
        header: "SKU",
        cell: ({ row }) => row.original.sku,
      },
      {
        accessorKey: "onHand",
        header: "Saldo",
        cell: ({ row }) => `Saldo ${row.original.onHand} ${row.original.unit} (mín. ${row.original.minStock})`,
      },
    ],
    [],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} />
}

function ExpiryTable({ rows, verb }: { rows: InventoryAlerts["expired"]; verb: "vence" | "venció" }) {
  const columns = React.useMemo<ColumnDef<InventoryAlerts["expired"][number]>[]>(
    () => [
      {
        accessorKey: "productName",
        header: "Producto",
        cell: ({ row }) => row.original.productName,
      },
      {
        accessorKey: "code",
        header: "Lote",
        cell: ({ row }) => `Lote ${row.original.code}`,
      },
      {
        accessorKey: "expiresAt",
        header: "Vencimiento",
        cell: ({ row }) => `${verb} ${row.original.expiresAt} · saldo ${row.original.quantityOnHand}`,
      },
    ],
    [verb],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} />
}
