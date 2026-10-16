import { sql } from "drizzle-orm"
import {
  boolean,
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
import { organization, user } from "./auth.js"
import { patient } from "./clinical.js"
import { contact, orgFk, timestamps } from "./crm.js"
import type { PortalScope } from "./portal.js"

/**
 * Portal del paciente: política, grants persistentes y passkeys.
 * Invariantes (ver local://portal-domain-contract.md):
 * - Sin fila en portal_policy el portal está deshabilitado.
 * - La coincidencia de teléfono NUNCA verifica identidad: no otorga, aprueba
 *   ni autocompleta nada. Toda verificación queda en portal_verification con
 *   método explícito del staff (presencial_documento|representacion_verificada).
 * - El grant persistente (portal_grant) es el que autoriza: enlaces y sesiones
 *   exigen grant activo y vigente además del vínculo representante↔paciente.
 * - Sin datos clínicos en mensajes de canal ni en títulos de tareas.
 */

export const PORTAL_VERIFIED_METHODS = ["presencial_documento", "representacion_verificada"] as const
export type PortalVerifiedMethod = (typeof PORTAL_VERIFIED_METHODS)[number]

export const PORTAL_GRANT_STATUSES = ["activo", "revocado"] as const
export type PortalGrantStatus = (typeof PORTAL_GRANT_STATUSES)[number]

export const PORTAL_WEBAUTHN_TYPES = ["registro", "autenticacion"] as const

/**
 * Política por organización (Configuración › Portal del paciente): encendido y
 * lo que el paciente puede ver. Sin fila = apagado. Lo demás son valores fijos
 * del código (`PORTAL_FIXED`, ADR 0037).
 */
export const portalPolicy = pgTable("portal_policy", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  portalEnabled: boolean("portal_enabled").notNull().default(false),
  allowedScope: jsonb("allowed_scope")
    .$type<{ appointments: boolean; budgets: boolean; account: boolean; documents: boolean }>()
    .notNull()
    .default({ appointments: true, budgets: true, account: true, documents: true }),
  updatedBy: text("updated_by").references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Grant persistente y revocable: UN paciente + UN contacto + alcance.
 * Solo hay un activo por par (parcial unique); revocar crea historia, no borra.
 */
export const portalGrant = pgTable(
  "portal_grant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    scope: jsonb("scope").$type<PortalScope>().notNull(),
    status: text("status").notNull().default("activo"),
    /** Solo métodos explícitos del staff (nunca teléfono ni PIN). */
    verifiedMethod: text("verified_method").notNull(),
    verifiedBy: text("verified_by").references(() => user.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id),
    revokeReason: text("revoke_reason"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("portal_grant_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("portal_grant_org_pair_active_uidx")
      .on(table.organizationId, table.patientId, table.contactId)
      .where(sql`"status" = 'activo'`),
    index("portal_grant_org_patient_idx").on(table.organizationId, table.patientId),
    index("portal_grant_org_contact_idx").on(table.organizationId, table.contactId),
    check("portal_grant_status_check", sql`${table.status} IN ('activo','revocado')`),
    check(
      "portal_grant_verified_method_check",
      sql`${table.verifiedMethod} IN ('presencial_documento','representacion_verificada')`,
    ),
    check("portal_grant_revoked_check", sql`(${table.status} <> 'revocado') = (${table.revokedAt} IS NULL)`),
  ],
)

/**
 * Evidencia append-only de cada verificación de identidad/representación.
 * Sin datos clínicos ni números de documento: método + quién + cuándo + ref.
 */
export const portalVerification = pgTable(
  "portal_verification",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id").references(() => portalGrant.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    verifiedBy: text("verified_by").references(() => user.id),
    /** Nota operativa del staff (sin PII sensible ni datos clínicos). */
    evidenceNote: text("evidence_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("portal_verification_org_pair_idx").on(
      table.organizationId,
      table.patientId,
      table.contactId,
    ),
    check(
      "portal_verification_method_check",
      sql`${table.method} IN ('presencial_documento','representacion_verificada')`,
    ),
  ],
)

/** Credencial passkey ligada a un grant (un contacto puede tener varias). */
export const portalPasskey = pgTable(
  "portal_passkey",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => portalGrant.id, { onDelete: "cascade" }),
    /** id base64url de la credencial WebAuthn (globalmente único). */
    credentialId: text("credential_id").notNull().unique(),
    /** Clave pública COSE en base64url (nunca el secreto). */
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports").array().notNull().default(sql`'{}'`),
    /** Etiqueta del dispositivo puesta por el paciente (p. ej. "Pixel 8"). */
    nickname: text("nickname"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id),
  },
  (table) => [
    uniqueIndex("portal_passkey_org_id_uidx").on(table.organizationId, table.id),
    index("portal_passkey_org_grant_idx").on(table.organizationId, table.grantId),
  ],
)

/**
 * Challenges WebAuthn: 5 min, un solo uso. El challenge exacto se valida con
 * la librería (expectedChallenge) más origin/rpID de config verificada.
 */
export const portalChallenge = pgTable(
  "portal_challenge",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    type: text("type").notNull(),
    /** Registro: grant de la sesión Bearer. Autenticación: null (descubrible). */
    grantId: uuid("grant_id").references(() => portalGrant.id, { onDelete: "cascade" }),
    /** Registro: sesión Bearer que lo pidió (debe seguir válida al verificar). */
    sessionId: uuid("session_id"),
    challenge: text("challenge").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("portal_challenge_org_expires_idx").on(table.organizationId, table.expiresAt),
    check("portal_challenge_type_check", sql`${table.type} IN ('registro','autenticacion')`),
  ],
)
