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

// Cada dato lleva su frase: lo que no pasa la validación llega a la pantalla
// tal cual, nunca con el texto en inglés de la librería.
const NO_FORM = "No llegaron los datos del formulario. Vuelve a intentarlo."

/** Texto con su largo máximo; vacío o con espacios lo dice el servicio con sus palabras. */
const words = (field: string, max: number) =>
  z.string(`${field} no es válido`).max(max, `${field} admite hasta ${max} caracteres`)

const dateOnly = z.string("El vencimiento no es una fecha válida").regex(/^\d{4}-\d{2}-\d{2}$/, "El vencimiento no es una fecha válida")

const quantity = z
  .number("La cantidad debe ser un número")
  .int("La cantidad debe ser un número entero")

const supplierInput = z.object(
  {
    name: words("El nombre del proveedor", 200).min(1, "Escribe el nombre del proveedor"),
    docType: words("El tipo de documento", 20).nullish(),
    docNumber: words("El número de documento", 50).nullish(),
    email: words("El correo", 200).nullish(),
    phone: words("El teléfono", 50).nullish(),
    address: words("La dirección", 500).nullish(),
  },
  NO_FORM,
)

const warehouseInput = z.object(
  {
    branchId: z.uuid("Elige la sede del almacén"),
    name: words("El nombre del almacén", 200).min(1, "Escribe el nombre del almacén"),
  },
  NO_FORM,
)

const productInput = z.object(
  {
    sku: words("El SKU", 60).min(1, "Escribe el SKU del producto"),
    name: words("El nombre del producto", 200).min(1, "Escribe el nombre del producto"),
    kind: z.enum(KIND, "El tipo debe ser insumo o producto").optional(),
    unit: words("La unidad", 60).min(1, "Escribe la unidad del producto").optional(),
    minStock: z
      .number("El stock mínimo debe ser un número")
      .int("El stock mínimo debe ser un número entero")
      .min(0, "El stock mínimo no puede ser negativo")
      .optional(),
  },
  NO_FORM,
)

const productPatch = productInput.partial()

const orderLineInput = z.object(
  {
    productId: z.uuid("Elige el producto de cada línea"),
    quantity: quantity.positive("La cantidad debe ser mayor que cero"),
    unitCostCents: z
      .number("El costo por unidad no es un importe válido")
      .int("El costo por unidad no es un importe válido")
      .min(0, "El costo por unidad no puede ser negativo")
      .optional(),
  },
  "Una línea de la orden no es válida",
)

const orderInput = z.object(
  {
    supplierId: z.uuid("Elige el proveedor"),
    warehouseId: z.uuid("Elige el almacén de destino"),
    currency: z.string("La moneda de la orden no es válida").regex(/^[A-Z]{3}$/, "La moneda de la orden no es válida").optional(),
    notes: words("Las notas", 2000).nullish(),
    lines: z
      .array(orderLineInput, "La orden necesita al menos una línea")
      .min(1, "La orden necesita al menos una línea")
      .max(200, "La orden admite hasta 200 líneas"),
  },
  NO_FORM,
)

const receptionInput = z.object(
  {
    idempotencyKey: z.uuid("No se pudo identificar esta recepción: vuelve a abrir la orden e inténtalo de nuevo"),
    lines: z
      .array(
        z.object(
          {
            productId: z.uuid("Un producto de la recepción no es válido"),
            quantity: quantity.positive("La cantidad recibida debe ser mayor que cero"),
            lotCode: words("El código de lote", 120).nullish(),
            expiresAt: dateOnly.nullish(),
          },
          "Una línea de la recepción no es válida",
        ),
        "La recepción necesita al menos una línea",
      )
      .min(1, "La recepción necesita al menos una línea")
      .max(200, "La recepción admite hasta 200 líneas"),
  },
  NO_FORM,
)

const movementInput = z.object(
  {
    productId: z.uuid("Elige el producto"),
    kind: z.enum(MOVEMENT_KIND, "Elige el tipo de movimiento"),
    quantity: quantity.refine((value) => value !== 0, "La cantidad no puede ser cero"),
    lotId: z.uuid("Elige el lote").nullish(),
    warehouseId: z.uuid("Elige el almacén").nullish(),
    destWarehouseId: z.uuid("Elige el almacén de destino").nullish(),
    reason: words("El motivo", 2000).min(1, "Escribe el motivo"),
    patientId: z.uuid("Elige el paciente atendido").nullish(),
    // Una por formulario abierto: sin ella un reintento duplicaría el movimiento.
    idempotencyKey: z.uuid("No se pudo identificar este movimiento: cierra el formulario y vuelve a abrirlo"),
  },
  NO_FORM,
)

const activationInput = z.object({ isActive: z.boolean("Indica si queda activo") }, NO_FORM)

const cancelInput = z.strictObject(
  {
    payments: z.enum(["anular", "a_favor"], "Elige qué pasa con los pagos de la compra").optional(),
    reason: z
      .string("El motivo no es válido")
      .trim()
      .min(1, "Escribe el motivo")
      .max(2000, "El motivo admite hasta 2000 caracteres")
      .optional(),
  },
  "Los datos de la cancelación no son válidos",
)

const isUuid = (value: string | undefined): value is string => value !== undefined && z.uuid().safeParse(value).success

/** Un número entero sin signo escrito en la dirección, o `undefined` si no vino. */
function wholeNumber(value: string | undefined): number | undefined | null {
  if (value === undefined || value === "") return undefined
  return /^\d{1,9}$/.test(value) ? Number(value) : null
}

export function createInventoryRoute(deps: CrmDeps) {
  const app = new Hono()

  const deny = (c: Context, permission: "inventory.read" | "inventory.write", role: string) =>
    canAccess(role, permission)
      ? null
      : c.json(
          errorBody(
            c,
            "FORBIDDEN",
            permission === "inventory.read"
              ? "No tienes permiso para ver el inventario"
              : "No tienes permiso para cambiar el inventario",
          ),
          403,
        )
  const invalid = (c: Context, message: string) => c.json(errorBody(c, "VALIDATION", message), 400)
  // Un id que no puede existir es un «no encontrado», no un error del servidor.
  const missing = (c: Context, message: string) => c.json(errorBody(c, "NOT_FOUND", message), 404)

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
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getProductDetail(tx, orgId, id)),
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
      return invalid(c, "Estado de orden inválido")
    }
    if (query.supplierId && !isUuid(query.supplierId)) return invalid(c, "El proveedor del filtro no es válido")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listPurchaseOrders(tx, orgId, {
          status: query.status,
          supplierId: query.supplierId,
          ...(query.pago === "por_pagar" ? { payment: "por_pagar" as const } : {}),
        }),
      ),
    )
  })

  app.get("/purchase-orders/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPurchaseOrder(tx, orgId, id)),
    )
  })

  app.get("/movements", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    if (query.kind && !(MOVEMENT_KIND as readonly string[]).includes(query.kind)) {
      return invalid(c, "Tipo de movimiento inválido")
    }
    if (query.productId && !isUuid(query.productId)) return invalid(c, "El producto del filtro no es válido")
    if (query.warehouseId && !isUuid(query.warehouseId)) return invalid(c, "El almacén del filtro no es válido")
    if (query.patientId && !isUuid(query.patientId)) return invalid(c, "El paciente del filtro no es válido")
    const limit = wholeNumber(query.limit)
    const offset = wholeNumber(query.offset)
    if (limit === null) return invalid(c, "La cantidad de movimientos por página debe ser un número entero")
    if (offset === null) return invalid(c, "La página pedida no es válida")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listMovements(tx, orgId, {
          productId: query.productId,
          warehouseId: query.warehouseId,
          kind: query.kind,
          patientId: query.patientId,
          from: query.from,
          to: query.to,
          limit,
          offset,
        }),
      ),
    )
  })

  app.get("/alerts", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.read", memberRole)
    if (denied) return denied
    const days = wholeNumber(c.req.query("expiryDays"))
    if (days === null) return invalid(c, "Los días para vencer deben ser un número entero")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAlerts(tx, orgId, days ?? 30)),
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
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    const parsed = productPatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateProduct(tx, orgId, userId, id, parsed.data)),
    )
  })

  app.post("/products/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    const parsed = activationInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setProductActive(tx, orgId, userId, id, parsed.data.isActive)),
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
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Proveedor no encontrado")
    const parsed = supplierInput.partial().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateSupplier(tx, orgId, userId, id, parsed.data)),
    )
  })

  app.post("/suppliers/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Proveedor no encontrado")
    const parsed = activationInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setSupplierActive(tx, orgId, userId, id, parsed.data.isActive)),
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
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Almacén no encontrado")
    const parsed = warehouseInput.partial().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateWarehouse(tx, orgId, userId, id, parsed.data)),
    )
  })

  app.post("/warehouses/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Almacén no encontrado")
    const parsed = activationInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setWarehouseActive(tx, orgId, userId, id, parsed.data.isActive)),
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
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => confirmPurchaseOrder(tx, orgId, userId, id)),
    )
  })

  app.post("/purchase-orders/:id/receive", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    const parsed = receptionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        receivePurchaseOrder(tx, orgId, userId, id, parsed.data.lines, parsed.data.idempotencyKey),
      ),
    )
  })

  app.post("/purchase-orders/:id/cancel", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    const parsed = cancelInput.safeParse((await c.req.json().catch(() => null)) ?? {})
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // Con pagos hay que decir qué pasa con ellos (anularlos o dejarlos a favor): eso es de caja.
    if (parsed.data.payments && !canAccess(memberRole, "finance.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Decidir qué pasa con lo pagado de una compra es de caja: pídeselo a quien la lleva"),
        403,
      )
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => cancelPurchaseOrder(tx, orgId, userId, id, parsed.data)),
    )
  })

  app.post("/movements", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "inventory.write", memberRole)
    if (denied) return denied
    const parsed = movementInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => recordMovement(tx, orgId, userId, parsed.data)),
    )
  })

  return app
}
