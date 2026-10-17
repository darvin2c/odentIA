/**
 * Finanzas: caja por sede (ventanas que nacen solas y solo se cierran), cierres
 * inmutables, gastos con su tipo y comisiones por profesional.
 *
 * Invariantes:
 * - Dinero siempre en enteros de la unidad menor de la moneda (ISO 4217), con
 *   la moneda congelada por documento; cambiar la configuración nunca
 *   reinterpreta históricos.
 * - Nada se borra: las correcciones son anulaciones con motivo y auditoría.
 * - Un cobro real (`patient_payment`) se integra a caja una sola vez.
 * - El arqueo cuenta solo efectivo, por el tipo del medio (UN/CEFACT 4461),
 *   nunca por su nombre.
 * - Sin emisor fiscal ni pasarela: no hay emisión de comprobantes ni cobro
 *   online en este dominio.
 */
import { sql } from "drizzle-orm"
import {
  char,
  check,
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
    // FK cash_movement.expense_id → expense.id en `0001_base_reglas.sql`
    // (expense se declara después).
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
      sql`${table.kind} IN ('apertura','cobro','gasto','aporte','retiro','devolucion')`,
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
    /**
     * Desglose del efectivo de la ventana. Siempre suma el esperado:
     * quedó + cobros + ingresado − gastos − retirado − devuelto.
     */
    openingRetainedCents: integer("opening_retained_cents").notNull().default(0),
    cashCollectedCents: integer("cash_collected_cents").notNull().default(0),
    /** Efectivo ingresado a mano (fondo, cambio). */
    cashAddedCents: integer("cash_added_cents").notNull().default(0),
    expenseCashCents: integer("expense_cash_cents").notNull().default(0),
    /** Efectivo retirado a mano (depósito, entrega parcial). */
    cashWithdrawnCents: integer("cash_withdrawn_cents").notNull().default(0),
    /** Efectivo devuelto a pacientes (devoluciones y anulaciones posteriores al cierre). */
    cashRefundedCents: integer("cash_refunded_cents").notNull().default(0),
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
    // Lo contado se reparte entero entre lo que queda y lo que se entrega.
    check(
      "cash_closure_split_check",
      sql`${table.retainedCents} + ${table.deliveredCents} = ${table.countedCents}`,
    ),
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
 * Liquidación de comisiones de un profesional en una moneda. Se liquida por
 * mes (`periodYear`/`periodMonth`). `base` conserva 'cobrado'/'produccion'
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
    // Un mes admite más de un pago (quincena, pago adelantado): cada pago
    // cubre lo pendiente hasta ese momento. Lo que impide pagar dos veces un
    // cobro es la unicidad por fuente de las líneas.
    index("commission_settlement_month_idx").on(
      table.organizationId,
      table.professionalUserId,
      table.periodYear,
      table.periodMonth,
    ),
    check("commission_settlement_base_check", sql`${table.base} IN ('cobrado','produccion')`),
    check(
      "commission_settlement_status_check",
      sql`${table.status} IN ('liquidada','anulada')`,
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
    /**
     * 'cobro': comisión de un cobro. 'ajuste': comisión ya pagada de un cobro
     * que después se anuló; resta del pago en el que entra.
     */
    kind: text("kind").notNull().default("cobro"),
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
    check("commission_line_kind_check", sql`${table.kind} IN ('cobro','ajuste')`),
  ],
)
