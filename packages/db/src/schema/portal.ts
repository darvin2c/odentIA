import { sql } from "drizzle-orm"
import {
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
import { patient } from "./clinical.js"
import { portalGrant, portalPasskey } from "./portal-access.js"
import { contact, conversation, message, orgFk, timestamps } from "./crm.js"

/**
 * Portal del paciente: acceso por enlaces de un solo uso que se canjean por
 * sesiones revocables. Invariantes:
 * - El token crudo NUNCA se persiste: solo su hash sha256 (tokenHash).
 * - El enlace se entrega por una conversación ya validada del contacto
 *   (deliveryConversationId/deliveryMessageId); la API staff jamás devuelve
 *   el token crudo.
 * - La sesión queda ligada a UN paciente + UN contacto + alcance congelado
 *   (scope): un representante con varios pacientes solo ve el autorizado.
 * - Sin cobro online: el portal solo lee la cuenta real (cargos/pagos/saldo).
 */

export const PORTAL_LINK_STATUSES = ["pendiente", "usado", "revocado"] as const
export type PortalLinkStatus = (typeof PORTAL_LINK_STATUSES)[number]

/** Alcance autorizado congelado en enlace y sesión. */
export interface PortalScope {
  /** Ver citas y confirmar/reprogramar según reglas de Agenda. */
  appointments: boolean
  /** Ver presupuestos presentados y decidirlos como representante verificado. */
  budgets: boolean
  /** Ver cuenta real y saldo (solo lectura, sin cobros). */
  account: boolean
  /** Ids de patient_document autorizados (vacío = ninguno). */
  documents: string[]
}

export const portalLink = pgTable(
  "portal_link",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Alcance autorizado por el operador al emitir. */
    scope: jsonb("scope").$type<PortalScope>().notNull(),
    /** sha256 hex del token crudo (el crudo solo viaja en el mensaje de entrega). */
    tokenHash: text("token_hash").notNull().unique(),
    /**
     * sha256 del PIN de 6 dígitos que el operador comunica al contacto por
     * vía independiente de la bandeja. Sin PIN no hay canje aunque el token
     * sea visible en la conversación (anti-escalada por lectura de inbox).
     */
    pinHash: text("pin_hash"),
    /** Intentos fallidos de PIN; a los 10 el enlace se revoca solo. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    status: text("status").notNull().default("pendiente"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id),
    /** Idempotencia de emisión: reintentos con la misma clave devuelven el pendiente. */
    idempotencyKey: text("idempotency_key"),
    /** Evidencia de entrega por canal validado del contacto. */
    deliveryConversationId: uuid("delivery_conversation_id").references(() => conversation.id),
    deliveryMessageId: uuid("delivery_message_id").references(() => message.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("portal_link_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("portal_link_token_hash_uidx").on(table.tokenHash),
    uniqueIndex("portal_link_org_idempotency_uidx")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`"idempotency_key" IS NOT NULL`),
    index("portal_link_org_patient_idx").on(table.organizationId, table.patientId),
    index("portal_link_org_contact_idx").on(table.organizationId, table.contactId),
    index("portal_link_org_expires_idx").on(table.organizationId, table.expiresAt),
    check(
      "portal_link_status_check",
      sql`${table.status} IN ('pendiente','usado','revocado')`,
    ),
  ],
)

export const portalSession = pgTable(
  "portal_session",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Nulo en sesiones passkey o por cambio de identidad (sin enlace). */
    linkId: uuid("link_id").references(() => portalLink.id, { onDelete: "cascade" }),
    /** Grant persistente que autoriza la sesión (exigido en cada lectura). */
    grantId: uuid("grant_id").references(() => portalGrant.id, { onDelete: "cascade" }),
    /** Cómo se autenticó: enlace_pin (activación asistida) o passkey. */
    authMethod: text("auth_method").notNull().default("enlace_pin"),
    /** Credencial que abrió la sesión (solo passkey; para revocación precisa). */
    passkeyId: uuid("passkey_id").references(() => portalPasskey.id, { onDelete: "set null" }),
    /** Alcance congelado al canjear (copia del enlace). */
    scope: jsonb("scope").$type<PortalScope>().notNull(),
    /** sha256 hex del token de sesión (el crudo se entrega una vez al canjear). */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id),
    /** Operador que emitió el enlace (FK real): recibe los avisos de lo que hace la persona; sus acciones quedan a nombre de ella. */
    issuedBy: text("issued_by").references(() => user.id),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("portal_session_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("portal_session_token_hash_uidx").on(table.tokenHash),
    index("portal_session_org_patient_idx").on(table.organizationId, table.patientId),
    index("portal_session_org_link_idx").on(table.organizationId, table.linkId),
    index("portal_session_org_grant_idx").on(table.organizationId, table.grantId),
    index("portal_session_org_expires_idx").on(table.organizationId, table.expiresAt),
  ],
)

/** Bitácora append-only de cada lectura/acción del portal (control por acceso). */
export const portalAccessLog = pgTable(
  "portal_access_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => portalSession.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("portal_access_log_org_session_idx").on(table.organizationId, table.sessionId),
    index("portal_access_log_org_created_idx").on(table.organizationId, table.createdAt),
  ],
)
