/**
 * Finanzas: caja por sede/turno, gastos y proveedores, cuentas por cobrar con
 * planes de cuotas, y comisiones por profesional.
 *
 * Invariantes:
 * - Dinero siempre en centavos enteros (`integer`) con moneda ISO congelada por
 *   documento; cambiar la configuración nunca reinterpreta históricos.
 * - Nada se borra: las correcciones son anulaciones con motivo y auditoría.
 * - Un cobro real (`patient_payment`) se integra a caja una sola vez.
 * - Las cuotas calendarizan un cargo existente: nunca duplican la deuda.
 * - Sin emisor fiscal ni pasarela: no hay emisión de comprobantes ni cobro
 *   online en este dominio.
 */
import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { orgFk, timestamps } from "./crm.js"
import { patient, patientCharge, patientPayment } from "./clinical.js"
import { supplier } from "./inventory.js"
import { branch } from "./org.js"

/** Turno de caja de una sucursal. Solo un turno abierto por sucursal+moneda. */
export const cashShift = pgTable(
  "cash_shift",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    currency: char("currency", { length: 3 }).notNull(),
    openingCents: integer("opening_cents").notNull().default(0),
    status: text("status").notNull().default("abierta"),
    openedBy: text("opened_by").references(() => user.id),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openNotes: text("open_notes"),
    closedBy: text("closed_by").references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Esperado en efectivo al cierre: solo apertura e ingresos en efectivo menos egresos. */
    expectedCents: integer("expected_cents"),
    /** Cobros electrónicos (tarjeta/transferencia/yape/plin) del turno: no entran al arqueo. */
    electronicCents: integer("electronic_cents"),
    /** Contado físico al cierre; la diferencia es contado − esperado en efectivo. */
    countedCents: integer("counted_cents"),
    differenceCents: integer("difference_cents"),
    closeNotes: text("close_notes"),
  },
  (table) => [
    index("cash_shift_org_branch_idx").on(table.organizationId, table.branchId, table.status),
    // Un solo turno abierto por sucursal y moneda (el cierre la libera).
    uniqueIndex("cash_shift_open_uidx")
      .on(table.organizationId, table.branchId, table.currency)
      .where(sql`status = 'abierta'`),
    check("cash_shift_opening_check", sql`${table.openingCents} >= 0`),
    check(
      "cash_shift_status_check",
      sql`${table.status} IN ('abierta','cerrada')`,
    ),
  ],
)

export const CASH_MOVEMENT_KINDS = [
  "apertura",
  "cobro",
  "gasto",
  "aporte",
  "retiro",
  "devolucion",
  "ajuste",
] as const

export const CASH_MOVEMENT_DIRECTIONS = ["ingreso", "egreso"] as const

/** Movimiento de caja. Los cobros enlazan el pago real; los gastos, el gasto. */
export const cashMovement = pgTable(
  "cash_movement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => cashShift.id),
    direction: text("direction").notNull(),
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    method: text("method"),
    concept: text("concept").notNull(),
    patientPaymentId: uuid("patient_payment_id").references(() => patientPayment.id),
    // FK cash_movement.expense_id → expense.id la crea la migración conjunta
    // (expense se declara después; ver local://finance-constraints.sql).
    expenseId: uuid("expense_id"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("cash_movement_org_shift_idx").on(table.organizationId, table.shiftId),
    // Un cobro real entra a caja una sola vez (solo filas vigentes).
    uniqueIndex("cash_movement_payment_uidx")
      .on(table.organizationId, table.patientPaymentId)
      .where(sql`${table.patientPaymentId} IS NOT NULL AND ${table.voidedAt} IS NULL`),
    check("cash_movement_amount_check", sql`${table.amountCents} > 0`),
    check(
      "cash_movement_direction_check",
      sql`${table.direction} IN ('ingreso','egreso')`,
    ),
    check(
      "cash_movement_kind_check",
      sql`${table.kind} IN ('apertura','cobro','gasto','aporte','retiro','devolucion','ajuste')`,
    ),
  ],
)

// Proveedores: catálogo único en schema/inventory.ts (`supplier`, compartido
// con Inventario). Los gastos referencian ese catálogo; no duplicar.

/** Gasto de la organización; enlazado a caja chica cuando pasa por un turno. */
export const expense = pgTable(
  "expense",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    supplierId: uuid("supplier_id").references(() => supplier.id),
    shiftId: uuid("shift_id").references(() => cashShift.id),
    concept: text("concept").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    spentAt: timestamp("spent_at", { withTimezone: true }).notNull().defaultNow(),
    receiptKind: text("receipt_kind").notNull().default("ninguno"),
    receiptNumber: text("receipt_number"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("expense_org_branch_spent_idx").on(
      table.organizationId,
      table.branchId,
      table.spentAt,
    ),
    index("expense_org_supplier_idx").on(table.organizationId, table.supplierId),
    check("expense_amount_check", sql`${table.amountCents} > 0`),
    check(
      "expense_receipt_check",
      sql`${table.receiptKind} IN ('boleta','factura','recibo','nota','ninguno')`,
    ),
  ],
)

/**
 * Plan de cuotas sobre un cargo existente. Las cuotas calendarizan el cobro;
 * el saldo real sigue viviendo en cargos menos aplicaciones (sin duplicar deuda).
 */
export const installmentPlan = pgTable(
  "installment_plan",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => patientCharge.id),
    currency: char("currency", { length: 3 }).notNull(),
    totalCents: integer("total_cents").notNull(),
    installments: integer("installments").notNull(),
    status: text("status").notNull().default("vigente"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("installment_plan_org_patient_idx").on(table.organizationId, table.patientId),
    // Un cargo se calendariza una sola vez mientras el plan esté vigente.
    uniqueIndex("installment_plan_charge_uidx")
      .on(table.organizationId, table.chargeId)
      .where(sql`${table.voidedAt} IS NULL`),
    check("installment_plan_total_check", sql`${table.totalCents} > 0`),
    check("installment_plan_count_check", sql`${table.installments} BETWEEN 1 AND 60`),
    check(
      "installment_plan_status_check",
      sql`${table.status} IN ('vigente','saldada','anulada')`,
    ),
  ],
)

/** Cuota de un plan: monto esperado y vencimiento; el pago real va al cargo. */
export const installmentQuota = pgTable(
  "installment_quota",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    planId: uuid("plan_id")
      .notNull()
      .references(() => installmentPlan.id, { onDelete: "cascade" }),
    nro: integer("nro").notNull(),
    dueAt: date("due_at").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pendiente"),
    paidCents: integer("paid_cents").notNull().default(0),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("installment_quota_org_plan_idx").on(table.organizationId, table.planId),
    uniqueIndex("installment_quota_plan_nro_uidx").on(table.planId, table.nro),
    check("installment_quota_nro_check", sql`${table.nro} > 0`),
    check("installment_quota_amount_check", sql`${table.amountCents} > 0`),
    check("installment_quota_paid_check", sql`${table.paidCents} >= 0`),
    check(
      "installment_quota_status_check",
      sql`${table.status} IN ('pendiente','parcial','pagada','vencida')`,
    ),
  ],
)

export const COMMISSION_BASES = ["cobrado", "produccion"] as const

/**
 * Regla de comisión por profesional. `rateBps` son puntos básicos
 * (1500 = 15 %). `base` deja explícito si se liquida sobre lo cobrado o lo
 * producido. `serviceId`/`branchId` nulos = regla general del profesional.
 */
export const commissionRule = pgTable(
  "commission_rule",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    professionalUserId: text("professional_user_id")
      .notNull()
      .references(() => user.id),
    base: text("base").notNull(),
    rateBps: integer("rate_bps").notNull(),
    serviceId: uuid("service_id"),
    branchId: uuid("branch_id").references(() => branch.id),
    isActive: boolean("is_active").notNull().default(true),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("commission_rule_org_prof_idx").on(table.organizationId, table.professionalUserId),
    check("commission_rule_rate_check", sql`${table.rateBps} BETWEEN 0 AND 10000`),
    check("commission_rule_base_check", sql`${table.base} IN ('cobrado','produccion')`),
  ],
)

/** Liquidación de comisiones de un profesional en un periodo y moneda. */
export const commissionSettlement = pgTable(
  "commission_settlement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    professionalUserId: text("professional_user_id")
      .notNull()
      .references(() => user.id),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    base: text("base").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    baseCents: integer("base_cents").notNull().default(0),
    commissionCents: integer("commission_cents").notNull().default(0),
    status: text("status").notNull().default("borrador"),
    notes: text("notes"),
    settledBy: text("settled_by").references(() => user.id),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("commission_settlement_org_prof_idx").on(
      table.organizationId,
      table.professionalUserId,
      table.periodFrom,
    ),
    check("commission_settlement_base_check", sql`${table.base} IN ('cobrado','produccion')`),
    check(
      "commission_settlement_status_check",
      sql`${table.status} IN ('borrador','liquidada','anulada')`,
    ),
    check(
      "commission_settlement_period_check",
      sql`${table.periodTo} >= ${table.periodFrom}`,
    ),
  ],
)

/**
 * Línea trazable de una liquidación: qué acto originó cada importe.
 * `sourceKey` identifica la fuente una sola vez (`app:<applicationId>` en
 * cobrado —cada aplicación parcial es una fuente distinta— o
 * `charge:<chargeId>` en producción) y su unique parcial impide comisionar
 * dos veces la misma fuente entre periodos solapados o llamadas
 * concurrentes. Las correcciones son anulaciones, nunca borrado.
 */
export const commissionSettlementLine = pgTable(
  "commission_settlement_line",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => commissionSettlement.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    chargeId: uuid("charge_id").references(() => patientCharge.id),
    paymentId: uuid("payment_id").references(() => patientPayment.id),
    patientId: uuid("patient_id").references(() => patient.id),
    description: text("description").notNull(),
    baseCents: integer("base_cents").notNull(),
    commissionCents: integer("commission_cents").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("commission_line_org_settlement_idx").on(table.organizationId, table.settlementId),
    uniqueIndex("commission_line_source_uidx")
      .on(table.organizationId, table.sourceKey)
      .where(sql`${table.voidedAt} IS NULL`),
    check("commission_line_base_check", sql`${table.baseCents} >= 0`),
    check("commission_line_amount_check", sql`${table.commissionCents} >= 0`),
  ],
)
