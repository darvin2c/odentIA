/** Tipos mínimos de inventario para la UI (la API es la fuente de verdad). */
import type { PurchaseBalance } from "./reports"

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
  /** Número de la orden en la clínica: «OC-0012». */
  orderNumber: number
  status: string
  currency: string
  notes: string | null
  supplierId: string
  supplierName: string | null
  warehouseId: string
  warehouseName: string | null
  createdAt: string
  /** Recibido, pagado y por pagar (ADR 0061). */
  balance: PurchaseBalance | null
}

/** Un pago de una compra: su gasto de Materiales o lo usado de lo que se tenía a favor. */
export interface PurchasePayment {
  id: string
  kind: "pago" | "a_favor"
  amountCents: number
  paidAt: string
  concept: string | null
  fromCash: boolean
  receiptKind: string | null
  receiptNumber: string | null
  byName: string | null
  voidedAt: string | null
  voidReason: string | null
}

export interface PurchaseOrderDetail extends PurchaseOrderItem {
  lines: PurchaseOrderLineItem[]
  totalCents: number
  payments: PurchasePayment[]
  /** Lo que se tiene a favor con este proveedor, en la moneda de la orden. */
  supplierCreditCents: number
}

export type PurchasePaymentTone = "warning" | "info" | "success" | "muted"

/** Cómo va el pago de una compra, en palabras y con su tono (nunca solo con color). */
export function purchasePaymentState(
  order: Pick<PurchaseOrderItem, "status">,
  balance: PurchaseBalance | null,
  money: (cents: number) => string,
): { label: string; tone: PurchasePaymentTone } {
  if (order.status === "borrador") return { label: "Sin confirmar", tone: "muted" }
  if (!balance) return { label: "—", tone: "muted" }
  if (order.status === "cancelada") return balance.paidCents > 0 ? { label: `A favor ${money(balance.paidCents)}`, tone: "info" } : { label: "Cancelada", tone: "muted" }
  if (balance.receivedCents === 0)
    return balance.paidCents > 0 ? { label: `Adelanto ${money(balance.paidCents)} · aún no llega`, tone: "info" } : { label: "Aún no llega", tone: "muted" }
  if (balance.dueCents > 0)
    return balance.paidCents > 0 ? { label: `Pagada en parte · falta ${money(balance.dueCents)}`, tone: "warning" } : { label: `Por pagar ${money(balance.dueCents)}`, tone: "warning" }
  if (balance.aheadCents > 0)
    return order.status === "recibida"
      ? { label: `✓ Pagada · a favor ${money(balance.aheadCents)}`, tone: "success" }
      : { label: `✓ Pagada · adelanto ${money(balance.aheadCents)}`, tone: "success" }
  return { label: "✓ Pagada", tone: "success" }
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
