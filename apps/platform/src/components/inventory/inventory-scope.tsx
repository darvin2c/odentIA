/**
 * Lo que comparten las piezas de Inventario: la sede elegida, el formato y la
 * moneda de la clínica, lo que puede hacer quien mira y cómo se abre cada
 * cosa (el producto o la compra al lado, los formularios). Lo aporta la página
 * (`routes/_org/inventory.tsx`); ninguna pieza decide permisos por su cuenta.
 */
import * as React from "react"
import type { BranchOption } from "../../lib/active-branch"
import type { ProductDetail, PurchaseOrderView, PurchaseView, SupplierItem } from "../../lib/inventory"

export type StockActionKind = "ajustar" | "uso" | "trasladar" | "agregar"

/** Una fila de una compra nueva que llega puesta («Pedir», «Pedir lo que falta»). */
export interface PurchasePresetLine {
  productId: string
  /** En unidades de compra. */
  quantity: number
  unitCostCents?: number
}

export interface PurchasePreset {
  supplierId?: string
  lines: PurchasePresetLine[]
  /** Por qué llegan estas filas, dicho arriba del formulario. */
  notice?: string
}

export interface InventoryOpeners {
  /** El producto al lado de la lista (`?producto=`). */
  product: (id: string) => void
  /** La compra al lado de la lista (`?tab=compras&orden=`). */
  order: (id: string) => void
  productForm: (product?: ProductDetail) => void
  action: (kind: StockActionKind, preset?: { productId?: string; lotId?: string }) => void
  purchase: (preset?: PurchasePreset) => void
  editPurchase: (order: PurchaseOrderView) => void
  receive: (orderId: string) => void
  paste: () => void
  /** Nuevo o editar proveedor; `onSaved` recibe el guardado (queda elegido en la compra). */
  supplier: (supplier?: SupplierItem, onSaved?: (saved: SupplierItem) => void) => void
  /** Movimientos de un producto, todos. */
  movementsOf: (productId: string) => void
  /** Compras de un proveedor. */
  ordersOf: (supplierId: string, view?: PurchaseView) => void
  count: () => void
}

export interface InventoryScope {
  branchId: string
  branchName: string
  /** Sedes activas. */
  branches: BranchOption[]
  locale: string
  /** Moneda de la clínica; sin ella no se escriben importes. */
  currency: string | null
  timeZone: string
  /** El nombre que ven los pacientes y los proveedores. */
  clinicName: string
  can: {
    /** Ver precios (`inventory.read`). */
    prices: boolean
    /** Registrar lo que llegó y el uso (`inventory.receive` o `inventory.write`). */
    receive: boolean
    /** Todo lo demás (`inventory.write`). */
    write: boolean
    /** Pagar una compra (`finance.write`). */
    pay: boolean
    /** Ver Finanzas (`finance.read`): «Ver gasto». */
    finance: boolean
    /** Abrir una atención (`clinical.read`). */
    clinical: boolean
    /** Buscar personas (`patients.read`). */
    people: boolean
  }
  open: InventoryOpeners
}

const InventoryContext = React.createContext<InventoryScope | null>(null)

export const InventoryProvider = InventoryContext.Provider

export function useInventory(): InventoryScope {
  const scope = React.useContext(InventoryContext)
  if (!scope) throw new Error("useInventory fuera de la página de Inventario")
  return scope
}
