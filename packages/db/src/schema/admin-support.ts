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
import { adminSchema } from "./schemas.js"

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
    /**
     * Cuándo pidió soporte el acceso de diagnóstico. Puesto: la propietaria y
     * los administradores leen el caso aunque no lo hayan abierto (ADR 0181).
     */
    accessRequestedAt: timestamp("access_requested_at", { withTimezone: true }),
    /**
     * Lo que pidió soporte con ese pedido: el rol de la clínica con que necesita
     * mirar (nulo = solo la configuración), cuántos minutos y quién lo pidió, a
     * quien se le da el permiso si la clínica lo autoriza.
     */
    accessRequestedRole: text("access_requested_role"),
    accessRequestedMinutes: integer("access_requested_minutes"),
    accessRequestedBy: text("access_requested_by").references(() => user.id),
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
    // `cobro`: la clínica pidió revisar una fila de lo que se le cobró (ADR 0054).
    check("support_case_kind_check", sql`${table.kind} in ('pregunta','problema','acceso','cobro')`),
    check("support_case_opener_check", sql`${table.openedBy} is not null or ${table.organizationId} is null`),
    check(
      "support_case_status_check",
      sql`${table.status} in ('abierto','en_atencion','esperando_clinica','resuelto')`,
    ),
  ],
)

/**
 * «Falta en la guía»: soporte marca un caso cuya respuesta no está en la
 * Ayuda. Es una marca del equipo de odentIA y vive en `admin`, no en
 * `support_case`, porque la clínica escribe en esa tabla: sin `GRANT` al rol
 * de la aplicación. Una fila por caso; «Ya está en la guía» la borra.
 */
export const supportGuideGap = adminSchema.table(
  "support_guide_gap",
  {
    caseId: uuid("case_id")
      .primaryKey()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
    markedBy: text("marked_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => [index("support_guide_gap_marked_idx").on(table.markedAt)],
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
    caseId: uuid("case_id").notNull(),
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
    foreignKey({ name: "support_message_case_id_case_id_fk", columns: [table.caseId], foreignColumns: [supportCase.id] })
      .onDelete("cascade"),
    // Impide cruces de organización: el mensaje vive en la org de su caso.
    foreignKey({
      name: "support_message_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }).onDelete("cascade"),
    // Destino de la FK compuesta de adjuntos: el mensaje pertenece a su caso.
    uniqueIndex("support_message_id_case_uidx").on(table.id, table.caseId),
  ],
)

export const supportAttachment = pgTable(
  "support_attachment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id").notNull(),
    messageId: uuid("message_id"),
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
    foreignKey({ name: "support_attachment_case_id_case_id_fk", columns: [table.caseId], foreignColumns: [supportCase.id] })
      .onDelete("cascade"),
    foreignKey({
      name: "support_attachment_message_id_message_id_fk",
      columns: [table.messageId],
      foreignColumns: [supportMessage.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "support_attachment_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }).onDelete("cascade"),
    // El adjunto no puede colgar de un mensaje de otro caso.
    foreignKey({
      name: "support_attachment_message_case_fk",
      columns: [table.messageId, table.caseId],
      foreignColumns: [supportMessage.id, supportMessage.caseId],
    }).onDelete("cascade"),
  ],
)

/**
 * Acceso delegado de soporte: un owner/admin de la clínica autoriza a soporte,
 * ligado a un caso, con vencimiento máximo de 1 hora y revocable. Dos alcances:
 * `diagnostico`, la lista de configuración que se lee desde la administración, y
 * `rol`, la app de la clínica en solo lectura con lo que ve `viewRole`. El actor
 * sigue siendo el staff: nunca suplanta al owner ni es miembro de la clínica.
 * Uno solo vigente por clínica (`support_access_grant_one_open_uidx`): dar otro
 * cierra el anterior, así el tope de 1 hora no se encadena abriendo casos.
 */
export const supportAccessGrant = pgTable(
  "support_access_grant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => user.id),
    scope: text("scope").notNull().default("diagnostico"),
    /** Con alcance `rol`: el rol de la clínica cuyo permiso de lectura usa soporte. */
    viewRole: text("view_role"),
    /** La persona de soporte que puede usarlo; nulo hasta que alguien de soporte tome el caso. */
    staffUserId: text("staff_user_id").references(() => user.id),
    /** Para qué, con las palabras de quien lo dio o lo pidió. */
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Quién lo cerró antes de tiempo (la clínica o el equipo); nulo si terminó solo. */
    revokedBy: text("revoked_by").references(() => user.id),
    /** Por qué terminó: lo quitaron, otro lo reemplazó, venció, se resolvió el caso o quien lo dio ya no puede darlo. */
    endReason: text("end_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_access_grant_case_idx").on(table.caseId, table.expiresAt),
    index("support_access_grant_org_idx").on(table.organizationId, table.expiresAt),
    uniqueIndex("support_access_grant_one_open_uidx")
      .on(table.organizationId)
      .where(sql`${table.revokedAt} is null`),
    check("support_access_grant_scope_check", sql`${table.scope} in ('diagnostico','rol')`),
    check(
      "support_access_grant_role_check",
      sql`(${table.scope} = 'rol') = (${table.viewRole} is not null)`,
    ),
    check(
      "support_access_grant_reason_check",
      sql`${table.reason} is null or char_length(${table.reason}) between 1 and 500`,
    ),
    check(
      "support_access_grant_end_check",
      sql`(${table.revokedAt} is null) = (${table.endReason} is null) and (${table.endReason} is null or ${table.endReason} in ('quitado','reemplazado','vencido','caso_resuelto','sin_quien_lo_dio'))`,
    ),
    check("support_access_grant_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    // Tope exacto de 1 h: el servicio crea expiresAt desde el mismo createdAt explícito.
    check(
      "support_access_grant_duration_check",
      sql`${table.expiresAt} <= ${table.createdAt} + interval '1 hour'`,
    ),
    foreignKey({ name: "support_access_grant_case_id_case_id_fk", columns: [table.caseId], foreignColumns: [supportCase.id] })
      .onDelete("cascade"),
    foreignKey({
      name: "support_access_grant_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("support_access_grant_id_case_org_uidx").on(
      table.id,
      table.caseId,
      table.organizationId,
    ),
  ],
)

/**
 * Auditoría de accesos delegados: autorizar, quitar, cada lectura diagnóstica,
 * cada entrada con pase y cada denegación. `staffUserId` es quien actuó: alguien
 * de soporte, o la persona de la clínica que autorizó o quitó. Las fichas que
 * abre soporte en solo lectura quedan además en `clinical_access_log`, que la
 * clínica ve. Append-only: ningún rol de app puede actualizar ni borrar.
 */
export const supportAccessAudit = pgTable(
  "support_access_audit",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    grantId: uuid("grant_id"),
    caseId: uuid("case_id").notNull(),
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
      sql`${table.action} in ('vista_diagnostica','denegado_sin_permiso','revocado','autorizado','pase','entrada','denegado_pase','denegado_solo_lectura')`,
    ),
    foreignKey({ name: "support_access_audit_case_id_case_id_fk", columns: [table.caseId], foreignColumns: [supportCase.id] })
      .onDelete("cascade"),
    foreignKey({
      name: "support_access_audit_grant_id_grant_id_fk",
      columns: [table.grantId],
      foreignColumns: [supportAccessGrant.id],
    }).onDelete("set null"),
    foreignKey({
      name: "support_access_audit_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }).onDelete("cascade"),
    // La lectura auditada corresponde al permiso que dice usar.
    foreignKey({
      name: "support_access_audit_grant_case_org_fk",
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
 * La entrada de soporte a la app de una clínica con un permiso de alcance `rol`.
 * La administración crea un pase de un solo uso (60 s, solo su hash); la app de la
 * clínica lo canjea por la sesión de solo mirar (su hash en `sessionHash`), que
 * vale mientras valga el permiso. Es de odentIA: sin `GRANT` al rol de la app;
 * solo la API la lee, con el dueño.
 */
export const supportAccessSession = adminSchema.table(
  "support_access_session",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => supportAccessGrant.id, { onDelete: "cascade" }),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => user.id),
    passHash: text("pass_hash").notNull(),
    passExpiresAt: timestamp("pass_expires_at", { withTimezone: true }).notNull(),
    sessionHash: text("session_hash"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("support_access_session_pass_uidx").on(table.passHash),
    uniqueIndex("support_access_session_session_uidx").on(table.sessionHash),
    index("support_access_session_grant_idx").on(table.grantId),
    check(
      "support_access_session_redeem_check",
      sql`(${table.redeemedAt} is null) = (${table.sessionHash} is null)`,
    ),
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
      name: "support_notice_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [supportCase.id, supportCase.organizationId],
    }).onDelete("cascade"),
  ],
)
