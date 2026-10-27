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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { supportCase } from "./admin-support.js"
import { organization, user } from "./auth.js"
import { orgFk, timestamps } from "./crm.js"
import { adminSchema } from "./schemas.js"

// Las tablas de cobro se crearon a mano: sus claves foráneas llevan el nombre
// que les dio PostgreSQL (`<tabla>_<columna>_fkey`), las de organización de
// las tablas de una clínica se borran con ella (`<tabla>_org_cascade_fk`) y
// las claves únicas son restricciones `UNIQUE` (`*_uidx`).

/**
 * Facturación SaaS de odentIA (slice Billing).
 *
 * - Tablas globales (sin organization_id): `saas_plan`,
 *   `saas_payment_method`, `saas_seller`, `saas_commission_settlement` y
 *   `saas_commission_settlement_line`. Solo el rol owner las escribe (rutas
 *   admin con ownerDb tras guard staff); el rol app solo lee planes y
 *   métodos activos. `0001_base_reglas.sql` lo blinda con REVOKE.
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
export const saasPlan = adminSchema.table(
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
    // Sin topes de sedes ni de personas (ADR 0031): el tamaño de la clínica se refleja en el uso.
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Cobro por acción (ADR 0031). Lo que la cuota devuelve como crédito para
     * los agentes cada mes, en la unidad menor de `currency`.
     */
    creditCents: integer("credit_cents").notNull().default(0),
    /**
     * Precio base de cada acción en millonésimas de `currency`; null = el plan
     * no cobra esa acción. Por tipo (ADR 0085): la conversación de Sofi según
     * lo que pasó en la agenda (`conversation_micros` es «Gestiona») y la
     * consulta de Clío según lo que dejó hecho (`consultation_micros` es
     * «Completa»).
     */
    conversationMicros: bigint("conversation_micros", { mode: "number" }),
    conversationInformMicros: bigint("conversation_inform_micros", { mode: "number" }),
    conversationAgendaMicros: bigint("conversation_agenda_micros", { mode: "number" }),
    consultationMicros: bigint("consultation_micros", { mode: "number" }),
    consultationSimpleMicros: bigint("consultation_simple_micros", { mode: "number" }),
    consultationStandardMicros: bigint("consultation_standard_micros", { mode: "number" }),
    recoveryMicros: bigint("recovery_micros", { mode: "number" }),
    /** Preguntas a Argos incluidas cada mes y el paquete que se suma al acabarlas (ADR 0085). */
    argosIncludedQuestions: integer("argos_included_questions").notNull().default(0),
    argosPackQuestions: integer("argos_pack_questions").notNull().default(100),
    argosPackMicros: bigint("argos_pack_micros", { mode: "number" }),
    /** Almacenamiento incluido y el precio de cada GB extra al mes (ADR 0085). */
    storageIncludedGb: integer("storage_included_gb").notNull().default(0),
    storageGbMicros: bigint("storage_gb_micros", { mode: "number" }),
    /** Tipos que no admiten descuento negociado: siempre a su precio base (ADR 0085). */
    fixedPriceTiers: text("fixed_price_tiers").array().notNull().default(sql`'{}'::text[]`),
    /** Descuento máximo sobre el precio base (precio mínimo) y lo que el vendedor da sin aprobación. */
    maxDiscountBps: integer("max_discount_bps").notNull().default(6000),
    sellerDiscountBps: integer("seller_discount_bps").notNull().default(1000),
    /** Prueba: saldo de regalo y días por defecto, y hasta dónde se negocia con aprobación. */
    trialCreditCents: integer("trial_credit_cents").notNull().default(0),
    trialDays: integer("trial_days").notNull().default(30),
    trialMaxCreditCents: integer("trial_max_credit_cents").notNull().default(0),
    trialMaxDays: integer("trial_max_days").notNull().default(60),
    /**
     * El producto del plan (ADR 0092): lo usan solo las clínicas de ese producto
     * y su web. Se elige al crearlo y no cambia.
     */
    product: text("product").notNull().default("dental"),
    /** El plan con que se cuenta y se prueba si la clínica aún no eligió uno. Uno como mucho por producto. */
    isDefault: boolean("is_default").notNull().default(false),
    /** La web lo publica (decisión 14 de Fundadores); un plan nuevo nace sin publicar. */
    showOnWeb: boolean("show_on_web").notNull().default(false),
    /** Plan por invitación (Fundadores): clínicas como máximo, contando invitaciones vigentes; null = sin tope. */
    seatLimit: integer("seat_limit"),
    /** Meses que se mantienen las condiciones desde que la clínica entra; después pasa al plan por defecto. */
    guaranteeMonths: integer("guarantee_months"),
    ...timestamps,
  },
  (table) => [
    unique("saas_plan_code_uidx").on(table.code),
    uniqueIndex("saas_plan_default_uidx").on(table.product).where(sql`${table.isDefault}`),
    check("saas_plan_product_check", sql`${table.product} IN ('dental','medical')`),
    check(
      "saas_plan_founders_check",
      sql`(${table.seatLimit} IS NULL OR ${table.seatLimit} > 0) AND (${table.guaranteeMonths} IS NULL OR ${table.guaranteeMonths} BETWEEN 1 AND 120)`,
    ),
    check(
      "saas_plan_action_check",
      sql`${table.creditCents} >= 0 AND coalesce(${table.conversationMicros}, 0) >= 0 AND coalesce(${table.consultationMicros}, 0) >= 0 AND coalesce(${table.recoveryMicros}, 0) >= 0`,
    ),
    check(
      "saas_plan_tier_check",
      sql`coalesce(${table.conversationInformMicros}, 0) >= 0 AND coalesce(${table.conversationAgendaMicros}, 0) >= 0 AND coalesce(${table.consultationSimpleMicros}, 0) >= 0 AND coalesce(${table.consultationStandardMicros}, 0) >= 0 AND coalesce(${table.argosPackMicros}, 0) >= 0 AND coalesce(${table.storageGbMicros}, 0) >= 0 AND ${table.argosIncludedQuestions} >= 0 AND ${table.argosPackQuestions} BETWEEN 1 AND 10000 AND ${table.storageIncludedGb} >= 0`,
    ),
    check(
      "saas_plan_fixed_tiers_check",
      sql`${table.fixedPriceTiers} <@ ARRAY['informa','gestiona','agenda','simple','estandar','completa','cita','preguntas','almacenamiento']::text[]`,
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
  ],
)

/** Medio de pago SaaS (transferencia, billetera, etc.). Instrucciones las escribe admin. */
export const saasPaymentMethod = adminSchema.table(
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
    unique("saas_payment_method_code_uidx").on(table.code),
    check("saas_payment_method_code_check", sql`length(trim(${table.code})) BETWEEN 1 AND 80`),
    check("saas_payment_method_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 120`),
  ],
)

/** Vendedor con su porcentaje y ventana congelables por cobro. */
export const saasSeller = adminSchema.table(
  "saas_seller",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id"),
    displayName: text("display_name").notNull(),
    /** Puntos básicos: 1000 = 10 %. Se congela por cobro al confirmar. */
    rateBps: integer("rate_bps").notNull(),
    /** Ventana en días tras la confirmación en que un reverso aún ajusta. Se congela por cobro. */
    windowDays: integer("window_days").notNull().default(90),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique("saas_seller_user_uidx").on(table.userId),
    foreignKey({ name: "saas_seller_user_id_fkey", columns: [table.userId], foreignColumns: [user.id] }),
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
    organizationId: text("organization_id").primaryKey(),
    planId: uuid("plan_id"),
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
    sellerId: uuid("seller_id"),
    /** Atribución congelada: porcentaje y ventana vigentes al asignar. */
    sellerRateBps: integer("seller_rate_bps"),
    sellerWindowDays: integer("seller_window_days"),
    sellerStartedAt: timestamp("seller_started_at", { withTimezone: true }),
    sellerEndedAt: timestamp("seller_ended_at", { withTimezone: true }),
    /** Descuento negociado sobre el precio base de cada acción (ADR 0031); la cuota no tiene descuento. */
    discountBps: integer("discount_bps").notNull().default(0),
    /** Último instante del descuento negociado (issue 168); null = no vence. Pasado, se cuenta a precio de lista. */
    discountEndsAt: timestamp("discount_ends_at", { withTimezone: true }),
    /** Entró por invitación a un plan con condiciones garantizadas: hasta cuándo valen. */
    guaranteedUntil: timestamp("guaranteed_until", { withTimezone: true }),
    /** Prueba negociada para esta clínica; null = la del plan. */
    trialCreditCents: integer("trial_credit_cents"),
    trialDays: integer("trial_days"),
    /** Lo máximo que la clínica paga al mes por encima del crédito; al llegar, los casos nuevos pasan al equipo. */
    spendCapCents: integer("spend_cap_cents"),
    /** Cada cuánto se factura lo que pasa del crédito: `mensual` o `quincenal`. */
    billingCycle: text("billing_cycle").notNull().default("mensual"),
    /** Al acabar las preguntas a Argos del mes, se suma un paquete sin preguntar (ADR 0085); apagado al empezar. */
    argosAutoPack: boolean("argos_auto_pack").notNull().default(false),
    /** Día en que la clínica activó el plan: su mes empieza ese día. */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("saas_subscription_status_idx").on(table.status),
    foreignKey({ name: "saas_subscription_organization_id_fkey", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
    foreignKey({ name: "saas_subscription_plan_id_fkey", columns: [table.planId], foreignColumns: [saasPlan.id] }),
    foreignKey({ name: "saas_subscription_seller_id_fkey", columns: [table.sellerId], foreignColumns: [saasSeller.id] }),
    check("saas_subscription_discount_check", sql`${table.discountBps} BETWEEN 0 AND 9000`),
    check(
      "saas_subscription_terms_check",
      sql`(${table.trialCreditCents} IS NULL OR ${table.trialCreditCents} >= 0) AND (${table.trialDays} IS NULL OR ${table.trialDays} BETWEEN 1 AND 365) AND (${table.spendCapCents} IS NULL OR ${table.spendCapCents} >= 0) AND ${table.billingCycle} IN ('mensual','quincenal')`,
    ),
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
    organizationId: text("organization_id").notNull(),
    planId: uuid("plan_id"),
    planCode: text("plan_code").notNull(),
    planName: text("plan_name").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paidCents: integer("paid_cents").notNull().default(0),
    /** Cargo del cobro por acción: lo que suman sus líneas sin impuesto, y el impuesto. Manual: null y 0. */
    subtotalCents: integer("subtotal_cents"),
    taxCents: integer("tax_cents").notNull().default(0),
    taxLabel: text("tax_label"),
    /**
     * Cargo del cobro por acción: el crédito del plan con que se emitió, congelado
     * como su cuota. Lo que se lea después de ese mes (Reportes, «Pedir revisión»,
     * el mes anterior en Facturación) usa este, no el del plan de hoy. Manual: null.
     */
    creditCents: integer("credit_cents"),
    status: text("status").notNull().default("pendiente"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdBy: text("created_by"),
    /** Idempotencia del recurrente automático (`periodo:AAAA-MM`); manual null. */
    dedupeKey: text("dedupe_key"),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (table) => [
    unique("saas_charge_org_id_uidx").on(table.organizationId, table.id),
    index("saas_charge_org_period_idx").on(table.organizationId, table.periodStart),
    index("saas_charge_org_status_idx").on(table.organizationId, table.status),
    foreignKey({ name: "saas_charge_org_cascade_fk", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
    foreignKey({ name: "saas_charge_plan_id_fkey", columns: [table.planId], foreignColumns: [saasPlan.id] }),
    foreignKey({ name: "saas_charge_created_by_fkey", columns: [table.createdBy], foreignColumns: [user.id] }),
    foreignKey({ name: "saas_charge_voided_by_fkey", columns: [table.voidedBy], foreignColumns: [user.id] }),
    uniqueIndex("saas_charge_org_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    check("saas_charge_amount_check", sql`${table.amountCents} >= 0`),
    check("saas_charge_paid_check", sql`${table.paidCents} >= 0`),
    check("saas_charge_credit_check", sql`${table.creditCents} IS NULL OR ${table.creditCents} >= 0`),
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
    organizationId: text("organization_id").notNull(),
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
    createdBy: text("created_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reverseReason: text("reverse_reason"),
    ...timestamps,
  },
  (table) => [
    unique("saas_payment_org_id_uidx").on(table.organizationId, table.id),
    unique("saas_payment_org_key_uidx").on(table.organizationId, table.idempotencyKey),
    foreignKey({ name: "saas_payment_org_cascade_fk", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
    foreignKey({ name: "saas_payment_created_by_fkey", columns: [table.createdBy], foreignColumns: [user.id] }),
    foreignKey({ name: "saas_payment_confirmed_by_fkey", columns: [table.confirmedBy], foreignColumns: [user.id] }),
    foreignKey({ name: "saas_payment_reversed_by_fkey", columns: [table.reversedBy], foreignColumns: [user.id] }),
    index("saas_payment_org_charge_idx").on(table.organizationId, table.chargeId),
    index("saas_payment_org_status_idx").on(table.organizationId, table.status),
    foreignKey({
      name: "saas_payment_organization_id_charge_id_fkey",
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
export const saasSellerCommission = adminSchema.table(
  "saas_seller_commission",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: text("organization_id").notNull(),
    paymentId: uuid("payment_id"),
    sellerId: uuid("seller_id").notNull(),
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
    unique("saas_seller_commission_payment_uidx").on(table.paymentId),
    foreignKey({ name: "saas_seller_commission_org_cascade_fk", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
    foreignKey({ name: "saas_seller_commission_seller_id_fkey", columns: [table.sellerId], foreignColumns: [saasSeller.id] }),
    index("saas_seller_commission_seller_status_idx").on(table.sellerId, table.status),
    foreignKey({
      name: "saas_seller_commission_organization_id_payment_id_fkey",
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
export const saasCommissionAdjustment = adminSchema.table(
  "saas_commission_adjustment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: text("organization_id").notNull(),
    commissionId: uuid("commission_id").notNull(),
    paymentId: uuid("payment_id"),
    sellerId: uuid("seller_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({ name: "saas_commission_adjustment_org_cascade_fk", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
    foreignKey({ name: "saas_commission_adjustment_commission_id_fkey", columns: [table.commissionId], foreignColumns: [saasSellerCommission.id] }),
    foreignKey({ name: "saas_commission_adjustment_seller_id_fkey", columns: [table.sellerId], foreignColumns: [saasSeller.id] }),
    foreignKey({ name: "saas_commission_adjustment_created_by_fkey", columns: [table.createdBy], foreignColumns: [user.id] }),
    check("saas_commission_adjustment_amount_check", sql`${table.amountCents} > 0`),
  ],
)

/** Liquidación mensual por vendedor (global; solo owner la escribe). */
export const saasCommissionSettlement = adminSchema.table(
  "saas_commission_settlement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sellerId: uuid("seller_id").notNull(),
    periodYear: integer("period_year").notNull(),
    periodMonth: integer("period_month").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    grossCents: integer("gross_cents").notNull().default(0),
    adjustmentCents: integer("adjustment_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    status: text("status").notNull().default("liquidada"),
    notes: text("notes"),
    settledBy: text("settled_by"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (table) => [
    foreignKey({ name: "saas_commission_settlement_seller_id_fkey", columns: [table.sellerId], foreignColumns: [saasSeller.id] }),
    foreignKey({ name: "saas_commission_settlement_settled_by_fkey", columns: [table.settledBy], foreignColumns: [user.id] }),
    foreignKey({ name: "saas_commission_settlement_voided_by_fkey", columns: [table.voidedBy], foreignColumns: [user.id] }),
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
export const saasCommissionSettlementLine = adminSchema.table(
  "saas_commission_settlement_line",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    settlementId: uuid("settlement_id").notNull(),
    kind: text("kind").notNull().default("cobro"),
    sourceKey: text("source_key").notNull(),
    commissionId: uuid("commission_id"),
    adjustmentId: uuid("adjustment_id"),
    organizationId: text("organization_id"),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (table) => [
    index("saas_settlement_line_settlement_idx").on(table.settlementId),
    foreignKey({ name: "saas_commission_settlement_line_settlement_id_fkey", columns: [table.settlementId], foreignColumns: [saasCommissionSettlement.id] }).onDelete("cascade"),
    foreignKey({ name: "saas_commission_settlement_line_commission_id_fkey", columns: [table.commissionId], foreignColumns: [saasSellerCommission.id] }),
    foreignKey({ name: "saas_commission_settlement_line_adjustment_id_fkey", columns: [table.adjustmentId], foreignColumns: [saasCommissionAdjustment.id] }),
    foreignKey({ name: "saas_settlement_line_org_cascade_fk", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
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
    organizationId: text("organization_id").notNull(),
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
    unique("saas_notice_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    foreignKey({ name: "saas_notice_org_cascade_fk", columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete("cascade"),
  ],
)

/**
 * Negociación por clínica que pide aprobación (ADR 0031): un descuento por
 * encima de lo que da el vendedor o una prueba más larga o con más saldo que
 * la del plan. La pide soporte o el vendedor; la decide la administración.
 * Solo owner (rutas admin) la escribe.
 */
export const saasNegotiation = adminSchema.table(
  "saas_negotiation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").notNull(),
    /** Descuento en puntos básicos, o saldo (centavos) y días de prueba. */
    discountBps: integer("discount_bps"),
    /** Hasta cuándo vale el descuento pedido; null = no vence. */
    discountEndsAt: timestamp("discount_ends_at", { withTimezone: true }),
    trialCreditCents: integer("trial_credit_cents"),
    trialDays: integer("trial_days"),
    note: text("note"),
    status: text("status").notNull().default("pendiente"),
    requestedBy: text("requested_by").references(() => user.id),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("saas_negotiation_org_status_idx").on(table.organizationId, table.status),
    check("saas_negotiation_kind_check", sql`${table.kind} IN ('descuento','prueba')`),
    check("saas_negotiation_status_check", sql`${table.status} IN ('pendiente','aprobada','rechazada')`),
  ],
)

/**
 * Línea congelada de un cargo del cobro por acción (ADR 0031): la cuota, las
 * acciones por encima del crédito por tipo, la devolución de las conversaciones
 * ya cobradas que llevaron a una cita recuperada (negativa), lo que cubrió el
 * crédito (importe 0, para que se vea) y el impuesto. Inmutable como el cargo.
 */
export const saasChargeLine = pgTable(
  "saas_charge_line",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    chargeId: uuid("charge_id").notNull(),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitBaseMicros: bigint("unit_base_micros", { mode: "number" }),
    unitPriceMicros: bigint("unit_price_micros", { mode: "number" }),
    amountCents: integer("amount_cents").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("saas_charge_line_charge_idx").on(table.organizationId, table.chargeId, table.sortOrder),
    foreignKey({
      name: "saas_charge_line_charge_fk",
      columns: [table.organizationId, table.chargeId],
      foreignColumns: [saasCharge.organizationId, saasCharge.id],
    }),
    check(
      "saas_charge_line_kind_check",
      sql`${table.kind} IN ('cuota','conversacion','consulta','cita','preguntas','almacenamiento','devolucion','revision','credito','impuesto')`,
    ),
    // Solo las devoluciones restan: la conversación ya cobrada que llevó a una cita
    // recuperada y lo que odentIA devolvió al revisar un cobro ya facturado (ADR 0054).
    check(
      "saas_charge_line_amount_check",
      sql`${table.quantity} >= 0 AND CASE WHEN ${table.kind} IN ('devolucion','revision') THEN ${table.amountCents} <= 0 ELSE ${table.amountCents} >= 0 END`,
    ),
  ],
)

export const SAAS_ACTION_KINDS = ["conversacion", "consulta", "cita", "preguntas", "almacenamiento"] as const
export type SaasActionKind = (typeof SAAS_ACTION_KINDS)[number]

/**
 * El tipo de una acción (ADR 0085): la conversación de Sofi según lo que pasó
 * en la agenda (`informa`, `gestiona`; `agenda` es la subida cuando el
 * paciente viene) y la consulta de Clío según lo que dejó hecho (`simple`,
 * `estandar`, `completa`). La cita recuperada, el paquete de preguntas y el
 * almacenamiento no tienen tipo.
 */
export const SAAS_ACTION_TIERS = ["informa", "gestiona", "agenda", "simple", "estandar", "completa"] as const
export type SaasActionTier = (typeof SAAS_ACTION_TIERS)[number]

/**
 * Lo que hicieron los agentes y se cobra por acción (ADR 0031): una
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
    /** Su tipo (`SAAS_ACTION_TIERS`); null en la cita recuperada, las preguntas y el almacenamiento. */
    tier: text("tier"),
    /** Cuántas unidades cobra: las preguntas de un paquete o los GB extra del mes; null en lo demás. */
    units: integer("units"),
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
    /**
     * Conversación que subió de Informa a Gestiona (ADR 0085): cuándo pasó y cuánto valía antes.
     * El presupuesto del mes cuenta la diferencia en ese momento, no al empezar la conversación.
     */
    tierChangedAt: timestamp("tier_changed_at", { withTimezone: true }),
    previousPriceMicros: bigint("previous_price_micros", { mode: "number" }),
    dedupeKey: text("dedupe_key").notNull(),
    /** Cargo que la cobró (fase 4); null mientras no se cobra. */
    chargeId: uuid("charge_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("saas_action_org_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    index("saas_action_org_occurred_idx").on(table.organizationId, table.occurredAt),
    index("saas_action_org_charge_idx").on(table.organizationId, table.chargeId),
    index("saas_action_org_contact_idx").on(table.organizationId, table.contactId, table.kind, table.occurredAt),
    check("saas_action_kind_check", sql`${table.kind} IN ('conversacion','consulta','cita','preguntas','almacenamiento')`),
    check(
      "saas_action_tier_check",
      sql`coalesce(CASE ${table.kind} WHEN 'conversacion' THEN ${table.tier} IN ('informa','gestiona','agenda') WHEN 'consulta' THEN ${table.tier} IN ('simple','estandar','completa') ELSE ${table.tier} IS NULL END, false) AND (${table.units} IS NULL OR ${table.units} > 0)`,
    ),
    check(
      "saas_action_price_check",
      sql`(${table.basePriceMicros} IS NULL) = (${table.priceMicros} IS NULL) AND coalesce(${table.priceMicros}, 0) >= 0 AND ${table.discountBps} BETWEEN 0 AND 9000`,
    ),
  ],
)

/**
 * Lo que la clínica tiene guardado cada día (ADR 0085): archivos de
 * pacientes, tomografías y adjuntos de conversaciones. El GB extra del mes
 * sale del promedio de sus días, como cobra el proveedor: lo que se sube y se
 * borra el mismo día casi no cuenta. Una fila por día; la escribe el reloj
 * SaaS (con owner) y la clínica la lee.
 */
export const storageUsageDay = pgTable(
  "storage_usage_day",
  {
    organizationId: orgFk("organization_id"),
    /** Día UTC de la medición. */
    day: text("day").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_usage_day_org_day_uidx").on(table.organizationId, table.day),
    check("storage_usage_day_check", sql`${table.bytes} >= 0 AND ${table.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  ],
)

/** Por qué pide la clínica revisar un cobro (issue 77, ADR 0054). */
export const SAAS_REVIEW_REASONS = ["spam", "agente", "doble", "otro"] as const
export type SaasReviewReason = (typeof SAAS_REVIEW_REASONS)[number]
export const SAAS_REVIEW_STATUSES = ["pendiente", "devuelta", "mantenida"] as const
export type SaasReviewStatus = (typeof SAAS_REVIEW_STATUSES)[number]

/**
 * «Pedir revisión» de una fila de «Cada acción de tus agentes» (ADR 0054): una
 * por acción. El spam dentro del tope se devuelve solo (`automatic`); lo demás
 * lo decide odentIA en un caso de Soporte, con lo que le dice a la clínica.
 * Devuelta antes de cobrarse, la fila no se cobra; ya cobrada, sale como
 * «Devolución por revisión» en el cargo siguiente (`creditChargeId`). La
 * aplicación solo pide y lee: decidir y anotar el cargo es del personal (owner).
 */
export const saasActionReview = pgTable(
  "saas_action_review",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    actionId: uuid("action_id")
      .notNull()
      .references(() => saasAction.id),
    reason: text("reason").notNull(),
    /** Lo que contó la clínica, si quiso. */
    note: text("note"),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Hasta cuándo puede leer odentIA esa conversación (decisión 11); nulo = no dio permiso o ya se respondió. */
    readUntil: timestamp("read_until", { withTimezone: true }),
    status: text("status").notNull().default("pendiente"),
    /** Se devolvió sola (spam dentro del tope): nadie de odentIA la decidió. */
    automatic: boolean("automatic").notNull().default(false),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByStaffId: text("decided_by_staff_id").references(() => user.id),
    /** Lo que odentIA le dice a la clínica al decidir. */
    answer: text("answer"),
    supportCaseId: uuid("support_case_id"),
    /** Ya estaba cobrada: el cargo que la devolvió con «Devolución por revisión». */
    creditChargeId: uuid("credit_charge_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_action_review_action_uidx").on(table.organizationId, table.actionId),
    index("saas_action_review_status_idx").on(table.status, table.requestedAt),
    foreignKey({
      name: "saas_action_review_case_fk",
      columns: [table.supportCaseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }),
    foreignKey({
      name: "saas_action_review_credit_charge_fk",
      columns: [table.organizationId, table.creditChargeId],
      foreignColumns: [saasCharge.organizationId, saasCharge.id],
    }),
    check("saas_action_review_reason_check", sql`${table.reason} IN ('spam','agente','doble','otro')`),
    check("saas_action_review_note_check", sql`${table.note} IS NULL OR length(${table.note}) <= 1000`),
    // Pendiente: nada decidido. Devuelta sola: sin personal. Decidida por odentIA: quién, cuándo y qué le dijo.
    check(
      "saas_action_review_decision_check",
      sql`(${table.status} = 'pendiente' AND ${table.decidedAt} IS NULL AND ${table.decidedByStaffId} IS NULL AND ${table.answer} IS NULL AND NOT ${table.automatic})
        OR (${table.status} = 'devuelta' AND ${table.automatic} AND ${table.decidedAt} IS NOT NULL AND ${table.decidedByStaffId} IS NULL)
        OR (${table.status} IN ('devuelta','mantenida') AND NOT ${table.automatic} AND ${table.decidedAt} IS NOT NULL
          AND ${table.decidedByStaffId} IS NOT NULL AND length(trim(${table.answer})) > 0)`,
    ),
    check("saas_action_review_credit_check", sql`${table.creditChargeId} IS NULL OR ${table.status} = 'devuelta'`),
  ],
)

/* ---------- Fundadores: alta por invitación y lista de espera (issue 165) ---------- */

export const SAAS_SIGNUP_MODES = ["invitacion", "abierta"] as const
export type SaasSignupMode = (typeof SAAS_SIGNUP_MODES)[number]

/**
 * Cómo se abren clínicas nuevas: «solo con invitación» o «abierta», una por
 * producto (ADR 0092): `mode` es el de odentIA y `medical_mode` el de latidIA.
 * Una sola fila (`id = 1`) que escribe la administración; la lee el guard de
 * `organization/create`. Global, sin `organization_id`: solo `ownerDb`.
 */
export const saasSignupPolicy = adminSchema.table(
  "saas_signup_policy",
  {
    id: integer("id").primaryKey().default(1),
    mode: text("mode").notNull().default("invitacion"),
    medicalMode: text("medical_mode").notNull().default("invitacion"),
    updatedBy: text("updated_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    check("saas_signup_policy_singleton_check", sql`${table.id} = 1`),
    check("saas_signup_policy_mode_check", sql`${table.mode} IN ('invitacion','abierta')`),
    check("saas_signup_policy_medical_mode_check", sql`${table.medicalMode} IN ('invitacion','abierta')`),
  ],
)

/**
 * Condiciones comerciales (issue 167, ADR 0074): las reglas que acompañan al
 * precio y valen para todas las clínicas. Cada cambio es una versión nueva que
 * rige desde `effective_from`; nada se reescribe ni se borra (disparador de la
 * 0051). Cada regla se lee con la versión del día en que empezó lo que mide.
 * La primera versión son los valores que estaban en el código
 * (`created_by` nulo). El rol app solo la lee.
 */
export const saasCommercialTerms = adminSchema.table(
  "saas_commercial_terms",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    /** Una conversación por persona en esta ventana. */
    conversationWindowHours: integer("conversation_window_hours").notNull(),
    /** Días entre el mensaje del Administrador y la reserva para que la cita cuente como recuperada. */
    recoveryWindowDays: integer("recovery_window_days").notNull(),
    /** Parte de las conversaciones del mes cuyo spam se devuelve sin revisar. */
    reviewAutoPercent: integer("review_auto_percent").notNull(),
    /** Días hábiles para responder una revisión de cobro. */
    reviewAnswerDays: integer("review_answer_days").notNull(),
    /** Días que odentIA puede leer la conversación revisada, con permiso. */
    reviewReadDays: integer("review_read_days").notNull(),
    paymentDays: integer("payment_days").notNull(),
    graceDays: integer("grace_days").notNull(),
    proofExtensionDays: integer("proof_extension_days").notNull(),
    proofExtensionMax: integer("proof_extension_max").notNull(),
    /** Con ciclo quincenal, a los cuántos días del tramo se cobra lo que pasó del crédito. */
    halfCycleDays: integer("half_cycle_days").notNull(),
    /** Prueba cuando no hay un plan por defecto. */
    trialDays: integer("trial_days").notNull(),
    warnPercent: integer("warn_percent").notNull(),
    alarmPercent: integer("alarm_percent").notNull(),
    /** Días hábiles para responder una solicitud de invitación. */
    waitlistAnswerDays: integer("waitlist_answer_days").notNull(),
    commissionMonths: integer("commission_months").notNull(),
    /** Días antes del fin de un precio especial en que se avisa a la clínica y a la administración. */
    discountNoticeDays: integer("discount_notice_days").notNull(),
    /** Días antes del fin de las condiciones garantizadas de una Fundadora en que se avisa. */
    guaranteeNoticeDays: integer("guarantee_notice_days").notNull(),
    reason: text("reason"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("saas_commercial_terms_effective_uidx").on(table.effectiveFrom),
    check(
      "saas_commercial_terms_limits_check",
      sql`${table.conversationWindowHours} BETWEEN 1 AND 72
        AND ${table.recoveryWindowDays} BETWEEN 1 AND 30
        AND ${table.reviewAutoPercent} BETWEEN 0 AND 30
        AND ${table.reviewAnswerDays} BETWEEN 1 AND 10
        AND ${table.reviewReadDays} BETWEEN 1 AND 30
        AND ${table.paymentDays} BETWEEN 1 AND 30
        AND ${table.graceDays} BETWEEN 1 AND 30
        AND ${table.proofExtensionDays} BETWEEN 0 AND 10
        AND ${table.proofExtensionMax} BETWEEN 0 AND 3
        AND ${table.halfCycleDays} BETWEEN 7 AND 21
        AND ${table.trialDays} BETWEEN 7 AND 90
        AND ${table.warnPercent} BETWEEN 50 AND 99
        AND ${table.alarmPercent} BETWEEN 50 AND 99
        AND ${table.warnPercent} < ${table.alarmPercent}
        AND ${table.waitlistAnswerDays} BETWEEN 1 AND 10
        AND ${table.commissionMonths} BETWEEN 1 AND 36
        AND ${table.discountNoticeDays} BETWEEN 1 AND 30
        AND ${table.guaranteeNoticeDays} BETWEEN 1 AND 60`,
    ),
    check("saas_commercial_terms_reason_check", sql`${table.reason} IS NULL OR length(${table.reason}) BETWEEN 1 AND 500`),
  ],
)

export const SAAS_WAITLIST_STATUSES = ["por_revisar", "invitada", "entro", "descartada"] as const
export type SaasWaitlistStatus = (typeof SAAS_WAITLIST_STATUSES)[number]
export const SAAS_WAITLIST_PROFESSIONALS = ["1", "2-3", "4-9", "10+"] as const
export const SAAS_WAITLIST_TOOLS = ["nada", "cuaderno_excel", "otro_software"] as const

/**
 * Solicitud de la lista de espera y, cuando se invita, su invitación. Una
 * invitación vale para un solo correo y abre una sola clínica: el token solo
 * se guarda como huella (`token_hash`), `claimed_at` la reserva mientras se
 * crea la clínica y `organization_id` queda al entrar. Global y solo de
 * `ownerDb` (la web la escribe por su ruta pública).
 */
export const saasWaitlistRequest = adminSchema.table(
  "saas_waitlist_request",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    clinicName: text("clinic_name").notNull(),
    /** ISO 3166-1 alfa-2. */
    countryCode: char("country_code", { length: 2 }).notNull(),
    city: text("city").notNull(),
    professionals: text("professionals").notNull(),
    currentTool: text("current_tool").notNull(),
    /** odentIA o latidIA: el del dominio donde se pidió (entrega 3 del issue 229). La clínica nace con él. */
    product: text("product").notNull().default("dental"),
    status: text("status").notNull().default("por_revisar"),
    note: text("note"),
    discardReason: text("discard_reason"),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    planId: uuid("plan_id").references(() => saasPlan.id),
    tokenHash: text("token_hash"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
    enteredAt: timestamp("entered_at", { withTimezone: true }),
    confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
    invitationSentAt: timestamp("invitation_sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saas_waitlist_request_token_uidx").on(table.tokenHash),
    uniqueIndex("saas_waitlist_request_org_uidx").on(table.organizationId),
    index("saas_waitlist_request_status_idx").on(table.status, table.createdAt),
    index("saas_waitlist_request_email_idx").on(table.email),
    check(
      "saas_waitlist_request_status_check",
      sql`${table.status} IN ('por_revisar','invitada','entro','descartada')`,
    ),
    check("saas_waitlist_request_professionals_check", sql`${table.professionals} IN ('1','2-3','4-9','10+')`),
    check(
      "saas_waitlist_request_tool_check",
      sql`${table.currentTool} IN ('nada','cuaderno_excel','otro_software')`,
    ),
    check("saas_waitlist_request_country_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check("saas_waitlist_request_product_check", sql`${table.product} IN ('dental','medical')`),
    check(
      "saas_waitlist_request_text_check",
      sql`length(trim(${table.firstName})) BETWEEN 1 AND 80 AND length(trim(${table.lastName})) BETWEEN 1 AND 80
        AND length(trim(${table.clinicName})) BETWEEN 1 AND 120 AND length(trim(${table.city})) BETWEEN 1 AND 80
        AND length(${table.email}) BETWEEN 3 AND 254 AND length(${table.phone}) BETWEEN 6 AND 20
        AND (${table.note} IS NULL OR length(${table.note}) <= 2000)`,
    ),
    // Invitada: plan, huella y vencimiento. Entró: además, su clínica. Descartada: con motivo.
    check(
      "saas_waitlist_request_invite_check",
      sql`(${table.status} = 'por_revisar' AND ${table.tokenHash} IS NULL AND ${table.organizationId} IS NULL)
        OR (${table.status} = 'invitada' AND ${table.tokenHash} IS NOT NULL AND ${table.planId} IS NOT NULL AND ${table.inviteExpiresAt} IS NOT NULL AND ${table.organizationId} IS NULL)
        OR (${table.status} = 'entro' AND ${table.planId} IS NOT NULL AND ${table.enteredAt} IS NOT NULL)
        OR (${table.status} = 'descartada' AND ${table.organizationId} IS NULL AND length(trim(coalesce(${table.discardReason}, ''))) > 0)`,
    ),
  ],
)
