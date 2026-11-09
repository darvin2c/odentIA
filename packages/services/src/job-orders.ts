import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { orgCounter, patient, patientCharge, patientPaymentApplication, paymentTicket } from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { jobOrder, jobOrderEvent, jobOrderLine } from "@odentia/db/schema/orders"
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { clinicToday } from "./inventory-stock.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { requirePatient } from "./patients.js"
import { type CollectMethodInput, collectCharge, createCharge, voidCharge } from "./payments.js"
import { orderNoticeOf, sendOrderReadyNotice } from "./job-order-notice.js"
import { productHooks } from "./products.js"

/**
 * El pedido (ADR 0171): lo que la clínica encarga a su taller o a un laboratorio
 * para entregárselo a la persona. Común a los productos; vistIA lo usa con los
 * lentes. La venta crea los cargos de lo que lleva (con la caja de siempre),
 * el pedido con la fecha prometida y, si deja un adelanto, lo cobra con los
 * medios que elija. Los pasos dicen hechos de la clínica y quién marcó cada uno.
 */

export const JOB_ORDER_STEPS = ["por_enviar", "en_laboratorio", "por_revisar", "listo", "entregado"] as const
export type JobOrderStep = (typeof JOB_ORDER_STEPS)[number]
export type JobOrderStatus = JobOrderStep | "anulado"

export const JOB_ORDER_STATUS_LABELS: Record<JobOrderStatus, string> = {
  por_enviar: "Por enviar",
  en_laboratorio: "En laboratorio",
  por_revisar: "Por revisar",
  listo: "Listo",
  entregado: "Entregado",
  anulado: "Anulado",
}

export const JOB_ORDER_LINE_KINDS = ["montura", "lunas", "contacto", "otro"] as const
export type JobOrderLineKind = (typeof JOB_ORDER_LINE_KINDS)[number]

export interface JobOrderSaleLine {
  kind: JobOrderLineKind
  /** Un producto del inventario (la montura): su precio y su stock. */
  productId?: string | null
  quantity?: number | null
  /** Sin producto: lo que es y su precio (las lunas a precio libre). */
  description?: string | null
  amountCents?: number | null
}

export interface JobOrderSaleInput {
  branchId: string
  requestId: string
  title: string
  maker: string
  promisedOn: string
  lines: JobOrderSaleLine[]
  /** La referencia del producto que se copia en el pedido (vistIA: la receta de lentes). */
  referenceId?: string | null
  /** Las medidas para montar (vistIA: alturas de montaje por ojo). */
  fitting?: Record<string, number | string> | null
  notes?: string | null
  /** El adelanto: los medios con que paga ahora; vacío, sin adelanto. */
  payments?: CollectMethodInput[]
  cashReceivedCents?: number
  /** Quien paga, si no es la persona (la mamá que compra los lentes de su hijo). */
  payerContactId?: string | null
}

const TEXT_MAX = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTES_MAX = 2000

function text(value: unknown, field: string, label: string, max = TEXT_MAX): string {
  if (typeof value !== "string" || !value.trim()) throw invalidField(field, `Escribe ${label}`)
  if (value.trim().length > max) throw invalidField(field, `${label}: como mucho ${max} caracteres`)
  return value.trim()
}

function optional(value: unknown, field: string, max = NOTES_MAX): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw invalidField(field, "Escribe un texto")
  if (value.trim().length > max) throw invalidField(field, `Como mucho ${max} caracteres`)
  return value.trim() || null
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw invalidField(field, "Elige la fecha en el calendario")
  return value
}

/**
 * Las medidas para montar (vistIA: la altura de montaje de cada ojo): pocas, con
 * su nombre y un número o un texto corto. Lo que cada producto mide lo dice su
 * pantalla; aquí solo se cuida que no sea otra cosa.
 */
function fittingOf(value: unknown): Record<string, number | string> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw invalidField("fitting", "Las medidas van con su nombre")
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 12) throw invalidField("fitting", "Como mucho 12 medidas")
  const out: Record<string, number | string> = {}
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z]{1,30}$/.test(key)) throw invalidField("fitting", "Las medidas van con su nombre")
    if (item === null || item === "") continue
    if (typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100) out[key] = item
    else if (typeof item === "string" && item.trim().length <= 60) out[key] = item.trim()
    else throw invalidField(`fitting.${key}`, "Escribe la medida en milímetros")
  }
  return Object.keys(out).length ? out : null
}

/** La persona de un pedido, para guardar su historia si está bloqueada; null si no existe. */
export async function jobOrderPatientId(tx: Db, orgId: string, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ patientId: jobOrder.patientId })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.id, id)))
  return row?.patientId ?? null
}

async function nextOrderNumber(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "job_order", value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`${orgCounter.value} + 1` },
    })
    .returning({ value: orgCounter.value })
  return Number(row!.value)
}

async function audit(tx: Db, orgId: string, actorUserId: string, action: string, id: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "job_order", entityId: id, metadata })
}

/**
 * El cargo vigente de una línea: el de la venta o, si la caja lo reemplazó (una
 * devolución parcial deja otro con lo que queda), el que lo nombra como original.
 */
const liveChargeOfLine = and(
  eq(patientCharge.organizationId, jobOrderLine.organizationId),
  isNull(patientCharge.voidedAt),
  or(eq(patientCharge.id, jobOrderLine.chargeId), eq(patientCharge.originalChargeId, jobOrderLine.chargeId)),
)

/** El pedido que rehace a otro y sigue vivo: el original queda reemplazado por él. */
const remadeAsOf = (orderId: typeof jobOrder.id) => sql`(
  select remake.id from job_order remake
  where remake.organization_id = ${jobOrder.organizationId} and remake.remake_of = ${orderId} and remake.status <> 'anulado'
  order by remake.created_at desc limit 1)`

/** Lo que identifica una venta: un reintento con la misma clave y otra cosa es un conflicto. */
function saleFingerprint(patientId: string, input: JobOrderSaleInput): string {
  const body = JSON.stringify({
    patientId,
    branchId: input.branchId,
    title: input.title?.trim(),
    maker: input.maker?.trim(),
    promisedOn: input.promisedOn,
    lines: input.lines,
    referenceId: input.referenceId ?? null,
    fitting: input.fitting ?? null,
    notes: input.notes?.trim() || null,
    payments: input.payments ?? [],
    cashReceivedCents: input.cashReceivedCents ?? null,
    payerContactId: input.payerContactId ?? null,
  })
  return createHash("sha256").update(body).digest("hex")
}

/**
 * La venta: los cargos de lo que lleva, el pedido con su fecha prometida y la
 * copia de la referencia del producto, y el adelanto si lo hay. Todo en la misma
 * transacción: si algo falla no queda una venta a medias. El adelanto puede ser
 * parcial y con varios medios; la entrega no lo exige. Un reintento con la misma
 * clave devuelve la misma venta (también al día siguiente); la misma clave con
 * otra venta es un conflicto, como en la caja.
 */
export async function createJobOrderSale(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: JobOrderSaleInput,
) {
  await requirePatient(tx, orgId, patientId)
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId))
    throw invalidField("requestId", "Falta la clave de la venta")
  const fingerprint = saleFingerprint(patientId, input)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('job_order:' || ${orgId} || ':' || ${input.requestId}))`)
  const [replay] = await tx
    .select({ id: jobOrder.id, fingerprint: jobOrder.requestFingerprint })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.requestKey, input.requestId), isNull(jobOrder.remakeOf)))
  if (replay) {
    if (replay.fingerprint !== fingerprint)
      throw new ServiceError("REQUEST_ID_CONFLICT", 409, "Esta venta ya se guardó con otros datos: búscala en Pedidos antes de volver a venderla")
    const [ticket] = await tx
      .select({ id: paymentTicket.id })
      .from(paymentTicket)
      .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.requestId, input.requestId)))
    return { order: await getJobOrder(tx, orgId, replay.id), ticketId: ticket?.id ?? null }
  }

  const title = text(input.title, "title", "qué es el pedido")
  const maker = text(input.maker, "maker", "quién lo hace")
  const promisedOn = isoDate(input.promisedOn, "promisedOn")
  if (promisedOn < (await clinicToday(tx, orgId)))
    throw invalidField("promisedOn", "La fecha prometida no puede ser anterior a hoy")
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 20)
    throw invalidField("lines", "Agrega lo que lleva el pedido (hasta 20 cosas)")

  // La referencia (vistIA: la receta vigente) se copia: el taller no abre la historia.
  const hooks = await productHooks(tx, orgId)
  let prescription: Record<string, unknown> | null = null
  if (input.referenceId) {
    if (!hooks.saleReference) throw invalidField("referenceId", "Este producto no copia una receta en el pedido")
    prescription = await hooks.saleReference.snapshot(tx, orgId, patientId, input.referenceId)
    if (!prescription) throw invalidField("referenceId", "Esa receta no es la vigente de esta persona")
  }

  const charges: Array<{ id: string; line: JobOrderSaleLine; description: string; quantity: number }> = []
  for (const [index, line] of input.lines.entries()) {
    const at = `lines[${index}]`
    if (!(JOB_ORDER_LINE_KINDS as readonly string[]).includes(line.kind)) throw invalidField(`${at}.kind`, "Elige qué es")
    if (!line.productId && line.quantity != null && line.quantity !== 1)
      throw invalidField(`${at}.quantity`, "La cantidad va con un producto del inventario: a precio libre, escribe el precio de todo")
    const charge = line.productId
      ? await createCharge(tx, orgId, actorUserId, patientId, {
          productId: line.productId,
          quantity: line.quantity ?? 1,
          branchId: input.branchId,
          requestKey: `${input.requestId}:${index}`,
        })
      : await createCharge(tx, orgId, actorUserId, patientId, {
          description: text(line.description, `${at}.description`, "qué es"),
          amountCents: line.amountCents ?? undefined,
          branchId: input.branchId,
        })
    charges.push({ id: charge.id, line, description: charge.description, quantity: line.productId ? (line.quantity ?? 1) : 1 })
  }

  const [order] = await tx
    .insert(jobOrder)
    .values({
      organizationId: orgId,
      branchId: input.branchId,
      patientId,
      orderNumber: await nextOrderNumber(tx, orgId),
      requestKey: input.requestId,
      requestFingerprint: fingerprint,
      promisedOn,
      maker,
      title,
      prescription,
      fitting: fittingOf(input.fitting),
      notes: optional(input.notes, "notes"),
      createdBy: actorUserId,
    })
    .returning()
  await tx.insert(jobOrderLine).values(
    charges.map((item, position) => ({
      organizationId: orgId,
      jobOrderId: order!.id,
      kind: item.line.kind,
      description: item.description,
      productId: item.line.productId ?? null,
      quantity: item.quantity,
      chargeId: item.id,
      position,
    })),
  )
  await tx.insert(jobOrderEvent).values({ organizationId: orgId, jobOrderId: order!.id, status: "por_enviar", actorUserId })
  await audit(tx, orgId, actorUserId, "job_order.created", order!.id, { patientId, lines: charges.length })

  const payments = input.payments ?? []
  const deposit = payments.length
    ? await collectCharge(tx, orgId, actorUserId, patientId, {
        branchId: input.branchId,
        chargeIds: charges.map((item) => item.id),
        payments,
        // La misma clave: el ticket del adelanto es de esta venta.
        requestId: input.requestId,
        ...(input.cashReceivedCents !== undefined ? { cashReceivedCents: input.cashReceivedCents } : {}),
        ...(input.payerContactId ? { payerContactId: input.payerContactId } : {}),
      })
    : null
  return { order: await getJobOrder(tx, orgId, order!.id), ticketId: deposit?.ticket.id ?? null }
}

async function lockOrder(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ order: jobOrder, remadeAs: sql<string | null>`${remadeAsOf(jobOrder.id)}` })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.id, id)))
    .for("update", { of: jobOrder })
  if (!row) throw notFound("Pedido")
  return { ...row.order, remadeAs: row.remadeAs }
}

/** Un pedido que se rehízo sigue en el nuevo: el original ya no avanza ni se anula. */
async function refuseRemade(tx: Db, orgId: string, remadeAs: string | null): Promise<void> {
  if (!remadeAs) return
  const [next] = await tx
    .select({ orderNumber: jobOrder.orderNumber })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.id, remadeAs)))
  throw new ServiceError("JOB_ORDER_REMADE", 409, `Este pedido se rehízo en el N.º ${next?.orderNumber ?? ""}: sigue en ese`)
}

/**
 * Avanza el pedido a un paso siguiente (se puede saltar uno: el taller propio no
 * pasa por «En laboratorio»). Nunca vuelve atrás: si algo salió mal, se rehace.
 * `at` es para la demo, que avanza en su propia noche.
 */
export async function advanceJobOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { status: unknown; note?: unknown },
  options: { at?: Date } = {},
) {
  const row = await lockOrder(tx, orgId, id)
  const next = input.status
  if (!(JOB_ORDER_STEPS as readonly unknown[]).includes(next)) throw invalidField("status", "Elige el paso del pedido")
  if (row.status === "anulado") throw new ServiceError("JOB_ORDER_VOIDED", 409, "El pedido está anulado")
  await refuseRemade(tx, orgId, row.remadeAs)
  const from = JOB_ORDER_STEPS.indexOf(row.status as JobOrderStep)
  const to = JOB_ORDER_STEPS.indexOf(next as JobOrderStep)
  if (to <= from) throw new ServiceError("JOB_ORDER_BACKWARDS", 409, `El pedido ya está ${JOB_ORDER_STATUS_LABELS[row.status as JobOrderStatus].toLowerCase()}: si algo salió mal, rehazlo`)
  const now = options.at ?? new Date()
  await tx
    .update(jobOrder)
    .set({ status: next as JobOrderStep, ...(next === "entregado" ? { deliveredAt: now } : {}), updatedAt: now })
    .where(eq(jobOrder.id, id))
  await tx.insert(jobOrderEvent).values({
    organizationId: orgId,
    jobOrderId: id,
    status: next as JobOrderStep,
    note: optional(input.note, "note"),
    actorUserId,
    at: now,
  })
  await audit(tx, orgId, actorUserId, "job_order.advanced", id, { from: row.status, to: next })
  // Listo: le avisa a la persona que puede recogerlo (ADR 0172). Si no sale, el pedido lo dice.
  if (next === "listo") await sendOrderReadyNotice(tx, orgId, actorUserId, id)
  return getJobOrder(tx, orgId, id)
}

/**
 * Anula un pedido que no se entregó, con su motivo. Lo que no se cobró se anula
 * con él en la caja, con la anulación de siempre (`voidCharge`: la montura vuelve
 * al inventario), salvo lo que comparte con otro pedido vivo (el original de un
 * rehecho); lo que ya tiene algo cobrado queda en su cuenta, para que la clínica
 * decida si lo devuelve o lo usa: no se devuelve dinero solo. Un pedido que se
 * rehízo no se anula: sigue en el nuevo.
 */
export async function voidJobOrder(tx: Db, orgId: string, actorUserId: string, id: string, input: { reason: unknown }) {
  const reason = text(input.reason, "reason", "el motivo", NOTES_MAX)
  const row = await lockOrder(tx, orgId, id)
  if (row.status === "anulado") throw new ServiceError("JOB_ORDER_VOIDED", 409, "El pedido ya está anulado")
  if (row.status === "entregado") throw new ServiceError("JOB_ORDER_DELIVERED", 409, "El pedido ya se entregó: si algo salió mal, rehazlo")
  await refuseRemade(tx, orgId, row.remadeAs)
  const charges = await tx
    .select({
      id: patientCharge.id,
      paid: sql<boolean>`exists (
        select 1 from ${patientPaymentApplication}
        where ${patientPaymentApplication.organizationId} = ${patientCharge.organizationId}
          and ${patientPaymentApplication.chargeId} = ${patientCharge.id}
          and ${patientPaymentApplication.voidedAt} is null)`,
      shared: sql<boolean>`exists (
        select 1 from job_order_line other_line
        join job_order other_order on other_order.organization_id = other_line.organization_id and other_order.id = other_line.job_order_id
        where other_line.organization_id = ${jobOrderLine.organizationId} and other_line.charge_id = ${jobOrderLine.chargeId}
          and other_line.job_order_id <> ${jobOrderLine.jobOrderId} and other_order.status <> 'anulado')`,
    })
    .from(jobOrderLine)
    .innerJoin(patientCharge, liveChargeOfLine)
    .where(and(eq(jobOrderLine.organizationId, orgId), eq(jobOrderLine.jobOrderId, id)))
  for (const charge of charges) {
    if (charge.paid || charge.shared) continue
    await voidCharge(tx, orgId, actorUserId, row.patientId, charge.id, { reason: `Pedido N.º ${row.orderNumber} anulado: ${reason}`.slice(0, 2000) })
  }
  const now = new Date()
  await tx.update(jobOrder).set({ status: "anulado", voidedAt: now, voidReason: reason, updatedAt: now }).where(eq(jobOrder.id, id))
  await tx.insert(jobOrderEvent).values({ organizationId: orgId, jobOrderId: id, status: "anulado", note: reason, actorUserId, at: now })
  await audit(tx, orgId, actorUserId, "job_order.voided", id, { reason })
  return getJobOrder(tx, orgId, id)
}

/**
 * Rehace un pedido (vuelve porque no ve bien, se rompió en el taller): uno nuevo,
 * unido al original, con lo mismo y con sus mismos cargos: no se cobra otra vez y
 * lo que faltaba pagar sigue en el nuevo. El original queda reemplazado. Un
 * reintento con la misma clave devuelve el mismo.
 */
export async function remakeJobOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { reason: unknown; promisedOn: unknown; maker?: unknown; requestId: unknown },
) {
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId))
    throw invalidField("requestId", "Falta la clave de lo que se rehace")
  const original = await lockOrder(tx, orgId, id)
  const [replay] = await tx
    .select({ id: jobOrder.id })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.requestKey, input.requestId)))
  if (replay) {
    if (original.remadeAs !== replay.id) throw new ServiceError("REQUEST_ID_CONFLICT", 409, "Este pedido ya se rehízo con otros datos: búscalo en Pedidos")
    return getJobOrder(tx, orgId, replay.id)
  }
  const reason = text(input.reason, "reason", "por qué se rehace", NOTES_MAX)
  const promisedOn = isoDate(input.promisedOn, "promisedOn")
  if (promisedOn < (await clinicToday(tx, orgId)))
    throw invalidField("promisedOn", "La fecha prometida no puede ser anterior a hoy")
  if (original.status === "anulado") throw new ServiceError("JOB_ORDER_VOIDED", 409, "El pedido está anulado")
  await refuseRemade(tx, orgId, original.remadeAs)
  const lines = await tx
    .select()
    .from(jobOrderLine)
    .where(and(eq(jobOrderLine.organizationId, orgId), eq(jobOrderLine.jobOrderId, id)))
    .orderBy(asc(jobOrderLine.position))
  const [order] = await tx
    .insert(jobOrder)
    .values({
      organizationId: orgId,
      branchId: original.branchId,
      patientId: original.patientId,
      orderNumber: await nextOrderNumber(tx, orgId),
      requestKey: input.requestId,
      promisedOn,
      maker: input.maker === undefined || input.maker === null ? original.maker : text(input.maker, "maker", "quién lo hace"),
      title: original.title,
      prescription: original.prescription,
      fitting: original.fitting,
      notes: original.notes,
      remakeOf: original.id,
      remakeReason: reason,
      createdBy: actorUserId,
    })
    .returning()
  if (lines.length)
    await tx.insert(jobOrderLine).values(
      lines.map((line) => ({
        organizationId: orgId,
        jobOrderId: order!.id,
        kind: line.kind,
        description: line.description,
        productId: line.productId,
        quantity: line.quantity,
        // Rehacer no se cobra: las líneas siguen con los cargos de la venta.
        chargeId: line.chargeId,
        position: line.position,
      })),
    )
  await tx.insert(jobOrderEvent).values({ organizationId: orgId, jobOrderId: order!.id, status: "por_enviar", note: reason, actorUserId })
  await audit(tx, orgId, actorUserId, "job_order.remade", order!.id, { remakeOf: original.id, reason })
  return getJobOrder(tx, orgId, order!.id)
}

/**
 * Lo que falta pagar de los cargos de cada pedido, en centavos: el importe de cada
 * cargo vigente menos lo aplicado vigente, como lo cuenta la caja.
 */
async function dueByOrder(tx: Db, orgId: string, orderIds: readonly string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map()
  const applied = sql`coalesce((select sum(${patientPaymentApplication.amountCents}) from ${patientPaymentApplication}
    where ${patientPaymentApplication.organizationId} = ${patientCharge.organizationId}
      and ${patientPaymentApplication.chargeId} = ${patientCharge.id}
      and ${patientPaymentApplication.voidedAt} is null), 0)`
  const rows = await tx
    .select({
      id: jobOrderLine.jobOrderId,
      due: sql<number>`coalesce(sum(greatest(${patientCharge.amountCents} - ${applied}, 0)), 0)::int`,
    })
    .from(jobOrderLine)
    .innerJoin(patientCharge, liveChargeOfLine)
    .where(and(eq(jobOrderLine.organizationId, orgId), inArray(jobOrderLine.jobOrderId, [...orderIds])))
    .groupBy(jobOrderLine.jobOrderId)
  return new Map(rows.map((row) => [row.id, Number(row.due)]))
}

/** La moneda de la clínica, la de los cargos de sus pedidos. */
async function orgCurrency(tx: Db, orgId: string): Promise<string | null> {
  const [row] = await tx.select({ currency: orgProfile.currency }).from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  return row?.currency ?? null
}

export interface JobOrderRow {
  id: string
  orderNumber: number
  status: JobOrderStatus
  statusLabel: string
  patientId: string
  patientName: string
  title: string
  maker: string
  promisedOn: string
  /** Pasó la fecha prometida y todavía no está listo. */
  overdue: boolean
  remakeOf: string | null
  /** El pedido que lo rehízo, si sigue vivo: este ya no es el que se trabaja. */
  remadeAs: string | null
  /** Lo que falta pagar (null para quien no ve la caja), en `currency`. */
  dueCents: number | null
  currency: string | null
  createdAt: string
}

const OPEN_STEPS = ["por_enviar", "en_laboratorio", "por_revisar"] as const

/**
 * Los pedidos de la clínica: los que se trabajan, del que vence antes al que
 * vence después (sin los que se rehicieron, que siguen en el nuevo); los
 * entregados y anulados, del más reciente al más antiguo. `withMoney`: con lo que
 * falta pagar.
 */
export async function listJobOrders(
  tx: Db,
  orgId: string,
  filter: { status?: JobOrderStatus | "abiertos" | "atrasados"; patientId?: string | null; withMoney: boolean },
): Promise<JobOrderRow[]> {
  const today = await clinicToday(tx, orgId)
  const remadeAs = sql<string | null>`${remadeAsOf(jobOrder.id)}`
  // La historia bloqueada (ADR 0080) no existe para los demás: tampoco sus pedidos.
  const conditions = [eq(jobOrder.organizationId, orgId), isNull(patientPerson.recordLockedAt)]
  if (filter.patientId) conditions.push(eq(jobOrder.patientId, filter.patientId))
  const working = filter.status === "abiertos" || filter.status === "atrasados" || (OPEN_STEPS as readonly string[]).includes(filter.status ?? "") || filter.status === "listo"
  if (filter.status === "abiertos") conditions.push(inArray(jobOrder.status, [...OPEN_STEPS, "listo"]))
  else if (filter.status === "atrasados") conditions.push(inArray(jobOrder.status, [...OPEN_STEPS]), sql`${jobOrder.promisedOn} < ${today}`)
  else if (filter.status) conditions.push(eq(jobOrder.status, filter.status))
  if (working) conditions.push(sql`${remadeAs} is null`)
  const rows = await tx
    .select({ order: jobOrder, patientName: patientPerson.displayName, remadeAs })
    .from(jobOrder)
    .innerJoin(patient, and(eq(patient.organizationId, jobOrder.organizationId), eq(patient.id, jobOrder.patientId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(...conditions))
    .orderBy(...(working ? [asc(jobOrder.promisedOn), desc(jobOrder.orderNumber)] : [desc(jobOrder.updatedAt), desc(jobOrder.orderNumber)]))
    .limit(500)
  const due = filter.withMoney ? await dueByOrder(tx, orgId, rows.map((row) => row.order.id)) : new Map()
  const currency = await orgCurrency(tx, orgId)
  return rows.map(({ order, patientName, remadeAs: next }) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as JobOrderStatus,
    statusLabel: JOB_ORDER_STATUS_LABELS[order.status as JobOrderStatus],
    patientId: order.patientId,
    patientName,
    title: order.title,
    maker: order.maker,
    promisedOn: order.promisedOn,
    overdue: (OPEN_STEPS as readonly string[]).includes(order.status) && order.promisedOn < today && !next,
    remakeOf: order.remakeOf,
    remadeAs: next,
    dueCents: filter.withMoney ? (due.get(order.id) ?? 0) : null,
    currency,
    createdAt: order.createdAt.toISOString(),
  }))
}

/**
 * El pedido entero: lo que lleva, la copia de la receta, las medidas y quién
 * marcó cada paso. `withPrescription`: la copia de la receta, solo para quien la
 * puede leer (quien la hace, quien vende con ella o quien lee la historia).
 */
export async function getJobOrder(
  tx: Db,
  orgId: string,
  id: string,
  options: { withMoney?: boolean; withPrescription?: boolean } = {},
) {
  const [row] = await tx
    .select({ order: jobOrder, patientName: patientPerson.displayName, remadeAs: sql<string | null>`${remadeAsOf(jobOrder.id)}` })
    .from(jobOrder)
    .innerJoin(patient, and(eq(patient.organizationId, jobOrder.organizationId), eq(patient.id, jobOrder.patientId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.id, id)))
  if (!row) throw notFound("Pedido")
  const lines = await tx
    .select({
      id: jobOrderLine.id,
      kind: jobOrderLine.kind,
      description: jobOrderLine.description,
      quantity: jobOrderLine.quantity,
      chargeId: jobOrderLine.chargeId,
      amountCents: patientCharge.amountCents,
    })
    .from(jobOrderLine)
    .leftJoin(patientCharge, liveChargeOfLine)
    .where(and(eq(jobOrderLine.organizationId, orgId), eq(jobOrderLine.jobOrderId, id)))
    .orderBy(asc(jobOrderLine.position))
  const events = await tx
    .select({ status: jobOrderEvent.status, note: jobOrderEvent.note, at: jobOrderEvent.at, actorName: user.name })
    .from(jobOrderEvent)
    .leftJoin(user, eq(user.id, jobOrderEvent.actorUserId))
    .where(and(eq(jobOrderEvent.organizationId, orgId), eq(jobOrderEvent.jobOrderId, id)))
    .orderBy(asc(jobOrderEvent.at))
  const related = [row.order.remakeOf, row.remadeAs].filter((value): value is string => Boolean(value))
  const numbers = related.length
    ? new Map(
        (
          await tx
            .select({ id: jobOrder.id, orderNumber: jobOrder.orderNumber })
            .from(jobOrder)
            .where(and(eq(jobOrder.organizationId, orgId), inArray(jobOrder.id, related)))
        ).map((item) => [item.id, item.orderNumber]),
      )
    : new Map<string, number>()
  const today = await clinicToday(tx, orgId)
  const withMoney = options.withMoney ?? true
  const due = withMoney ? await dueByOrder(tx, orgId, [id]) : new Map()
  const order = row.order
  const link = (orderId: string | null) => (orderId ? { id: orderId, orderNumber: numbers.get(orderId) ?? null } : null)
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as JobOrderStatus,
    statusLabel: JOB_ORDER_STATUS_LABELS[order.status as JobOrderStatus],
    patientId: order.patientId,
    patientName: row.patientName,
    title: order.title,
    maker: order.maker,
    promisedOn: order.promisedOn,
    overdue: (OPEN_STEPS as readonly string[]).includes(order.status) && order.promisedOn < today && !row.remadeAs,
    /** La copia de la receta; null si no lleva o si quien mira no la puede leer (`prescriptionHidden`). */
    prescription: options.withPrescription === false ? null : (order.prescription as Record<string, unknown> | null),
    prescriptionHidden: options.withPrescription === false && order.prescription !== null,
    fitting: order.fitting as Record<string, unknown> | null,
    notes: order.notes,
    remakeOf: order.remakeOf,
    remakeOfOrder: link(order.remakeOf),
    remadeAs: link(row.remadeAs),
    remakeReason: order.remakeReason,
    voidReason: order.voidReason,
    lines: lines.map((line) => ({ ...line, amountCents: withMoney ? line.amountCents : null })),
    events: events.map((event) => ({
      status: event.status as JobOrderStatus,
      statusLabel: JOB_ORDER_STATUS_LABELS[event.status as JobOrderStatus],
      note: event.note,
      at: event.at.toISOString(),
      actorName: event.actorName,
    })),
    dueCents: withMoney ? (due.get(id) ?? 0) : null,
    currency: await orgCurrency(tx, orgId),
    /** «Pedido listo»: si salió, si llegó, si falló o si no se sabe (ADR 0172). */
    readyNotice:
      order.status === "listo"
        ? await orderNoticeOf(tx, orgId, order)
        : order.status === "entregado"
          ? deliveredNotice(await orderNoticeOf(tx, orgId, order))
          : null,
  }
}

/** Entregado, solo se dice el aviso que salió: lo que no salió ya no hace falta. */
function deliveredNotice(notice: Awaited<ReturnType<typeof orderNoticeOf>>) {
  if (!notice || notice.status === "no_salio" || notice.status === "fallo" || notice.status === "dudoso") return null
  return { ...notice, canResend: false }
}

/** Lo que el producto muestra al vender y copia en el pedido (vistIA: las recetas de lentes vigentes). */
export async function saleReferencesOf(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const hooks = await productHooks(tx, orgId)
  return hooks.saleReference ? hooks.saleReference.current(tx, orgId, patientId) : []
}
