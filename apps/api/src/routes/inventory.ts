import { withOrgContext } from "@odentia/db"
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  createWarehouse,
  getAlerts,
  getProductDetail,
  getPurchaseOrder,
  listMovements,
  listProducts,
  listPurchaseOrders,
  listSuppliers,
  listWarehouses,
  receivePurchaseOrder,
  recordMovement,
  setProductActive,
  setSupplierActive,
  setWarehouseActive,
  updateProduct,
  updateSupplier,
  updateWarehouse,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const KIND = ["insumo", "producto"] as const
const MOVEMENT_KIND = ["ingreso", "consumo", "ajuste", "traslado"] as const
const ORDER_STATUS = ["borrador", "confirmada", "parcialmente_recibida", "recibida", "cancelada"] as const

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha AAAA-MM-DD")

const supplierInput = z.object({
  name: z.string().min(1).max(200),
  docType: z.string().max(20).nullish(),
  docNumber: z.string().max(50).nullish(),
  email: z.string().max(200).nullish(),
  phone: z.string().max(50).nullish(),
  address: z.string().max(500).nullish(),
})

const warehouseInput = z.object({
  branchId: z.uuid(),
  name: z.string().min(1).max(200),
})

const productInput = z.object({
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  kind: z.enum(KIND).optional(),
  unit: z.string().min(1).max(60).optional(),
  minStock: z.number().int().min(0).optional(),
})

const productPatch = productInput.partial()

const orderLineInput = z.object({
  productId: z.uuid(),
  quantity: z.number().int().positive(),
  unitCostCents: z.number().int().min(0).optional(),
})

const orderInput = z.object({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(orderLineInput).min(1).max(200),
})
const receptionInput = z.object({
  idempotencyKey: z.uuid(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().positive(),
        lotCode: z.string().max(120).nullish(),
        expiresAt: dateOnly.nullish(),
      }),
    )
    .min(1)
    .max(200),
})

const movementInput = z.object({
  productId: z.uuid(),
  kind: z.enum(MOVEMENT_KIND),
  quantity: z.number().int(),
  lotId: z.uuid().nullish(),
  warehouseId: z.uuid().nullish(),
  destWarehouseId: z.uuid().nullish(),
  reason: z.string().min(1).max(2000),
  patientId: z.uuid().nullish(),
  idempotencyKey: z.string().max(200).nullish(),
})


export function createInventoryRoute(deps: CrmDeps) {
  const app = new Hono()

  const deny = (c: Context, permission: string, role: string) =>
    canAccess(role, permission)
      ? null
      : c.json(errorBody(c, "FORBIDDEN", `Se requiere permiso ${permission}`), 403)

  /* Lecturas: inventory.read */
  app.get("/products", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listProducts(tx, orgId, {
          q: query.q,
          kind: query.kind,
          lowStock: query.lowStock === "true" ? true : undefined,
          onlyActive: query.onlyActive === "true" ? true : undefined,
        }),
      ),
    )
  })

  app.get("/products/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getProductDetail(tx, orgId, c.req.param("id"))),
    )
  })

  app.get("/suppliers", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listSuppliers(tx, orgId, { q: query.q, onlyActive: query.onlyActive === "true" }),
      ),
    )
  })

  app.get("/warehouses", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listWarehouses(tx, orgId, c.req.query("onlyActive") === "true"),
      ),
    )
  })

  app.get("/purchase-orders", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    if (query.status && !(ORDER_STATUS as readonly string[]).includes(query.status)) {
      return c.json(errorBody(c, "VALIDATION", "Estado de orden inválido"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listPurchaseOrders(tx, orgId, { status: query.status, supplierId: query.supplierId }),
      ),
    )
  })

  app.get("/purchase-orders/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPurchaseOrder(tx, orgId, c.req.param("id"))),
    )
  })

  app.get("/movements", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    if (query.kind && !(MOVEMENT_KIND as readonly string[]).includes(query.kind)) {
      return c.json(errorBody(c, "VALIDATION", "Tipo de movimiento inválido"), 400)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listMovements(tx, orgId, {
          productId: query.productId,
          warehouseId: query.warehouseId,
          kind: query.kind,
          patientId: query.patientId,
          from: query.from,
          to: query.to,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        }),
      ),
    )
  })

  app.get("/alerts", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const days = c.req.query("expiryDays")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAlerts(tx, orgId, days ? Number(days) : 30)),
    )
  })

  /* Escrituras: inventory.write */
  app.post("/products", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = productInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createProduct(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/products/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = productPatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateProduct(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/products/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = z.object({ isActive: z.boolean() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setProductActive(tx, orgId, userId, c.req.param("id"), parsed.data.isActive),
      ),
    )
  })

  app.post("/suppliers", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = supplierInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createSupplier(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/suppliers/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = supplierInput.partial().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateSupplier(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/suppliers/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = z.object({ isActive: z.boolean() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setSupplierActive(tx, orgId, userId, c.req.param("id"), parsed.data.isActive),
      ),
    )
  })

  app.post("/warehouses", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = warehouseInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createWarehouse(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/warehouses/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = warehouseInput.partial().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateWarehouse(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/warehouses/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = z.object({ isActive: z.boolean() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setWarehouseActive(tx, orgId, userId, c.req.param("id"), parsed.data.isActive),
      ),
    )
  })

  app.post("/purchase-orders", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = orderInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createPurchaseOrder(tx, orgId, userId, parsed.data)),
    )
  })

  app.post("/purchase-orders/:id/confirm", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => confirmPurchaseOrder(tx, orgId, userId, c.req.param("id"))),
    )
  })

  app.post("/purchase-orders/:id/receive", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = receptionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        receivePurchaseOrder(tx, orgId, userId, c.req.param("id"), parsed.data.lines, parsed.data.idempotencyKey),
      ),
    )
  })

  app.post("/purchase-orders/:id/cancel", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => cancelPurchaseOrder(tx, orgId, userId, c.req.param("id"))),
    )
  })

  app.post("/movements", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = movementInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (parsed.data.quantity === 0) {
      return c.json(errorBody(c, "VALIDATION", "La cantidad no puede ser cero"), 400)
    }
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => recordMovement(tx, orgId, userId, parsed.data)),
    )
  })

  return app
}
