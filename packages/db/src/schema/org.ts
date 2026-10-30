import type { RegistrationConfig } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
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
  // Producto de la clínica (ADR 0079): qué app la atiende y qué hace lo común
  // en cada momento (`services/src/products.ts`). Las de hoy son dentales.
  product: text("product").notNull().default("dental"),
  // Impresión del ticket y hoja de cierre: térmica de 58 o 80 mm.
  receiptWidth: text("receipt_width").notNull().default("80"),
  // Tamaño de hoja para el presupuesto: A4 (ISO 216) o Carta.
  sheetSize: text("sheet_size").notNull().default("A4"),
  // Frase al pie del ticket; por defecto recibo interno sin validez fiscal.
  ticketFooter: text("ticket_footer").notNull().default("Recibo interno. No es un documento fiscal."),
  // Presupuesto: días de vigencia al entregarlo y sus dos textos, que edita cada
  // clínica; vacíos, esa sección no sale. El texto inicial, también el de las
  // clínicas nuevas, es dato de la base (su migración): el código no lo escribe.
  budgetValidDays: smallint("budget_valid_days").notNull().default(30),
  budgetPaymentTerms: text("budget_payment_terms").default(
    "Cada tratamiento se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.",
  ),
  budgetChangeTerms: text("budget_change_terms").default(
    "Solo por algo que no se podía ver antes de empezar. Se le explica y le entregamos un presupuesto nuevo para que decida; nada se cobra sin su aceptación.",
  ),
  // Teléfono para urgencias de la clínica (también cuando está cerrada): lo da
  // el agente ante una urgencia, junto con el número de emergencias del país
  // (ADR 0084). Nulo: el agente da solo ese número.
  emergencyPhone: text("emergency_phone"),
  // Impuestos de lo que cobra la clínica (ADR 0083): vale lo que propone su
  // país (`resolveOrgTaxes` de @odentia/clinical); aquí solo queda lo que la
  // clínica cambió, con la categoría de UN/CEFACT 5305 y la tasa en puntos
  // básicos. Nulo es «lo del país». La forma de la clínica solo la pregunta un
  // país donde el impuesto de la atención depende de ella (México).
  taxLegalForm: text("tax_legal_form"),
  servicesTaxCategory: text("services_tax_category"),
  servicesTaxBps: integer("services_tax_bps"),
  productsTaxCategory: text("products_tax_category"),
  productsTaxBps: integer("products_tax_bps"),
  // Verificación en dos pasos a todo el equipo (ADR 0107): encendida, la API
  // no deja operar en esta clínica a quien no la tiene activa.
  requireTwoFactor: boolean("require_two_factor").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "org_profile_services_tax_check",
    sql`(${table.servicesTaxCategory} IS NULL) = (${table.servicesTaxBps} IS NULL) AND (${table.servicesTaxCategory} IS NULL OR (${table.servicesTaxCategory} = 'S' AND ${table.servicesTaxBps} BETWEEN 1 AND 5000) OR (${table.servicesTaxCategory} IN ('E','O','Z') AND ${table.servicesTaxBps} = 0))`,
  ),
  check(
    "org_profile_products_tax_check",
    sql`(${table.productsTaxCategory} IS NULL) = (${table.productsTaxBps} IS NULL) AND (${table.productsTaxCategory} IS NULL OR (${table.productsTaxCategory} = 'S' AND ${table.productsTaxBps} BETWEEN 1 AND 5000) OR (${table.productsTaxCategory} IN ('E','O','Z') AND ${table.productsTaxBps} = 0))`,
  ),
  check("org_profile_receipt_width_check", sql`${table.receiptWidth} IN ('58','80')`),
  check("org_profile_budget_valid_days_check", sql`${table.budgetValidDays} BETWEEN 1 AND 365`),
  check("org_profile_product_check", sql`${table.product} IN ('dental','medical')`),
  check("org_profile_sheet_size_check", sql`${table.sheetSize} IN ('A4','Letter')`),
  check(
    "org_profile_diagnosis_system_check",
    sql`${table.diagnosisSystem} IS NULL OR ${table.diagnosisSystem} IN ('ICD-10','ICD-11','ICD-10-PE')`,
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

export const branch = pgTable(
  "branch",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    /**
     * El enlace corto para llegar (`<clínica>/llegar/<slug>`): lo pone la base
     * al crearla a partir del nombre (`branch_slug_fill`, migración 0061) y no
     * cambia al renombrarla. Por eso no se escribe al insertar.
     */
    slug: text("slug")
      .notNull()
      .$defaultFn(() => ""),
    /**
     * Dirección internacional (HL7 FHIR Address), la misma forma que la del
     * paciente (issue 36): calle y número; ciudad o localidad (`city`); el
     * nivel entre región y ciudad (`district`, la provincia en Perú); región
     * ISO 3166-2 (o su nombre, si el país no tiene lista); código postal y
     * país ISO 3166-1. Etiquetas y obligatoriedad las pone el perfil del país.
     */
    addressLine1: text("address_line1"),
    city: text("city"),
    district: text("district"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: char("country", { length: 2 }),
    /** La ficha de la sede en Google Maps (Place ID): lo único de Google que se guarda; abre «Cómo llegar». */
    googlePlaceId: text("google_place_id"),
    phone: text("phone"),
    email: text("email"),
    // null = hereda la zona horaria de la organización
    timezone: text("timezone"),
    // Minutos de una cita regular en la sede: lo que dura cuando no lleva servicio.
    appointmentDefaultMinutes: integer("appointment_default_minutes").notNull().default(60),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("branch_org_slug_uidx").on(table.organizationId, table.slug),
    // Destino de las claves compuestas que impiden apuntar a otra clínica.
    uniqueIndex("branch_org_id_finance_uidx").on(table.organizationId, table.id),
  ],
)

/**
 * Búsquedas de direcciones de cada clínica por día (issue 36): el tope diario
 * de las sugerencias de la sede (Google) y del paciente (Geoapify). Solo la
 * cuenta: lo escrito no se guarda.
 */
export const addressLookupDay = pgTable(
  "address_lookup_day",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    day: date("day").notNull(),
    purpose: text("purpose").notNull(),
    searches: integer("searches").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.day, table.purpose] }),
    check("address_lookup_day_purpose_check", sql`${table.purpose} in ('sede', 'paciente')`),
    check("address_lookup_day_searches_check", sql`${table.searches} >= 0`),
  ],
)

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
    // Lo último que pasó con una cosa (la invitación a volver de un paciente, la
    // confirmación de una cita): sin él, cada consulta recorre lo de toda la clínica.
    index("audit_event_org_entity_id_created_idx").on(
      table.organizationId,
      table.entity,
      table.entityId,
      table.createdAt.desc(),
    ),
  ],
)
