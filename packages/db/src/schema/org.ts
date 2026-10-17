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
} from "drizzle-orm/pg-core"
import { organization } from "./auth.js"

export const orgProfile = pgTable("org_profile", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id),
  legalName: text("legal_name").notNull(),
  /**
   * El nombre que ve la persona en todo (decisión 19): WhatsApp, «Su enlace»,
   * el portal, el registro, el chat web y los PDF. Obligatorio: vacío, la base
   * pone la razón social (respaldo de datos viejos) y lo copia en
   * `organization.name`. La razón social va solo en el comprobante y lo legal.
   */
  tradeName: text("trade_name").notNull().default(""),
  // Tipo de identificador fiscal tal como lo nombra el país de la clínica
  // (texto libre); null mientras la clínica no lo tenga.
  fiscalDocType: text("fiscal_doc_type"),
  fiscalDocNumber: text("fiscal_doc_number"),
  fiscalAddress: text("fiscal_address"),
  // Perfil regional (ISO 3166-1, ISO 4217, IANA, BCP 47): sin valores por
  // defecto, porque el núcleo no asume ningún país; quien crea el perfil los
  // pasa siempre (el alta los deriva del país con `regionPresetForCountry`).
  countryCode: char("country_code", { length: 2 }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  timezone: text("timezone").notNull(),
  locale: text("locale").notNull(),
  // Lista de diagnósticos de la clínica (decisión 26 de la fase 4): CIE-10 o
  // CIE-11. Nula en perfiles creados sin ella: vale la que recomienda su país
  // (`clinicalProfileFor(...).diagnosis.recommended`); el alta la guarda.
  diagnosisSystem: text("diagnosis_system"),
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
  check(
    "org_profile_diagnosis_system_check",
    sql`${table.diagnosisSystem} IS NULL OR ${table.diagnosisSystem} IN ('ICD-10','ICD-11')`,
  ),
  check("org_profile_ticket_footer_check", sql`length(trim(${table.ticketFooter})) BETWEEN 1 AND 280`),
])

export const patientRegistrationConfig = pgTable("patient_registration_config", {
  organizationId: text("organization_id").primaryKey().references(() => organization.id),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(false),
  fields: jsonb("fields").$type<RegistrationConfig["fields"]>().notNull(),
  privacyNotice: text("privacy_notice").notNull().default(""),
  // Qué permisos de mensajes pregunta el registro, además de la atención.
  askReminders: boolean("ask_reminders").notNull().default(true),
  askMessages: boolean("ask_messages").notNull().default(true),
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
