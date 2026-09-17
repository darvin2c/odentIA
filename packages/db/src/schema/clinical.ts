import type { BloodGroup, ContactRelationship, ProcedureCodingSnapshot, RegistrationAnswers, RegistrationEntryPoint, RegistrationRespondent } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
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
import { organization, user } from "./auth.js"
import { contact, conversation, orgFk, timestamps } from "./crm.js"
import { branch } from "./org.js"

/** Ficha clínica independiente de sus interlocutores y responsables CRM. */
export const patient = pgTable(
  "patient",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    displayName: text("display_name").notNull(),
    bloodGroup: text("blood_group").$type<BloodGroup>(),
    patientNumber: integer("patient_number").notNull(),
    docType: text("doc_type"),
    docNumber: text("doc_number"),
    birthDate: date("birth_date"),
    sex: text("sex"),
    phone: text("phone"),
    email: text("email"),
    avatarStorageKey: text("avatar_storage_key"),
    maritalStatus: text("marital_status"),
    educationLevel: text("education_level"),
    occupation: text("occupation"),
    address: text("address"),
    origin: text("origin"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    insuranceType: text("insurance_type"),
    insuranceDetail: text("insurance_detail"),
    referralSource: text("referral_source"),
    dataConsentAt: timestamp("data_consent_at", { withTimezone: true }),
    dataConsentBy: text("data_consent_by").references(() => user.id),
    registeredBranchId: uuid("registered_branch_id").references(() => branch.id),
    /** Revisión de antecedentes (agregado transaccional de salud). */
    healthRevision: integer("health_revision").notNull().default(0),
    healthReviewStatus: jsonb("health_review_status")
      .notNull()
      .default({ allergies: "unknown", conditions: "unknown", medications: "unknown" }),
    healthReviewedAt: timestamp("health_reviewed_at", { withTimezone: true }),
    healthReviewedBy: text("health_reviewed_by").references(() => user.id),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("patient_org_id_uidx").on(table.organizationId, table.id),
    check("patient_blood_group_check", sql`${table.bloodGroup} IS NULL OR ${table.bloodGroup} IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')`),
    uniqueIndex("patient_org_number_uidx").on(table.organizationId, table.patientNumber),
    uniqueIndex("patient_org_doc_uidx")
      .on(table.organizationId, table.docType, table.docNumber)
      .where(sql`"doc_number" IS NOT NULL`),
  ],
)

export const patientContact = pgTable("patient_contact", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  patientId: uuid("patient_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  relationship: text("relationship").$type<ContactRelationship>().notNull(),
  relationshipDetail: text("relationship_detail"),
  isPreferred: boolean("is_preferred").notNull().default(false),
  createdBy: text("created_by").references(() => user.id),
  ...timestamps,
}, table => [
  foreignKey({ columns: [table.organizationId, table.patientId], foreignColumns: [patient.organizationId, patient.id] }),
  foreignKey({ columns: [table.organizationId, table.contactId], foreignColumns: [contact.organizationId, contact.id] }),
  uniqueIndex("patient_contact_org_patient_contact_uidx").on(table.organizationId, table.patientId, table.contactId),
  uniqueIndex("patient_contact_self_patient_uidx").on(table.organizationId, table.patientId).where(sql`${table.relationship} = 'self'`),
  uniqueIndex("patient_contact_self_contact_uidx").on(table.organizationId, table.contactId).where(sql`${table.relationship} = 'self'`),
  uniqueIndex("patient_contact_preferred_uidx").on(table.organizationId, table.patientId).where(sql`${table.isPreferred}`),
  check("patient_contact_relationship_check", sql`${table.relationship} IN ('self','guardian','family','other')`),
  check("patient_contact_detail_check", sql`length(${table.relationshipDetail}) <= 100`),
])

export const patientRegistrationLink = pgTable("patient_registration_link", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  contactId: uuid("contact_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdBy: text("created_by").notNull().references(() => user.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("patient_registration_link_org_id_uidx").on(table.organizationId, table.id),
  uniqueIndex("patient_registration_link_token_uidx").on(table.tokenHash),
  foreignKey({ columns: [table.organizationId, table.contactId], foreignColumns: [contact.organizationId, contact.id] }),
  foreignKey({ columns: [table.organizationId, table.conversationId], foreignColumns: [conversation.organizationId, conversation.id] }),
])

export const patientRegistration = pgTable("patient_registration", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  patientId: uuid("patient_id").notNull(),
  submissionId: uuid("submission_id"),
  payloadHash: text("payload_hash"),
  entryPoint: text("entry_point").$type<RegistrationEntryPoint | "legacy">().notNull(),
  respondent: text("respondent").$type<RegistrationRespondent>(),
  actorUserId: text("actor_user_id").references(() => user.id),
  contextContactId: uuid("context_contact_id"),
  conversationId: uuid("conversation_id"),
  linkId: uuid("link_id"),
  formVersion: integer("form_version"),
  answers: jsonb("answers").$type<RegistrationAnswers | Record<string, never>>().notNull(),
  privacyNotice: text("privacy_notice"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("patient_registration_org_patient_uidx").on(table.organizationId, table.patientId),
  uniqueIndex("patient_registration_submission_uidx").on(table.organizationId, table.submissionId).where(sql`${table.submissionId} IS NOT NULL`),
  foreignKey({ columns: [table.organizationId, table.patientId], foreignColumns: [patient.organizationId, patient.id] }),
  foreignKey({ columns: [table.organizationId, table.contextContactId], foreignColumns: [contact.organizationId, contact.id] }),
  foreignKey({ columns: [table.organizationId, table.conversationId], foreignColumns: [conversation.organizationId, conversation.id] }),
  foreignKey({ columns: [table.organizationId, table.linkId], foreignColumns: [patientRegistrationLink.organizationId, patientRegistrationLink.id] }),
  check("patient_registration_entry_check", sql`${table.entryPoint} IN ('platform','public_link','qr','conversation','legacy')`),
  check("patient_registration_respondent_check", sql`${table.respondent} IS NULL OR ${table.respondent} IN ('patient','representative','staff')`),
])

/** Correlativos por organización (patient → HC-000123; futuros comprobantes). */
export const orgCounter = pgTable(
  "org_counter",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    key: text("key").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.key] })],
)

export const patientAllergy = pgTable(
  "patient_allergy",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    substance: text("substance").notNull(),
    reaction: text("reaction"),
    severity: text("severity").notNull().default("moderada"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [index("patient_allergy_org_patient_idx").on(table.organizationId, table.patientId)],
)

export const patientCondition = pgTable(
  "patient_condition",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("activa"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [index("patient_condition_org_patient_idx").on(table.organizationId, table.patientId)],
)

export const patientMedication = pgTable(
  "patient_medication",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dose: text("dose"),
    frequency: text("frequency"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_medication_org_patient_idx").on(table.organizationId, table.patientId),
  ],
)

/** Snapshot versionado de la entrevista (append-only, sin updatedAt). */
export const patientAnamnesis = pgTable(
  "patient_anamnesis",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    answers: jsonb("answers").notNull(),
    createdBy: text("created_by")
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("patient_anamnesis_patient_version_uidx").on(table.patientId, table.version),
    index("patient_anamnesis_org_patient_idx").on(table.organizationId, table.patientId),
  ],
)

/** Evolución por consulta (append-only, sin updatedAt). */
export const clinicalNote = pgTable(
  "clinical_note",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id),
    note: text("note").notNull(),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    kind: text("kind").notNull().default("evolucion"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("clinical_note_org_patient_created_idx").on(
      table.organizationId,
      table.patientId,
      table.createdAt,
    ),
  ],
)

/** Documentos/consentimientos (append-only, blob en S3). */
export const patientDocument = pgTable(
  "patient_document",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    label: text("label").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: text("uploaded_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("patient_document_org_patient_idx").on(table.organizationId, table.patientId)],
)

/** Odontograma FDI NTS 188-MINSA/DGIESP-2022 por pieza/superficie (append-only).
 * Los hallazgos nuevos usan status='recorded'; la anulación es una corrección
 * auditable (voidedAt/voidedBy/voidReason + proyección status='voided') que
 * NUNCA muta condition/surface/note. needsReview=true marca filas migradas
 * del catálogo anterior (legacyData conserva el objeto original) excluidas
 * del dibujo normativo hasta su revisión clínica. */
export const odontogramEntry = pgTable(
  "odontogram_entry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    toothNumber: smallint("tooth_number").notNull(),
    surface: text("surface"),
    condition: text("condition").notNull(),
    status: text("status").notNull().default("recorded"),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    note: text("note"),
    details: jsonb("details").notNull().default({}),
    needsReview: boolean("needs_review").notNull().default(false),
    legacyData: jsonb("legacy_data"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    createdBy: text("created_by").references(() => user.id),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    ...timestamps,
  },
  (table) => [
    index("odontogram_entry_org_patient_tooth_idx").on(
      table.organizationId,
      table.patientId,
      table.toothNumber,
    ),
  ],
)

/**
 * Acta de odontograma NTS 188: snapshot inmutable de los hallazgos activos al
 * sellar, con firma manuscrita capturada (trazos normalizados 0..100, NO se
 * afirma firma digital certificada), datos del examinador y propósito.
 * Append-only sin updatedAt; la inmutabilidad es regla de servicio y REVOKE
 * a nivel DB. El snapshot `entries` siempre lo calcula el servidor.
 */
export const odontogramAssessment = pgTable(
  "odontogram_assessment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id),
    purpose: text("purpose").notNull(),
    specifications: text("specifications").notNull(),
    observations: text("observations").notNull(),
    examinerName: text("examiner_name").notNull(),
    registrationNumber: text("registration_number").notNull(),
    patientName: text("patient_name").notNull(),
    patientNumber: integer("patient_number").notNull(),
    signature: jsonb("signature").notNull(),
    signatureKind: text("signature_kind").notNull().default("captured_handwritten"),
    entries: jsonb("entries").notNull(),
    standard: text("standard").notNull().default("NTS 188-MINSA/DGIESP-2022"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("odontogram_assessment_org_patient_idx").on(table.organizationId, table.patientId),
  ],
)

/**
 * Atención/encuentro clínico. Borrador editable; al finalizar queda cerrado
 * (la inmutabilidad es regla de servicio; correcciones posteriores = adendas
 * en clinical_note con kind='adenda'). Un solo borrador por paciente.
 */
export const encounter = pgTable(
  "encounter",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branch.id),
    dentistUserId: text("dentist_user_id")
      .notNull()
      .references(() => user.id),
    status: text("status").notNull().default("borrador"),
    reason: text("reason"),
    evolution: text("evolution"),
    indications: text("indications"),
    nextStep: text("next_step"),
    examination: jsonb("examination"),
    nextAppointmentAt: timestamp("next_appointment_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: text("finalized_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("encounter_org_patient_idx").on(table.organizationId, table.patientId),
    uniqueIndex("encounter_patient_open_uidx").on(table.patientId).where(sql`status = 'borrador'`),
  ],
)

/** Piezas dentales involucradas en una atención. */
export const encounterTooth = pgTable(
  "encounter_tooth",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounter.id, { onDelete: "cascade" }),
    toothNumber: smallint("tooth_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("encounter_tooth_encounter_tooth_uidx").on(table.encounterId, table.toothNumber),
  ],
)

/** Sistemas de codificación de procedimientos (catálogo global, SIN org_id, SIN RLS). */
export const procedureCodeSystem = pgTable("procedure_code_system", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  publisher: text("publisher").notNull(),
  country: char("country", { length: 2 }),
  license: text("license").notNull(),
  sourceUrl: text("source_url").notNull(),
})

/**
 * Códigos de procedimiento por sistema y versión (global, SIN org_id, SIN RLS,
 * solo lectura en runtime como cie10_code). La versión es la del publicador
 * (p. ej. RM-550-2023-MINSA para CPMS), nunca un correlativo interno.
 */
export const procedureCode = pgTable(
  "procedure_code",
  {
    systemKey: text("system_key")
      .notNull()
      .references(() => procedureCodeSystem.key),
    code: text("code").notNull(),
    version: text("version").notNull(),
    display: text("display").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    replacedBy: text("replaced_by"),
  },
  (table) => [
    primaryKey({ columns: [table.systemKey, table.code, table.version] }),
    index("procedure_code_system_code_idx").on(table.systemKey, table.code),
  ],
)
/**
 * Ediciones importadas del catálogo oficial (una fila por sistema y versión).
 * Global, SIN org_id, SIN RLS, solo lectura en runtime como cie10_code. La
 * versión es la del publicador (p. ej. RM-550-2023-MINSA para CPMS), nunca un
 * correlativo interno. `isCurrent` marca la edición vigente por sistema
 * (índice parcial único): el seed solo activa la edición importada y jamás
 * reactiva versiones anteriores. `scope` describe el ámbito extraído de la
 * estructura oficial (p. ej. secciones 1.3+2.7) y `expectedCount` las filas
 * oficiales del ámbito para conciliar cobertura en el seed.
 */
export const procedureCatalogRelease = pgTable(
  "procedure_catalog_release",
  {
    systemKey: text("system_key")
      .notNull()
      .references(() => procedureCodeSystem.key),
    version: text("version").notNull(),
    scope: text("scope").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    expectedCount: integer("expected_count").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.systemKey, table.version] }),
    uniqueIndex("procedure_catalog_release_current_uidx")
      .on(table.systemKey)
      .where(sql`"is_current"`),
  ],
)

/** Biblioteca global de prestaciones (solo lectura para el rol app, como cie10_code). */
export const treatmentTemplate = pgTable(
  "treatment_template",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    name: text("name").notNull(),
    specialty: text("specialty").notNull(),
    scope: text("scope").notNull(),
    surfaceCountMin: integer("surface_count_min"),
    surfaceCountMax: integer("surface_count_max"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
  },
  (table) => [uniqueIndex("treatment_template_key_uidx").on(table.key)],
)

/**
 * Proyección 1:1 plantilla ↔ código oficial (global, SIN org_id, SIN RLS).
 * Cada plantilla es la proyección de UN código oficial (key
 * `cpms:<version>:<code>`) y cada código tiene UNA plantilla: los únicos
 * garantizan que ninguna plantilla tenga mappings múltiples ni ningún código
 * dos plantillas. Sin equivalencias aproximadas ni denominaciones inventadas:
 * el nombre de la plantilla es la denominación oficial íntegra.
 * El precio nunca vive aquí: solo en `service_catalog`/presupuestos.
 */
export const treatmentTemplateCode = pgTable(
  "treatment_template_code",
  {
    templateId: uuid("template_id")
      .notNull()
      .references(() => treatmentTemplate.id, { onDelete: "cascade" }),
    systemKey: text("system_key").notNull(),
    code: text("code").notNull(),
    version: text("version").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.systemKey, table.code, table.version] }),
    foreignKey({
      columns: [table.systemKey, table.code, table.version],
      foreignColumns: [procedureCode.systemKey, procedureCode.code, procedureCode.version],
    }),
    index("treatment_template_code_reverse_idx").on(table.systemKey, table.code, table.version),
    uniqueIndex("treatment_template_code_template_uidx").on(table.templateId),
    uniqueIndex("treatment_template_code_code_uidx").on(table.systemKey, table.code, table.version),
  ],
)

/** Oferta organizacional de tratamientos y tarifas (recurso /services). */
export const serviceCatalog = pgTable(
  "service_catalog",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    templateId: uuid("template_id").references(() => treatmentTemplate.id),
    source: text("source").notNull().default("custom"),
    code: text("code"),
    name: text("name").notNull(),
    specialty: text("specialty"),
    scope: text("scope"),
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }).notNull().default("PEN"),
    durationMin: integer("duration_min"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("service_catalog_org_code_uidx")
      .on(table.organizationId, table.code)
      .where(sql`"code" IS NOT NULL`),
    index("service_catalog_org_active_idx").on(table.organizationId, table.isActive),
    index("service_catalog_org_specialty_idx").on(table.organizationId, table.specialty),
    index("service_catalog_template_idx").on(table.templateId),
  ],
)
/** Procedimiento realizado durante una atención; puede cerrar un ítem del plan. */
export const encounterProcedure = pgTable("encounter_procedure", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  encounterId: uuid("encounter_id")
    .notNull()
    .references(() => encounter.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").references(() => serviceCatalog.id),
  toothNumber: smallint("tooth_number"),
  scope: text("scope"),
  surfaces: text("surfaces").array().notNull().default([]),
  quadrant: smallint("quadrant"),
  arch: text("arch"),
  description: text("description").notNull(),
  diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
  planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
  codings: jsonb("codings").$type<ProcedureCodingSnapshot[]>().notNull().default([]),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/** Plan clínico longitudinal del paciente: existe antes que cualquier
 * presupuesto y puede continuar en múltiples visitas. `originEncounterId`
 * solo se informa en planes heredados (legado); los planes nuevos nacen
 * desde una atención borrador pero no se cierran con ella. */
export const treatmentPlan = pgTable(
  "treatment_plan",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    originEncounterId: uuid("origin_encounter_id").references(() => encounter.id),
    isLegacy: boolean("is_legacy").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [index("treatment_plan_org_patient_idx").on(table.organizationId, table.patientId)],
)
/** Cabecera del documento económico: siempre pertenece a un plan clínico.
 * `status`/`acceptedByName`/`decisionNote` conservan la máquina de estados
 * actual; el contenido cotizado vive en `treatment_budget_item` (snapshot),
 * no en un join mutable a la oferta vigente. */
export const treatmentBudget = pgTable(
  "treatment_budget",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => treatmentPlan.id),
    budgetNumber: integer("budget_number").notNull(),
    title: text("title").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("PEN"),
    status: text("status").notNull().default("borrador"),
    notes: text("notes"),
    acceptedByName: text("accepted_by_name"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => user.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("treatment_budget_org_number_uidx").on(table.organizationId, table.budgetNumber),
    index("treatment_budget_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_budget_org_plan_idx").on(table.organizationId, table.planId),
  ],
)
/** Indicación clínica del plan. `budgetId` es el presupuesto vigente (nullable:
 * sin presupuesto = decisión pendiente). La decisión se deriva de la línea
 * económica vigente, no de una columna propia. `sourceEncounterId` conserva
 * la atención de origen y nunca cambia. `serviceId` + título/precio/moneda
 * son snapshot de la oferta al indicar: el precio NUNCA se edita en el ítem. */
export const treatmentPlanItem = pgTable(
  "treatment_plan_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => treatmentPlan.id),
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    budgetId: uuid("budget_id").references(() => treatmentBudget.id),
    toothNumber: smallint("tooth_number"),
    scope: text("scope"),
    surfaces: text("surfaces").array().notNull().default([]),
    quadrant: smallint("quadrant"),
    arch: text("arch"),
    title: text("title").notNull(),
    detail: text("detail"),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    codings: jsonb("codings").$type<ProcedureCodingSnapshot[]>().notNull().default([]),
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }).notNull().default("PEN"),
    status: text("status").notNull().default("pendiente"),
    sourceEncounterId: uuid("source_encounter_id").references(() => encounter.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("treatment_plan_item_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_plan_item_org_service_idx").on(table.organizationId, table.serviceId),
    index("treatment_plan_item_org_budget_idx").on(table.organizationId, table.budgetId),
    index("treatment_plan_item_org_plan_idx").on(table.organizationId, table.planId),
  ],
)
/** Línea económica cotizada en un presupuesto: snapshot de lo realmente
 * cotizado (no un join mutable). UNIQUE(budgetId,planItemId). Append-only
 * tras presentar: solo `decision` cambia al decidir. */
export const treatmentBudgetItem = pgTable(
  "treatment_budget_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => treatmentPlan.id),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => treatmentBudget.id),
    planItemId: uuid("plan_item_id")
      .notNull()
      .references(() => treatmentPlanItem.id),
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    title: text("title").notNull(),
    scope: text("scope"),
    toothNumber: smallint("tooth_number"),
    surfaces: text("surfaces").array().notNull().default([]),
    quadrant: smallint("quadrant"),
    arch: text("arch"),
    codings: jsonb("codings").$type<ProcedureCodingSnapshot[]>().notNull().default([]),
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }).notNull().default("PEN"),
    decision: text("decision").notNull().default("pendiente"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("treatment_budget_item_budget_plan_uidx").on(table.budgetId, table.planItemId),
    index("treatment_budget_item_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_budget_item_org_budget_idx").on(table.organizationId, table.budgetId),
    index("treatment_budget_item_org_plan_idx").on(table.organizationId, table.planId),
  ],
)
/** Vínculo atención ↔ ítem del plan (creado al abrir atención o al registrar
 * procedimiento; conserva aunque el ítem quede realizado). PK compuesta. */
export const encounterPlanItem = pgTable(
  "encounter_plan_item",
  {
    organizationId: orgFk("organization_id"),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounter.id, { onDelete: "cascade" }),
    planItemId: uuid("plan_item_id")
      .notNull()
      .references(() => treatmentPlanItem.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.encounterId, table.planItemId] }),
    index("encounter_plan_item_plan_item_idx").on(table.planItemId),
  ],
)

/** Contexto versionado del documento (append-only): cada corrección agrega una
 * versión; las lecturas usan la vigente. Blob/original inmutables en
 * patient_document (sin encounterId/toothNumber: viven aquí). */
export const patientDocumentContext = pgTable(
  "patient_document_context",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => patientDocument.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    toothNumbers: smallint("tooth_numbers").array().notNull().default(sql`'{}'`),
    tags: text("tags").array().notNull().default(sql`'{}'`),
    authorUserId: text("author_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("patient_document_context_document_version_uidx").on(
      table.documentId,
      table.version,
    ),
    index("patient_document_context_org_patient_idx").on(table.organizationId, table.patientId),
    index("patient_document_context_document_idx").on(table.documentId),
  ],
)

/** Catálogo CIE-10 global (SIN org_id, SIN RLS, read-only en runtime). */
export const cie10Code = pgTable("cie10_code", {
  code: text("code").primaryKey(),
  description: text("description").notNull(),
})
