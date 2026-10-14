/**
 * Promociones (propiedad PresupuestosPromociones, fases 4–5).
 *
 * Una promoción es un ajuste de precio con nombre, fechas y precios ya
 * definidos: nombre, vigencia, precio por servicio (fijo o «desde» mínimo) y
 * condiciones en una frase. Caja y presupuestos la ofrecen opt-in; la persona
 * decide si corresponde. Lo ya cotizado/cobrado con ella nunca cambia: las
 * líneas de presupuesto congelan su snapshot y el histórico jamás relee la
 * tarifa vigente ni la promoción vigente.
 *
 * Invariantes:
 * - Dinero en centavos enteros con moneda ISO por precio (la del servicio).
 * - `mode: 'fixed'` = precio final; `'from'` = mínimo anunciado, el precio
 *   final lo pone quien presupuesta (nunca se da «desde» como final).
 * - Vencida (`endsAt` pasada) o inactiva deja de ofrecerse sola.
 * - Nada se borra: terminar adelanta `endsAt`, desactivar apaga `isActive`.
 */
import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { serviceCatalog } from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"

/** Cabecera: nombre, vigencia, condiciones y activo. */
export const promotion = pgTable(
  "promotion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    conditions: text("conditions"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("promotion_org_active_idx").on(table.organizationId, table.isActive, table.startsAt),
    index("promotion_org_ends_idx").on(table.organizationId, table.endsAt),
    check(
      "promotion_dates_check",
      sql`${table.endsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`,
    ),
  ],
)

/** Precio de un servicio dentro de la promoción (fijo o «desde»). */
export const promotionServicePrice = pgTable(
  "promotion_service_price",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => promotion.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => serviceCatalog.id),
    mode: text("mode").notNull().default("fixed"),
    /**
     * Cómo lo dice el agente (`PRICE_DISCLOSURES`); por defecto sigue a `mode`
     * («fijo» → exacto, «desde» → desde). Presupuesto y caja no lo leen.
     */
    priceDisclosure: text("price_disclosure").notNull().default("exacto"),
    priceCents: integer("price_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Nada se borra: retirar un servicio lo desactiva (el histórico no relee). */
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("promotion_service_price_promo_service_uidx").on(
      table.promotionId,
      table.serviceId,
    ),
    index("promotion_service_price_org_service_idx").on(table.organizationId, table.serviceId),
    index("promotion_service_price_org_promo_idx").on(table.organizationId, table.promotionId),
    check(
      "promotion_service_price_mode_check",
      sql`${table.mode} IN ('fixed','from')`,
    ),
    check("promotion_service_price_amount_check", sql`${table.priceCents} >= 0`),
    check(
      "promotion_service_price_disclosure_check",
      sql`${table.priceDisclosure} IN ('exacto','desde','evaluacion')`,
    ),
  ],
)

export const PROMOTION_MODES = ["fixed", "from"] as const
export type PromotionMode = (typeof PROMOTION_MODES)[number]

export type PromotionRow = typeof promotion.$inferSelect
export type PromotionServicePriceRow = typeof promotionServicePrice.$inferSelect
