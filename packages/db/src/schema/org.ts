import type { RegistrationConfig } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  check,
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
  // Impresión del ticket y hoja de cierre: térmica de 58 o 80 mm.
  receiptWidth: text("receipt_width").notNull().default("80"),
  // Tamaño de hoja para el presupuesto: A4 (ISO 216) o Carta.
  sheetSize: text("sheet_size").notNull().default("A4"),
  // Frase al pie del ticket; por defecto recibo interno sin validez fiscal.
  ticketFooter: text("ticket_footer").notNull().default("Recibo interno. No es un documento fiscal."),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("org_profile_receipt_width_check", sql`${table.receiptWidth} IN ('58','80')`),
  check("org_profile_sheet_size_check", sql`${table.sheetSize} IN ('A4','Letter')`),
  check("org_profile_ticket_footer_check", sql`length(trim(${table.ticketFooter})) BETWEEN 1 AND 280`),
])

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
  // Minutos de una cita regular en la sede: lo que dura cuando no lleva servicio.
  appointmentDefaultMinutes: integer("appointment_default_minutes").notNull().default(60),
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
