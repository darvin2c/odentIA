import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organization, user } from "./auth.js"
import { orgFk, timestamps } from "./crm.js"

/**
 * Facturación SaaS de odentIA (slice Billing).
 *
 * - Tablas globales (sin organization_id): `saas_plan`,
 *   `saas_payment_method`, `saas_seller`, `saas_commission_settlement` y
 *   `saas_commission_settlement_line`. Solo el rol owner las escribe (rutas
 *   admin con ownerDb tras guard staff); el rol app solo lee planes y
 *   métodos activos. La migración 0072 lo blinda con REVOKE.
 * - Tablas de tenant (con organization_id + RLS `org_isolation`):
 *   `saas_subscription`, `saas_charge`, `saas_payment`,
 *   `saas_seller_commission`, `saas_commission_adjustment`, `saas_notice`,
 *   `saas_action`.
 * - Dinero siempre en enteros de la unidad menor con moneda ISO 4217
 *   congelada por fila. Nada de precios bancarios ni pasarelas: la cobranza
 *   es manual con comprobante privado en Storage.
 */

export const SAAS_SUBSCRIPTION_STATUSES = [
  "prueba",
  "activa",
  "gracia",
  "restringida",
  "pausada",
  "cancelada",
] as const
export type SaasSubscriptionStatus = (typeof SAAS_SUBSCRIPTION_STATUSES)[number]

export const SAAS_CHARGE_STATUSES = [
  "pendiente",
  "parcial",
  "pagada",
  "reversada",
  "anulada",
] as const
export type SaasChargeStatus = (typeof SAAS_CHARGE_STATUSES)[number]

export const SAAS_PAYMENT_STATUSES = ["pendiente", "confirmado", "reversado", "devuelto"] as const
export type SaasPaymentStatus = (typeof SAAS_PAYMENT_STATUSES)[number]

/** Plan comercial por moneda. Lo configura admin; sin valores productivos en código. */
export const saasPlan = pgTable(
  "saas_plan",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    currency: char("currency", { length: 3 }).notNull(),
    /** Precio del período en la unidad menor de `currency`. */
    priceCents: integer("price_cents").notNull(),
    billingPeriod: text("billing_period").notNull().default("mensual"),
    /** null = sin tope; nunca recorta históricos, solo altas nuevas. */
    maxBranches: integer("max_branches"),
    maxSeats: integer("max_seats"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Cobro por acción (ADR 0030). Lo que la cuota devuelve como crédito para
     * los agentes cada mes, en la unidad menor de `currency`.
     */
    creditCents: integer("credit_cents").notNull().default(0),
    /** Precio base de cada acción en millonésimas de `currency`; null = el plan no cobra esa acción. */
    conversationMicros: bigint("conversation_micros", { mode: "number" }),
    consultationMicros: bigint("consultation_micros", { mode: "number" }),
    recoveryMicros: bigint("recovery_micros", { mode: "number" }),
    /** Descuento máximo sobre el precio base (precio mínimo) y lo que el vendedor da sin aprobación. */
    maxDiscountBps: integer("max_discount_bps").notNull().default(6000),
    sellerDiscountBps: integer("seller_discount_bps").notNull().default(1000),
    /** Prueba: saldo de regalo y días por defecto, y hasta dónde se negocia con aprobación. */
    trialCreditCents: integer("trial_credit_cents").notNull().default(0),
    trialDays: integer("trial_days").notNull().default(30),
    trialMaxCreditCents: integer("trial_max_credit_cents").notNull().default(0),
    trialMaxDays: integer("trial_max_days").notNull().default(60),
    /** El plan con que se cuenta y se prueba si la clínica aún no eligió uno. Uno como mucho. */
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_plan_code_uidx").on(table.code),
    uniqueIndex("saas_plan_default_uidx").on(table.isDefault).where(sql`${table.isDefault}`),
    check(
      "saas_plan_action_check",
      sql`${table.creditCents} >= 0 AND coalesce(${table.conversationMicros}, 0) >= 0 AND coalesce(${table.consultationMicros}, 0) >= 0 AND coalesce(${table.recoveryMicros}, 0) >= 0`,
    ),
    check(
      "saas_plan_discount_check",
      sql`${table.maxDiscountBps} BETWEEN 0 AND 9000 AND ${table.sellerDiscountBps} BETWEEN 0 AND ${table.maxDiscountBps}`,
    ),
    check(
      "saas_plan_trial_check",
      sql`${table.trialCreditCents} >= 0 AND ${table.trialDays} BETWEEN 1 AND 365 AND ${table.trialMaxCreditCents} >= ${table.trialCreditCents} AND ${table.trialMaxDays} >= ${table.trialDays}`,
    ),
    index("saas_plan_currency_active_idx").on(table.currency, table.isActive),
    check("saas_plan_price_check", sql`${table.priceCents} >= 0`),
    check("saas_plan_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("saas_plan_code_check", sql`length(trim(${table.code})) BETWEEN 1 AND 80`),
    check(
      "saas_plan_limits_check",
      sql`(${table.maxBranches} IS NULL OR ${table.maxBranches} > 0) AND (${table.maxSeats} IS NULL OR ${table.maxSeats} > 0)`,
    ),
  ],
)

/** Medio de pago SaaS (transferencia, billetera, etc.). Instrucciones las escribe admin. */
export const saasPaymentMethod = pgTable(
  "saas_payment_method",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** Cómo pagar (texto libre de admin; nunca claves en código). */
    instructions: text("instructions"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_payment_method_code_uidx").on(table.code),
    check("saas_payment_method_code_check", sql`length(trim(${table.code})) BETWEEN 1 AND 80`),
    check("saas_payment_method_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 120`),
  ],
)

/** Vendedor con su porcentaje y ventana congelables por cobro. */
export const saasSeller = pgTable(
  "saas_seller",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").references(() => user.id),
    displayName: text("display_name").notNull(),
    /** Puntos básicos: 1000 = 10 %. Se congela por cobro al confirmar. */
    rateBps: integer("rate_bps").notNull(),
    /** Ventana en días tras la confirmación en que un reverso aún ajusta. Se congela por cobro. */
    windowDays: integer("window_days").notNull().default(90),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_seller_user_uidx").on(table.userId),
    check("saas_seller_rate_check", sql`${table.rateBps} BETWEEN 0 AND 10000`),
    check("saas_seller_window_check", sql`${table.windowDays} BETWEEN 0 AND 730`),
  ],
)

/**
 * Suscripción de la organización (una fila por clínica).
 * `restrictReason` = suspensión COMERCIAL; `pauseReason` = pausa comercial
 * (razones separadas). Los bloqueos de seguridad/manual viven fuera de esta
 * tabla (slice Organizations) y pagar jamás los toca.
 */
export const saasSubscription = pgTable(
  "saas_subscription",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => saasPlan.id),
    status: text("status").notNull().default("prueba"),
    /** Demo: exenta de cobro, restricción y comisiones. */
    isDemo: boolean("is_demo").notNull().default(false),
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    restrictReason: text("restrict_reason"),
    pauseReason: text("pause_reason"),
    /** Prórroga acotada por comprobante pendiente (no aplaza sin límite). */
    proofExtensionUntil: timestamp("proof_extension_until", { withTimezone: true }),
    proofExtensionCount: integer("proof_extension_count").notNull().default(0),
    sellerId: uuid("seller_id").references(() => saasSeller.id),
    /** Atribución congelada: porcentaje y ventana vigentes al asignar. */
    sellerRateBps: integer("seller_rate_bps"),
    sellerWindowDays: integer("seller_window_days"),
    sellerStartedAt: timestamp("seller_started_at", { withTimezone: true }),
    sellerEndedAt: timestamp("seller_ended_at", { withTimezone: true }),
    billingEmail: text("billing_email"),
    /** Descuento negociado sobre el precio base de cada acción (ADR 0030); la cuota no tiene descuento. */
    discountBps: integer("discount_bps").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("saas_subscription_status_idx").on(table.status),
    check("saas_subscription_discount_check", sql`${table.discountBps} BETWEEN 0 AND 9000`),
    index("saas_subscription_period_end_idx").on(table.currentPeriodEnd),
    check(
      "saas_subscription_status_check",
      sql`${table.status} IN ('prueba','activa','gracia','restringida','pausada','cancelada')`,
    ),
  ],
)

/**
 * Cargo periódico (histórico inmutable: congela plan, importe y moneda).
 * `paidCents` solo crece por confirmaciones y decrece por reversos/
 * devoluciones; el cambio de plan nunca reescribe cargos pasados.
 */
export const saasCharge = pgTable(
  "saas_charge",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    planId: uuid("plan_id").references(() => saasPlan.id),
    planCode: text("plan_code").notNull(),
    planName: text("plan_name").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paidCents: integer("paid_cents").notNull().default(0),
    status: text("status").notNull().default("pendiente"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id),
    /** Idempotencia del recurrente automático (`periodo:AAAA-MM`); manual null. */
    dedupeKey: text("dedupe_key"),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    uniqueIndex("saas_charge_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("saas_charge_org_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    check("saas_charge_amount_check", sql`${table.amountCents} >= 0`),
    check("saas_charge_paid_check", sql`${table.paidCents} >= 0`),
    check(
      "saas_charge_status_check",
      sql`${table.status} IN ('pendiente','parcial','pagada','reversada','anulada')`,
    ),
  ],
)

/**
 * Pago/comprobante de un cargo. `pendiente` = comprobante aportado por la
 * clínica a la espera de confirmación admin. El objeto del comprobante vive
 * en el bucket PRIVADO de adjuntos (URL firmada, nunca pública).
 */
export const saasPayment = pgTable(
  "saas_payment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    chargeId: uuid("charge_id"),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    methodCode: text("method_code").notNull(),
    status: text("status").notNull().default("pendiente"),
    receiptObjectKey: text("receipt_object_key"),
    receiptFilename: text("receipt_filename"),
    receiptMime: text("receipt_mime"),
    receiptSize: integer("receipt_size"),
    idempotencyKey: text("idempotency_key").notNull(),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").references(() => user.id),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by").references(() => user.id),
    reverseReason: text("reverse_reason"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_payment_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("saas_payment_org_key_uidx").on(table.organizationId, table.idempotencyKey),
    index("saas_payment_org_charge_idx").on(table.organizationId, table.chargeId),
    index("saas_payment_org_status_idx").on(table.organizationId, table.status),
    foreignKey({
      columns: [table.organizationId, table.chargeId],
      foreignColumns: [saasCharge.organizationId, saasCharge.id],
    }),
    check("saas_payment_amount_check", sql`${table.amountCents} > 0`),
    check(
      "saas_payment_status_check",
      sql`${table.status} IN ('pendiente','confirmado','reversado','devuelto')`,
    ),
  ],
)

/**
 * Comisión de vendedor por cobro CONFIRMADO (no demo). Congela porcentaje
 * (`rateBps`) y ventana (`windowDays`); inmutable salvo liquidación.
 */
export const saasSellerCommission = pgTable(
  "saas_seller_commission",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    paymentId: uuid("payment_id"),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => saasSeller.id),
    rateBps: integer("rate_bps").notNull(),
    windowDays: integer("window_days").notNull(),
    baseCents: integer("base_cents").notNull(),
    commissionCents: integer("commission_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    adjustableUntil: timestamp("adjustable_until", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pendiente"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_seller_commission_payment_uidx").on(table.paymentId),
    index("saas_seller_commission_seller_status_idx").on(table.sellerId, table.status),
    foreignKey({
      columns: [table.organizationId, table.paymentId],
      foreignColumns: [saasPayment.organizationId, saasPayment.id],
    }),
    check("saas_seller_commission_amount_check", sql`${table.commissionCents} >= 0`),
    check(
      "saas_seller_commission_status_check",
      sql`${table.status} IN ('pendiente','liquidada','ajustada')`,
    ),
  ],
)

/**
 * Ajuste por reverso/devolución tras liquidación: fila nueva trazable, jamás
 * muta la liquidación original. Se descuenta en la siguiente liquidación.
 */
export const saasCommissionAdjustment = pgTable(
  "saas_commission_adjustment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    commissionId: uuid("commission_id")
      .notNull()
      .references(() => saasSellerCommission.id),
    paymentId: uuid("payment_id"),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => saasSeller.id),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").references(() => user.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("saas_commission_adjustment_seller_idx").on(table.sellerId, table.appliedAt),
    check("saas_commission_adjustment_amount_check", sql`${table.amountCents} > 0`),
  ],
)

/** Liquidación mensual por vendedor (global; solo owner la escribe). */
export const saasCommissionSettlement = pgTable(
  "saas_commission_settlement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => saasSeller.id),
    periodYear: integer("period_year").notNull(),
    periodMonth: integer("period_month").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    grossCents: integer("gross_cents").notNull().default(0),
    adjustmentCents: integer("adjustment_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
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
    index("saas_settlement_seller_period_idx").on(
      table.sellerId,
      table.periodYear,
      table.periodMonth,
    ),
    check("saas_settlement_month_check", sql`${table.periodMonth} BETWEEN 1 AND 12`),
    check("saas_settlement_status_check", sql`${table.status} IN ('liquidada','anulada')`),
  ],
)

/** Línea congelada de una liquidación (cobro o ajuste). Inmutable. */
export const saasCommissionSettlementLine = pgTable(
  "saas_commission_settlement_line",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => saasCommissionSettlement.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("cobro"),
    sourceKey: text("source_key").notNull(),
    commissionId: uuid("commission_id").references(() => saasSellerCommission.id),
    adjustmentId: uuid("adjustment_id").references(() => saasCommissionAdjustment.id),
    organizationId: text("organization_id").references(() => organization.id),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (table) => [
    index("saas_settlement_line_settlement_idx").on(table.settlementId),
    uniqueIndex("saas_settlement_line_source_uidx")
      .on(table.sourceKey)
      .where(sql`${table.voidedAt} IS NULL`),
    check("saas_settlement_line_kind_check", sql`${table.kind} IN ('cobro','ajuste')`),
  ],
)

/**
 * Avisos y envíos del ciclo (prueba/gracia/restricción/liquidación):
 * idempotencia persistida. `dedupeKey` único impide avisos y correos dobles.
 */
export const saasNotice = pgTable(
  "saas_notice",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    emailTo: text("email_to"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    /** pendiente → reclamado → enviado | incierto (incierto jamás reintenta). */
    emailState: text("email_state").notNull().default("pendiente"),
    metadata: text("metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_notice_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    index("saas_notice_org_kind_idx").on(table.organizationId, table.kind),
  ],
)

export const SAAS_ACTION_KINDS = ["conversacion", "consulta", "cita"] as const
export type SaasActionKind = (typeof SAAS_ACTION_KINDS)[number]

/**
 * Lo que hicieron los agentes y se cobra por acción (ADR 0030): una
 * conversación de Recepción por persona cada 24 horas, una consulta dictada y
 * confirmada por atención y una cita recuperada que el paciente atendió. El
 * precio se congela al contar (base, descuento de la clínica y precio
 * propio): cambiar un precio después no reescribe lo contado. Libro: la
 * aplicación solo registra y lee; el cobro (con owner) anota el cargo.
 */
export const saasAction = pgTable(
  "saas_action",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    contactId: uuid("contact_id"),
    conversationId: uuid("conversation_id"),
    encounterId: uuid("encounter_id"),
    appointmentId: uuid("appointment_id"),
    /** Canal de la conversación o por dónde se reservó la cita. */
    channel: text("channel"),
    /** Cita: cuándo escribió el Administrador; de ahí hasta la reserva, la conversación va dentro de la cita. */
    windowStart: timestamp("window_start", { withTimezone: true }),
    /** Qué hizo el agente, en palabras y sin información clínica. */
    detail: text("detail").notNull(),
    currency: char("currency", { length: 3 }),
    /** Millonésimas de `currency`; null si el plan no tiene precio para la acción. */
    basePriceMicros: bigint("base_price_micros", { mode: "number" }),
    priceMicros: bigint("price_micros", { mode: "number" }),
    discountBps: integer("discount_bps").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    /** Cargo que la cobró (fase 4); null mientras no se cobra. */
    chargeId: uuid("charge_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("saas_action_org_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    index("saas_action_org_occurred_idx").on(table.organizationId, table.occurredAt),
    index("saas_action_org_contact_idx").on(table.organizationId, table.contactId, table.kind, table.occurredAt),
    check("saas_action_kind_check", sql`${table.kind} IN ('conversacion','consulta','cita')`),
    check(
      "saas_action_price_check",
      sql`(${table.basePriceMicros} IS NULL) = (${table.priceMicros} IS NULL) AND coalesce(${table.priceMicros}, 0) >= 0 AND ${table.discountBps} BETWEEN 0 AND 9000`,
    ),
  ],
)
