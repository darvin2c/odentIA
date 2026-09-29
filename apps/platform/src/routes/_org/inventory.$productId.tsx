import { Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, toast } from "@odentia/ui"
import { DataTable, EmptyState, FormDrawer, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import * as React from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { MOVEMENT_KIND_LABELS, type ProductDetail, type WarehouseItem } from "../../lib/inventory"

export const Route = createFileRoute("/_org/inventory/$productId")({
  component: ProductDetailPage,
})

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? (error.shape.message ?? error.message) : String(error)
}

function ProductDetailPage() {
  const { productId } = Route.useParams()
  const canRead = usePermission("inventory.read")
  const canWrite = usePermission("inventory.write")
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  const detailQuery = useQuery({
    queryKey: ["inventory", "product", productId],
    enabled: canRead,
    queryFn: () => apiFetch<{ data: ProductDetail }>(`/api/inventory/products/${productId}`),
  })
  const detail = detailQuery.data?.data

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["inventory"] })
  }

  if (!canRead) {
    return (
      <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
        <EmptyState title="Sin acceso" description="Tu rol no tiene permiso de lectura de inventario." />
      </PageShell>
    )
  }

  return (
    <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
      <Link to="/inventory" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> Volver al inventario
      </Link>
      {detailQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando producto…</p>
      ) : !detail ? (
        <EmptyState title="Producto no encontrado" description="Verifica el enlace o vuelve al inventario." />
      ) : (
        <>
          <PageHeader
            title={detail.name}
            subtitle={`${detail.sku} · ${detail.unit} · Saldo total: ${detail.onHand} (mín. ${detail.minStock})`}
            actions={
              <div className="flex gap-2">
                {detail.lowStock && <Badge variant="destructive">Bajo mínimo</Badge>}
                {!detail.isActive && <Badge variant="outline">Desactivado</Badge>}
                {canWrite && (
                  <Button size="sm" onClick={() => { setFormError(null); setOpen(true) }}>
                    Registrar movimiento
                  </Button>
                )}
              </div>
            }
          />

          <section>
            <h2 className="mb-2 text-sm font-semibold">Lotes ({detail.lots.length})</h2>
            {detail.lots.length === 0 ? (
              <EmptyState title="Sin lotes" description="La primera recepción de compra crea el lote." />
            ) : (
              <DetailLotsTable detail={detail} />
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Movimientos recientes</h2>
            {detail.movements.length === 0 ? (
              <EmptyState title="Sin movimientos registrados" />
            ) : (
              <DetailMovementsTable detail={detail} />
            )}
          </section>
        </>
      )}

      {open && detail && (
        <DetailMovementFormDrawer
          productId={detail.id}
          lots={detail.lots.map((lot) => ({ id: lot.id, code: lot.code, quantityOnHand: lot.quantityOnHand }))}
          formError={formError}
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); invalidate() }}
          onError={setFormError}
        />
      )}
    </PageShell>
  )
}

function DetailLotsTable({ detail }: { detail: ProductDetail }) {
  const columns = React.useMemo<ColumnDef<ProductDetail["lots"][number]>[]>(
    () => [
      {
        accessorKey: "code",
        header: "Lote",
        cell: ({ row }) => `Lote ${row.original.code}`,
      },
      {
        accessorKey: "quantityOnHand",
        header: "Saldo",
        cell: ({ row }) => `Saldo: ${row.original.quantityOnHand}`,
      },
      {
        accessorKey: "warehouseName",
        header: "Detalle",
        cell: ({ row }) => (
          <span>
            {row.original.warehouseName ?? row.original.warehouseId}
            {row.original.expiresAt ? ` · vence ${row.original.expiresAt}` : " · sin vencimiento"}
            {row.original.purchaseOrderId ? " · trazable a compra" : ""}
          </span>
        ),
      },
    ],
    [],
  )
  const table = useReactTable({ data: detail.lots, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} />
}

function DetailMovementsTable({ detail }: { detail: ProductDetail }) {
  const columns = React.useMemo<ColumnDef<ProductDetail["movements"][number]>[]>(
    () => [
      {
        accessorKey: "kind",
        header: "Tipo",
        cell: ({ row }) => <Badge variant="outline">{MOVEMENT_KIND_LABELS[row.original.kind] ?? row.original.kind}</Badge>,
      },
      {
        accessorKey: "quantityDelta",
        header: "Cantidad",
        cell: ({ row }) => (
          <span className={row.original.quantityDelta < 0 ? "text-destructive" : "text-green-700"}>
            {row.original.quantityDelta > 0 ? "+" : ""}{row.original.quantityDelta}
          </span>
        ),
      },
      {
        accessorKey: "reason",
        header: "Detalle",
        cell: ({ row }) => (
          <span>
            {row.original.lotCode ? `Lote ${row.original.lotCode} · ` : ""}{row.original.reason}
            {row.original.patientName ? ` · Paciente: ${row.original.patientName}` : ""}
          </span>
        ),
      },
    ],
    [],
  )
  const table = useReactTable({ data: detail.movements, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} />
}

function DetailMovementFormDrawer({
  productId,
  lots,
  formError,
  onClose,
  onDone,
  onError,
}: {
  productId: string
  lots: Array<{ id: string; code: string; quantityOnHand: number }>
  formError: string | null
  onClose: () => void
  onDone: () => void
  onError: (message: string | null) => void
}) {
  const warehousesQuery = useQuery({
    queryKey: ["inventory", "warehouses", "active"],
    queryFn: () => apiFetch<{ data: WarehouseItem[] }>("/api/inventory/warehouses?onlyActive=true"),
  })
  const [kind, setKind] = React.useState("ingreso")
  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      apiFetch("/api/inventory/movements", { method: "POST", body: JSON.stringify(values) }),
    onSuccess: () => { onError(null); toast.success("Movimiento registrado"); onDone() },
    onError: (error) => onError(errorMessage(error)),
  })
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const rawQuantity = Number(form.get("quantity") ?? 0)
    mutation.mutate({
      productId,
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
      title="Registrar movimiento"
      description="Ingreso, consumo clínico (exige paciente del tenant), ajuste o traslado entre almacenes."
      error={formError}
      isSubmitting={mutation.isPending}
      submitLabel="Registrar"
      cancelLabel="Cancelar"
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="dm-kind">Tipo</Label>
          <Select name="kind" value={kind} onValueChange={(value) => setKind(value ?? "ingreso")}>
            <SelectTrigger id="dm-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ingreso">Ingreso</SelectItem>
              <SelectItem value="consumo">Consumo (exige paciente)</SelectItem>
              <SelectItem value="ajuste">Ajuste (admite negativo)</SelectItem>
              <SelectItem value="traslado">Traslado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label htmlFor="dm-qty">Cantidad</Label><Input id="dm-qty" name="quantity" type="number" required /></div>
      </div>
      <div>
        <Label htmlFor="dm-lot">Lote {kind === "traslado" ? "origen" : ""}</Label>
        <Select name="lotId" required>
          <SelectTrigger id="dm-lot"><SelectValue placeholder="Elige lote" /></SelectTrigger>
          <SelectContent>
            {lots.map((lot) => (
              <SelectItem key={lot.id} value={lot.id}>{lot.code} (saldo {lot.quantityOnHand})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {kind === "traslado" && (
        <div>
          <Label htmlFor="dm-dest">Almacén destino</Label>
          <Select name="destWarehouseId" required>
            <SelectTrigger id="dm-dest"><SelectValue placeholder="Elige destino" /></SelectTrigger>
            <SelectContent>
              {(warehousesQuery.data?.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {kind === "consumo" && (
        <div><Label htmlFor="dm-patient">Paciente atendido (UUID del tenant)</Label><Input id="dm-patient" name="patientId" required placeholder="UUID del paciente" /></div>
      )}
      <div><Label htmlFor="dm-reason">Motivo</Label><Textarea id="dm-reason" name="reason" required maxLength={2000} /></div>
    </FormDrawer>
  )
}
