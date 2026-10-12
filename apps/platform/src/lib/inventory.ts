/** Tipos mínimos de inventario para la UI (la API es la fuente de verdad). */

export interface InventoryProduct {
  id: string
  sku: string
  name: string
  kind: string
  unit: string
  minStock: number
  isActive: boolean
  onHand: number
  lowStock: boolean
}

export interface ProductLotItem {
  id: string
  code: string
  warehouseId: string
  warehouseName: string | null
  supplierId: string | null
  purchaseOrderId: string | null
  expiresAt: string | null
  quantityOnHand: number
  createdAt: string
}

export interface ProductDetail extends InventoryProduct {
  lots: ProductLotItem[]
  movements: StockMovementItem[]
}

export interface StockMovementItem {
  id: string
  kind: string
  quantityDelta: number
  reason: string
  actorUserId: string | null
  purchaseOrderId: string | null
  patientId: string | null
  patientName: string | null
  productId: string
  productSku: string | null
  productName: string | null
  productUnit: string | null
  lotId: string | null
  lotCode: string | null
  warehouseId: string
  warehouseName: string | null
  destWarehouseId: string | null
  createdAt: string
}

export interface SupplierItem {
  id: string
  name: string
  docType: string | null
  docNumber: string | null
  email: string | null
  phone: string | null
  address: string | null
  isActive: boolean
}

export interface WarehouseItem {
  id: string
  branchId: string
  branchName: string | null
  name: string
  isActive: boolean
  createdAt: string
}

export interface PurchaseOrderLineItem {
  id: string
  productId: string
  productSku: string | null
  productName: string | null
  productUnit: string | null
  quantity: number
  unitCostCents: number
  receivedQuantity: number
}

export interface PurchaseOrderItem {
  id: string
  status: string
  currency: string
  notes: string | null
  supplierId: string
  supplierName: string | null
  warehouseId: string
  warehouseName: string | null
  createdAt: string
}

export interface PurchaseOrderDetail extends PurchaseOrderItem {
  lines: PurchaseOrderLineItem[]
  totalCents: number
}

export interface InventoryAlerts {
  lowStock: Array<{
    productId: string
    sku: string
    name: string
    unit: string
    minStock: number
    onHand: number
  }>
  expiring: Array<{
    lotId: string
    productName: string | null
    sku: string | null
    code: string
    warehouseName: string | null
    expiresAt: string | null
    quantityOnHand: number
  }>
  expired: Array<{
    lotId: string
    productName: string | null
    sku: string | null
    code: string
    warehouseName: string | null
    expiresAt: string | null
    quantityOnHand: number
  }>
}

export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  ingreso: "Ingreso",
  consumo: "Consumo",
  ajuste: "Ajuste",
  traslado: "Traslado",
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  borrador: "Borrador",
  confirmada: "Confirmada",
  parcialmente_recibida: "Parcial",
  recibida: "Recibida",
  cancelada: "Cancelada",
}

/** Centavos enteros a texto en la moneda indicada (sin floats). */
export function formatCents(amountCents: number, currency: string): string {
  const sign = amountCents < 0 ? "-" : ""
  const absolute = Math.abs(amountCents)
  const whole = Math.floor(absolute / 100)
  const rest = String(absolute % 100).padStart(2, "0")
  return `${sign}${currency} ${whole}.${rest}`
}
