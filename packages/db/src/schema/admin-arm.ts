import { type SQL, sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { saasDemo } from "./admin-demos.js"
import { organization, user } from "./auth.js"
import { saasPlan, saasSeller } from "./saas-billing.js"
import { adminSchema } from "./schemas.js"

/**
 * El ARM de la administración (Agentic Relationship Management): la relación
 * de Sallca con cada clínica, desde el primer contacto hasta que usa y paga.
 * El cliente es el eje: la solicitud de la web, la cuenta (organización), las
 * personas, las actividades, las tareas, la venta, los envíos, los archivos y
 * lo que prepara Kairós cuelgan de él.
 *
 * Todo vive en `admin` (ADR 0064) y nace cerrado al rol de la aplicación (ADR
 * 0063): sin `GRANT`, solo `ownerDb` después del guard del personal. Los
 * nombres llevan prefijo (`saas_`, `kairos_`) porque `task`, `contact` y
 * `opportunity` ya existen en `public` y el `search_path` no los distingue.
 *
 * Reglas que la base protege (`0105_arm_reglas.sql`): una oportunidad abierta
 * por cliente; la propuesta enviada no cambia sus condiciones y de enviada
 * solo pasa a aceptada o no aceptada; un envío solo avanza de pendiente a
 * enviado, incierto o no salió, y de incierto a enviado o no salió (lo
 * resuelve una persona: nunca se reintenta); la bitácora (`saas_follow_up`)
 * solo se agrega. La etapa de un cliente no se guarda: se calcula.
 */

/** `col IN ('a','b',…)` desde la lista exportada: una sola fuente para el check y el código. */
function oneOf(column: AnyPgColumn | SQL, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(","))})`
}

export const SAAS_CLIENT_PRODUCTS = ["dental", "medical", "optical"] as const
export const SAAS_CLIENT_ORIGINS = [
  "web",
  "referido",
  "evento",
  "whatsapp",
  "redes",
  "busqueda",
  "otro",
] as const
export type SaasClientOrigin = (typeof SAAS_CLIENT_ORIGINS)[number]
export const SAAS_CONTACT_ROLES = ["decide", "usa", "paga"] as const
export type SaasContactRole = (typeof SAAS_CONTACT_ROLES)[number]
export const SAAS_CONTACT_CHANNELS = ["whatsapp", "correo", "llamada"] as const
export type SaasContactChannel = (typeof SAAS_CONTACT_CHANNELS)[number]
export const SAAS_ACTIVITY_KINDS = [
  "llamada",
  "whatsapp",
  "correo",
  "reunion",
  "presentacion",
  "propuesta",
  "nota",
] as const
export type SaasActivityKind = (typeof SAAS_ACTIVITY_KINDS)[number]
export const SAAS_ACTIVITY_DIRECTIONS = ["salio", "entro"] as const
export type SaasActivityDirection = (typeof SAAS_ACTIVITY_DIRECTIONS)[number]
export const SAAS_TASK_KINDS = [
  "llamar",
  "escribir",
  "presentacion",
  "propuesta",
  "alta",
  "cobro",
  "otro",
] as const
export type SaasTaskKind = (typeof SAAS_TASK_KINDS)[number]
export const SAAS_TASK_STATUSES = ["abierta", "hecha", "cancelada"] as const
export type SaasTaskStatus = (typeof SAAS_TASK_STATUSES)[number]
export const SAAS_OPPORTUNITY_DECISIONS = ["entro", "no_por_ahora", "perdido"] as const
export type SaasOpportunityDecision = (typeof SAAS_OPPORTUNITY_DECISIONS)[number]
export const SAAS_LOST_REASONS = [
  "precio",
  "sigue_con_lo_que_usa",
  "no_es_el_momento",
  "no_respondio",
  "le_falta_una_funcion",
  "no_es_una_clinica",
  "otro",
] as const
export type SaasLostReason = (typeof SAAS_LOST_REASONS)[number]
export const SAAS_PROPOSAL_STATUSES = [
  "borrador",
  "por_aprobar",
  "enviada",
  "aceptada",
  "no_aceptada",
] as const
export type SaasProposalStatus = (typeof SAAS_PROPOSAL_STATUSES)[number]
/** Los mismos ciclos que `saas_subscription.billing_cycle`. */
export const SAAS_PROPOSAL_BILLING_CYCLES = ["mensual", "quincenal"] as const
export const SAAS_OUTREACH_CHANNELS = ["correo", "whatsapp"] as const
export type SaasOutreachChannel = (typeof SAAS_OUTREACH_CHANNELS)[number]
export const SAAS_OUTREACH_STATUSES = ["pendiente", "enviado", "incierto", "no_salio"] as const
export type SaasOutreachStatus = (typeof SAAS_OUTREACH_STATUSES)[number]
export const KAIROS_ITEM_KINDS = [
  "mensaje",
  "propuesta",
  "guion",
  "dato",
  "vinculo",
  "duplicado",
  "demo",
  "presentacion_hecha",
  "correo_sin_cliente",
] as const
export type KairosItemKind = (typeof KAIROS_ITEM_KINDS)[number]
export const KAIROS_ITEM_STATUSES = [
  "espera",
  "ejecutada",
  "fallida",
  "incierta",
  "descartada",
  "vencida",
] as const
export type KairosItemStatus = (typeof KAIROS_ITEM_STATUSES)[number]
export const SAAS_CLIENT_FILE_KINDS = [
  "carta",
  "propuesta",
  "presentacion",
  "archivo_clinica",
  "correo",
  "otro",
] as const
export type SaasClientFileKind = (typeof SAAS_CLIENT_FILE_KINDS)[number]
export const SAAS_CLIENT_FILE_SOURCES = ["persona", "kairos", "correo"] as const
export type SaasClientFileSource = (typeof SAAS_CLIENT_FILE_SOURCES)[number]
export const SAAS_INBOUND_MAILBOXES = ["soporte", "contacto"] as const
export type SaasInboundMailbox = (typeof SAAS_INBOUND_MAILBOXES)[number]
export const SAAS_INBOUND_MATCHES = ["contacto", "solicitud", "miembro", "persona"] as const
export type SaasInboundMatch = (typeof SAAS_INBOUND_MATCHES)[number]
export const KAIROS_AI_PURPOSES = [
  "borrador",
  "resumen",
  "anotar",
  "guion",
  "semana",
  "clasificar",
] as const
export type KairosAiPurpose = (typeof KAIROS_AI_PURPOSES)[number]
/** Los mismos valores que la solicitud de la web (`saas_waitlist_request`). */
export const SAAS_CLIENT_PROFESSIONALS = ["1", "2-3", "4-9", "10+"] as const
export const SAAS_CLIENT_TOOLS = ["nada", "cuaderno_excel", "otro_software"] as const

/** Una frase del resumen de Kairós con su fuente (actividad, solicitud, correo…). */
export interface SaasClientSummarySource {
  text: string
  source: string
}

/** Un adjunto de un correo entrante: solo se guarda, nunca se abre ni va al modelo. */
export interface SaasInboundAttachment {
  filename: string
  contentType: string
  size: number
  fileId: string | null
}

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

/**
 * La clínica con la que Sallca tiene una relación, desde el primer contacto
 * (una solicitud de la web, una llamada, un referido) y para siempre: si
 * abre su cuenta, `organization_id` la liga (una organización, un cliente).
 * Las demos para presentar nunca son clientes. Archivada sale de las listas
 * pero no se borra. `created_by` nulo es el sistema o Kairós.
 */
export const saasClient = adminSchema.table(
  "saas_client",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    product: text("product").notNull(),
    /** ISO 3166-1 alfa-2. */
    countryCode: char("country_code", { length: 2 }).notNull().default("PE"),
    city: text("city"),
    professionals: text("professionals"),
    currentTool: text("current_tool"),
    origin: text("origin").notNull().default("otro"),
    originDetail: text("origin_detail"),
    referredByClientId: uuid("referred_by_client_id").references((): AnyPgColumn => saasClient.id, {
      onDelete: "set null",
    }),
    /** Responsable. */
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: text("archived_by").references(() => user.id),
    /** «Lo que hay que saber», de Kairós: cada frase con su fuente en `summary_sources`. */
    summary: text("summary"),
    summarySources: jsonb("summary_sources").$type<SaasClientSummarySource[]>(),
    summaryAt: timestamp("summary_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("saas_client_org_uidx").on(table.organizationId),
    index("saas_client_product_idx").on(table.product),
    index("saas_client_owner_idx").on(table.ownerUserId),
    index("saas_client_name_idx").on(sql`lower(${table.name})`),
    check("saas_client_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 160`),
    check("saas_client_product_check", oneOf(table.product, SAAS_CLIENT_PRODUCTS)),
    check("saas_client_country_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check("saas_client_city_check", sql`${table.city} IS NULL OR length(${table.city}) <= 120`),
    check(
      "saas_client_professionals_check",
      sql`${table.professionals} IS NULL OR ${oneOf(table.professionals, SAAS_CLIENT_PROFESSIONALS)}`,
    ),
    check(
      "saas_client_tool_check",
      sql`${table.currentTool} IS NULL OR ${oneOf(table.currentTool, SAAS_CLIENT_TOOLS)}`,
    ),
    check("saas_client_origin_check", oneOf(table.origin, SAAS_CLIENT_ORIGINS)),
    check(
      "saas_client_origin_detail_check",
      sql`${table.originDetail} IS NULL OR length(${table.originDetail}) <= 300`,
    ),
    check(
      "saas_client_referred_check",
      sql`${table.referredByClientId} IS DISTINCT FROM ${table.id}`,
    ),
  ],
)

/**
 * Una persona de la clínica: quién decide, quién la usa, quién paga. Al
 * trasladar una solicitud, sus papeles quedan por confirmar
 * (`roles_confirmed = false`). Un principal por cliente. Se liga a un usuario
 * solo por correo exacto y con el sí de una persona, nunca por teléfono.
 */
export const saasClientContact = adminSchema.table(
  "saas_client_contact",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => saasClient.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Cargo. */
    title: text("title"),
    roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
    rolesConfirmed: boolean("roles_confirmed").notNull().default(true),
    /** E.164. */
    phone: text("phone"),
    /** En minúsculas. */
    email: text("email"),
    preferredChannel: text("preferred_channel"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("saas_client_contact_primary_uidx")
      .on(table.clientId)
      .where(sql`${table.isPrimary}`),
    uniqueIndex("saas_client_contact_user_uidx")
      .on(table.clientId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index("saas_client_contact_email_idx").on(table.email),
    check("saas_client_contact_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 160`),
    check(
      "saas_client_contact_title_check",
      sql`${table.title} IS NULL OR length(${table.title}) <= 120`,
    ),
    check(
      "saas_client_contact_roles_check",
      sql`${table.roles} <@ ARRAY[${sql.raw(SAAS_CONTACT_ROLES.map((role) => `'${role}'`).join(","))}]::text[]`,
    ),
    check(
      "saas_client_contact_phone_check",
      sql`${table.phone} IS NULL OR ${table.phone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      "saas_client_contact_email_check",
      sql`${table.email} IS NULL OR (${table.email} = lower(${table.email}) AND length(${table.email}) BETWEEN 3 AND 254)`,
    ),
    check(
      "saas_client_contact_channel_check",
      sql`${table.preferredChannel} IS NULL OR ${oneOf(table.preferredChannel, SAAS_CONTACT_CHANNELS)}`,
    ),
  ],
)

/**
 * Lo que hay que hacer con un cliente, para un día de Lima (`due_on`) y, si
 * hay hora, `due_at`. Kairós pone tareas (`by_kairos`) con una clave por regla
 * y día (`kairos_key`) para no repetirlas.
 */
export const saasTask = adminSchema.table(
  "saas_task",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => saasClient.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** Día civil de Lima. */
    dueOn: date("due_on").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => saasClientContact.id, { onDelete: "set null" }),
    demoId: uuid("demo_id").references(() => saasDemo.id, { onDelete: "set null" }),
    status: text("status").notNull().default("abierta"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    byKairos: boolean("by_kairos").notNull().default(false),
    kairosKey: text("kairos_key"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: text("done_by").references(() => user.id),
    doneNote: text("done_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("saas_task_kairos_key_uidx").on(table.kairosKey),
    index("saas_task_status_due_idx").on(table.status, table.dueOn),
    index("saas_task_client_status_idx").on(table.clientId, table.status),
    index("saas_task_assignee_status_idx").on(table.assigneeUserId, table.status),
    check("saas_task_kind_check", oneOf(table.kind, SAAS_TASK_KINDS)),
    check("saas_task_status_check", oneOf(table.status, SAAS_TASK_STATUSES)),
    check("saas_task_title_check", sql`length(trim(${table.title})) BETWEEN 1 AND 200`),
    check(
      "saas_task_done_note_check",
      sql`${table.doneNote} IS NULL OR length(${table.doneNote}) <= 2000`,
    ),
  ],
)

/**
 * La venta a un cliente: abierta mientras no hay decisión. Una abierta por
 * cliente; las decididas quedan como historia («oportunidades anteriores»).
 * `no_por_ahora` dice cuándo volver; `perdido` y `no_por_ahora`, por qué;
 * `entro` no lleva motivo.
 */
export const saasOpportunity = adminSchema.table(
  "saas_opportunity",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => saasClient.id, { onDelete: "cascade" }),
    sellerId: uuid("seller_id").references(() => saasSeller.id, { onDelete: "set null" }),
    expectedOn: date("expected_on"),
    decision: text("decision"),
    reason: text("reason"),
    reasonDetail: text("reason_detail"),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    returnOn: date("return_on"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("saas_opportunity_open_uidx")
      .on(table.clientId)
      .where(sql`${table.decision} IS NULL`),
    index("saas_opportunity_client_idx").on(table.clientId, table.createdAt),
    check(
      "saas_opportunity_decision_check",
      sql`(${table.decision} IS NULL) = (${table.decidedAt} IS NULL)
        AND (${table.decision} IS NULL OR ${oneOf(table.decision, SAAS_OPPORTUNITY_DECISIONS)})
        AND (${table.reason} IS NULL OR ${oneOf(table.reason, SAAS_LOST_REASONS)})
        AND (${table.decision} IS DISTINCT FROM 'no_por_ahora' OR ${table.returnOn} IS NOT NULL)
        AND (${table.decision} IS NULL OR ${table.decision} = 'entro' OR ${table.reason} IS NOT NULL)
        AND (${table.decision} IS DISTINCT FROM 'entro' OR (${table.reason} IS NULL AND ${table.reasonDetail} IS NULL))`,
    ),
    check(
      "saas_opportunity_reason_detail_check",
      sql`${table.reasonDetail} IS NULL OR length(${table.reasonDetail}) <= 500`,
    ),
  ],
)

/**
 * Una propuesta con sus condiciones: plan, precio de lista congelado, descuento
 * (y cuántos meses dura), prueba, ciclo y vigencia. Numerada por cliente
 * (`version`). Enviada, sus condiciones no cambian y solo pasa a aceptada o no
 * aceptada (`saas_proposal_guard`). «Vencida» se calcula. Pasar del descuento
 * del vendedor la deja `por_aprobar` hasta que una persona de Administración
 * la aprueba (`approved_by`).
 */
export const saasProposal = adminSchema.table(
  "saas_proposal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => saasClient.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => saasOpportunity.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => saasPlan.id),
    /** Unidad menor de `currency` (ISO 4217). */
    listPriceCents: integer("list_price_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Puntos básicos: 1000 = 10 %. */
    discountBps: integer("discount_bps").notNull().default(0),
    /** Cuántos meses dura el descuento; nulo, mientras dure la suscripción. */
    discountMonths: integer("discount_months"),
    trialDays: integer("trial_days"),
    trialCreditCents: integer("trial_credit_cents"),
    billingCycle: text("billing_cycle").notNull().default("mensual"),
    validUntil: date("valid_until").notNull(),
    status: text("status").notNull().default("borrador"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => user.id),
    acceptedNote: text("accepted_note"),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("saas_proposal_version_uidx").on(table.clientId, table.version),
    index("saas_proposal_status_idx").on(table.status, table.validUntil),
    check("saas_proposal_status_check", oneOf(table.status, SAAS_PROPOSAL_STATUSES)),
    check("saas_proposal_version_check", sql`${table.version} >= 1`),
    check(
      "saas_proposal_money_check",
      sql`${table.listPriceCents} >= 0 AND ${table.currency} ~ '^[A-Z]{3}$'
        AND (${table.trialCreditCents} IS NULL OR ${table.trialCreditCents} >= 0)`,
    ),
    check(
      "saas_proposal_discount_check",
      sql`${table.discountBps} BETWEEN 0 AND 9000 AND (${table.discountMonths} IS NULL OR ${table.discountMonths} BETWEEN 1 AND 36)`,
    ),
    check(
      "saas_proposal_trial_check",
      sql`${table.trialDays} IS NULL OR ${table.trialDays} BETWEEN 0 AND 365`,
    ),
    check("saas_proposal_cycle_check", oneOf(table.billingCycle, SAAS_PROPOSAL_BILLING_CYCLES)),
    check(
      "saas_proposal_note_check",
      sql`${table.acceptedNote} IS NULL OR length(${table.acceptedNote}) <= 1000`,
    ),
  ],
)

/**
 * Lo que preparó Kairós y espera el sí de una persona: un mensaje, una
 * propuesta, un dato, un vínculo… Kairós nunca envía ni decide solo. Vence a
 * las 48 h; si el cliente cambió desde que se preparó (`expected_state`),
 * queda `vencida` y se vuelve a preparar. `idempotency_key` evita prepararlo
 * dos veces. `admin_only`: lo que Soporte no ve.
 */
export const kairosItem = adminSchema.table(
  "kairos_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id").references(() => saasClient.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** Por qué lo preparó. */
    reason: text("reason").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    expectedState: jsonb("expected_state").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("espera"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    adminOnly: boolean("admin_only").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("kairos_item_idempotency_uidx").on(table.idempotencyKey),
    index("kairos_item_status_idx").on(table.status, table.expiresAt),
    index("kairos_item_client_idx").on(table.clientId, table.status),
    check("kairos_item_kind_check", oneOf(table.kind, KAIROS_ITEM_KINDS)),
    check("kairos_item_status_check", oneOf(table.status, KAIROS_ITEM_STATUSES)),
    check(
      "kairos_item_text_check",
      sql`length(trim(${table.title})) BETWEEN 1 AND 200 AND length(trim(${table.reason})) BETWEEN 1 AND 1000`,
    ),
  ],
)

/**
 * Un mensaje a un cliente por correo o WhatsApp. El correo lo envía la ruta
 * después de reservarlo (`pendiente`) y queda `enviado` o `incierto`; nunca se
 * reintenta. El de WhatsApp sale por enlace y queda pendiente hasta que la
 * persona dice «Salió» o «No salió». Solo avanza de pendiente a enviado,
 * incierto o no salió, y de incierto a enviado o no salió; lo demás no cambia
 * (`saas_outreach_guard`).
 */
export const saasOutreach = adminSchema.table(
  "saas_outreach",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => saasClient.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => saasClientContact.id, { onDelete: "set null" }),
    channel: text("channel").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    proposalId: uuid("proposal_id").references(() => saasProposal.id, { onDelete: "set null" }),
    kairosItemId: uuid("kairos_item_id").references(() => kairosItem.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pendiente"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("saas_outreach_client_idx").on(table.clientId, table.createdAt),
    index("saas_outreach_status_idx").on(table.status),
    check("saas_outreach_channel_check", oneOf(table.channel, SAAS_OUTREACH_CHANNELS)),
    check("saas_outreach_status_check", oneOf(table.status, SAAS_OUTREACH_STATUSES)),
    check(
      "saas_outreach_text_check",
      sql`length(trim(${table.body})) BETWEEN 1 AND 5000 AND length(trim(${table.toAddress})) BETWEEN 3 AND 254
        AND (${table.subject} IS NULL OR length(${table.subject}) <= 200)`,
    ),
  ],
)

/**
 * Los archivos de un cliente en el bucket privado (`clients/<clientId>/…`):
 * carta, propuesta, presentación, lo que mandó la clínica. Lo de la clínica y lo que llega por correo se borra a los 30 días
 * (`delete_after`). Soporte no ve lo `admin_only`.
 */
export const saasClientFile = adminSchema.table(
  "saas_client_file",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => saasClient.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    adminOnly: boolean("admin_only").notNull().default(true),
    deleteAfter: date("delete_after"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    source: text("source"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("saas_client_file_object_uidx").on(table.objectKey),
    index("saas_client_file_client_idx").on(table.clientId, table.createdAt),
    index("saas_client_file_delete_idx").on(table.deleteAfter),
    check("saas_client_file_kind_check", oneOf(table.kind, SAAS_CLIENT_FILE_KINDS)),
    check(
      "saas_client_file_source_check",
      sql`${table.source} IS NULL OR ${oneOf(table.source, SAAS_CLIENT_FILE_SOURCES)}`,
    ),
    check(
      "saas_client_file_text_check",
      sql`length(trim(${table.filename})) BETWEEN 1 AND 255 AND ${table.sizeBytes} >= 0`,
    ),
  ],
)

/**
 * Un correo que llegó a soporte@ o contacto@ de un producto, firmado por el
 * worker de Cloudflare. Una vez por `message_id`. El cliente se busca por
 * correo exacto (contacto, solicitud, miembro) solo si el remitente está
 * verificado (`sender_verified`: DMARC, o SPF o DKIM alineados con el From,
 * según Cloudflare); si no, o si hay más de uno, queda sin cliente hasta que
 * una persona lo asigna (`matched_by_user`). El texto (`text_body`) se borra a
 * los 30 días de llegar, con los adjuntos.
 */
export const saasInboundEmail = adminSchema.table(
  "saas_inbound_email",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid("client_id").references(() => saasClient.id, { onDelete: "set null" }),
    mailbox: text("mailbox").notNull(),
    product: text("product").notNull(),
    messageId: text("message_id").notNull(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    textBody: text("text_body"),
    senderVerified: boolean("sender_verified").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    attachments: jsonb("attachments")
      .$type<SaasInboundAttachment[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    matchedBy: text("matched_by"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    matchedByUser: text("matched_by_user").references(() => user.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("saas_inbound_email_message_uidx").on(table.messageId),
    index("saas_inbound_email_client_idx").on(table.clientId, table.receivedAt),
    index("saas_inbound_email_from_idx").on(table.fromAddress),
    check("saas_inbound_email_mailbox_check", oneOf(table.mailbox, SAAS_INBOUND_MAILBOXES)),
    check("saas_inbound_email_product_check", oneOf(table.product, SAAS_CLIENT_PRODUCTS)),
    check(
      "saas_inbound_email_matched_check",
      sql`${table.matchedBy} IS NULL OR ${oneOf(table.matchedBy, SAAS_INBOUND_MATCHES)}`,
    ),
    check(
      "saas_inbound_email_text_check",
      sql`length(trim(${table.messageId})) BETWEEN 1 AND 998
        AND (${table.textBody} IS NULL OR length(${table.textBody}) <= 20000)
        AND (${table.subject} IS NULL OR length(${table.subject}) <= 998)`,
    ),
  ],
)

/**
 * Lo que gasta Kairós en el modelo: gasto de Sallca, sin clínica. `cost_micros`
 * nulo si el modelo no tiene precio conocido (nunca un precio supuesto).
 */
export const kairosAiUsage = adminSchema.table(
  "kairos_ai_usage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    clientId: uuid("client_id").references(() => saasClient.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("kairos_ai_usage_created_idx").on(table.createdAt),
    check("kairos_ai_usage_purpose_check", oneOf(table.purpose, KAIROS_AI_PURPOSES)),
    check(
      "kairos_ai_usage_tokens_check",
      sql`coalesce(${table.inputTokens}, 0) >= 0 AND coalesce(${table.outputTokens}, 0) >= 0
        AND coalesce(${table.cachedTokens}, 0) >= 0 AND coalesce(${table.costMicros}, 0) >= 0`,
    ),
  ],
)

/** Una cifra que cita el resumen de la semana: la pone el cálculo de los reportes, nunca el modelo. */
export interface KairosWeeklyFigure {
  label: string
  words: string
}

/**
 * El resumen de la semana que escribe Kairós para Reportes (solo
 * Administración): uno por semana, la del lunes `week_start` (día de Lima).
 * `figures` guarda las cifras que citó, tal como las dio el cálculo; el texto
 * solo las cita. Una semana escrita no se reescribe.
 */
export const kairosWeekly = adminSchema.table(
  "kairos_weekly",
  {
    weekStart: date("week_start", { mode: "string" }).primaryKey(),
    text: text("text").notNull(),
    figures: jsonb("figures").$type<KairosWeeklyFigure[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    check("kairos_weekly_monday_check", sql`extract(isodow from ${table.weekStart}) = 1`),
    check("kairos_weekly_text_check", sql`char_length(btrim(${table.text})) BETWEEN 1 AND 4000`),
  ],
)
