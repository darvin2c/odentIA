import type { RegistrationConfig } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { organization } from "./auth.js"

export const orgProfile = pgTable("org_profile", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name"),
  fiscalDocType: text("fiscal_doc_type").notNull().default("RUC"),
  fiscalDocNumber: text("fiscal_doc_number"),
  billingEmail: text("billing_email"),
  fiscalAddress: text("fiscal_address"),
  countryCode: char("country_code", { length: 2 }).notNull().default("PE"),
  currency: char("currency", { length: 3 }).notNull().default("PEN"),
  timezone: text("timezone").notNull().default("America/Lima"),
  locale: text("locale").notNull().default("es-PE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const patientRegistrationConfig = pgTable("patient_registration_config", {
  organizationId: text("organization_id").primaryKey().references(() => organization.id),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(false),
  fields: jsonb("fields").$type<RegistrationConfig["fields"]>().notNull(),
  privacyNotice: text("privacy_notice").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const branch = pgTable("branch", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  name: text("name").notNull(),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  department: text("department"),
  province: text("province"),
  district: text("district"),
  ubigeo: varchar("ubigeo", { length: 6 }),
  phone: text("phone"),
  email: text("email"),
  mapsUrl: text("maps_url"),
  // null = hereda la zona horaria de la organización
  timezone: text("timezone"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: text("organization_id").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Replay SSE: eventos de una org ordenados por tiempo.
    index("audit_event_org_created_idx").on(table.organizationId, table.createdAt),
  ],
)
