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
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { orgFk, timestamps } from "./crm.js"
import { patient, patientCharge, patientPayment, patientPaymentApplication, serviceCatalog } from "./clinical.js"
import { purchaseOrder } from "./inventory.js"
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
  // El vuelto en otra moneda: el exceso del billete entra en una caja y el vuelto
  // sale de la otra. Va unido al pago, en la caja de cada moneda.
  "vuelto",
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
    // Un cobro real entra a caja una sola vez (solo filas vigentes), en la moneda que sea.
    // Su vuelto es otro tipo y toca dos cajas: entra el exceso en una y sale el vuelto de
    // la otra, una vez cada uno.
    uniqueIndex("cash_movement_payment_uidx")
      .on(table.organizationId, table.patientPaymentId, table.kind, table.direction)
      .where(sql`${table.patientPaymentId} IS NOT NULL AND ${table.voidedAt} IS NULL`),
    check("cash_movement_amount_check", sql`${table.amountCents} > 0`),
    check(
      "cash_movement_direction_check",
      sql`${table.direction} IN ('ingreso','egreso')`,
    ),
    check(
      "cash_movement_kind_check",
      sql`${table.kind} IN ('apertura','cobro','gasto','aporte','retiro','devolucion','vuelto')`,
    ),
  ],
)

// Proveedores: catálogo único en schema/inventory.ts (`supplier`, compartido
// con Inventario). Los gastos referencian ese catálogo; no duplicar.

/** Cada cuántos meses puede repetirse un gasto: cada mes, cada 6 meses o cada año. */
export const RECURRING_EVERY_MONTHS = [1, 6, 12] as const

/**
 * Un gasto que se repite (el alquiler, un sueldo, la luz): la plantilla, no el
 * pago. Lo que hay por pagar se calcula al leer: un mes M tiene su ocurrencia si
 * M ≥ `first_month`, (M − `first_month`) es múltiplo de `every_months` y M ≤
 * `last_month`. Vence el día `min(day, último día de M)`: se guarda el día y no
 * la fecha, para que el 31 no se corra al 28 para siempre. Nunca se registra
 * solo: pagar es crear el gasto con `recurring_id` y `recurring_month`.
 * Se cambian importe, concepto, día, persona, si sale de la caja y el fin;
 * cada cuánto, la moneda, el tipo y la sede no (es terminarla y crear otra).
 */
export const expenseRecurring = pgTable(
  "expense_recurring",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    /** Un tipo de `EXPENSE_CATEGORIES` (lo valida el servicio, como en `expense`). */
    category: text("category").notNull(),
    concept: text("concept").notNull(),
    /** Lo que suele pagarse; cada pago puede llevar otro importe. */
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    everyMonths: smallint("every_months").notNull(),
    /** Día del mes en que vence (1–31); si el mes no lo tiene, el último. */
    day: smallint("day").notNull(),
    /** Mes de la primera ocurrencia, `YYYY-MM`. */
    firstMonth: text("first_month").notNull(),
    /** Último mes con ocurrencia, `YYYY-MM`; nulo mientras se repita. Antes del primero: ya no tiene ninguna. */
    lastMonth: text("last_month"),
    /** De quién es un sueldo: solo con el tipo «Personal». */
    memberUserId: text("member_user_id").references(() => user.id),
    /** Cómo suele pagarse: con el efectivo de la caja o fuera de ella. */
    fromCash: boolean("from_cash").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("expense_recurring_org_id_uidx").on(table.organizationId, table.id),
    index("expense_recurring_org_branch_idx").on(table.organizationId, table.branchId),
    index("expense_recurring_org_member_idx")
      .on(table.organizationId, table.memberUserId)
      .where(sql`${table.memberUserId} IS NOT NULL`),
    check("expense_recurring_every_check", sql`${table.everyMonths} IN (1, 6, 12)`),
    check("expense_recurring_day_check", sql`${table.day} BETWEEN 1 AND 31`),
    check("expense_recurring_amount_check", sql`${table.amountCents} > 0`),
    check(
      "expense_recurring_month_check",
      sql`${table.firstMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND (${table.lastMonth} IS NULL OR ${table.lastMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`,
    ),
    check(
      "expense_recurring_member_check",
      sql`${table.memberUserId} IS NULL OR ${table.category} = 'Personal'`,
    ),
  ],
)

/**
 * «No hubo este mes»: la ocurrencia de ese mes deja de estar por pagar sin un
 * gasto. Una por plantilla y mes mientras siga en pie; «Deshacer» la anula.
 */
export const expenseRecurringSkip = pgTable(
  "expense_recurring_skip",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    recurringId: uuid("recurring_id").notNull(),
    /** Mes de la ocurrencia, `YYYY-MM`. */
    month: text("month").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
  },
  (table) => [
    uniqueIndex("expense_recurring_skip_uidx")
      .on(table.organizationId, table.recurringId, table.month)
      .where(sql`${table.voidedAt} IS NULL`),
    foreignKey({
      name: "expense_recurring_skip_recurring_org_fk",
      columns: [table.organizationId, table.recurringId],
      foreignColumns: [expenseRecurring.organizationId, expenseRecurring.id],
    }),
    check("expense_recurring_skip_month_check", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
)

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
    /**
     * Dos monedas, igual que un pago de paciente: `amountCents` y `currency` son
     * lo que cancela; esto, lo que salió en otra moneda (nulo si salió en la misma).
     */
    tenderCents: integer("tender_cents"),
    tenderCurrency: char("tender_currency", { length: 3 }),
    /** El cambio usado, en palabras (moneda del negocio por 1 de la otra). */
    exchangeRate: numeric("exchange_rate"),
    /** Cuánto vale en moneda del negocio, congelado. Hay valor si y solo si hay cambio. */
    businessCents: integer("business_cents"),
    spentAt: timestamp("spent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Comprobante libre según país (fase 3 deja el tipo libre; el catálogo llega con el módulo fiscal). */
    receiptKind: text("receipt_kind").notNull().default("ninguno"),
    receiptNumber: text("receipt_number"),
    notes: text("notes"),
    /**
     * El pago (o adelanto) de una compra de Inventario: un gasto de Materiales
     * enlazado a su orden. Lo pagado de una compra es la suma de sus gastos
     * vigentes; no hay otro registro del pago (ADR 0061).
     */
    purchaseOrderId: uuid("purchase_order_id"),
    /**
     * El pago del impuesto de lo cobrado (el IGV que la clínica entrega a la
     * autoridad, ADR 0083): un gasto de «Impuestos» que no resta de lo que deja,
     * porque ese impuesto ya salió de lo cobrado.
     */
    salesTax: boolean("sales_tax").notNull().default(false),
    /**
     * El pago de una ocurrencia de un gasto que se repite: la plantilla y el mes
     * (`YYYY-MM`), los dos o ninguno, escritos al insertar. Un mes se paga una
     * sola vez mientras su gasto siga en pie: anularlo lo deja por pagar.
     */
    recurringId: uuid("recurring_id"),
    recurringMonth: text("recurring_month"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    uniqueIndex("expense_recurring_month_uidx")
      .on(table.organizationId, table.recurringId, table.recurringMonth)
      .where(sql`${table.recurringId} IS NOT NULL AND ${table.voidedAt} IS NULL`),
    foreignKey({
      name: "expense_recurring_id_org_fk",
      columns: [table.organizationId, table.recurringId],
      foreignColumns: [expenseRecurring.organizationId, expenseRecurring.id],
    }),
    check(
      "expense_recurring_link_check",
      sql`(${table.recurringId} IS NULL) = (${table.recurringMonth} IS NULL) AND (${table.recurringMonth} IS NULL OR ${table.recurringMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`,
    ),
    index("expense_org_branch_spent_idx").on(
      table.organizationId,
      table.branchId,
      table.spentAt,
    ),
    index("expense_org_purchase_idx")
      .on(table.organizationId, table.purchaseOrderId)
      .where(sql`${table.purchaseOrderId} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId, table.purchaseOrderId],
      foreignColumns: [purchaseOrder.organizationId, purchaseOrder.id],
    }),
    check("expense_amount_check", sql`${table.amountCents} > 0`),
    check(
      "expense_tender_check",
      sql`(${table.tenderCents} IS NULL) = (${table.tenderCurrency} IS NULL) AND (${table.tenderCents} IS NULL OR (${table.tenderCents} >= 0 AND ${table.tenderCurrency} <> ${table.currency} AND ${table.exchangeRate} IS NOT NULL))`,
    ),
    check(
      "expense_value_check",
      sql`(${table.exchangeRate} IS NULL) = (${table.businessCents} IS NULL) AND (${table.exchangeRate} IS NULL OR (${table.exchangeRate} > 0 AND ${table.businessCents} >= 0))`,
    ),
    check(
      "expense_purchase_category_check",
      sql`${table.purchaseOrderId} IS NULL OR ${table.category} = 'Materiales'`,
    ),
    check("expense_sales_tax_check", sql`NOT ${table.salesTax} OR ${table.category} = 'Impuestos'`),
  ],
)

/**
 * «Puede faltar un gasto · No hubo ese gasto»: la clínica dijo que ese mes no
 * tuvo gastos de ese tipo, y Reportes deja de avisarlo. Uno por tipo, mes y
 * sede (sin sede: la clínica entera).
 */
export const expenseGapDismissal = pgTable(
  "expense_gap_dismissal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    category: text("category").notNull(),
    /** Mes civil en la zona de la clínica, `YYYY-MM`. */
    month: text("month").notNull(),
    branchId: uuid("branch_id").references(() => branch.id),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Uno por tipo, mes y sede: el índice único con NULLS NOT DISTINCT va en la
  // migración de reglas (Drizzle no lo declara en un índice).
  (table) => [check("expense_gap_dismissal_month_check", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`)],
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
     * quedó + cobros + ingresado − gastos − retirado − devuelto + vuelto.
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
    /** Vuelto en otra moneda, con signo: entra el exceso del billete, sale el vuelto. */
    cashChangeCents: integer("cash_change_cents").notNull().default(0),
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
 * Las reglas de comisión de un profesional, por versiones (QA de comisiones,
 * entrega 7; ADR 0151): cada cambio es una fila nueva que vale para lo que se
 * cobra desde `effectiveFrom`, y lo cobrado antes conserva la regla de su día.
 * Nada se edita ni se borra.
 *
 * - Sin servicio: el porcentaje general (`rateBps` obligatorio).
 * - Con servicio: una excepción, con otro porcentaje o un monto fijo por cada
 *   procedimiento (en moneda del negocio, en proporción a lo cobrado), o sin
 *   ninguno de los dos, que es «vuelve al general».
 * - La primera versión general de alguien vale desde siempre (`-infinity`):
 *   fijar el porcentaje tarde no deja en cero lo ya cobrado.
 *
 * Reemplaza a `commission_rule`, que ya no se lee ni se escribe.
 */
export const commissionRate = pgTable(
  "commission_rate",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    professionalUserId: text("professional_user_id")
      .notNull()
      .references(() => user.id),
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    rateBps: integer("rate_bps"),
    fixedCents: integer("fixed_cents"),
    /**
     * La moneda del monto fijo: la del precio del servicio al guardarlo, porque la comisión va en la
     * moneda de lo cobrado. Nula en lo guardado antes, que era en moneda del negocio.
     */
    fixedCurrency: char("fixed_currency", { length: 3 }),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Una versión por momento: la general y la de cada servicio.
    uniqueIndex("commission_rate_general_uidx")
      .on(table.organizationId, table.professionalUserId, table.effectiveFrom)
      .where(sql`${table.serviceId} IS NULL`),
    uniqueIndex("commission_rate_service_uidx")
      .on(table.organizationId, table.professionalUserId, table.serviceId, table.effectiveFrom)
      .where(sql`${table.serviceId} IS NOT NULL`),
    uniqueIndex("commission_rate_org_id_uidx").on(table.organizationId, table.id),
    check("commission_rate_rate_check", sql`${table.rateBps} IS NULL OR ${table.rateBps} BETWEEN 0 AND 10000`),
    check("commission_rate_fixed_check", sql`${table.fixedCents} IS NULL OR ${table.fixedCents} > 0`),
    check("commission_rate_one_check", sql`${table.rateBps} IS NULL OR ${table.fixedCents} IS NULL`),
    check("commission_rate_fixed_currency_check", sql`${table.fixedCurrency} IS NULL OR ${table.fixedCents} IS NOT NULL`),
    check(
      "commission_rate_general_check",
      sql`${table.serviceId} IS NOT NULL OR (${table.rateBps} IS NOT NULL AND ${table.fixedCents} IS NULL)`,
    ),
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
    /**
     * La parte de un cobro de un tratamiento de varias sesiones (1 a `sessions`).
     * Nula en lo de una sola parte y en lo pagado antes: cubre el cobro entero.
     */
    slice: smallint("slice"),
    sessions: smallint("sessions"),
    /** El monto fijo por procedimiento que se usó, si fue una excepción con monto. */
    fixedCents: integer("fixed_cents"),
    /** El porcentaje o el monto fue una excepción para el servicio. */
    forService: boolean("for_service").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("commission_line_org_settlement_idx").on(table.organizationId, table.settlementId),
    index("commission_line_org_application_idx").on(table.organizationId, table.applicationId),
    uniqueIndex("commission_line_source_uidx")
      .on(table.organizationId, table.sourceKey)
      .where(sql`${table.voidedAt} IS NULL`),
    check("commission_line_base_check", sql`${table.baseCents} >= 0`),
    check("commission_line_amount_check", sql`${table.commissionCents} >= 0`),
    check("commission_line_kind_check", sql`${table.kind} IN ('cobro','ajuste')`),
  ],
)
