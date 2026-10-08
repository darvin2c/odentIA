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
import { user } from "./auth.js"
import { encounter, patient, serviceCatalog, treatmentPlanItem } from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"

/**
 * Especialidades y formularios clínicos por organización.
 *
 * - Las especialidades las crea cada organización (sin enum fijo): todo lo
 *   demás cuelga de `org_specialty`.
 * - Las plantillas de formulario y de consentimiento se versionan por filas
 *   nuevas (nunca se muta una versión publicada): los registros capturados
 *   guardan snapshot de versión + contenido para no alterarse.
 * - El odontograma NTS 188 sigue siendo la única fuente normativa de
 *   hallazgos dentales; estos formularios no lo reemplazan.
 */

/** Especialidad creada por la organización (p. ej. "Endodoncia"). */
export const orgSpecialty = pgTable(
  "org_specialty",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    /** Clave estable por organización (slug). */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("org_specialty_org_key_uidx").on(table.organizationId, table.key),
    index("org_specialty_org_active_idx").on(table.organizationId, table.isActive),
  ],
)

/** Profesionales (usuarios miembros) adscritos a una especialidad. */
export const professionalSpecialty = pgTable(
  "professional_specialty",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    specialtyId: uuid("specialty_id")
      .notNull()
      .references(() => orgSpecialty.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("professional_specialty_uidx").on(
      table.organizationId,
      table.specialtyId,
      table.userId,
    ),
    index("professional_specialty_org_user_idx").on(table.organizationId, table.userId),
  ],
)

/**
 * Registro profesional del miembro en la organización. Es la identidad con la
 * que firma atenciones, actas de odontograma, recetas y consentimientos: cada
 * documento guarda una instantánea, así que editarlo no reescribe lo firmado.
 */
export const professionalProfile = pgTable(
  "professional_profile",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    /** Nombre con el que firma; si falta se usa el de la cuenta. */
    signatureName: text("signature_name"),
    professionalTitle: text("professional_title").notNull().default("Cirujano dentista"),
    /** Colegio profesional que emite la colegiatura (COP en Perú). */
    registrationBody: text("registration_body").notNull().default("COP"),
    registrationNumber: text("registration_number"),
    /** Registro nacional de especialista, cuando corresponde. */
    specialtyRegistration: text("specialty_registration"),
    updatedBy: text("updated_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("professional_profile_org_user_uidx").on(table.organizationId, table.userId),
    check(
      "professional_profile_lengths_check",
      sql`length(${table.professionalTitle}) between 1 and 120 and length(${table.registrationBody}) between 1 and 40 and (${table.registrationNumber} is null or length(${table.registrationNumber}) between 1 and 20) and (${table.signatureName} is null or length(${table.signatureName}) between 1 and 200) and (${table.specialtyRegistration} is null or length(${table.specialtyRegistration}) between 1 and 40)`,
    ),
  ],
)

/** Prestaciones del tarifario vinculadas a una especialidad dinámica. */
export const serviceSpecialty = pgTable(
  "service_specialty",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    specialtyId: uuid("specialty_id")
      .notNull()
      .references(() => orgSpecialty.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => serviceCatalog.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("service_specialty_uidx").on(
      table.organizationId,
      table.specialtyId,
      table.serviceId,
    ),
    index("service_specialty_org_service_idx").on(table.organizationId, table.serviceId),
  ],
)

export const FORM_TEMPLATE_STATUSES = ["borrador", "publicado", "archivado"] as const

/**
 * Plantilla de formulario clínico versionada. Cada versión es una fila
 * (`key` + `version` únicos por organización); publicar crea una fila nueva
 * con el contenido congelado, nunca edita la publicada.
 */
export const clinicalFormTemplate = pgTable(
  "clinical_form_template",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    specialtyId: uuid("specialty_id").references(() => orgSpecialty.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("borrador"),
    /** Secciones con campos tipados: { sections: [{ id, title, fields: [...] }] }. */
    schema: jsonb("schema").notNull(),
    createdBy: text("created_by").references(() => user.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("clinical_form_template_org_key_version_uidx").on(
      table.organizationId,
      table.key,
      table.version,
    ),
    index("clinical_form_template_org_specialty_idx").on(table.organizationId, table.specialtyId),
    index("clinical_form_template_org_status_idx").on(table.organizationId, table.status),
    check(
      "clinical_form_template_status_check",
      sql`${table.status} in ('borrador','publicado','archivado')`,
    ),
    check("clinical_form_template_version_check", sql`${table.version} >= 1`),
  ],
)

export const FORM_RESPONSE_STATUSES = ["borrador", "finalizado"] as const

/**
 * Captura de un formulario por paciente/atención. Guarda snapshot de la
 * versión de plantilla usada para que republicar no altere registros previos.
 */
export const clinicalFormResponse = pgTable(
  "clinical_form_response",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    templateId: uuid("template_id")
      .notNull()
      .references(() => clinicalFormTemplate.id),
    templateVersion: integer("template_version").notNull(),
    /** Snapshot congelado del esquema vigente al responder. */
    templateSnapshot: jsonb("template_snapshot").notNull(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    professionalUserId: text("professional_user_id").references(() => user.id),
    status: text("status").notNull().default("borrador"),
    answers: jsonb("answers").notNull().default({}),
    authorUserId: text("author_user_id").references(() => user.id),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("clinical_form_response_org_patient_idx").on(table.organizationId, table.patientId),
    index("clinical_form_response_org_encounter_idx").on(table.organizationId, table.encounterId),
    index("clinical_form_response_org_template_idx").on(table.organizationId, table.templateId),
    check("clinical_form_response_status_check", sql`${table.status} in ('borrador','finalizado')`),
  ],
)

/** Adenda de un formulario finalizado (append-only, no muta la captura). */
export const clinicalFormAddendum = pgTable(
  "clinical_form_addendum",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    responseId: uuid("response_id")
      .notNull()
      .references(() => clinicalFormResponse.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("clinical_form_addendum_response_idx").on(table.responseId)],
)

export const CONSENT_TEMPLATE_STATUSES = ["borrador", "publicado", "archivado"] as const

/** Plantilla de consentimiento informado versionada (igual que formularios). */
export const consentTemplate = pgTable(
  "consent_template",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    specialtyId: uuid("specialty_id").references(() => orgSpecialty.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    /** Texto legal del consentimiento (versión congelada al publicar). */
    body: text("body").notNull(),
    /**
     * Secciones fijas (@odentia/clinical ConsentSections): procedimiento,
     * beneficios, riesgos, alternativas y consecuencias. Nulo en plantillas
     * anteriores de solo texto; `body` queda como su texto equivalente.
     */
    sections: jsonb("sections"),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("borrador"),
    createdBy: text("created_by").references(() => user.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("consent_template_org_key_version_uidx").on(
      table.organizationId,
      table.key,
      table.version,
    ),
    index("consent_template_org_specialty_idx").on(table.organizationId, table.specialtyId),
    index("consent_template_org_status_idx").on(table.organizationId, table.status),
    check(
      "consent_template_status_check",
      sql`${table.status} in ('borrador','publicado','archivado')`,
    ),
    check("consent_template_version_check", sql`${table.version} >= 1`),
  ],
)

export const CONSENT_STATUSES = ["pendiente", "firmado", "revocado", "anulado"] as const
export const CONSENT_SIGNER_KINDS = ["paciente", "representante"] as const

/**
 * Documento de consentimiento por procedimiento/plan. El documento aceptado
 * es inmutable: solo cambia `status` (firma/revocación) con historia en
 * `consent_event`. La firma es manuscrita (trazo capturado en el navegador);
 * no se afirma firma certificada ni valor de firma digital.
 */
export const consentDocument = pgTable(
  "consent_document",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    templateId: uuid("template_id")
      .notNull()
      .references(() => consentTemplate.id),
    templateVersion: integer("template_version").notNull(),
    /** Snapshot del texto aceptado (inmutable). */
    bodySnapshot: text("body_snapshot").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    /** Procedimiento o plan al que aplica (texto libre de referencia clínica). */
    procedureRef: text("procedure_ref"),
    signerKind: text("signer_kind").notNull().default("paciente"),
    signerName: text("signer_name").notNull(),
    signerDoc: text("signer_doc"),
    representativeRelation: text("representative_relation"),
    /**
     * Persona que firmó, cuando se eligió entre los vinculados al paciente (él
     * mismo o su representante legal vigente). Nulo en firmas anteriores. La FK
     * compuesta por organización vive en la migración.
     */
    signerContactId: uuid("signer_contact_id"),
    /** Trazo manuscrito capturado (JSON de trazos); sin biometría certificada. */
    signatureData: jsonb("signature_data"),
    status: text("status").notNull().default("pendiente"),
    authorUserId: text("author_user_id").references(() => user.id),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    /** Snapshot de las secciones aceptadas (inmutable). */
    sectionsSnapshot: jsonb("sections_snapshot"),
    /** CIE-10 que motiva el procedimiento. */
    diagnosisCode: text("diagnosis_code"),
    /** Profesional que informa: snapshot de su perfil y firma manuscrita. */
    informedAt: timestamp("informed_at", { withTimezone: true }),
    informedBy: text("informed_by").references(() => user.id),
    informerName: text("informer_name"),
    informerTitle: text("informer_title"),
    informerRegistration: text("informer_registration"),
    professionalSignature: jsonb("professional_signature"),
    /** La persona firmante confirmó haber comprendido la información. */
    comprehensionConfirmed: boolean("comprehension_confirmed").notNull().default(false),
    witnessName: text("witness_name"),
    witnessDoc: text("witness_doc"),
    /** Anulación de un pendiente (no cuenta como consentimiento). */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").references(() => user.id),
    cancelReason: text("cancel_reason"),
    /** Quien revoca (la persona firmante o su representante) y su firma. */
    revokerName: text("revoker_name"),
    revokerContactId: uuid("revoker_contact_id"),
    revokeSignature: jsonb("revoke_signature"),
    /** PDF del documento firmado guardado como documento clínico y su huella. */
    pdfDocumentId: uuid("pdf_document_id"),
    pdfSha256: text("pdf_sha256"),
    ...timestamps,
  },
  (table) => [
    index("consent_document_org_patient_idx").on(table.organizationId, table.patientId),
    index("consent_document_org_status_idx").on(table.organizationId, table.status),
    index("consent_document_org_template_idx").on(table.organizationId, table.templateId),
    check(
      "consent_document_status_check",
      sql`${table.status} in ('pendiente','firmado','revocado','anulado')`,
    ),
    check(
      "consent_document_signer_check",
      sql`${table.signerKind} in ('paciente','representante')`,
    ),
  ],
)

/** Historia de estados del consentimiento (append-only). */
export const consentEvent = pgTable(
  "consent_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    documentId: uuid("document_id")
      .notNull()
      .references(() => consentDocument.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("consent_event_document_idx").on(table.documentId)],
)

export const CLINICAL_ORDER_KINDS = ["laboratorio", "interconsulta"] as const
export const CLINICAL_ORDER_STATUSES = [
  "solicitado",
  "en_proceso",
  "completado",
  "cancelado",
] as const

/**
 * Orden de laboratorio o interconsulta. El destinatario es texto libre
 * (laboratorio o profesional externo) y la especialidad destino debe existir
 * en la organización: sin listas fijas.
 */
export const clinicalOrder = pgTable(
  "clinical_order",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").notNull(),
    specialtyId: uuid("specialty_id").references(() => orgSpecialty.id, {
      onDelete: "set null",
    }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    fromUserId: text("from_user_id").references(() => user.id),
    /** Destinatario: laboratorio o profesional (texto libre, sin catálogo fijo). */
    recipient: text("recipient").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    status: text("status").notNull().default("solicitado"),
    resultText: text("result_text"),
    resultAt: timestamp("result_at", { withTimezone: true }),
    completedBy: text("completed_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("clinical_order_org_patient_idx").on(table.organizationId, table.patientId),
    index("clinical_order_org_status_idx").on(table.organizationId, table.status),
    index("clinical_order_org_specialty_idx").on(table.organizationId, table.specialtyId),
    check("clinical_order_kind_check", sql`${table.kind} in ('laboratorio','interconsulta')`),
    check(
      "clinical_order_status_check",
      sql`${table.status} in ('solicitado','en_proceso','completado','cancelado')`,
    ),
  ],
)

export type OrgSpecialtyRow = typeof orgSpecialty.$inferSelect
export type ClinicalFormTemplateRow = typeof clinicalFormTemplate.$inferSelect
export type ClinicalFormResponseRow = typeof clinicalFormResponse.$inferSelect
export type ConsentTemplateRow = typeof consentTemplate.$inferSelect
export type ConsentDocumentRow = typeof consentDocument.$inferSelect
export type ClinicalOrderRow = typeof clinicalOrder.$inferSelect

// Referencia para que el barrel del padre no rompa si aún no re-exporta este archivo.
export const CLINICAL_FORMS_TABLES = [
  "org_specialty",
  "professional_specialty",
  "service_specialty",
  "clinical_form_template",
  "clinical_form_response",
  "clinical_form_addendum",
  "consent_template",
  "consent_document",
  "consent_event",
  "clinical_order",
] as const
