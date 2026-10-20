import { withOrgContext } from "@odentia/db"
import {
  addStock,
  adjustLot,
  cancelPurchaseOrder,
  closePurchaseOrder,
  confirmPurchaseOrder,
  countStock,
  createProduct,
  createPurchaseOrder,
  createReorderDrafts,
  createSupplier,
  createWarehouse,
  getProductDetail,
  getPurchaseOrder,
  getReorderSuggestions,
  importProducts,
  listMovements,
  listProducts,
  listPurchaseOrders,
  listSuppliers,
  listWarehouses,
  previewProductImport,
  receivePurchaseOrder,
  registerUse,
  setProductActive,
  setSupplierActive,
  setWarehouseActive,
  transferStock,
  updateProduct,
  updatePurchaseOrder,
  updateSupplier,
  updateWarehouse,
  writeOffExpired,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * Inventario por sede (ADR 0067). Leer es de quien ve el inventario con
 * precios (`inventory.read`) o sin ellos (`inventory.stock`, recepción): a
 * quien no ve precios la respuesta no los trae. Registrar lo que llegó y el
 * uso fuera de una atención es de `inventory.receive`; lo demás, de
 * `inventory.write`.
 */

const MOVEMENT_KIND = ["ingreso", "consumo", "ajuste", "traslado", "venta", "cobertura", "devolucion"] as const
const ORDER_STATUS = ["borrador", "confirmada", "parcialmente_recibida", "recibida", "cerrada", "cancelada"] as const
const ORDER_VIEW = ["por_llegar", "por_pagar", "borradores", "todas"] as const
const PRODUCT_NEED = ["hacen_falta", "por_vencer"] as const

// Cada dato lleva su frase: lo que no pasa la validación llega a la pantalla
// tal cual, nunca con el texto en inglés de la librería.
const NO_FORM = "No llegaron los datos del formulario. Vuelve a intentarlo."
const RETRY = "No se pudo identificar esta operación: cierra el formulario y vuelve a abrirlo"

/** Texto con su largo máximo; vacío o con espacios lo dice el servicio con sus palabras. */
const words = (field: string, max: number) =>
  z.string(`${field} no es válido`).max(max, `${field} admite hasta ${max} caracteres`)

const dateOnly = z.string("El vencimiento no es una fecha válida").regex(/^\d{4}-\d{2}-\d{2}$/, "El vencimiento no es una fecha válida")

const quantity = z.number("La cantidad debe ser un número").int("La cantidad debe ser un número entero")
const positive = quantity.positive("La cantidad debe ser mayor que cero")
const cents = (field: string) =>
  z.number(`${field} no es un importe válido`).int(`${field} no es un importe válido`).min(0, `${field} no puede ser negativo`)
const formKey = z.uuid(RETRY)
const note = words("El detalle", 500).nullish()

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

const minimumsInput = z
  .array(
    z.object(
      {
        branchId: z.uuid("Elige la sede del mínimo"),
        minQuantity: z
          .number("El mínimo debe ser un número")
          .int("El mínimo debe ser un número entero")
          .min(0, "El mínimo no puede ser negativo"),
      },
      "Un mínimo no es válido",
    ),
    "Los mínimos no son válidos",
  )
  .max(200, "Los mínimos no son válidos")

const productInput = z.object(
  {
    name: words("El nombre del producto", 200).min(1, "Escribe el nombre del producto"),
    sku: words("El código", 60).nullish(),
    usedInCare: z.boolean("Indica si se usa en las atenciones").optional(),
    forSale: z.boolean("Indica si se vende").optional(),
    unit: words("La unidad", 60).min(1, "Escribe la unidad en que se usa").optional(),
    unitCode: words("La unidad", 20).nullish(),
    purchaseUnit: words("La unidad de compra", 60).nullish(),
    purchaseUnitCode: words("La unidad de compra", 20).nullish(),
    purchaseFactor: z
      .number("Cuántas trae cada unidad de compra debe ser un número")
      .int("Cuántas trae cada unidad de compra debe ser un número entero")
      .min(1, "Cada unidad de compra trae al menos 1")
      .max(100_000, "Cada unidad de compra trae hasta 100000")
      .optional(),
    minimums: minimumsInput.optional(),
    salePriceCents: cents("El precio de venta").nullish(),
  },
  NO_FORM,
)

const productPatch = productInput.partial()

const sheetValue = z.union([z.number("«Hay» no es un número"), words("Un número de la lista", 40)], "Un número de la lista no es válido").nullish()

const importRow = z.object(
  {
    name: words("El nombre", 300).nullish(),
    unit: words("La unidad", 120).nullish(),
    onHand: sheetValue,
    minQuantity: sheetValue,
    productId: z.uuid("El producto elegido no es válido").nullish(),
  },
  "Una fila de la lista no es válida",
)

const importRows = z
  .array(importRow, "Pega al menos una fila")
  .min(1, "Pega al menos una fila")
  .max(500, "Se pegan hasta 500 filas por vez: divide la lista")

const previewInput = z.object({ branchId: z.uuid("Elige la sede"), rows: importRows }, NO_FORM)
const importInput = z.object({ branchId: z.uuid("Elige la sede"), rows: importRows, idempotencyKey: formKey }, NO_FORM)

const countInput = z.object(
  {
    branchId: z.uuid("Elige la sede"),
    idempotencyKey: formKey,
    items: z
      .array(
        z.object(
          {
            productId: z.uuid("Un producto del conteo no es válido"),
            counted: z
              .number("Lo que hay debe ser un número")
              .int("Lo que hay debe ser un número entero")
              .min(0, "Lo que hay no puede ser negativo"),
          },
          "Un producto del conteo no es válido",
        ),
        "Escribe lo que hay de al menos un producto",
      )
      .min(1, "Escribe lo que hay de al menos un producto")
      .max(2000, "Se cuentan hasta 2000 productos por vez"),
  },
  NO_FORM,
)

const writeOffInput = z.object({ branchId: z.uuid("Elige la sede"), idempotencyKey: formKey }, NO_FORM)

const adjustInput = z.object(
  {
    counted: z.number("Cuántos hay debe ser un número").int("Cuántos hay debe ser un número entero").min(0, "Cuántos hay no puede ser negativo"),
    reason: z.enum(["conteo", "se_dano", "vencio", "otro"], "Elige por qué se ajusta"),
    note,
    idempotencyKey: formKey,
  },
  NO_FORM,
)

const usageInput = z.object(
  {
    productId: z.uuid("Elige el producto"),
    branchId: z.uuid("Elige la sede"),
    quantity: positive,
    lotId: z.uuid("Elige el lote").nullish(),
    patientId: z.uuid("Elige el paciente").nullish(),
    note,
    idempotencyKey: formKey,
  },
  NO_FORM,
)

const transferInput = z.object(
  {
    productId: z.uuid("Elige el producto"),
    fromBranchId: z.uuid("Elige la sede de donde sale"),
    toBranchId: z.uuid("Elige la sede a la que va"),
    quantity: positive,
    lotId: z.uuid("Elige el lote").nullish(),
    note,
    idempotencyKey: formKey,
  },
  NO_FORM,
)

const additionInput = z.object(
  {
    productId: z.uuid("Elige el producto"),
    branchId: z.uuid("Elige la sede"),
    quantity: positive,
    lotCode: words("El código de lote", 120).nullish(),
    expiresAt: dateOnly.nullish(),
    reason: z.enum(["muestra", "otro"], "Elige por qué entra"),
    note,
    idempotencyKey: formKey,
  },
  NO_FORM,
)

const lotInput = z.object(
  {
    quantity: positive,
    lotCode: words("El código de lote", 120).nullish(),
    expiresAt: dateOnly.nullish(),
  },
  "Un lote no es válido",
)

const lotsInput = z.array(lotInput, "Los lotes no son válidos").min(1, "Escribe cuánto llegó en cada lote").max(50, "Un producto admite hasta 50 lotes")

const orderLineInput = z.object(
  {
    productId: z.uuid("Elige el producto de cada línea"),
    quantity: positive,
    unitCostCents: cents("El costo por unidad").optional(),
    lots: lotsInput.optional(),
  },
  "Una línea de la orden no es válida",
)

const orderLines = z
  .array(orderLineInput, "La orden necesita al menos una línea")
  .min(1, "La orden necesita al menos una línea")
  .max(200, "La orden admite hasta 200 líneas")

const orderInput = z.object(
  {
    supplierId: z.uuid("Elige el proveedor"),
    branchId: z.uuid("Elige la sede a la que llega la compra").nullish(),
    warehouseId: z.uuid("Elige el almacén de destino").nullish(),
    mode: z.enum(["borrador", "pedir", "ya_la_tengo"], "Elige si la compra se pide o ya la tienes").optional(),
    currency: z.string("La moneda de la orden no es válida").regex(/^[A-Z]{3}$/, "La moneda de la orden no es válida").optional(),
    notes: words("Las notas", 2000).nullish(),
    lines: orderLines,
  },
  NO_FORM,
)

const orderPatch = z.object(
  {
    supplierId: z.uuid("Elige el proveedor").optional(),
    branchId: z.uuid("Elige la sede a la que llega la compra").nullish(),
    warehouseId: z.uuid("Elige el almacén de destino").nullish(),
    notes: words("Las notas", 2000).nullish(),
    lines: orderLines.optional(),
  },
  NO_FORM,
)

const receptionInput = z.object(
  {
    idempotencyKey: z.uuid("No se pudo identificar esta recepción: vuelve a abrir la orden e inténtalo de nuevo"),
    lines: z
      .array(
        z
          .object(
            {
              productId: z.uuid("Un producto de la recepción no es válido"),
              quantity: quantity.positive("La cantidad recibida debe ser mayor que cero").optional(),
              lotCode: words("El código de lote", 120).nullish(),
              expiresAt: dateOnly.nullish(),
              lots: lotsInput.optional(),
              unitCostCents: cents("El precio de la factura").optional(),
            },
            "Una línea de la recepción no es válida",
          )
          .refine((line) => line.quantity !== undefined || (line.lots?.length ?? 0) > 0, "Escribe cuánto llegó de cada producto"),
        "La recepción necesita al menos una línea",
      )
      .min(1, "La recepción necesita al menos una línea")
      .max(200, "La recepción admite hasta 200 líneas"),
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

const reorderInput = z.object({ branchId: z.uuid("Elige la sede") }, NO_FORM)

const isUuid = (value: string | undefined): value is string => value !== undefined && z.uuid().safeParse(value).success

/** Un número entero sin signo escrito en la dirección, o `undefined` si no vino. */
function wholeNumber(value: string | undefined): number | undefined | null {
  if (value === undefined || value === "") return undefined
  return /^\d{1,9}$/.test(value) ? Number(value) : null
}

type Access = "read" | "receive" | "write"

const FORBIDDEN: Record<Access, string> = {
  read: "No tienes permiso para ver el inventario",
  receive: "No tienes permiso para registrar lo que llega o se usa del inventario",
  write: "No tienes permiso para cambiar el inventario",
}

export function createInventoryRoute(deps: CrmDeps) {
  const app = new Hono()

  /** Ver es con precios (`inventory.read`) o sin ellos (`inventory.stock`). */
  const allowed = (role: string, access: Access) =>
    access === "read"
      ? canAccess(role, "inventory.read") || canAccess(role, "inventory.stock")
      : access === "receive"
        ? canAccess(role, "inventory.receive") || canAccess(role, "inventory.write")
        : canAccess(role, "inventory.write")
  const deny = (c: Context, access: Access, role: string) =>
    allowed(role, access) ? null : c.json(errorBody(c, "FORBIDDEN", FORBIDDEN[access]), 403)
  /** A quien no ve precios, la API no se los entrega. */
  const seesPrices = (role: string) => canAccess(role, "inventory.read")
  const invalid = (c: Context, message: string) => c.json(errorBody(c, "VALIDATION", message), 400)
  // Un id que no puede existir es un «no encontrado», no un error del servidor.
  const missing = (c: Context, message: string) => c.json(errorBody(c, "NOT_FOUND", message), 404)
  const body = async (c: Context) => c.req.json().catch(() => null)

  /* ---------------- productos ---------------- */

  app.get("/products", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    if (query.branchId && !isUuid(query.branchId)) return invalid(c, "La sede del filtro no es válida")
    if (query.need && !(PRODUCT_NEED as readonly string[]).includes(query.need)) return invalid(c, "El filtro de productos no es válido")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listProducts(tx, orgId, {
          branchId: query.branchId,
          q: query.q,
          need: query.need as (typeof PRODUCT_NEED)[number] | undefined,
          prices: seesPrices(memberRole),
        }),
      ),
    )
  })

  app.post("/products/import/preview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = previewInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => previewProductImport(tx, orgId, parsed.data.branchId, parsed.data.rows)),
    )
  })

  app.post("/products/import", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = importInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { branchId, rows, idempotencyKey } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => importProducts(tx, orgId, userId, branchId, rows, idempotencyKey)),
    )
  })

  app.get("/products/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    const branchId = c.req.query("branchId")
    if (branchId && !isUuid(branchId)) return invalid(c, "La sede del filtro no es válida")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getProductDetail(tx, orgId, id, { branchId, prices: seesPrices(memberRole) })),
    )
  })

  app.post("/products", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = productInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createProduct(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/products/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    const parsed = productPatch.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateProduct(tx, orgId, userId, id, parsed.data)),
    )
  })

  app.post("/products/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    const parsed = activationInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setProductActive(tx, orgId, userId, id, parsed.data.isActive)),
    )
  })

  // «Dar de baja» lo vencido de la sede, sin formulario.
  app.post("/products/:id/write-off", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Producto no encontrado")
    const parsed = writeOffInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        writeOffExpired(tx, orgId, userId, id, parsed.data.branchId, parsed.data.idempotencyKey),
      ),
    )
  })

  /* ---------------- contar y movimientos sueltos ---------------- */

  app.post("/count", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = countInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { branchId, items, idempotencyKey } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => countStock(tx, orgId, userId, branchId, items, idempotencyKey)),
    )
  })

  app.post("/lots/:id/adjust", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Lote no encontrado")
    const parsed = adjustInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => adjustLot(tx, orgId, userId, { lotId: id, ...parsed.data })),
    )
  })

  // «Registrar uso»: lo que se usó o se regaló fuera de una atención (recepción también).
  app.post("/usage", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "receive", memberRole)
    if (denied) return denied
    const parsed = usageInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => registerUse(tx, orgId, userId, parsed.data)))
  })

  app.post("/transfers", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = transferInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => transferStock(tx, orgId, userId, parsed.data)))
  })

  // «Agregar sin compra»: una muestra, un regalo o algo que apareció.
  app.post("/additions", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = additionInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => addStock(tx, orgId, userId, parsed.data)))
  })

  app.get("/movements", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    if (query.kind && !(MOVEMENT_KIND as readonly string[]).includes(query.kind)) return invalid(c, "Tipo de movimiento inválido")
    if (query.branchId && !isUuid(query.branchId)) return invalid(c, "La sede del filtro no es válida")
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
          branchId: query.branchId,
          productId: query.productId,
          warehouseId: query.warehouseId,
          patientId: query.patientId,
          q: query.q,
          kind: query.kind,
          from: query.from,
          to: query.to,
          limit,
          offset,
        }),
      ),
    )
  })

  /* ---------------- proveedores y almacenes ---------------- */

  app.get("/suppliers", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listSuppliers(tx, orgId, { q: query.q, onlyActive: query.onlyActive === "true", prices: seesPrices(memberRole) }),
      ),
    )
  })

  app.post("/suppliers", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = supplierInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createSupplier(tx, orgId, userId, parsed.data)))
  })

  app.patch("/suppliers/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Proveedor no encontrado")
    const parsed = supplierInput.partial().safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updateSupplier(tx, orgId, userId, id, parsed.data)))
  })

  app.post("/suppliers/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Proveedor no encontrado")
    const parsed = activationInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setSupplierActive(tx, orgId, userId, id, parsed.data.isActive)),
    )
  })

  app.get("/warehouses", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const branchId = c.req.query("branchId")
    if (branchId && !isUuid(branchId)) return invalid(c, "La sede del filtro no es válida")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listWarehouses(tx, orgId, { onlyActive: c.req.query("onlyActive") === "true", branchId }),
      ),
    )
  })

  app.post("/warehouses", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = warehouseInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createWarehouse(tx, orgId, userId, parsed.data)))
  })

  app.patch("/warehouses/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Almacén no encontrado")
    const parsed = warehouseInput.partial().safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updateWarehouse(tx, orgId, userId, id, parsed.data)))
  })

  app.post("/warehouses/:id/activation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Almacén no encontrado")
    const parsed = activationInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setWarehouseActive(tx, orgId, userId, id, parsed.data.isActive)),
    )
  })

  /* ---------------- compras ---------------- */

  app.get("/purchase-orders", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const query = c.req.query()
    const view = query.pago === "por_pagar" ? "por_pagar" : (query.view ?? "todas")
    if (!(ORDER_VIEW as readonly string[]).includes(view)) return invalid(c, "La vista de compras no es válida")
    if (view === "por_pagar" && !seesPrices(memberRole))
      return c.json(errorBody(c, "FORBIDDEN", "Lo que falta pagar de las compras lo ve quien lleva las compras"), 403)
    if (query.status && !(ORDER_STATUS as readonly string[]).includes(query.status)) return invalid(c, "Estado de orden inválido")
    if (query.supplierId && !isUuid(query.supplierId)) return invalid(c, "El proveedor del filtro no es válido")
    if (query.branchId && !isUuid(query.branchId)) return invalid(c, "La sede del filtro no es válida")
    const limit = wholeNumber(query.limit)
    const offset = wholeNumber(query.offset)
    if (limit === null) return invalid(c, "La cantidad de compras por página debe ser un número entero")
    if (offset === null) return invalid(c, "La página pedida no es válida")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listPurchaseOrders(tx, orgId, {
          branchId: query.branchId,
          view: view as (typeof ORDER_VIEW)[number],
          status: query.status,
          supplierId: query.supplierId,
          q: query.q,
          prices: seesPrices(memberRole),
          limit,
          offset,
        }),
      ),
    )
  })

  app.get("/purchase-orders/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "read", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPurchaseOrder(tx, orgId, id, { prices: seesPrices(memberRole) })),
    )
  })

  app.post("/purchase-orders", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = orderInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createPurchaseOrder(tx, orgId, userId, parsed.data)))
  })

  // Editar un borrador: sus productos se reemplazan.
  app.patch("/purchase-orders/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    const parsed = orderPatch.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updatePurchaseOrder(tx, orgId, userId, id, parsed.data)))
  })

  app.post("/purchase-orders/:id/confirm", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => confirmPurchaseOrder(tx, orgId, userId, id)))
  })

  // «Registrar lo que llegó»: recepción también, sin tocar precios.
  app.post("/purchase-orders/:id/receive", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "receive", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    const parsed = receptionInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // El precio de la factura cambia lo que se debe: es de quien lleva las compras.
    if (parsed.data.lines.some((line) => line.unitCostCents !== undefined) && !canAccess(memberRole, "inventory.write"))
      return c.json(errorBody(c, "FORBIDDEN", "Corregir el precio de la factura es de quien lleva las compras"), 403)
    const prices = seesPrices(memberRole)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await receivePurchaseOrder(tx, orgId, userId, id, parsed.data.lines, parsed.data.idempotencyKey)
        return getPurchaseOrder(tx, orgId, id, { prices })
      }),
    )
  })

  app.post("/purchase-orders/:id/close", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => closePurchaseOrder(tx, orgId, userId, id)))
  })

  app.post("/purchase-orders/:id/cancel", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const id = c.req.param("id")
    if (!isUuid(id)) return missing(c, "Orden de compra no encontrada")
    const parsed = cancelInput.safeParse((await body(c)) ?? {})
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // Con pagos hay que decir qué pasa con ellos (anularlos o dejarlos a favor): eso es de caja.
    if (parsed.data.payments && !canAccess(memberRole, "finance.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Decidir qué pasa con lo pagado de una compra es de caja: pídeselo a quien la lleva"),
        403,
      )
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => cancelPurchaseOrder(tx, orgId, userId, id, parsed.data)))
  })

  /* ---------------- pedir lo que falta ---------------- */

  app.get("/reorder", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const branchId = c.req.query("branchId")
    if (branchId && !isUuid(branchId)) return invalid(c, "La sede del filtro no es válida")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getReorderSuggestions(tx, orgId, branchId, { prices: seesPrices(memberRole) })),
    )
  })

  app.post("/reorder/drafts", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const denied = deny(c, "write", memberRole)
    if (denied) return denied
    const parsed = reorderInput.safeParse(await body(c))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createReorderDrafts(tx, orgId, userId, parsed.data.branchId)))
  })

  return app
}
