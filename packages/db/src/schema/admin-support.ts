import { sql } from "drizzle-orm"
import {
  boolean,
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

/**
 * Casos de soporte de odentIA: la única fuente de lo que una persona envía
 * desde la Ayuda. Cada envío abre su caso, o se junta con el suyo que siga
 * abierto: los hilos son privados por organización y nunca se mezclan entre
 * clínicas. `organizationId` nulo = caso de acceso desde el
 * panel (sin clínica: problemas de entrada u onboarding).
 */
export const supportCase = pgTable(
  "support_case",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: text("organization_id").references(() => organization.id),
    kind: text("kind").notNull().default("pregunta"),
    question: text("question").notNull(),
    detail: text("detail"),
    screen: text("screen").notNull().default("/"),
    role: text("role").notNull().default(""),
    appVersion: text("app_version"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("abierto"),
    assigneeStaffId: text("assignee_staff_id").references(() => user.id),
    /**
     * Quien lo abrió. Nulo solo en los casos automáticos de odentIA («Modelo
     * sin responder»), que tampoco son de una clínica: ninguna clínica los ve.
     */
    openedBy: text("opened_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    reopenedCount: integer("reopened_count").notNull().default(0),
    /** Última respuesta pública del equipo: lo que la clínica aún no abre es no leído. */
    lastPublicMessageAt: timestamp("last_public_message_at", { withTimezone: true }),
    /** Cuándo abrió la clínica la conversación por última vez («Ver»). */
    clientSeenAt: timestamp("client_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_case_org_status_idx").on(table.organizationId, table.status, table.updatedAt),
    index("support_case_staff_idx").on(table.status, table.updatedAt),
    index("support_case_assignee_idx").on(table.assigneeStaffId, table.status),
    index("support_case_dedupe_idx").on(table.dedupeKey, table.status),
    index("support_case_opener_idx").on(table.openedBy, table.createdAt),
    // Destino de las FK compuestas de mensajes/adjuntos/permisos: impide cruces de organización.
    uniqueIndex("support_case_id_org_uidx").on(table.id, table.organizationId),
    check("support_case_kind_check", sql`${table.kind} in ('pregunta','problema','acceso')`),
    check("support_case_opener_check", sql`${table.openedBy} is not null or ${table.organizationId} is null`),
    check(
      "support_case_status_check",
      sql`${table.status} in ('abierto','en_atencion','esperando_clinica','resuelto')`,
    ),
  ],
)

/**
 * Conversación del caso. `isInternal` = nota interna del equipo: la clínica
 * nunca la ve. Responder a varios casos usa el mismo texto pero una fila por
 * caso: los hilos siguen privados.
 */
export const supportMessage = pgTable(
  "support_message",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id),
    authorKind: text("author_kind").notNull().default("cliente"),
    authorUserId: text("author_user_id").references(() => user.id),
    body: text("body").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_message_case_idx").on(table.caseId, table.createdAt),
    check(
      "support_message_author_check",
      sql`${table.authorKind} in ('cliente','staff','sistema')`,
    ),
    // Impide cruces de organización: el mensaje vive en la org de su caso.
    foreignKey({
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }),
    // Destino de la FK compuesta de adjuntos: el mensaje pertenece a su caso.
    uniqueIndex("support_message_id_case_uidx").on(table.id, table.caseId),
  ],
)

export const supportAttachment = pgTable(
  "support_attachment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => supportMessage.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id),
    objectKey: text("object_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_attachment_case_idx").on(table.caseId, table.createdAt),
    foreignKey({
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }),
    // El adjunto no puede colgar de un mensaje de otro caso.
    foreignKey({
      columns: [table.messageId, table.caseId],
      foreignColumns: [supportMessage.id, supportMessage.caseId],
    }),
  ],
)

/**
 * Acceso delegado de diagnóstico: un owner/admin de la clínica autoriza a
 * soporte a ver la configuración operacional (no clínica) de su organización,
 * ligado a un caso, con vencimiento máximo de 1 hora y revocable. El actor
 * sigue siendo el staff: nunca suplanta al owner.
 */
export const supportAccessGrant = pgTable(
  "support_access_grant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => user.id),
    scope: text("scope").notNull().default("diagnostico"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_access_grant_case_idx").on(table.caseId, table.expiresAt),
    index("support_access_grant_org_idx").on(table.organizationId, table.expiresAt),
    check("support_access_grant_scope_check", sql`${table.scope} = 'diagnostico'`),
    check("support_access_grant_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    // Tope exacto de 1 h: el servicio crea expiresAt desde el mismo createdAt explícito.
    check(
      "support_access_grant_duration_check",
      sql`${table.expiresAt} <= ${table.createdAt} + interval '1 hour'`,
    ),
    foreignKey({
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }),
    uniqueIndex("support_access_grant_id_case_org_uidx").on(
      table.id,
      table.caseId,
      table.organizationId,
    ),
  ],
)

/**
 * Auditoría de accesos delegados: cada lectura diagnóstica, denegación y
 * revocación. Append-only: ningún rol de app puede actualizar ni borrar.
 */
export const supportAccessAudit = pgTable(
  "support_access_audit",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    grantId: uuid("grant_id").references(() => supportAccessGrant.id, { onDelete: "set null" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => user.id),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_access_audit_grant_idx").on(table.grantId, table.createdAt),
    index("support_access_audit_case_idx").on(table.caseId, table.createdAt),
    check(
      "support_access_audit_action_check",
      sql`${table.action} in ('vista_diagnostica','denegado_sin_permiso','revocado')`,
    ),
    foreignKey({
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }),
    // La lectura auditada corresponde al permiso que dice usar.
    foreignKey({
      columns: [table.grantId, table.caseId, table.organizationId],
      foreignColumns: [
        supportAccessGrant.id,
        supportAccessGrant.caseId,
        supportAccessGrant.organizationId,
      ],
    }),
  ],
)

/**
 * Avisos por correo de un caso: a soporte cuando se abre o la clínica responde
 * (`recipientUserId` nulo = el buzón de soporte, `SUPPORT_INBOX_EMAIL`) y a
 * quien preguntó cuando soporte le responde y no lo vio. El correo solo avisa:
 * no lleva el texto del caso. El aviso se guarda y se reclama antes de SMTP
 * (pendiente → reclamado → enviado | incierto | omitido); un envío incierto no
 * se reintenta. `dedupeKey` único impide dos correos por el mismo hecho. La
 * aplicación solo los crea y lee: reclamar y cerrar es del worker (owner).
 */
export const supportNotice = pgTable(
  "support_notice",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    recipientUserId: text("recipient_user_id").references(() => user.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull().unique(),
    emailState: text("email_state").notNull().default("pendiente"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_notice_case_idx").on(table.caseId, table.createdAt),
    index("support_notice_state_idx").on(table.emailState, table.createdAt),
    check(
      "support_notice_kind_check",
      sql`${table.kind} in ('caso_nuevo','clinica_respondio','respuesta','necesita_algo')`,
    ),
    check(
      "support_notice_state_check",
      sql`${table.emailState} in ('pendiente','reclamado','enviado','incierto','omitido')`,
    ),
    // A soporte van los avisos de la clínica; a la persona, los de soporte.
    check(
      "support_notice_recipient_check",
      sql`(${table.kind} in ('caso_nuevo','clinica_respondio')) = (${table.recipientUserId} is null)`,
    ),
    foreignKey({
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }),
  ],
)
