import type { Db } from "@odentia/db"
import {
  encounter,
  encounterProcedure,
  patient,
  patientCharge,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
  paymentReturn,
  paymentTicket,
  ticketCounter,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { cashClosure } from "@odentia/db/schema/finance"
import { product } from "@odentia/db/schema/inventory"
import { auditEvent } from "@odentia/db/schema/org"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { user } from "@odentia/db/schema/auth"
import { and, asc, desc, eq, inArray, isNull, or, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { orgProfileRequired } from "./locale.js"
import {
  ensureOpenShift,
  hasClosureSince,
  recordCashEgreso,
  recordCashIncome,
  requireBranch,
  reverseCashIncome,
} from "./finance.js"
import { isCashLike, requirePaymentMethod } from "./payment-methods.js"
import { requirePromotionPrice } from "./promotions.js"
import { budgetLineUnits } from "./budgets.js"
import { requirePatient } from "./patients.js"
import { requireLinkedActiveContact } from "./responsibilities.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { clinicToday, consumeFefo, defaultWarehouse, returnSold, stockBySede } from "./inventory-stock.js"
import { quantityWords } from "@odentia/clinical"
import { findOrgLocale } from "./locale.js"
import { foldedWordsMatch } from "./search-text.js"

/** Aviso en vivo para el stream del home (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

export function assertPositiveCents(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw validation("El importe debe ser un entero mayor que cero")
  return value
}
function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value))
    throw validation("La moneda debe ser un código ISO 4217 de tres letras")
  return value
}
function reason(value: string): string {
  const text = value?.trim()
  if (!text || text.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  return text
}
function instant(value: string): Date {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()))
    throw validation("Fecha ISO inválida")
  return date
}
function sum(rows: ReadonlyArray<{ amountCents: number }>): number {
  let total = 0
  for (const row of rows) {
    total += row.amountCents
    if (!Number.isSafeInteger(total)) throw validation("El total excede el rango exacto admitido")
  }
  return total
}
function conflict(code: string, message: string) {
  return new ServiceError(code, 409, message)
}
// Serializa aplicaciones, anulaciones y devoluciones del paciente para impedir sobregiros.
async function lockAccount(tx: Db, orgId: string, patientId: string) {
  const [row] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  if (!row) throw notFound("Paciente")
}
async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entity: string,
  id: string,
  action: string,
  metadata?: Record<string, unknown>,
) {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity, entityId: id, action, ...(metadata ? { metadata } : {}) })
}
async function chargeRow(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx
    .select()
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.id, id),
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
      ),
    )
  if (!row) throw notFound("Cargo")
  if (row.voidedAt) throw conflict("CHARGE_VOIDED", "El cargo está anulado")
  return row
}
export interface CreateChargeInput {
  budgetItemId?: string | null
  /**
   * Producto que se vende desde «Cobrar» (ADR 0067): el concepto toma su
   * nombre y su precio de venta × `quantity`, exige la sede y descuenta de su
   * almacén principal al crearse. Sin tratamiento, atención ni importe propio.
   */
  productId?: string | null
  /** Unidades de uso del producto vendidas (1 por defecto). */
  quantity?: number | null
  /**
   * Clave del formulario de la venta, obligatoria con `productId`: un
   * reintento tras un corte devuelve el mismo concepto sin vender ni
   * descontar otra vez.
   */
  requestKey?: string | null
  encounterProcedureId?: string | null
  planItemId?: string | null
  /** Sede del concepto manual (los de acto/presupuesto la heredan de su fuente). */
  branchId?: string | null
  /** Promoción para un acto con servicio (la línea presupuestaria ya trae la suya). */
  promotionId?: string | null
  /**
   * Promoción que ya se acordó en un presupuesto aceptado: el cargo la hereda
   * tal cual (nombre y precio congelados). No se vuelve a exigir que siga
   * vigente: lo aceptado a tiempo se cobra aunque la promoción haya terminado.
   */
  frozenPromotion?: { id: string; name: string } | null
  description?: string
  amountCents?: number
  currency?: string
  dueAt?: string | null
  notes?: string | null
}
export async function createCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateChargeInput,
) {
  const orgUnit = await lockOrgCurrency(tx, orgId)
  await lockAccount(tx, orgId, patientId)
  if (input.budgetItemId && input.encounterProcedureId)
    throw validation("Seleccione una sola fuente del cargo")
  if (input.productId && (input.budgetItemId || input.encounterProcedureId || input.planItemId))
    throw validation("Un producto se cobra solo, sin tratamiento ni atención")
  if (!input.productId && input.quantity != null) throw validation("La cantidad solo va con un producto")
  let planItemId = input.planItemId ?? null
  let description = input.description?.trim() ?? ""
  let amountCents = input.amountCents
  let unit = input.currency
  let branchId = input.branchId ?? null
  let promotionId: string | null = null
  let promotionName: string | null = null
  if (branchId) await requireBranch(tx, orgId, branchId)
  let sale: { productId: string; quantity: number; branchId: string } | null = null
  if (input.productId) {
    // El precio viene del producto: si hay que cambiarlo en un cobro, es la
    // corrección con motivo de cualquier concepto (no toca lo que hay).
    if (input.amountCents !== undefined || input.description?.trim())
      throw validation("El importe y el concepto de un producto salen de su precio de venta: corrígelos después con motivo")
    const quantity = input.quantity ?? 1
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999)
      throw validation("La cantidad va de 1 a 9999")
    if (!branchId) throw validation("Elige la sede del cobro: el producto sale de su almacén")
    const [item] = await tx
      .select({
        id: product.id,
        name: product.name,
        isActive: product.isActive,
        forSale: product.forSale,
        salePriceCents: product.salePriceCents,
        saleCurrency: product.saleCurrency,
      })
      .from(product)
      .where(and(eq(product.organizationId, orgId), eq(product.id, input.productId)))
      .limit(1)
    if (!item) throw notFound("Producto")
    if (!item.isActive) throw conflict("PRODUCT_INACTIVE", `«${item.name}» está desactivado: no se puede vender`)
    if (!item.forSale)
      throw conflict("PRODUCT_NOT_FOR_SALE", `«${item.name}» no se vende: márcalo así en Inventario para cobrarlo`)
    if (item.salePriceCents === null || item.salePriceCents <= 0 || !item.saleCurrency)
      throw conflict("PRODUCT_WITHOUT_PRICE", `«${item.name}» no tiene precio de venta: ponlo en Inventario para cobrarlo`)
    if (input.currency && input.currency !== item.saleCurrency)
      throw conflict("CURRENCY_MISMATCH", "La moneda no coincide con el precio de venta del producto")
    const requestKey = input.requestKey?.trim() ?? ""
    if (!requestKey || requestKey.length > 120)
      throw validation("No se pudo identificar esta venta: cierra el cobro y vuelve a abrirlo")
    // El mismo formulario otra vez (un corte de red): el concepto ya existe y ya descontó.
    const [prior] = await tx
      .select()
      .from(patientCharge)
      .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.requestKey, requestKey)))
      .limit(1)
    if (prior) {
      if (prior.patientId !== patientId || prior.productId !== input.productId || prior.productQuantity !== quantity)
        throw conflict("CONFLICT", "Esta venta ya se registró con otros datos. Cierra el cobro y vuelve a abrirlo.")
      return prior
    }
    // «Cepillo dental suave × 2»; con uno solo, el nombre.
    description = quantity === 1 ? item.name : `${item.name} × ${quantity}`
    amountCents = item.salePriceCents * quantity
    unit = item.saleCurrency
    sale = { productId: item.id, quantity, branchId }
  }
  if (input.budgetItemId) {
    const [source] = await tx
      .select({ line: treatmentBudgetItem, budget: treatmentBudget })
      .from(treatmentBudgetItem)
      .innerJoin(
        treatmentBudget,
        and(
          eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
          eq(treatmentBudget.organizationId, orgId),
          eq(treatmentBudget.patientId, patientId),
        ),
      )
      .where(
        and(
          eq(treatmentBudgetItem.id, input.budgetItemId),
          eq(treatmentBudgetItem.organizationId, orgId),
          eq(treatmentBudgetItem.patientId, patientId),
        ),
      )
    if (!source) throw notFound("Línea presupuestaria")
    await tx
      .select({ id: treatmentPlan.id })
      .from(treatmentPlan)
      .where(
        and(eq(treatmentPlan.id, source.budget.planId), eq(treatmentPlan.organizationId, orgId)),
      )
      .for("update")
    const [budget] = await tx
      .select()
      .from(treatmentBudget)
      .where(
        and(eq(treatmentBudget.id, source.budget.id), eq(treatmentBudget.organizationId, orgId)),
      )
    if (!["aceptado", "parcial"].includes(budget.status) || source.line.decision !== "aceptado")
      throw conflict(
        "BUDGET_NOT_ACCEPTED",
        "La línea no pertenece a una propuesta aceptada vigente",
      )
    if (planItemId && planItemId !== source.line.planItemId)
      throw validation("El cargo conserva el tratamiento de su fuente")
    planItemId = source.line.planItemId
    // La promoción se acordó al presupuestar con la misma regla: el cargo hereda el snapshot.
    if (input.promotionId && input.promotionId !== source.line.promotionId)
      throw validation("La promoción del cargo es la de su línea presupuestaria")
    promotionId = source.line.promotionId
    promotionName = source.line.promotionName
    const [pricedItem] = await tx
      .select({ priceCents: treatmentPlanItem.priceCents })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, source.line.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
    const itemPrice = pricedItem?.priceCents ?? null
    description = source.line.title
    unit = source.line.currency
    if (input.currency && input.currency !== unit)
      throw conflict("CURRENCY_MISMATCH", "La moneda no coincide con la propuesta")
    // El cargo respeta el precio acordado de la línea, no la tarifa: una
    // revisión crea otra línea del mismo tratamiento y solo habilita la
    // diferencia. En modo sesión cada visita cobra el precio por sesión con
    // tope de visitas planificadas.
    const generated = await tx
      .select({
        // Lo cobrado de un tratamiento incluye lo devuelto (ADR 0068): una
        // devolución no deja «por generar» lo que ya se cobró.
        amountCents: sql<number>`${patientCharge.amountCents} + ${patientCharge.returnedCents}`.mapWith(Number),
        encounterProcedureId: patientCharge.encounterProcedureId,
      })
      .from(patientCharge)
      .where(
        and(
          eq(patientCharge.organizationId, orgId),
          eq(patientCharge.patientId, patientId),
          eq(patientCharge.planItemId, source.line.planItemId),
          eq(patientCharge.currency, unit),
          isNull(patientCharge.voidedAt),
        ),
      )
    // En sesión cada visita atendida cuenta (acto no nulo), igual que el cierre clínico.
    const visitCount = generated.filter((g) => g.encounterProcedureId !== null).length
    if (source.line.billingMode === "session") {
      const planned = source.line.sessionsPlanned ?? 1
      if (visitCount >= planned)
        throw conflict("CHARGE_EXCEEDS_BUDGET", "El tratamiento ya tiene cobradas sus visitas planificadas")
      const sessionPrice = source.line.priceCents ?? itemPrice ?? 0
      if (sessionPrice <= 0)
        throw conflict("CHARGE_EXCEEDS_BUDGET", "La línea no tiene precio por sesión acordado")
      amountCents ??= sessionPrice
      if (amountCents > sessionPrice)
        throw conflict(
          "CHARGE_EXCEEDS_BUDGET",
          "El cargo supera el precio por sesión acordado",
        )
    } else {
      const agreed = source.line.priceCents ?? itemPrice ?? 0
      const remaining = agreed - sum(generated)
      if (remaining <= 0)
        throw conflict("CHARGE_EXCEEDS_BUDGET", "El tratamiento ya tiene cargado el importe acordado")
      amountCents ??= remaining
      if (amountCents > remaining)
        throw conflict(
          "CHARGE_EXCEEDS_BUDGET",
          "El cargo supera el importe pendiente de generar de este tratamiento",
        )
    }
  } else if (input.encounterProcedureId) {
    const [source] = await tx
      .select({ procedure: encounterProcedure, branchId: encounter.branchId })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(
          eq(encounter.id, encounterProcedure.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
      .where(
        and(
          eq(encounterProcedure.id, input.encounterProcedureId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
    if (!source) throw notFound("Procedimiento")
    // Sin servicio no hay tarifa: el acto libre nunca genera cargo.
    if (!source.procedure.serviceId) {
      throw conflict("ACT_NOT_BILLABLE", "El acto libre no genera cargo (no tiene precio)")
    }
    if (planItemId && planItemId !== source.procedure.planItemId)
      throw validation("El cargo conserva el tratamiento de su fuente")
    if (branchId && branchId !== source.branchId)
      throw validation("El cargo conserva la sede de su atención")
    branchId = source.branchId
    planItemId = source.procedure.planItemId
    description = source.procedure.description
    // El costo viaja con el acto: importe y moneda del snapshot registrado.
    amountCents ??= source.procedure.priceCents ?? undefined
    unit ??= source.procedure.currency ?? undefined
    if (input.frozenPromotion) {
      promotionId = input.frozenPromotion.id
      promotionName = input.frozenPromotion.name
    } else if (input.promotionId) {
      // Promoción al cobrar un servicio incluido: exige precio final si es «desde» (misma regla).
      const snapshot = await requirePromotionPrice(
        tx,
        orgId,
        input.promotionId,
        source.procedure.serviceId,
        amountCents,
      )
      // El precio fijo manda; el «desde» ya validó el final contra su mínimo.
      if (snapshot.mode === "fixed") amountCents = snapshot.priceCents
      promotionId = input.promotionId
      promotionName = snapshot.promotionName
    }
  }
  if (!input.budgetItemId && !input.encounterProcedureId) unit ??= orgUnit
  if (input.promotionId && !input.budgetItemId && !input.encounterProcedureId)
    throw validation("La promoción requiere un concepto con servicio: aplícala con update al concepto")
  if (planItemId) {
    const [item] = await tx
      .select({ id: treatmentPlanItem.id })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
    if (!item) throw notFound("Tratamiento")
  }
  if (!description || description.length > 2000)
    throw validation("La descripción debe tener 1–2000 caracteres")
  if (amountCents === undefined || !unit)
    throw validation("El importe y la moneda son obligatorios")
  const [row] = await tx
    .insert(patientCharge)
    .values({
      organizationId: orgId,
      patientId,
      planItemId,
      branchId,
      budgetItemId: input.budgetItemId,
      encounterProcedureId: input.encounterProcedureId,
      promotionId,
      promotionName,
      description,
      amountCents: assertPositiveCents(amountCents),
      currency: currency(unit),
      dueAt: input.dueAt ? instant(input.dueAt) : null,
      notes: input.notes,
      productId: sale?.productId ?? null,
      productQuantity: sale?.quantity ?? null,
      requestKey: sale ? (input.requestKey?.trim() ?? null) : null,
      createdBy: actorUserId,
    })
    .returning()
  if (sale) {
    // Sale de la clínica al agregarlo, aunque se pague después: del almacén
    // principal de la sede, del lote que vence primero; si no había, queda
    // como faltante (la venta no se bloquea).
    const store = await defaultWarehouse(tx, orgId, sale.branchId)
    await consumeFefo(tx, orgId, {
      productId: sale.productId,
      warehouseId: store.id,
      quantity: sale.quantity,
      allowShortage: true,
      // Lo vencido no se vende: sale de los lotes vigentes.
      usableOn: await clinicToday(tx, orgId),
      base: {
        kind: "venta",
        reason: `Vendido a ${await patientName(tx, orgId, patientId)}`,
        actorUserId,
        keyPrefix: `venta:${row.id}`,
        patientId,
        chargeId: row.id,
      },
    })
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "patient_charge",
    row.id,
    "charge.created",
    sale ? { patientId, productId: sale.productId, quantity: sale.quantity } : undefined,
  )
  return row
}

/** El nombre de la persona del paciente, para el motivo de lo que se le vende. */
async function patientName(tx: Db, orgId: string, patientId: string): Promise<string> {
  const [row] = await tx
    .select({ displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  return row?.displayName ?? "un paciente"
}
export interface SaleProduct {
  productId: string
  name: string
  /** Unidad de uso, en singular: se vende por ella («1 frasco»). */
  unit: string
  /** Precio de venta por unidad; null si el producto aún no tiene precio (no se puede agregar). */
  salePriceCents: number | null
  currency: string | null
  /** Lo que hay en la sede del cobro (lotes − faltante; puede ser negativo). */
  onHand: number
  /** «4 frascos»; null si no hay: «No hay en Miraflores: quedará como faltante». */
  onHandText: string | null
}

/**
 * «+ Agregar producto» en «Cobrar»: productos activos que se venden, por
 * nombre o código, con su precio de venta y lo que hay en la sede del cobro.
 * Nunca el costo: Caja no lo ve.
 */
export async function listSaleProducts(
  tx: Db,
  orgId: string,
  input: { branchId: string; q?: string; limit?: number },
): Promise<{ branch: { id: string; name: string }; items: SaleProduct[] }> {
  const site = await requireBranch(tx, orgId, input.branchId)
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  const conditions = [eq(product.organizationId, orgId), eq(product.isActive, true), eq(product.forSale, true)]
  const q = input.q?.trim()
  if (q) conditions.push(foldedWordsMatch([product.name, product.sku], q))
  const rows = await tx
    .select({
      productId: product.id,
      name: product.name,
      unit: product.unit,
      salePriceCents: product.salePriceCents,
      currency: product.saleCurrency,
    })
    .from(product)
    .where(and(...conditions))
    .orderBy(asc(product.name), asc(product.id))
    .limit(limit)
  const stock = await stockBySede(tx, orgId, { branchId: site.id, productIds: rows.map((row) => row.productId) })
  const { locale } = await findOrgLocale(tx, orgId)
  return {
    branch: { id: site.id, name: site.name },
    items: rows.map((row) => {
      const onHand = stock.get(row.productId)?.onHand ?? 0
      return {
        ...row,
        salePriceCents: row.salePriceCents !== null && row.salePriceCents > 0 ? row.salePriceCents : null,
        onHand,
        onHandText: onHand > 0 ? quantityWords(onHand, row.unit, locale) : null,
      }
    }),
  }
}

export async function voidCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: string },
) {
  await lockAccount(tx, orgId, patientId)
  const current = await chargeRow(tx, orgId, patientId, id)
  const [application] = await tx
    .select({ id: patientPaymentApplication.id })
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        eq(patientPaymentApplication.chargeId, id),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
    .limit(1)
  if (application)
    throw conflict("CHARGE_HAS_APPLICATIONS", "Anule las aplicaciones antes de anular el cargo")
  const [row] = await tx
    .update(patientCharge)
    .set({
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: reason(input.reason),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(patientCharge.id, id),
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
      ),
    )
    .returning()
  if (current.productId) {
    // Quitar el concepto de un producto lo devuelve: cada lote recibe lo
    // suyo y lo que se vendió sin haber baja el faltante. Las salidas viven en
    // el concepto original; lo que ya volvió en una devolución no vuelve dos veces.
    const original = rootOfCharge(current)
    await returnSold(tx, orgId, {
      chargeId: original,
      base: {
        kind: "devolucion",
        reason: `Venta anulada: ${current.description}`,
        actorUserId,
        keyPrefix: `venta-anulada:${id}`,
        patientId,
        chargeId: original,
      },
    })
  }
  await audit(tx, orgId, actorUserId, "patient_charge", id, "charge.voided", {
    patientId,
    description: row?.description,
    amountCents: row?.amountCents,
    currency: row?.currency,
    reason: row?.voidReason,
  })
  return row
}
// --- Edición de conceptos (corrige lo que quedó por cobrar, con motivo) -----------------

export interface UpdateChargeInput {
  amountCents?: number
  description?: string
  /** Promoción a aplicar al cobrar (exige servicio en el concepto); null la quita. */
  promotionId?: string | null
  /** Obligatorio al cambiar importe o descripción; una promoción es su propio motivo. */
  reason?: string | null
}

/** Servicio del concepto: el de su acto o el de su línea presupuestaria. */
async function chargeServiceId(
  tx: Db,
  orgId: string,
  charge: { budgetItemId: string | null; encounterProcedureId: string | null },
): Promise<{ serviceId: string | null; sourcePriceCents: number | null }> {
  if (charge.encounterProcedureId) {
    const [procedure] = await tx
      .select({ serviceId: encounterProcedure.serviceId, priceCents: encounterProcedure.priceCents })
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.id, charge.encounterProcedureId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
    return { serviceId: procedure?.serviceId ?? null, sourcePriceCents: procedure?.priceCents ?? null }
  }
  if (charge.budgetItemId) {
    const [line] = await tx
      .select({ serviceId: treatmentBudgetItem.serviceId, priceCents: treatmentBudgetItem.priceCents })
      .from(treatmentBudgetItem)
      .where(
        and(
          eq(treatmentBudgetItem.id, charge.budgetItemId),
          eq(treatmentBudgetItem.organizationId, orgId),
        ),
      )
    return { serviceId: line?.serviceId ?? null, sourcePriceCents: line?.priceCents ?? null }
  }
  return { serviceId: null, sourcePriceCents: null }
}

/**
 * Corrige un concepto sin cobros aplicados: importe, descripción o promoción.
 * Con cobros aplicados no se reescribe (se cobra parcial y el resto queda por
 * cobrar). Cada cambio queda en auditoría con el valor anterior, el nuevo y
 * el motivo; `edit_reason` guarda solo el último.
 */
export async function updateCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: UpdateChargeInput,
) {
  await lockAccount(tx, orgId, patientId)
  const current = await chargeRow(tx, orgId, patientId, id)
  const [application] = await tx
    .select({ id: patientPaymentApplication.id })
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        eq(patientPaymentApplication.chargeId, id),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
    .limit(1)
  if (application)
    throw conflict("CHARGE_HAS_APPLICATIONS", "El concepto ya tiene cobros aplicados: no se edita")
  const patch: Partial<typeof patientCharge.$inferInsert> = {}
  if (input.amountCents !== undefined) patch.amountCents = assertPositiveCents(input.amountCents)
  if (input.description !== undefined) {
    const text = input.description.trim()
    if (!text || text.length > 2000) throw validation("La descripción debe tener 1–2000 caracteres")
    patch.description = text
  }
  // Motivo: lo escribe la persona o lo da la promoción aplicada.
  let reasonText = input.reason?.trim() ? reason(input.reason) : null
  if (input.promotionId) {
    const { serviceId } = await chargeServiceId(tx, orgId, current)
    if (!serviceId) throw validation("La promoción solo aplica a conceptos con servicio")
    const snapshot = await requirePromotionPrice(tx, orgId, input.promotionId, serviceId, patch.amountCents)
    if (snapshot.currency !== current.currency)
      throw conflict("CURRENCY_MISMATCH", "La promoción usa otra moneda")
    // Con «desde», bajar del mínimo anunciado sí exige un motivo propio.
    if (snapshot.mode === "from" && snapshot.floorCents != null && snapshot.priceCents < snapshot.floorCents && !reasonText)
      throw validation("El precio queda por debajo del mínimo de la promoción: indica el motivo")
    reasonText ??= `Promoción «${snapshot.promotionName}»`
    if (snapshot.priceCents === 0) {
      // Una promoción sin costo no deja nada que cobrar: el concepto se retira
      // con la promoción como motivo, en vez de quedar con importe cero.
      const [gone] = await tx
        .update(patientCharge)
        .set({
          voidedAt: new Date(),
          voidedBy: actorUserId,
          voidReason: reasonText,
          // Mismo texto en ambos: así se reconoce el concepto que una promoción dejó sin costo.
          editReason: reasonText,
          promotionId: snapshot.promotionId,
          promotionName: snapshot.promotionName,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(patientCharge.id, id),
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
          ),
        )
        .returning()
      await audit(tx, orgId, actorUserId, "patient_charge", id, "charge.voided", {
        patientId,
        description: current.description,
        amountCents: current.amountCents,
        currency: current.currency,
        reason: reasonText,
        promotionId: snapshot.promotionId,
      })
      return gone
    }
    patch.amountCents = snapshot.priceCents
    patch.promotionId = snapshot.promotionId
    patch.promotionName = snapshot.promotionName
  } else if (input.promotionId === null && current.promotionId) {
    // Quitar la promoción devuelve el precio de origen del concepto.
    if (current.budgetItemId)
      throw conflict(
        "PROMOTION_FROM_BUDGET",
        "La promoción viene del presupuesto aceptado: se cambia con una revisión del presupuesto",
      )
    const { sourcePriceCents } = await chargeServiceId(tx, orgId, current)
    if (patch.amountCents === undefined) {
      if (sourcePriceCents == null || sourcePriceCents <= 0)
        throw validation("Indica el importe del concepto sin la promoción")
      patch.amountCents = sourcePriceCents
    }
    patch.promotionId = null
    patch.promotionName = null
    reasonText ??= `Se quitó la promoción «${current.promotionName ?? ""}»`
  }
  if (patch.amountCents === undefined && patch.description === undefined)
    throw validation("Indique el nuevo importe, la nueva descripción o una promoción")
  if (!reasonText) throw validation("El motivo del cambio es obligatorio")
  patch.editReason = reasonText
  const [row] = await tx
    .update(patientCharge)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(patientCharge.id, id),
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
      ),
    )
    .returning()
  await audit(tx, orgId, actorUserId, "patient_charge", id, "charge.edited", {
    patientId,
    reason: reasonText,
    fromAmountCents: current.amountCents,
    toAmountCents: row?.amountCents,
    fromDescription: current.description,
    toDescription: row?.description,
    fromPromotion: current.promotionName,
    toPromotion: row?.promotionName ?? null,
    currency: current.currency,
  })
  return row
}


// --- Cobro atómico -----------------------------------------------------------------------

/** Medio efectivo que acepta la clínica (catálogo de Configuración, congelado al cobrar). */
const CASH_TYPE_CODE = "10"

function uuid(value: string, field = "El identificador"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw validation(`${field} debe ser un UUID`)
  return value
}

/** Moneda de la clínica con bloqueo compartido: orden perfil→cuenta/caja, sin deadlocks con el cambio de región. */
async function lockOrgCurrency(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx
    .select({ currency: orgProfile.currency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("share")
  // Sin respaldo de un país: la moneda sale del perfil o no hay cobro.
  if (!profile) throw orgProfileRequired()
  return profile.currency
}

/** Siguiente número de ticket de la organización, sin saltos: vive en la misma transacción. */
async function nextTicketNumber(tx: Db, orgId: string): Promise<number> {
  // La fila nace sin competir: dos primeros cobros simultáneos de la clínica
  // esperan aquí y después toman números consecutivos, ninguno falla.
  await tx.insert(ticketCounter).values({ organizationId: orgId, nextNumber: 1 }).onConflictDoNothing()
  const [current] = await tx
    .select()
    .from(ticketCounter)
    .where(eq(ticketCounter.organizationId, orgId))
    .for("update")
  if (!current) throw new ServiceError("INTERNAL", 500, "No se pudo numerar el ticket")
  await tx
    .update(ticketCounter)
    .set({ nextNumber: current.nextNumber + 1 })
    .where(eq(ticketCounter.organizationId, orgId))
  return current.nextNumber
}

/**
 * Lo que el ticket congela al cobrar (`payment_ticket.snapshot`). El ticket
 * impreso y enviado se arma solo con esto: nada vivo lo reescribe después.
 */
export interface TicketFrozen {
  /** Huella del pedido (idempotencia). */
  request: string
  patient: { id: string; displayName: string; docType?: string | null; docNumber?: string | null }
  payer?: { contactId: string; displayName: string } | null
  issuer: { userId: string; name: string }
  clinic: {
    legalName: string
    tradeName: string | null
    fiscalAddress: string | null
    locale: string
    currency: string
    timezone: string
  }
  branch: { id: string; name: string }
  lines: Array<{
    /** null = adelanto sin concepto. */
    chargeId: string | null
    description: string
    /** Precio completo del concepto. */
    amountCents: number
    /** Lo que este cobro pagó de él. */
    appliedCents: number
    promotion: string | null
  }>
  methods: Array<{
    paymentMethodId: string
    name: string
    typeCode: string
    amountCents: number
    reference: string | null
  }>
  /** Frase al pie vigente al cobrar. */
  notice: string
  /** Lo que quedó por cobrar de esos conceptos. */
  remainingCents?: number
}

export interface CollectMethodInput {
  paymentMethodId: string
  amountCents: number
  reference?: string | null
}

export interface CollectInput {
  branchId: string
  payerContactId?: string | null
  /** Conceptos a pagar. Omitido = todo lo pendiente empezando por lo más antiguo. */
  chargeIds?: string[]
  /** Adelanto puro (sin conceptos): todo lo cobrado queda a favor. Excluyente con chargeIds. */
  advanceCents?: number
  /** Medios del cobro. Vacío = solo saldo a favor (el crédito debe cubrir la deuda). */
  payments?: CollectMethodInput[]
  /** Solo con medio en efectivo: lo recibido; el vuelto es recibido − parte en efectivo. */
  cashReceivedCents?: number
  /** Clave de idempotencia del cobro: reintentar devuelve el mismo ticket. */
  requestId: string
}

interface OutstandingCharge {
  charge: typeof patientCharge.$inferSelect
  outstanding: number
}

/** Aplicado vigente por concepto (para resolver conceptos elegidos). */
async function liveAppliedByCharge(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<Record<string, number>> {
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
  const applied: Record<string, number> = {}
  for (const app of applications)
    applied[app.chargeId] = (applied[app.chargeId] ?? 0) + app.amountCents
  return applied
}

async function outstandingCharges(
  tx: Db,
  orgId: string,
  patientId: string,
  unit: string,
): Promise<OutstandingCharge[]> {
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
        eq(patientCharge.currency, unit),
        isNull(patientCharge.voidedAt),
      ),
    )
    .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
  const applied = new Map<string, number>()
  for (const app of applications)
    applied.set(app.chargeId, (applied.get(app.chargeId) ?? 0) + app.amountCents)
  const result: OutstandingCharge[] = []
  for (const charge of charges) {
    const rest = charge.amountCents - (applied.get(charge.id) ?? 0)
    if (rest > 0) result.push({ charge, outstanding: rest })
  }
  return result
}

interface CreditPayment {
  payment: typeof patientPayment.$inferSelect
  available: number
}

/** Saldo a favor real (pagado − aplicado − devuelto), de lo más antiguo. */
async function availableCredit(
  tx: Db,
  orgId: string,
  patientId: string,
  unit: string,
): Promise<CreditPayment[]> {
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(
      and(
        eq(patientPayment.organizationId, orgId),
        eq(patientPayment.patientId, patientId),
        eq(patientPayment.currency, unit),
        isNull(patientPayment.voidedAt),
      ),
    )
    .orderBy(asc(patientPayment.paidAt), asc(patientPayment.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
  const refunds = await tx
    .select()
    .from(patientPaymentRefund)
    .where(
      and(
        eq(patientPaymentRefund.organizationId, orgId),
        eq(patientPaymentRefund.patientId, patientId),
      ),
    )
  const applied = new Map<string, number>()
  for (const app of applications)
    applied.set(app.paymentId, (applied.get(app.paymentId) ?? 0) + app.amountCents)
  const refunded = new Map<string, number>()
  for (const refund of refunds)
    refunded.set(refund.paymentId, (refunded.get(refund.paymentId) ?? 0) + refund.amountCents)
  const result: CreditPayment[] = []
  for (const payment of payments) {
    const rest = payment.amountCents - (applied.get(payment.id) ?? 0) - (refunded.get(payment.id) ?? 0)
    if (rest > 0) result.push({ payment, available: rest })
  }
  return result
}

/**
 * Cobra en una sola transacción: crea el ticket numerado, un pago por medio,
 * aplica el saldo a favor y reparte lo nuevo empezando por lo más antiguo,
 * y deja todo en la caja de la sede. Todo o nada. Idempotente por requestId;
 * el número del ticket es único por organización y sin saltos (contador bajo
 * lock en la misma transacción; la caja y el correlativo se serializan junto
 * al paciente para impedir duplicados concurrentes).
 */
export async function collectCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CollectInput,
) {
  // Misma clave de idempotencia = misma transacción lógica: se serializa antes
  // de leer (sin catch de carrera: el lock transaccional ordena los reintentos).
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('collect:' || ${orgId} || ':' || ${input.requestId}))`,
  )
  const orgUnit = await lockOrgCurrency(tx, orgId)
  await lockAccount(tx, orgId, patientId)
  const requestId = uuid(input.requestId, "La clave de idempotencia")
  const fingerprint = JSON.stringify({
    branchId: input.branchId,
    payerContactId: input.payerContactId ?? null,
    chargeIds: input.chargeIds ? [...new Set(input.chargeIds)].sort() : null,
    advanceCents: input.advanceCents ?? null,
    payments: (input.payments ?? []).map((p) => ({
      paymentMethodId: p.paymentMethodId,
      amountCents: p.amountCents,
      reference: p.reference?.trim() || null,
    })),
    cashReceivedCents: input.cashReceivedCents ?? null,
  })
  const [replay] = await tx
    .select()
    .from(paymentTicket)
    .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.requestId, requestId)))
  if (replay) {
    // La clave no se reusa entre pacientes ni entre cobros distintos.
    const snapshot = replay.snapshot as { request?: string; remainingCents?: number } | null
    if (replay.patientId !== patientId || snapshot?.request !== fingerprint)
      throw conflict("REQUEST_ID_CONFLICT", "La clave de idempotencia ya se usó en otro cobro")
    // El reintento devuelve lo mismo que el cobro original, sin registrar nada.
    const replayPayments = await tx
      .select()
      .from(patientPayment)
      .where(
        and(
          eq(patientPayment.organizationId, orgId),
          eq(patientPayment.patientId, patientId),
          eq(patientPayment.ticketId, replay.id),
        ),
      )
      .orderBy(asc(patientPayment.createdAt), asc(patientPayment.id))
    return {
      ticket: replay,
      payments: replayPayments,
      creditAppliedCents: replay.creditAppliedCents,
      remainingCents: snapshot?.remainingCents ?? 0,
      duplicate: true as const,
      account: await getAccountSummary(tx, orgId, patientId),
    }
  }
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  if (input.payerContactId)
    await requireLinkedActiveContact(tx, orgId, patientId, input.payerContactId)
  if (input.advanceCents !== undefined && input.chargeIds?.length)
    throw validation("El adelanto no se combina con conceptos")
  const methods = []
  for (const item of input.payments ?? []) {
    const amount = assertPositiveCents(item.amountCents)
    const method = await requirePaymentMethod(tx, orgId, item.paymentMethodId)
    methods.push({
      paymentMethodId: method.id,
      name: method.name,
      typeCode: method.typeCode,
      amountCents: amount,
      reference: item.reference?.trim() ? item.reference.trim().slice(0, 200) : null,
    })
  }
  const totalNew = sum(methods)
  // Manda la moneda de la clínica: los conceptos en otra moneda no entran al cobro.
  const unit = orgUnit
  let targets: OutstandingCharge[]
  if (input.advanceCents !== undefined) {
    const advance = assertPositiveCents(input.advanceCents)
    if (advance !== totalNew)
      throw validation("El adelanto coincide con la suma de los medios")
    targets = []
  } else if (input.chargeIds?.length) {
    // Sin repetidos: el mismo concepto dos veces se cobraría dos veces.
    const wanted = new Set(input.chargeIds)
    const selected = await tx
      .select()
      .from(patientCharge)
      .where(
        and(
          eq(patientCharge.organizationId, orgId),
          eq(patientCharge.patientId, patientId),
          isNull(patientCharge.voidedAt),
        ),
      )
      .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
    const byId: Record<string, (typeof selected)[number]> = {}
    for (const charge of selected) byId[charge.id] = charge
    const missing = [...wanted].filter((id) => !byId[id])
    if (missing.length) throw notFound("Cargo")
    // Siempre lo más antiguo primero: el orden en que se marcaron no decide.
    const picked = selected.filter((charge) => wanted.has(charge.id))
    if (picked.some((c) => c.currency !== unit))
      throw conflict("CURRENCY_MISMATCH", "Los conceptos son de otra moneda que la clínica")
    const applied = await liveAppliedByCharge(tx, orgId, patientId)
    targets = picked
      .map((charge) => ({ charge, outstanding: charge.amountCents - (applied[charge.id] ?? 0) }))
      .filter((t) => t.outstanding > 0)
    if (!targets.length) throw conflict("NOTHING_DUE", "Los conceptos ya están cobrados")
  } else {
    targets = await outstandingCharges(tx, orgId, patientId, unit)
    if (!targets.length) throw conflict("NOTHING_DUE", "El paciente no tiene conceptos por cobrar")
  }
  const cashTotal = sum(methods.filter((m) => isCashLike(m.typeCode)))
  let cashReceived: number | null = null
  let change: number | null = null
  if (input.cashReceivedCents !== undefined) {
    if (cashTotal <= 0) throw validation("Lo recibido solo aplica con medio en efectivo")
    cashReceived = assertPositiveCents(input.cashReceivedCents)
    if (cashReceived < cashTotal)
      throw validation("Lo recibido no cubre la parte en efectivo")
    change = cashReceived - cashTotal
  }
  const need = sum(targets.map((t) => ({ amountCents: t.outstanding })))
  // El saldo a favor se usa solo, empezando por lo más antiguo.
  const credit = await availableCredit(tx, orgId, patientId, unit)
  let creditApplied = 0
  const applicationValues: Array<typeof patientPaymentApplication.$inferInsert> = []
  {
    let rest = need
    for (const { payment, available } of credit) {
      if (rest <= 0) break
      let fromPayment = Math.min(available, rest)
      for (const target of targets) {
        if (fromPayment <= 0 || target.outstanding <= 0) continue
        const take = Math.min(fromPayment, target.outstanding)
        applicationValues.push({
          organizationId: orgId,
          patientId,
          paymentId: payment.id,
          chargeId: target.charge.id,
          amountCents: take,
          createdBy: actorUserId,
        })
        target.outstanding -= take
        fromPayment -= take
        rest -= take
        creditApplied += take
      }
    }
  }
  // Sin dinero nuevo vale el crédito que cubre: el cobro puede ser solo a favor.
  if (totalNew === 0 && creditApplied === 0)
    throw validation("No hay saldo a favor ni medios para cobrar")
  const ticketNumber = await nextTicketNumber(tx, orgId)
  const [person] = await tx
    .select({ displayName: patientPerson.displayName, docType: patientPerson.docType, docNumber: patientPerson.docNumber })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  const [payer] = input.payerContactId
    ? await tx
        .select({ displayName: contact.displayName })
        .from(contact)
        .where(and(eq(contact.id, input.payerContactId), eq(contact.organizationId, orgId)))
    : []
  const [issuer] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, actorUserId))
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  if (!profile) throw orgProfileRequired()
  const paidAt = new Date()
  // Reparte lo nuevo empezando por lo más antiguo; el excedente queda a favor.
  // Las líneas del ticket reflejan lo realmente pagado por este cobro.
  const newAppliedByCharge: Record<string, number> = {}
  {
    let pool = totalNew
    for (const target of targets) {
      if (pool <= 0 || target.outstanding <= 0) continue
      const take = Math.min(pool, target.outstanding)
      newAppliedByCharge[target.charge.id] = take
      target.outstanding -= take
      pool -= take
    }
  }
  const creditAppliedByCharge: Record<string, number> = {}
  for (const value of applicationValues) {
    if (value.chargeId)
      creditAppliedByCharge[value.chargeId] = (creditAppliedByCharge[value.chargeId] ?? 0) + value.amountCents
  }
  const lines: Array<{
    chargeId: string | null
    description: string
    amountCents: number
    appliedCents: number
    promotion: string | null
  }> = targets
    .filter((t) => (creditAppliedByCharge[t.charge.id] ?? 0) + (newAppliedByCharge[t.charge.id] ?? 0) > 0)
    .map((t) => ({
      chargeId: t.charge.id,
      description: t.charge.description,
      amountCents: t.charge.amountCents,
      appliedCents: (creditAppliedByCharge[t.charge.id] ?? 0) + (newAppliedByCharge[t.charge.id] ?? 0),
      promotion: t.charge.promotionName,
    }))
  if (input.advanceCents !== undefined)
    lines.push({
      chargeId: null,
      description: "Adelanto (saldo a favor)",
      amountCents: totalNew,
      appliedCents: 0,
      promotion: null,
    })
  const [ticket] = await tx
    .insert(paymentTicket)
    .values({
      organizationId: orgId,
      patientId,
      branchId: branchRow.id,
      ticketNumber,
      currency: unit,
      totalCents: totalNew,
      creditAppliedCents: creditApplied,
      cashReceivedCents: cashReceived,
      changeCents: change,
      payerContactId: input.payerContactId ?? null,
      requestId,
      snapshot: {
        request: fingerprint,
        patient: {
          id: patientId,
          displayName: person?.displayName ?? "",
          docType: person?.docType ?? null,
          docNumber: person?.docNumber ?? null,
        },
        payer: input.payerContactId
          ? { contactId: input.payerContactId, displayName: payer?.displayName ?? "" }
          : null,
        issuer: { userId: actorUserId, name: issuer?.name ?? "" },
        clinic: {
          legalName: profile.legalName ?? "",
          tradeName: profile.tradeName ?? null,
          fiscalAddress: profile.fiscalAddress ?? null,
          locale: profile.locale,
          currency: profile.currency,
          timezone: profile.timezone,
        },
        branch: { id: branchRow.id, name: branchRow.name },
        lines,
        methods: methods.map((m) => ({
          paymentMethodId: m.paymentMethodId,
          name: m.name,
          typeCode: m.typeCode,
          amountCents: m.amountCents,
          reference: m.reference,
        })),
        notice: profile.ticketFooter,
        // Lo que quedó por cobrar de estos conceptos: el reintento lo repite igual.
        remainingCents: sum(targets.map((t) => ({ amountCents: t.outstanding }))),
      },
      createdBy: actorUserId,
    })
    .returning()
  if (!ticket) throw new ServiceError("INTERNAL", 500, "No se pudo registrar el cobro")
  const payments = []
  for (const item of methods) {
    const [payment] = await tx
      .insert(patientPayment)
      .values({
        organizationId: orgId,
        patientId,
        ticketId: ticket.id,
        branchId: branchRow.id,
        paymentMethodId: item.paymentMethodId,
        methodName: item.name,
        methodTypeCode: item.typeCode,
        payerContactId: input.payerContactId ?? null,
        amountCents: item.amountCents,
        currency: unit,
        paidAt,
        reference: item.reference,
        createdBy: actorUserId,
      })
      .returning()
    payments.push(payment)
    await audit(tx, orgId, actorUserId, "patient_payment", payment.id, "payment.created")
  }
  // Las aplicaciones del dinero nuevo usan los pagos recién creados.
  {
    const fresh = [...payments]
    for (const target of targets) {
      const pending = newAppliedByCharge[target.charge.id] ?? 0
      if (pending <= 0) continue
      let rest = pending
      for (const payment of fresh) {
        if (rest <= 0) break
        const used = sum(
          applicationValues
            .filter((a) => a.paymentId === payment.id)
            .map((a) => ({ amountCents: a.amountCents })),
        )
        const free = payment.amountCents - used
        if (free <= 0) continue
        const take = Math.min(free, rest)
        applicationValues.push({
          organizationId: orgId,
          patientId,
          paymentId: payment.id,
          chargeId: target.charge.id,
          ticketId: ticket.id,
          amountCents: take,
          createdBy: actorUserId,
        })
        rest -= take
      }
    }
  }
  for (const value of applicationValues) {
    if (!value.ticketId) value.ticketId = ticket.id
    const [app] = await tx.insert(patientPaymentApplication).values(value).returning()
    await audit(tx, orgId, actorUserId, "patient_payment_application", app.id, "payment.applied")
  }
  // Todo cobro queda en la caja de su sede: la caja se crea sola, nunca se abre.
  const shift = await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, unit)
  for (const payment of payments) {
    await recordCashIncome(tx, orgId, actorUserId, shift.id, {
      paymentId: payment.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      methodName: payment.methodName,
      methodTypeCode: payment.methodTypeCode,
      concept: `Ticket ${ticketNumber}`,
    })
  }
  await audit(tx, orgId, actorUserId, "payment_ticket", ticket.id, "ticket.created")
  await notify(tx, { orgId, kind: "payment.created", at: new Date().toISOString() })
  const remaining = sum(targets.map((t) => ({ amountCents: t.outstanding })))
  return {
    ticket,
    payments,
    creditAppliedCents: creditApplied,
    remainingCents: remaining,
    duplicate: false as const,
    account: await getAccountSummary(tx, orgId, patientId),
  }
}

// --- Anulación del cobro (una sola acción) -------------------------------------------------

export interface VoidTicketInput {
  reason: string
  /** Permiso finance.admin ya comprobado en ruta: exige administración tras el cierre. */
  allowPostClose: boolean
}

/**
 * Anula el ticket completo: revierte sus aplicaciones (incluido el crédito
 * previo que consumió), sus pagos y su ingreso a caja. Si la ventana ya
 * cerró, la caja queda intacta y el dinero sale de la caja del día
 * (requiere `allowPostClose`). El ticket queda marcado, nunca se borra.
 */
export async function voidTicket(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  ticketId: string,
  input: VoidTicketInput,
) {
  await lockAccount(tx, orgId, patientId)
  const [ticket] = await tx
    .select()
    .from(paymentTicket)
    .where(
      and(
        eq(paymentTicket.id, ticketId),
        eq(paymentTicket.organizationId, orgId),
        eq(paymentTicket.patientId, patientId),
      ),
    )
  if (!ticket) throw notFound("Ticket")
  if (ticket.voidedAt) throw conflict("TICKET_VOIDED", "El ticket ya está anulado")
  const voidReason = reason(input.reason)
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(
      and(
        eq(patientPayment.organizationId, orgId),
        eq(patientPayment.patientId, patientId),
        eq(patientPayment.ticketId, ticket.id),
        isNull(patientPayment.voidedAt),
      ),
    )
  for (const payment of payments) {
    const refunds = await tx
      .select({ id: patientPaymentRefund.id })
      .from(patientPaymentRefund)
      .where(
        and(
          eq(patientPaymentRefund.organizationId, orgId),
          eq(patientPaymentRefund.patientId, patientId),
          eq(patientPaymentRefund.paymentId, payment.id),
        ),
      )
      .limit(1)
    if (refunds.length)
      throw conflict("TICKET_HAS_REFUNDS", "El ticket tiene devoluciones: no se puede anular")
  }
  // Una devolución que dejó el dinero a favor no toca los pagos, pero la venta
  // ya cambió: el ticket deja de poder anularse igual.
  const [returned] = await tx
    .select({ id: paymentReturn.id })
    .from(paymentReturn)
    .where(and(eq(paymentReturn.organizationId, orgId), eq(paymentReturn.ticketId, ticket.id)))
    .limit(1)
  if (returned) throw conflict("TICKET_HAS_REFUNDS", "El ticket tiene devoluciones: no se puede anular")
  // Un cobro solo con saldo a favor no tocó la caja, pero la regla es la
  // misma: después del siguiente cierre lo anula administración.
  if (
    payments.length === 0 &&
    !input.allowPostClose &&
    (await hasClosureSince(tx, orgId, ticket.branchId, ticket.currency, ticket.createdAt))
  )
    throw conflict(
      "POST_CLOSE_NEEDS_ADMIN",
      "La caja ya cerró después de este cobro: solo administración puede anularlo",
    )
  // Se revierte lo que este ticket aplicó (incluido el saldo a favor que usó)
  // y también lo que sus pagos cubrieron después en otros tickets: un adelanto
  // anulado no puede seguir pagando un concepto. Ese concepto vuelve a quedar
  // por cobrar. Anular deshace la venta (ADR 0068): el producto que pagó este
  // ticket sale de la cuenta y vuelve a la sede; un servicio, ya hecho, queda
  // por cobrar.
  const paymentIds = payments.map((p) => p.id)
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        isNull(patientPaymentApplication.voidedAt),
        paymentIds.length
          ? or(
              eq(patientPaymentApplication.ticketId, ticket.id),
              inArray(patientPaymentApplication.paymentId, paymentIds),
            )
          : eq(patientPaymentApplication.ticketId, ticket.id),
      ),
    )
  const reopenedCents = sum(applications.filter((app) => app.ticketId !== ticket.id))
  let compensated = false
  for (const payment of payments) {
    compensated = (await reverseCashIncome(tx, orgId, actorUserId, payment, voidReason, input.allowPostClose)) || compensated
  }
  for (const app of applications) {
    await tx
      .update(patientPaymentApplication)
      .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason })
      .where(eq(patientPaymentApplication.id, app.id))
    await audit(tx, orgId, actorUserId, "patient_payment_application", app.id, "payment.application_voided")
  }
  for (const payment of payments) {
    await tx
      .update(patientPayment)
      .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason, updatedAt: new Date() })
      .where(eq(patientPayment.id, payment.id))
    await audit(tx, orgId, actorUserId, "patient_payment", payment.id, "payment.voided")
  }
  // Los productos que pagó este ticket y ya nadie más paga: la venta se deshace.
  const returnedProducts: Array<{ description: string; quantity: number; branchId: string | null }> = []
  const soldHere = [...new Set(applications.filter((app) => app.ticketId === ticket.id).map((app) => app.chargeId))]
  if (soldHere.length) {
    const products = await tx
      .select()
      .from(patientCharge)
      .where(
        and(
          eq(patientCharge.organizationId, orgId),
          eq(patientCharge.patientId, patientId),
          inArray(patientCharge.id, soldHere),
          isNull(patientCharge.voidedAt),
          sql`${patientCharge.productId} is not null`,
        ),
      )
    const ticketLabel = `Ticket ${String(ticket.ticketNumber).padStart(6, "0")} anulado`
    for (const charge of products) {
      const [stillPaid] = await tx
        .select({ id: patientPaymentApplication.id })
        .from(patientPaymentApplication)
        .where(
          and(
            eq(patientPaymentApplication.organizationId, orgId),
            eq(patientPaymentApplication.chargeId, charge.id),
            isNull(patientPaymentApplication.voidedAt),
          ),
        )
        .limit(1)
      if (stillPaid) continue
      await tx
        .update(patientCharge)
        .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: `${ticketLabel}: ${voidReason}`, updatedAt: new Date() })
        .where(eq(patientCharge.id, charge.id))
      const original = rootOfCharge(charge)
      await returnSold(tx, orgId, {
        chargeId: original,
        base: {
          kind: "devolucion",
          reason: `${ticketLabel}: ${charge.description}`,
          actorUserId,
          keyPrefix: `ticket-anulado:${ticket.id}:${charge.id}`,
          patientId,
          chargeId: original,
        },
      })
      await audit(tx, orgId, actorUserId, "patient_charge", charge.id, "charge.voided", {
        patientId,
        description: charge.description,
        amountCents: charge.amountCents,
        currency: charge.currency,
        reason: `${ticketLabel}: ${voidReason}`,
      })
      returnedProducts.push({ description: charge.description, quantity: charge.productQuantity ?? 1, branchId: charge.branchId })
    }
  }
  const [row] = await tx
    .update(paymentTicket)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason })
    .where(eq(paymentTicket.id, ticket.id))
    .returning()
  await audit(tx, orgId, actorUserId, "payment_ticket", ticket.id, "ticket.voided")
  await notify(tx, { orgId, kind: "payment.voided", at: new Date().toISOString() })
  return {
    ticket: row,
    voidedPayments: payments.length,
    voidedApplications: applications.length,
    /** Lo que este cobro había cubierto en otros tickets y vuelve a quedar por cobrar. */
    reopenedCents,
    /** Los productos de este ticket que salieron de la cuenta y volvieron a su sede. */
    returnedProducts,
    compensated,
    account: await getAccountSummary(tx, orgId, patientId),
  }
}

/** El concepto original de una cadena de devoluciones: el que guarda las salidas del inventario. */
function rootOfCharge(charge: { id: string; originalChargeId: string | null }): string {
  return charge.originalChargeId ?? charge.id
}

// --- Devolución del saldo a favor ----------------------------------------------------------

export interface RefundCreditInput {
  branchId: string
  amountCents: number
  /** Cómo se lo devuelven (snapshot para la constancia). El dinero sale del efectivo de la caja. */
  paymentMethodId?: string | null
  reason: string
  currency?: string
}

/**
 * Devuelve dinero del saldo a favor: solo lo no aplicado. El egreso sale del
 * efectivo de la caja del día (auto). Responde la constancia imprimible.
 * Para devolver algo ya cobrado a un concepto, primero se anula ese cobro.
 */
export async function refundCredit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: RefundCreditInput,
) {
  const orgUnit = await lockOrgCurrency(tx, orgId)
  await lockAccount(tx, orgId, patientId)
  const amount = assertPositiveCents(input.amountCents)
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const unit = input.currency ?? orgUnit
  const credit = await availableCredit(tx, orgId, patientId, unit)
  const total = sum(credit.map((c) => ({ amountCents: c.available })))
  if (amount > total)
    throw conflict("INSUFFICIENT_CREDIT", "Solo se devuelve lo que está a favor")
  let methodName = "Efectivo"
  let methodTypeCode: string | null = CASH_TYPE_CODE
  if (input.paymentMethodId) {
    const method = await requirePaymentMethod(tx, orgId, input.paymentMethodId)
    methodName = method.name
    methodTypeCode = method.typeCode
  }
  const at = new Date()
  const refunds = []
  {
    let rest = amount
    for (const { payment, available } of credit) {
      if (rest <= 0) break
      const take = Math.min(available, rest)
      const [refund] = await tx
        .insert(patientPaymentRefund)
        .values({
          organizationId: orgId,
          patientId,
          paymentId: payment.id,
          amountCents: take,
          refundedAt: at,
          reason: reason(input.reason),
          createdBy: actorUserId,
        })
        .returning()
      refunds.push(refund)
      await audit(tx, orgId, actorUserId, "patient_payment_refund", refund.id, "payment.refunded")
      rest -= take
    }
  }
  // La constancia se congela al devolver: clínica, sede, a quién, cuánto y por
  // qué medio. El PDF se arma solo con esto, igual que el ticket.
  const [person] = await tx
    .select({ displayName: patientPerson.displayName, docType: patientPerson.docType, docNumber: patientPerson.docNumber })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  const [issuer] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actorUserId))
  const [profile] = await tx.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  if (!profile) throw orgProfileRequired()
  const receiptId = refunds[0]!.id
  const frozen: RefundFrozen = {
    patientId,
    refundIds: refunds.map((r) => r.id),
    patient: {
      displayName: person?.displayName ?? "",
      docType: person?.docType ?? null,
      docNumber: person?.docNumber ?? null,
    },
    issuer: { userId: actorUserId, name: issuer?.name ?? "" },
    clinic: {
      legalName: profile.legalName ?? "",
      tradeName: profile.tradeName ?? null,
      fiscalAddress: profile.fiscalAddress ?? null,
      locale: profile.locale,
      currency: profile.currency,
      timezone: profile.timezone,
    },
    branch: { id: branchRow.id, name: branchRow.name },
    amountCents: amount,
    currency: unit,
    methodName,
    methodTypeCode,
    reason: reason(input.reason),
    refundedAt: at.toISOString(),
  }
  await audit(tx, orgId, actorUserId, "patient_payment_refund", receiptId, "refund.receipt", { ...frozen })
  const shift = await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, unit)
  await recordCashEgreso(tx, orgId, actorUserId, shift.id, {
    kind: "devolucion",
    amountCents: amount,
    currency: unit,
    methodName,
    methodTypeCode,
    concept: `Devolución a favor`,
  })
  await notify(tx, { orgId, kind: "payment.refunded", at: at.toISOString() })
  return {
    refunds,
    /** Con este id se pide la constancia en PDF. */
    receiptId,
    amountCents: amount,
    currency: unit,
    branchId: branchRow.id,
    methodName,
    refundedAt: at,
    account: await getAccountSummary(tx, orgId, patientId),
  }
}

/** Lo que la constancia de devolución congela (`audit_event` «refund.receipt»). */
export interface RefundFrozen {
  patientId: string
  refundIds: string[]
  patient: { displayName: string; docType: string | null; docNumber: string | null }
  issuer: { userId: string; name: string }
  clinic: {
    legalName: string
    tradeName: string | null
    fiscalAddress: string | null
    locale: string
    currency: string
    timezone: string
  }
  branch: { id: string; name: string }
  amountCents: number
  currency: string
  methodName: string
  methodTypeCode: string | null
  reason: string
  refundedAt: string
}

/** Constancia congelada de una devolución del paciente. Solo lectura. */
export async function getRefundReceipt(
  tx: Db,
  orgId: string,
  patientId: string,
  receiptId: string,
): Promise<RefundFrozen> {
  await requirePatient(tx, orgId, patientId)
  const [row] = await tx
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.action, "refund.receipt"),
        eq(auditEvent.entity, "patient_payment_refund"),
        eq(auditEvent.entityId, uuid(receiptId)),
      ),
    )
    .limit(1)
  const frozen = row?.metadata as RefundFrozen | null | undefined
  if (!frozen || frozen.patientId !== patientId) throw notFound("Constancia de devolución")
  return frozen
}

// --- Devolver: el paciente devuelve algo o pide su dinero (ADR 0068) -----------------------

/** Siguiente número de devolución de la organización, sin saltos: mismo contador que los tickets. */
async function nextReturnNumber(tx: Db, orgId: string): Promise<number> {
  await tx.insert(ticketCounter).values({ organizationId: orgId, nextNumber: 1 }).onConflictDoNothing()
  const [current] = await tx
    .select()
    .from(ticketCounter)
    .where(eq(ticketCounter.organizationId, orgId))
    .for("update")
  if (!current) throw new ServiceError("INTERNAL", 500, "No se pudo numerar la devolución")
  await tx
    .update(ticketCounter)
    .set({ nextReturnNumber: current.nextReturnNumber + 1 })
    .where(eq(ticketCounter.organizationId, orgId))
  return current.nextReturnNumber
}

/** «000001»: el número de un ticket o una devolución como se imprime. */
function sixDigits(value: number): string {
  return String(value).padStart(6, "0")
}

/**
 * Lo que la devolución congela al hacerse (`payment_return.snapshot`): se
 * imprime y se envía solo con esto. Nada vivo lo reescribe después.
 */
export interface ReturnFrozen {
  /** Huella del pedido (idempotencia). */
  request: string
  patient: { id: string; displayName: string; docType: string | null; docNumber: string | null }
  issuer: { userId: string; name: string }
  clinic: TicketFrozen["clinic"]
  branch: { id: string; name: string }
  ticket: { id: string; number: number; createdAt: string }
  lines: Array<{
    /** El concepto del que se devolvió (el vivo al devolver). */
    chargeId: string
    description: string
    /** Unidades devueltas de un producto (nulo en un servicio). */
    quantity: number | null
    amountCents: number
    kind: "producto" | "servicio"
    /** Producto: volvió a la sede o no (se devolvió abierto o dañado). */
    backToStock: boolean | null
  }>
  payout: { kind: "pagado"; methodName: string; typeCode: string | null } | { kind: "a_favor" }
  reason: string
  /** Frase al pie vigente al devolver. */
  notice: string
}

export interface ReturnableLine {
  /** El concepto vivo hoy: tras una devolución anterior, su versión rebajada. */
  chargeId: string
  description: string
  kind: "producto" | "servicio"
  /** Nombre del producto, sin la cantidad. */
  productName: string | null
  /** Unidades que siguen vendidas (producto). */
  quantity: number | null
  /** Precio vigente del concepto. */
  amountCents: number
  /** Lo que este ticket pagó del concepto y sigue en pie: el tope de lo que se devuelve. */
  paidCents: number
  /** Por qué no se puede devolver desde este ticket; nulo si se puede. */
  blockedReason: string | null
}

type ChargeRow = typeof patientCharge.$inferSelect
type ApplicationRow = typeof patientPaymentApplication.$inferSelect

/**
 * Los conceptos de un ticket como están hoy, con lo que este ticket pagó de
 * cada uno: un concepto que ya tuvo una devolución se sigue por su cadena.
 */
async function ticketReturnLines(
  tx: Db,
  orgId: string,
  patientId: string,
  ticket: typeof paymentTicket.$inferSelect,
): Promise<Array<ReturnableLine & { charge: ChargeRow; applications: ApplicationRow[] }>> {
  const frozen = ticket.snapshot as TicketFrozen
  const ids = [...new Set((frozen.lines ?? []).map((line) => line.chargeId).filter((id): id is string => !!id))]
  if (!ids.length) return []
  const sold = await tx
    .select({ id: patientCharge.id, originalChargeId: patientCharge.originalChargeId })
    .from(patientCharge)
    .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.patientId, patientId), inArray(patientCharge.id, ids)))
  const order = new Map(ids.map((id, index) => [id, index]))
  const rootOrder = new Map(sold.map((row) => [rootOfCharge(row), order.get(row.id) ?? 0]))
  const roots = [...rootOrder.keys()]
  if (!roots.length) return []
  const live = await tx
    .select()
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
        isNull(patientCharge.voidedAt),
        or(inArray(patientCharge.id, roots), inArray(patientCharge.originalChargeId, roots)),
      ),
    )
  if (!live.length) return []
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        isNull(patientPaymentApplication.voidedAt),
        inArray(
          patientPaymentApplication.chargeId,
          live.map((charge) => charge.id),
        ),
      ),
    )
  const productIds = [...new Set(live.map((charge) => charge.productId).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (productIds.length) {
    const rows = await tx
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(and(eq(product.organizationId, orgId), inArray(product.id, productIds)))
    for (const row of rows) names.set(row.id, row.name)
  }
  return live
    .map((charge) => {
      const all = applications.filter((app) => app.chargeId === charge.id)
      const paid = sum(all.filter((app) => app.ticketId === ticket.id))
      const kind = charge.productId ? ("producto" as const) : ("servicio" as const)
      const blockedReason =
        paid <= 0
          ? "Este ticket ya no paga este concepto."
          : kind === "producto" && paid !== charge.amountCents
            ? "Este producto no se pagó entero con este ticket: quítalo de la cuenta o anula el cobro que lo pagó."
            : null
      return {
        chargeId: charge.id,
        description: charge.description,
        kind,
        productName: charge.productId ? (names.get(charge.productId) ?? charge.description) : null,
        quantity: charge.productQuantity,
        amountCents: charge.amountCents,
        paidCents: paid,
        blockedReason,
        charge,
        applications: all,
      }
    })
    .filter((line) => line.paidCents > 0)
    .sort((a, b) => (rootOrder.get(rootOfCharge(a.charge)) ?? 0) - (rootOrder.get(rootOfCharge(b.charge)) ?? 0))
}

/** Las devoluciones de unos tickets, de la más antigua a la más nueva. */
async function returnsOfTickets(tx: Db, orgId: string, ticketIds: string[]) {
  if (!ticketIds.length) return []
  return tx
    .select({
      id: paymentReturn.id,
      ticketId: paymentReturn.ticketId,
      number: paymentReturn.returnNumber,
      totalCents: paymentReturn.totalCents,
      currency: paymentReturn.currency,
      outcome: paymentReturn.outcome,
      methodName: paymentReturn.methodName,
      createdAt: paymentReturn.createdAt,
    })
    .from(paymentReturn)
    .where(and(eq(paymentReturn.organizationId, orgId), inArray(paymentReturn.ticketId, ticketIds)))
    .orderBy(asc(paymentReturn.createdAt), asc(paymentReturn.id))
}

/**
 * Qué se puede devolver de un ticket: sus conceptos como están hoy, con lo
 * que pagó este ticket de cada uno, y los medios con que se pagó (el primero
 * es el que se propone para devolver el dinero).
 */
export async function getTicketReturnable(tx: Db, orgId: string, patientId: string, ticketId: string) {
  await requirePatient(tx, orgId, patientId)
  const [ticket] = await tx
    .select()
    .from(paymentTicket)
    .where(and(eq(paymentTicket.id, ticketId), eq(paymentTicket.organizationId, orgId), eq(paymentTicket.patientId, patientId)))
  if (!ticket) throw notFound("Ticket")
  const frozen = ticket.snapshot as TicketFrozen
  const lines = ticket.voidedAt ? [] : await ticketReturnLines(tx, orgId, patientId, ticket)
  return {
    ticketId: ticket.id,
    number: ticket.ticketNumber,
    currency: ticket.currency,
    branchId: ticket.branchId,
    createdAt: ticket.createdAt,
    voided: !!ticket.voidedAt,
    lines: lines.map(({ charge: _charge, applications: _applications, ...line }) => line),
    methods: (frozen.methods ?? []).map((method) => ({
      paymentMethodId: method.paymentMethodId,
      name: method.name,
      typeCode: method.typeCode,
      amountCents: method.amountCents,
      reference: method.reference,
    })),
    returns: await returnsOfTickets(tx, orgId, [ticket.id]),
  }
}

export interface ReturnLineInput {
  /** El concepto vivo (de `getTicketReturnable`). */
  chargeId: string
  /** Producto: cuántas unidades devuelve. */
  quantity?: number
  /** Servicio: cuánto dinero devuelve. */
  amountCents?: number
  /** Producto: vuelve a la sede (por defecto) o no, porque se devolvió abierto o dañado. */
  backToStock?: boolean
}

export interface ReturnTicketInput {
  /** Sede donde se devuelve: de su caja sale el dinero. */
  branchId: string
  lines: ReturnLineInput[]
  /** Con qué medio se le paga; nulo = queda a favor en su cuenta. */
  paymentMethodId: string | null
  reason: string
  /** Clave del formulario: un reintento devuelve la misma devolución. */
  requestId: string
}

/**
 * Devuelve parte o todo lo que pagó un ticket (ADR 0068). La venta del ticket
 * queda en pie: cada concepto se anula y lo reemplaza otro con lo que queda,
 * con su pago; lo devuelto queda a favor y, si se le paga, sale en el mismo
 * paso por el medio elegido. El producto vuelve a la sede si está en buen
 * estado. Nada se reescribe hacia atrás: Reportes ve la devolución el día
 * que pasa. Idempotente por `requestId`.
 */
export async function returnFromTicket(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  ticketId: string,
  input: ReturnTicketInput,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('return:' || ${orgId} || ':' || ${input.requestId}))`,
  )
  await lockOrgCurrency(tx, orgId)
  await lockAccount(tx, orgId, patientId)
  const requestId = uuid(input.requestId, "La clave de la devolución")
  const fingerprint = JSON.stringify({
    ticketId,
    branchId: input.branchId,
    lines: [...input.lines]
      .map((line) => ({
        chargeId: line.chargeId,
        quantity: line.quantity ?? null,
        amountCents: line.amountCents ?? null,
        backToStock: line.backToStock ?? null,
      }))
      .sort((a, b) => a.chargeId.localeCompare(b.chargeId)),
    paymentMethodId: input.paymentMethodId ?? null,
    reason: input.reason?.trim() ?? "",
  })
  const [replay] = await tx
    .select()
    .from(paymentReturn)
    .where(and(eq(paymentReturn.organizationId, orgId), eq(paymentReturn.requestId, requestId)))
  if (replay) {
    if (replay.patientId !== patientId || (replay.snapshot as ReturnFrozen | null)?.request !== fingerprint)
      throw conflict("REQUEST_ID_CONFLICT", "Esta devolución ya se registró con otros datos. Cierra y vuelve a abrir.")
    return { paymentReturn: replay, duplicate: true as const, account: await getAccountSummary(tx, orgId, patientId) }
  }
  const [ticket] = await tx
    .select()
    .from(paymentTicket)
    .where(and(eq(paymentTicket.id, ticketId), eq(paymentTicket.organizationId, orgId), eq(paymentTicket.patientId, patientId)))
  if (!ticket) throw notFound("Ticket")
  if (ticket.voidedAt) throw conflict("TICKET_VOIDED", "El ticket está anulado: no hay nada que devolver")
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const reasonText = reason(input.reason)
  if (!input.lines.length) throw validation("Elige qué devuelve")
  if (new Set(input.lines.map((line) => line.chargeId)).size !== input.lines.length)
    throw validation("Cada concepto va una sola vez")
  const available = new Map((await ticketReturnLines(tx, orgId, patientId, ticket)).map((line) => [line.chargeId, line]))
  const plan = input.lines.map((line) => {
    const found = available.get(line.chargeId)
    if (!found) throw conflict("NOT_IN_TICKET", "Ese concepto no es de este ticket o ya cambió: vuelve a abrir la devolución")
    if (found.blockedReason) throw conflict("NOT_RETURNABLE", found.blockedReason)
    if (found.kind === "producto") {
      if (line.amountCents !== undefined) throw validation("Lo que se devuelve de un producto sale de la cantidad")
      const sold = found.quantity ?? 1
      const quantity = line.quantity ?? 0
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > sold)
        throw validation(`De «${found.productName}» se devuelven de 1 a ${sold}`)
      // Todo, o la parte proporcional: el último que se devuelva lleva el redondeo.
      const amountCents = quantity === sold ? found.amountCents : Math.round((found.amountCents * quantity) / sold)
      return { line: found, quantity, amountCents, backToStock: line.backToStock ?? true }
    }
    if (line.quantity !== undefined || line.backToStock !== undefined)
      throw validation("De un servicio se devuelve un importe")
    const amountCents = assertPositiveCents(line.amountCents ?? 0)
    if (amountCents > found.paidCents)
      throw conflict("RETURN_EXCEEDS_PAID", `De «${found.description}» no se devuelve más de lo que pagó este ticket`)
    return { line: found, quantity: null, amountCents, backToStock: null }
  })
  const total = sum(plan.map((item) => ({ amountCents: item.amountCents })))
  const method = input.paymentMethodId ? await requirePaymentMethod(tx, orgId, input.paymentMethodId) : null
  const number = await nextReturnNumber(tx, orgId)
  const label = `Devolución ${sixDigits(number)}`
  const [person] = await tx
    .select({ displayName: patientPerson.displayName, docType: patientPerson.docType, docNumber: patientPerson.docNumber })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  const [issuer] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actorUserId))
  const [profile] = await tx.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  if (!profile) throw orgProfileRequired()
  const snapshot: ReturnFrozen = {
    request: fingerprint,
    patient: {
      id: patientId,
      displayName: person?.displayName ?? "",
      docType: person?.docType ?? null,
      docNumber: person?.docNumber ?? null,
    },
    issuer: { userId: actorUserId, name: issuer?.name ?? "" },
    clinic: {
      legalName: profile.legalName ?? "",
      tradeName: profile.tradeName ?? null,
      fiscalAddress: profile.fiscalAddress ?? null,
      locale: profile.locale,
      currency: profile.currency,
      timezone: profile.timezone,
    },
    branch: { id: branchRow.id, name: branchRow.name },
    ticket: { id: ticket.id, number: ticket.ticketNumber, createdAt: ticket.createdAt.toISOString() },
    lines: plan.map((item) => {
      const name = item.line.productName ?? item.line.description
      return {
        chargeId: item.line.chargeId,
        description: item.line.kind === "producto" ? (item.quantity === 1 ? name : `${name} × ${item.quantity}`) : item.line.description,
        quantity: item.quantity,
        amountCents: item.amountCents,
        kind: item.line.kind,
        backToStock: item.backToStock,
      }
    }),
    payout: method ? { kind: "pagado", methodName: method.name, typeCode: method.typeCode } : { kind: "a_favor" },
    reason: reasonText,
    notice: profile.ticketFooter,
  }
  const [row] = await tx
    .insert(paymentReturn)
    .values({
      organizationId: orgId,
      patientId,
      ticketId: ticket.id,
      branchId: branchRow.id,
      returnNumber: number,
      currency: ticket.currency,
      totalCents: total,
      outcome: method ? "pagado" : "a_favor",
      paymentMethodId: method?.id ?? null,
      methodName: method?.name ?? null,
      methodTypeCode: method?.typeCode ?? null,
      reason: reasonText,
      requestId,
      snapshot,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo registrar la devolución")
  const now = new Date()
  // Lo que se libera de cada pago: queda a favor, o se le paga.
  const freed = new Map<string, number>()
  for (const item of plan) {
    const { charge, applications } = item.line
    // Lo devuelto sale de lo que pagó este ticket, de lo último aplicado primero.
    const taken = new Map<string, number>()
    let left = item.amountCents
    const mine = applications
      .filter((app) => app.ticketId === ticket.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    for (const app of mine) {
      if (left <= 0) break
      const take = Math.min(app.amountCents, left)
      taken.set(app.id, take)
      freed.set(app.paymentId, (freed.get(app.paymentId) ?? 0) + take)
      left -= take
    }
    await tx
      .update(patientCharge)
      .set({ voidedAt: now, voidedBy: actorUserId, voidReason: `${label}: ${reasonText}`, updatedAt: now })
      .where(eq(patientCharge.id, charge.id))
    for (const app of applications) {
      await tx
        .update(patientPaymentApplication)
        .set({ voidedAt: now, voidedBy: actorUserId, voidReason: label, returnId: row.id })
        .where(eq(patientPaymentApplication.id, app.id))
    }
    const remaining = charge.amountCents - item.amountCents
    const original = rootOfCharge(charge)
    if (remaining > 0) {
      const keptQuantity =
        item.quantity !== null && charge.productQuantity !== null ? charge.productQuantity - item.quantity : null
      const productName = item.line.productName ?? charge.description
      const [next] = await tx
        .insert(patientCharge)
        .values({
          organizationId: orgId,
          patientId,
          planItemId: charge.planItemId,
          budgetItemId: charge.budgetItemId,
          encounterProcedureId: charge.encounterProcedureId,
          branchId: charge.branchId,
          promotionId: charge.promotionId,
          promotionName: charge.promotionName,
          editReason: charge.editReason,
          description:
            keptQuantity !== null ? (keptQuantity === 1 ? productName : `${productName} × ${keptQuantity}`) : charge.description,
          amountCents: remaining,
          currency: charge.currency,
          dueAt: charge.dueAt,
          notes: charge.notes,
          productId: charge.productId,
          productQuantity: keptQuantity,
          originalChargeId: original,
          returnedCents: charge.returnedCents + item.amountCents,
          createdBy: actorUserId,
        })
        .returning()
      for (const app of applications) {
        const kept = app.amountCents - (taken.get(app.id) ?? 0)
        if (kept <= 0) continue
        await tx.insert(patientPaymentApplication).values({
          organizationId: orgId,
          patientId,
          paymentId: app.paymentId,
          chargeId: next.id,
          ticketId: app.ticketId,
          replacesApplicationId: app.id,
          amountCents: kept,
          createdBy: actorUserId,
        })
      }
      await audit(tx, orgId, actorUserId, "patient_charge", next.id, "charge.returned", {
        patientId,
        returnId: row.id,
        replaces: charge.id,
        returnedCents: item.amountCents,
      })
    } else {
      await audit(tx, orgId, actorUserId, "patient_charge", charge.id, "charge.returned", {
        patientId,
        returnId: row.id,
        returnedCents: item.amountCents,
      })
    }
    if (item.line.kind === "producto" && item.quantity && item.backToStock) {
      await returnSold(tx, orgId, {
        chargeId: original,
        quantity: item.quantity,
        base: {
          kind: "devolucion",
          reason: `${label}: ${snapshot.patient.displayName || "paciente"}`,
          actorUserId,
          keyPrefix: `devolucion:${row.id}:${original}`,
          patientId,
          chargeId: original,
        },
      })
    }
  }
  if (method) {
    // Se le paga en el mismo paso: lo liberado de cada pago sale por el medio elegido.
    for (const [paymentId, amountCents] of freed) {
      const [refund] = await tx
        .insert(patientPaymentRefund)
        .values({
          organizationId: orgId,
          patientId,
          paymentId,
          amountCents,
          refundedAt: now,
          reason: `${label}: ${reasonText}`,
          returnId: row.id,
          createdBy: actorUserId,
        })
        .returning()
      await audit(tx, orgId, actorUserId, "patient_payment_refund", refund.id, "payment.refunded", { returnId: row.id })
    }
    const shift = await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, ticket.currency)
    await recordCashEgreso(tx, orgId, actorUserId, shift.id, {
      kind: "devolucion",
      amountCents: total,
      currency: ticket.currency,
      methodName: method.name,
      methodTypeCode: method.typeCode,
      concept: `${label} · Ticket ${sixDigits(ticket.ticketNumber)}`,
    })
  }
  await audit(tx, orgId, actorUserId, "payment_return", row.id, "return.created", {
    patientId,
    ticketId: ticket.id,
    totalCents: total,
    outcome: row.outcome,
  })
  await notify(tx, { orgId, kind: "payment.refunded", at: now.toISOString() })
  return { paymentReturn: row, duplicate: false as const, account: await getAccountSummary(tx, orgId, patientId) }
}

/** Una devolución tal como se registró (lo que se imprime y se envía). Solo lectura. */
export async function getPaymentReturn(tx: Db, orgId: string, patientId: string, returnId: string) {
  await requirePatient(tx, orgId, patientId)
  const [row] = await tx
    .select()
    .from(paymentReturn)
    .where(
      and(
        eq(paymentReturn.organizationId, orgId),
        eq(paymentReturn.patientId, patientId),
        eq(paymentReturn.id, uuid(returnId, "La devolución")),
      ),
    )
  if (!row) throw notFound("Devolución")
  return { ...row, snapshot: row.snapshot as ReturnFrozen }
}

// --- Cuenta del paciente (tres cifras) ------------------------------------------------------

export interface AccountPending {
  chargeId: string
  description: string
  currency: string
  totalCents: number
  paidCents: number
  saldoCents: number
  since: Date | null
  budgetItemId: string | null
  planItemId: string | null
  encounterProcedureId: string | null
  /** Quién atendió el acto que originó el concepto: solo el nombre, nada clínico. */
  attendedBy: string | null
  attendedAt: Date | null
  /** En lo que se cobra por sesión: qué visita es y cuántas se previeron. */
  visitNumber: number | null
  visitsPlanned: number | null
  /** Servicio del concepto (su acto o su línea): con él caja ofrece la promoción vigente. */
  serviceId: string | null
  branchId: string | null
  promotionId: string | null
  promotionName: string | null
  /** Producto vendido desde «Cobrar» y cuántas unidades (ADR 0067): ya salió de la sede. */
  productId: string | null
  productQuantity: number | null
}

/**
 * Cuenta nueva: tres cifras por moneda (por cobrar, pagado, a favor),
 * pendiente por concepto y cobros (tickets con estado). Sin selector de
 * moneda: cada fila trae la suya.
 */
/**
 * Lo que debe, lo que pagó, lo que tiene a favor y el saldo, por moneda. Una
 * sola fórmula para Caja, la página de la persona, el portal y los mensajes
 * (decisión 22): el saldo descuenta lo que tiene a favor, nunca baja de cero.
 * «Debe: S/ 100 · A favor: S/ 100 · Saldo: S/ 0».
 */
export function accountBalances(rows: {
  charges: ReadonlyArray<{ currency: string; amountCents: number; voidedAt: Date | null }>
  payments: ReadonlyArray<{ id: string; currency: string; amountCents: number; voidedAt: Date | null }>
  applications: ReadonlyArray<{ paymentId: string; amountCents: number; voidedAt: Date | null }>
  refunds: ReadonlyArray<{ paymentId: string; amountCents: number }>
}): Array<{ currency: string; porCobrar: number; pagado: number; aFavor: number; saldo: number }> {
  const liveCharges = rows.charges.filter((c) => !c.voidedAt)
  const livePayments = rows.payments.filter((p) => !p.voidedAt)
  const currencyOf = new Map(livePayments.map((p) => [p.id, p.currency]))
  const units = [...new Set([...liveCharges.map((c) => c.currency), ...livePayments.map((p) => p.currency)])].sort()
  return units.map((unit) => {
    const charged = sum(liveCharges.filter((c) => c.currency === unit))
    const paid = sum(livePayments.filter((p) => p.currency === unit))
    const applied = sum(rows.applications.filter((a) => !a.voidedAt && currencyOf.get(a.paymentId) === unit))
    const refunded = sum(rows.refunds.filter((r) => currencyOf.get(r.paymentId) === unit))
    const porCobrar = charged - applied
    const aFavor = paid - applied - refunded
    return {
      currency: unit,
      porCobrar,
      // Neto que conserva la clínica: lo cobrado menos lo devuelto.
      pagado: paid - refunded,
      aFavor,
      // Lo que de verdad falta: lo que debe menos lo que ya tiene a favor.
      saldo: Math.max(porCobrar - Math.max(aFavor, 0), 0),
    }
  })
}

/**
 * Lo que la persona tiene a favor en una moneda, en SQL: lo pagado menos lo
 * aplicado y lo devuelto (la misma cuenta que `accountBalances`). Lo que avisa
 * de un saldo vencido lo resta de lo que debe: con lo que tiene a favor
 * alcanzando, no hay saldo vencido (decisión 22).
 */
export function patientCreditSql(orgId: SQLWrapper | string, patientId: SQLWrapper, currency: SQLWrapper): SQL {
  return sql`(select coalesce(sum(credit_payment.amount_cents
      - coalesce((select sum(credit_app.amount_cents) from patient_payment_application credit_app
          where credit_app.organization_id = credit_payment.organization_id and credit_app.payment_id = credit_payment.id
            and credit_app.voided_at is null), 0)
      - coalesce((select sum(credit_refund.amount_cents) from patient_payment_refund credit_refund
          where credit_refund.organization_id = credit_payment.organization_id and credit_refund.payment_id = credit_payment.id), 0)), 0)
    from patient_payment credit_payment
    where credit_payment.organization_id = ${orgId} and credit_payment.patient_id = ${patientId}
      and credit_payment.currency = ${currency} and credit_payment.voided_at is null)`
}

export async function getAccountSummary(tx: Db, orgId: string, patientId: string) {
  const patientRow = await requirePatient(tx, orgId, patientId)
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.patientId, patientId)))
    .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(and(eq(patientPayment.organizationId, orgId), eq(patientPayment.patientId, patientId)))
    .orderBy(asc(patientPayment.paidAt), asc(patientPayment.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
      ),
    )
  const refunds = await tx
    .select()
    .from(patientPaymentRefund)
    .where(
      and(
        eq(patientPaymentRefund.organizationId, orgId),
        eq(patientPaymentRefund.patientId, patientId),
      ),
    )
  const tickets = await tx
    .select()
    .from(paymentTicket)
    .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.patientId, patientId)))
    .orderBy(asc(paymentTicket.createdAt), asc(paymentTicket.id))
  const appliedByCharge: Record<string, number> = {}
  for (const app of applications) {
    if (app.voidedAt) continue
    appliedByCharge[app.chargeId] = (appliedByCharge[app.chargeId] ?? 0) + app.amountCents
  }
  const appliedByPayment: Record<string, number> = {}
  for (const app of applications) {
    if (app.voidedAt) continue
    appliedByPayment[app.paymentId] = (appliedByPayment[app.paymentId] ?? 0) + app.amountCents
  }
  const refundedByPayment: Record<string, number> = {}
  for (const refund of refunds)
    refundedByPayment[refund.paymentId] = (refundedByPayment[refund.paymentId] ?? 0) + refund.amountCents
  const liveCharges = charges.filter((c) => !c.voidedAt)
  const livePayments = payments.filter((p) => !p.voidedAt)
  const byCurrency = accountBalances({ charges, payments, applications, refunds })
  // Servicio de cada concepto vivo, en dos consultas (actos y líneas).
  const procedureIds = liveCharges.map((c) => c.encounterProcedureId).filter((v): v is string => !!v)
  const lineIds = liveCharges.map((c) => c.budgetItemId).filter((v): v is string => !!v)
  const serviceByProcedure: Record<string, string | null> = {}
  // Quién atendió: el profesional de la atención del acto. Caja ve el nombre, no la atención.
  const attendedByProcedure: Record<string, { name: string | null; at: Date | null }> = {}
  if (procedureIds.length) {
    const rows = await tx
      .select({
        id: encounterProcedure.id,
        serviceId: encounterProcedure.serviceId,
        professionalName: user.name,
        finalizedAt: encounter.finalizedAt,
        startedAt: encounter.startedAt,
      })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId)),
      )
      .leftJoin(user, eq(user.id, encounter.professionalUserId))
      .where(and(eq(encounterProcedure.organizationId, orgId), inArray(encounterProcedure.id, procedureIds)))
    for (const row of rows) {
      serviceByProcedure[row.id] = row.serviceId
      attendedByProcedure[row.id] = { name: row.professionalName ?? null, at: row.finalizedAt ?? row.startedAt ?? null }
    }
  }
  // Cobro por sesión: visitas previstas del tratamiento y qué visita es cada concepto.
  const planItemIds = [...new Set(liveCharges.map((c) => c.planItemId).filter((v): v is string => !!v))]
  const plannedByPlanItem: Record<string, number> = {}
  if (planItemIds.length) {
    const rows = await tx
      .select({ planItemId: treatmentBudgetItem.planItemId, sessionsPlanned: treatmentBudgetItem.sessionsPlanned })
      .from(treatmentBudgetItem)
      .where(
        and(
          eq(treatmentBudgetItem.organizationId, orgId),
          eq(treatmentBudgetItem.patientId, patientId),
          inArray(treatmentBudgetItem.planItemId, planItemIds),
          eq(treatmentBudgetItem.billingMode, "session"),
          eq(treatmentBudgetItem.decision, "aceptado"),
        ),
      )
      .orderBy(asc(treatmentBudgetItem.createdAt))
    for (const row of rows) plannedByPlanItem[row.planItemId] = row.sessionsPlanned ?? 1
  }
  const visitNumberByCharge: Record<string, number> = {}
  const visitasPorTratamiento: Record<string, number> = {}
  for (const charge of liveCharges) {
    // Una visita es un acto atendido de ese tratamiento (los cargos van del más antiguo al más nuevo).
    if (!charge.planItemId || !charge.encounterProcedureId) continue
    const next = (visitasPorTratamiento[charge.planItemId] ?? 0) + 1
    visitasPorTratamiento[charge.planItemId] = next
    visitNumberByCharge[charge.id] = next
  }
  const serviceByLine: Record<string, string | null> = {}
  if (lineIds.length) {
    const rows = await tx
      .select({ id: treatmentBudgetItem.id, serviceId: treatmentBudgetItem.serviceId })
      .from(treatmentBudgetItem)
      .where(and(eq(treatmentBudgetItem.organizationId, orgId), inArray(treatmentBudgetItem.id, lineIds)))
    for (const row of rows) serviceByLine[row.id] = row.serviceId
  }
  const pendiente: AccountPending[] = liveCharges
    .map((charge) => {
      const paid = appliedByCharge[charge.id] ?? 0
      return {
        chargeId: charge.id,
        description: charge.description,
        currency: charge.currency,
        totalCents: charge.amountCents,
        paidCents: paid,
        saldoCents: charge.amountCents - paid,
        since: charge.createdAt,
        budgetItemId: charge.budgetItemId,
        planItemId: charge.planItemId,
        encounterProcedureId: charge.encounterProcedureId,
        attendedBy: charge.encounterProcedureId
          ? (attendedByProcedure[charge.encounterProcedureId]?.name ?? null)
          : null,
        attendedAt: charge.encounterProcedureId
          ? (attendedByProcedure[charge.encounterProcedureId]?.at ?? null)
          : null,
        visitNumber:
          charge.planItemId && plannedByPlanItem[charge.planItemId] != null
            ? (visitNumberByCharge[charge.id] ?? null)
            : null,
        visitsPlanned: charge.planItemId ? (plannedByPlanItem[charge.planItemId] ?? null) : null,
        serviceId:
          (charge.encounterProcedureId ? serviceByProcedure[charge.encounterProcedureId] : null) ??
          (charge.budgetItemId ? serviceByLine[charge.budgetItemId] : null) ??
          null,
        branchId: charge.branchId,
        promotionId: charge.promotionId,
        promotionName: charge.promotionName,
        productId: charge.productId ?? null,
        productQuantity: charge.productQuantity ?? null,
      }
    })
    .filter((row) => row.saldoCents > 0)
  const ticketPayments: Record<string, typeof payments> = {}
  for (const payment of payments) {
    if (!payment.ticketId) continue
    if (!ticketPayments[payment.ticketId]) ticketPayments[payment.ticketId] = []
    ticketPayments[payment.ticketId].push(payment)
  }
  // Último cierre por sede y moneda: después de él, anular un cobro anterior pide administración.
  const lastClosure: Record<string, Date> = {}
  const ticketBranches = [...new Set(tickets.map((t) => t.branchId))]
  if (ticketBranches.length) {
    const rows = await tx
      .select({ branchId: cashClosure.branchId, currency: cashClosure.currency, closedAt: cashClosure.closedAt })
      .from(cashClosure)
      .where(and(eq(cashClosure.organizationId, orgId), inArray(cashClosure.branchId, ticketBranches)))
      .orderBy(desc(cashClosure.closedAt))
    for (const row of rows) {
      const key = `${row.branchId}|${row.currency}`
      if (!lastClosure[key]) lastClosure[key] = row.closedAt
    }
  }
  const returnRows = await returnsOfTickets(
    tx,
    orgId,
    tickets.map((ticket) => ticket.id),
  )
  const cobros = tickets.map((ticket) => ({
    ticketId: ticket.id,
    number: ticket.ticketNumber,
    branchId: ticket.branchId,
    currency: ticket.currency,
    totalCents: ticket.totalCents,
    creditAppliedCents: ticket.creditAppliedCents,
    cashReceivedCents: ticket.cashReceivedCents,
    changeCents: ticket.changeCents,
    payerContactId: ticket.payerContactId,
    status: ticket.voidedAt ? ("anulado" as const) : ("vigente" as const),
    voidedAt: ticket.voidedAt,
    voidReason: ticket.voidReason,
    /** La caja de su sede ya cerró después de este cobro: solo administración lo anula. */
    closedAfter: (lastClosure[`${ticket.branchId}|${ticket.currency}`]?.getTime() ?? 0) >= ticket.createdAt.getTime(),
    createdAt: ticket.createdAt,
    snapshot: ticket.snapshot,
    payments: (ticketPayments[ticket.id] ?? []).map((p) => ({
      id: p.id,
      methodName: p.methodName,
      amountCents: p.amountCents,
      voidedAt: p.voidedAt,
    })),
    /** Devoluciones de este ticket (ADR 0068): con alguna, ya no se anula. */
    returns: returnRows.filter((item) => item.ticketId === ticket.id),
  }))
  // Historial anterior sin ticket (nunca se borra ni se inventa sede): filas
  // de solo lectura, marcadas como histórico. Solo se imprimen con evidencia.
  const historico = payments
    .filter((p) => !p.ticketId)
    .map((p) => ({
      paymentId: p.id,
      currency: p.currency,
      methodName: p.methodName,
      methodTypeCode: p.methodTypeCode,
      amountCents: p.amountCents,
      appliedCents: appliedByPayment[p.id] ?? 0,
      refundedCents: refundedByPayment[p.id] ?? 0,
      paidAt: p.paidAt,
      status: p.voidedAt ? ("anulado" as const) : ("vigente" as const),
      voidReason: p.voidReason,
      origin: "historico" as const,
    }))
  // De qué cobro viene el saldo a favor: los pagos vigentes con dinero sin aplicar ni devolver.
  const ticketById: Record<string, (typeof tickets)[number]> = {}
  for (const ticket of tickets) ticketById[ticket.id] = ticket
  const aFavorOrigen = livePayments
    .map((p) => ({
      paymentId: p.id,
      ticketId: p.ticketId,
      ticketNumber: p.ticketId ? (ticketById[p.ticketId]?.ticketNumber ?? null) : null,
      currency: p.currency,
      paidAt: p.paidAt,
      availableCents: p.amountCents - (appliedByPayment[p.id] ?? 0) - (refundedByPayment[p.id] ?? 0),
      /** El cobro fue un adelanto (sin concepto). */
      advance: p.ticketId
        ? ((ticketById[p.ticketId]?.snapshot as TicketFrozen | null)?.lines ?? []).some((l) => l.chargeId === null)
        : false,
    }))
    .filter((row) => row.availableCents > 0)
  return {
    patientId,
    /** Identidad mínima para la cabecera de caja: sin datos clínicos ni traza de lectura. */
    patient: {
      displayName: patientRow.displayName,
      docType: patientRow.docType,
      docNumber: patientRow.docNumber,
      sex: patientRow.sex,
    },
    byCurrency,
    pendiente,
    cobros,
    historico,
    aFavorOrigen,
    /** Visitas atendidas por tratamiento (actos con cargo vivo): base de «ya realizado» en cobro por sesión. */
    visitasPorTratamiento,
    conCargo: coveredPlanItems(liveCharges),
  }
}

/** Tratamientos con cargo vivo (cobrado o no): una sola tarifa por tratamiento. */
function coveredPlanItems(charges: Array<{ planItemId: string | null }>): string[] {
  return [...new Set(charges.filter((c) => c.planItemId).map((c) => c.planItemId as string))].sort()
}

/**
 * Snapshot del ticket para el PDF y la impresión (Documentos): ticket
 * inmutable con sus pagos, aplicaciones vigentes, conceptos, sede y moneda.
 * Solo lectura.
 */
export async function getTicketReceipt(tx: Db, orgId: string, patientId: string, ticketId: string) {
  const [ticket] = await tx
    .select()
    .from(paymentTicket)
    .where(
      and(
        eq(paymentTicket.id, ticketId),
        eq(paymentTicket.organizationId, orgId),
        eq(paymentTicket.patientId, patientId),
      ),
    )
  if (!ticket) throw notFound("Ticket")
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(
      and(
        eq(patientPayment.organizationId, orgId),
        eq(patientPayment.patientId, patientId),
        eq(patientPayment.ticketId, ticket.id),
      ),
    )
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        eq(patientPaymentApplication.ticketId, ticket.id),
      ),
    )
  const paymentIds = payments.map((p) => p.id)
  const charges = paymentIds.length
    ? await tx
        .select()
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
          ),
        )
    : []
  const chargeById: Record<string, (typeof charges)[number]> = {}
  for (const charge of charges) chargeById[charge.id] = charge
  const [branchRow] = await tx
    .select()
    .from(branch)
    .where(and(eq(branch.id, ticket.branchId), eq(branch.organizationId, orgId)))
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  return {
    ticket,
    payments,
    applications,
    chargeById,
    branch: branchRow ?? null,
    orgProfile: profile ?? null,
    /** La caja de su sede ya cerró después de este cobro: solo administración lo anula. */
    closedAfter: await hasClosureSince(tx, orgId, ticket.branchId, ticket.currency, ticket.createdAt),
    /** Devoluciones de este ticket (ADR 0068). */
    returns: await returnsOfTickets(tx, orgId, [ticket.id]),
  }
}

export async function getPatientAccount(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.patientId, patientId)))
    .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(and(eq(patientPayment.organizationId, orgId), eq(patientPayment.patientId, patientId)))
    .orderBy(asc(patientPayment.paidAt), asc(patientPayment.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
      ),
    )
    .orderBy(asc(patientPaymentApplication.createdAt), asc(patientPaymentApplication.id))
  const refunds = await tx
    .select()
    .from(patientPaymentRefund)
    .where(
      and(
        eq(patientPaymentRefund.organizationId, orgId),
        eq(patientPaymentRefund.patientId, patientId),
      ),
    )
    .orderBy(asc(patientPaymentRefund.refundedAt), asc(patientPaymentRefund.id))
  const agreed = await tx
    .select({
      priceCents: treatmentBudgetItem.priceCents,
      currency: treatmentBudgetItem.currency,
      billingMode: treatmentBudgetItem.billingMode,
      sessionsPlanned: treatmentBudgetItem.sessionsPlanned,
    })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, treatmentBudgetItem.planItemId),
        eq(treatmentPlanItem.budgetId, treatmentBudgetItem.budgetId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .innerJoin(
      treatmentBudget,
      and(
        eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentPlanItem.decisionStatus, "aceptado"),
        eq(treatmentBudgetItem.decision, "aceptado"),
      ),
    )
  // Los mismos montos que Caja (`accountBalances`); lo aceptado cuenta todas
  // las visitas de lo que se cobra por sesión, como el presupuesto.
  const balances = accountBalances({ charges, payments, applications, refunds })
  const units = [...new Set([...balances.map((b) => b.currency), ...agreed.map((r) => r.currency)])].sort()
  const byCurrency = units.map((unit) => {
    const balance = balances.find((b) => b.currency === unit) ?? { porCobrar: 0, pagado: 0, aFavor: 0, saldo: 0 }
    return {
      currency: unit,
      agreedCents: agreed
        .filter((r) => r.currency === unit)
        .reduce((total, r) => total + (r.priceCents ?? 0) * budgetLineUnits(r), 0),
      ...balance,
    }
  })
  return { byCurrency, charges, payments, applications, refunds }
}
