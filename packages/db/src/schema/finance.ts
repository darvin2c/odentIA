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
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { orgFk, timestamps } from "./crm.js"
import { patient, patientCharge, patientPayment, patientPaymentApplication } from "./clinical.js"
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
    /** Cuánto queda en caja para el día siguiente y cuánto se entrega (suman el contado). */
    retainedCents: integer("retained_cents"),
    deliveredCents: integer("delivered_cents"),
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
    /** Tipo UN/CEFACT 4461 congelado al cobrar (10 efectivo). Nulo = histórico anterior. */
    methodTypeCode: text("method_type_code"),
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
    /** Tipo del gasto (Personal, Alquiler, Laboratorio, Materiales, Servicios, Impuestos, Otros). */
    category: text("category").notNull().default("Otros"),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    spentAt: timestamp("spent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Comprobante libre según país (fase 3 deja el tipo libre; el catálogo llega con el módulo fiscal). */
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
  ],
)
/** Cierre de caja inmutable: congela la ventana desde el cierre anterior. Lo posterior corrige como movimiento del día en que se corrige. */
export const cashClosure = pgTable(
  "cash_closure",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    currency: char("currency", { length: 3 }).notNull(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => cashShift.id),
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    /** Quedó del cierre anterior + cobros en efectivo − gastos de caja. */
    openingRetainedCents: integer("opening_retained_cents").notNull().default(0),
    cashCollectedCents: integer("cash_collected_cents").notNull().default(0),
    expenseCashCents: integer("expense_cash_cents").notNull().default(0),
    expectedCents: integer("expected_cents").notNull(),
    countedCents: integer("counted_cents").notNull(),
    differenceCents: integer("difference_cents").notNull(),
    retainedCents: integer("retained_cents").notNull(),
    deliveredCents: integer("delivered_cents").notNull(),
    /** Totales por medio no efectivo para comparar con su reporte. */
    totalsByMethod: jsonb("totals_by_method").notNull(),
    notes: text("notes"),
    closedBy: text("closed_by").references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cash_closure_org_branch_idx").on(table.organizationId, table.branchId, table.closedAt),
    uniqueIndex("cash_closure_shift_uidx").on(table.organizationId, table.shiftId),
  ],
)

/** Porcentaje único de comisión por profesional (puntos básicos: 4000 = 40 %).
 * Fase 8: una sola tasa por profesional sobre lo cobrado de lo que atendió.
 * Reemplaza las reglas por base/servicio/sede: la migración conserva solo la
 * tasa general de cobrado inequívoca (un profesional, una sola regla general)
 * y deja sin configurar al resto; la evidencia queda en `audit_event`. */
export const commissionRule = pgTable(
  "commission_rule",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    professionalUserId: text("professional_user_id")
      .notNull()
      .references(() => user.id),
    rateBps: integer("rate_bps").notNull(),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("commission_rule_org_prof_uidx").on(table.organizationId, table.professionalUserId),
    check("commission_rule_rate_check", sql`${table.rateBps} BETWEEN 0 AND 10000`),
  ],
)

/**
 * Liquidación de comisiones de un profesional en una moneda. Fase 8 liquida
 * por mes (`periodYear`/`periodMonth` siempre informados en lo nuevo).
 * `periodFrom`/`periodTo` se conservan como rango histórico: la migración
 * solo informa año/mes cuando el rango cae dentro de un mismo mes civil, sin
 * inventar mes para rangos multimes. `base` conserva 'cobrado'/'produccion'
 * previos; `rateBps` null = histórico multirregla. `expenseId` enlaza el pago
 * registrado como gasto de Personal (exactamente uno por liquidación).
 * 'borrador' se conserva para filas históricas sin acción real (no se borra
 * dato); lo nuevo siempre nace 'liquidada'.
 */
export const commissionSettlement = pgTable(
  "commission_settlement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    professionalUserId: text("professional_user_id")
      .notNull()
      .references(() => user.id),
    /** Rango histórico (nullable; lo nuevo usa año/mes y lo deja nulo). */
    periodFrom: date("period_from"),
    periodTo: date("period_to"),
    /** Mes liquidado (nulo en histórico multimes que no encaja). */
    periodYear: integer("period_year"),
    periodMonth: integer("period_month"),
    base: text("base").notNull().default("cobrado"),
    currency: char("currency", { length: 3 }).notNull(),
    rateBps: integer("rate_bps"),
    baseCents: integer("base_cents").notNull().default(0),
    commissionCents: integer("commission_cents").notNull().default(0),
    expenseId: uuid("expense_id").references(() => expense.id),
    status: text("status").notNull().default("liquidada"),
    notes: text("notes"),
    settledBy: text("settled_by").references(() => user.id),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    // Solo liquidaciones mensuales nuevas: el histórico (año/mes nulos o
    // anulado) no entra al único-por-mes aunque comparta profesional y mes.
    uniqueIndex("commission_settlement_month_uidx")
      .on(
        table.organizationId,
        table.professionalUserId,
        table.periodYear,
        table.periodMonth,
        table.currency,
      )
      .where(
        sql`${table.voidedAt} IS NULL AND ${table.periodYear} IS NOT NULL AND ${table.periodMonth} IS NOT NULL`,
      ),
    check("commission_settlement_base_check", sql`${table.base} IN ('cobrado','produccion')`),
    check(
      "commission_settlement_status_check",
      sql`${table.status} IN ('borrador','liquidada','anulada')`,
    ),
    check(
      "commission_settlement_month_check",
      sql`${table.periodMonth} IS NULL OR (${table.periodMonth} BETWEEN 1 AND 12)`,
    ),
    check("commission_settlement_rate_check", sql`${table.rateBps} IS NULL OR (${table.rateBps} BETWEEN 0 AND 10000)`),
  ],
)

/**
 * Línea trazable de una liquidación: qué cobro originó cada importe.
 * `sourceKey` (`app:<applicationId>`) impide comisionar dos veces la misma
 * fuente entre liquidaciones vigentes, incluidas las anteriores a Fase 8
 * (se preservan como histórico explícito). Las correcciones son anulaciones,
 * nunca borrado.
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
    applicationId: uuid("application_id").references(() => patientPaymentApplication.id),
    chargeId: uuid("charge_id").references(() => patientCharge.id),
    paymentId: uuid("payment_id").references(() => patientPayment.id),
    patientId: uuid("patient_id").references(() => patient.id),
    description: text("description").notNull(),
    baseCents: integer("base_cents").notNull(),
    commissionCents: integer("commission_cents").notNull(),
    rateBps: integer("rate_bps"),
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
