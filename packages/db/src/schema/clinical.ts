import type {
  BloodGroup,
  ContactRelationship,
  ProcedureCodingSnapshot,
  RegistrationAnswers,
  RegistrationEntryPoint,
  RegistrationRespondent,
} from "@odentia/clinical"
import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
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
import { appointment } from "./agenda.js"
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
    /** Nombre separado (ADR 0004); display_name se deriva de él en la base. */
    givenNames: text("given_names"),
    paternalSurname: text("paternal_surname"),
    maternalSurname: text("maternal_surname"),
    /** El nombre se separó por heurística al migrar: recepción debe confirmarlo. */
    identityNeedsReview: boolean("identity_needs_review").notNull().default(false),
    /** Valores anteriores que no encajaron en un catálogo (nunca se descartan). */
    identityLegacy: jsonb("identity_legacy"),
    bloodGroup: text("blood_group").$type<BloodGroup>(),
    patientNumber: integer("patient_number").notNull(),
    docType: text("doc_type"),
    docNumber: text("doc_number"),
    /** País emisor del documento y nacionalidad (ISO 3166-1 alfa-2). */
    docCountry: char("doc_country", { length: 2 }),
    nationality: char("nationality", { length: 2 }),
    birthDate: date("birth_date"),
    sex: text("sex"),
    phone: text("phone"),
    email: text("email"),
    avatarStorageKey: text("avatar_storage_key"),
    /** Ubigeo INEI del lugar de nacimiento y del domicilio. */
    birthPlaceUbigeo: char("birth_place_ubigeo", { length: 6 }),
    addressUbigeo: char("address_ubigeo", { length: 6 }),
    addressReference: text("address_reference"),
    insurerName: text("insurer_name"),
    affiliationNumber: text("affiliation_number"),
    emergencyContactRelationship: text("emergency_contact_relationship"),
    /** Clasificación del estado físico de la ASA (I–VI). */
    asaClass: text("asa_class"),
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
    check(
      "patient_blood_group_check",
      sql`${table.bloodGroup} IS NULL OR ${table.bloodGroup} IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')`,
    ),
    check(
      "patient_doc_type_check",
      sql`${table.docType} IS NULL OR ${table.docType} IN ('DNI','CE','PASAPORTE','CNV','DIE','OTRO')`,
    ),
    // ISO/IEC 5218: M=1, F=2, I(indeterminado)=9, D(desconocido)=0.
    check("patient_sex_check", sql`${table.sex} IS NULL OR ${table.sex} IN ('M','F','I','D')`),
    check(
      "patient_marital_status_check",
      sql`${table.maritalStatus} IS NULL OR ${table.maritalStatus} IN ('soltero','casado','conviviente','viudo','divorciado','separado')`,
    ),
    check(
      "patient_education_level_check",
      sql`${table.educationLevel} IS NULL OR ${table.educationLevel} IN ('sin_nivel','inicial','primaria_incompleta','primaria_completa','secundaria_incompleta','secundaria_completa','superior_no_universitaria_incompleta','superior_no_universitaria_completa','superior_universitaria_incompleta','superior_universitaria_completa','posgrado')`,
    ),
    check(
      "patient_asa_class_check",
      sql`${table.asaClass} IS NULL OR ${table.asaClass} IN ('I','II','III','IV','V','VI')`,
    ),
    uniqueIndex("patient_org_number_uidx").on(table.organizationId, table.patientNumber),
    uniqueIndex("patient_org_doc_uidx")
      .on(table.organizationId, table.docType, table.docNumber)
      .where(sql`"doc_number" IS NOT NULL`),
  ],
)

export const patientContact = pgTable(
  "patient_contact",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    relationship: text("relationship").$type<ContactRelationship>().notNull(),
    relationshipDetail: text("relationship_detail"),
    isPreferred: boolean("is_preferred").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }),
    uniqueIndex("patient_contact_org_patient_contact_uidx").on(
      table.organizationId,
      table.patientId,
      table.contactId,
    ),
    uniqueIndex("patient_contact_self_patient_uidx")
      .on(table.organizationId, table.patientId)
      .where(sql`${table.relationship} = 'self'`),
    uniqueIndex("patient_contact_self_contact_uidx")
      .on(table.organizationId, table.contactId)
      .where(sql`${table.relationship} = 'self'`),
    uniqueIndex("patient_contact_preferred_uidx")
      .on(table.organizationId, table.patientId)
      .where(sql`${table.isPreferred}`),
    check(
      "patient_contact_relationship_check",
      sql`${table.relationship} IN ('self','guardian','family','other')`,
    ),
    check("patient_contact_detail_check", sql`length(${table.relationshipDetail}) <= 100`),
  ],
)

export const patientRegistrationLink = pgTable(
  "patient_registration_link",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("patient_registration_link_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("patient_registration_link_token_uidx").on(table.tokenHash),
    foreignKey({
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversation.organizationId, conversation.id],
    }),
  ],
)

export const patientRegistration = pgTable(
  "patient_registration",
  {
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
  },
  (table) => [
    uniqueIndex("patient_registration_org_patient_uidx").on(table.organizationId, table.patientId),
    uniqueIndex("patient_registration_submission_uidx")
      .on(table.organizationId, table.submissionId)
      .where(sql`${table.submissionId} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.contextContactId],
      foreignColumns: [contact.organizationId, contact.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversation.organizationId, conversation.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.linkId],
      foreignColumns: [patientRegistrationLink.organizationId, patientRegistrationLink.id],
    }),
    check(
      "patient_registration_entry_check",
      sql`${table.entryPoint} IN ('platform','public_link','qr','conversation','legacy')`,
    ),
    check(
      "patient_registration_respondent_check",
      sql`${table.respondent} IS NULL OR ${table.respondent} IN ('patient','representative','staff')`,
    ),
  ],
)

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
    /** Tipo de alérgeno; nulo en registros anteriores o cuando no se precisó. */
    category: text("category"),
    reaction: text("reaction"),
    /** Sin valor por defecto: lo no declarado se guarda como «desconocida». */
    severity: text("severity").notNull(),
    /** Alergia (inmunológica) o intolerancia; criticidad y verificación como HL7 FHIR AllergyIntolerance. */
    kind: text("kind").notNull().default("alergia"),
    criticality: text("criticality"),
    verification: text("verification").notNull().default("no_confirmada"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_allergy_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_allergy_severity_check",
      sql`${table.severity} IN ('leve','moderada','severa','desconocida')`,
    ),
    check("patient_allergy_kind_check", sql`${table.kind} IN ('alergia','intolerancia')`),
    check(
      "patient_allergy_criticality_check",
      sql`${table.criticality} IS NULL OR ${table.criticality} IN ('baja','alta','no_evaluable')`,
    ),
    check(
      "patient_allergy_verification_check",
      sql`${table.verification} IN ('no_confirmada','confirmada','descartada')`,
    ),
    check(
      "patient_allergy_category_check",
      sql`${table.category} IS NULL OR ${table.category} IN ('medicamento','anestesico','material','alimento','ambiental','otro')`,
    ),
  ],
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
    /** Código CIE-10 cuando el clínico lo precisa; el nombre declarado se conserva. */
    cie10Code: text("cie10_code").references(() => cie10Code.code),
    status: text("status").notNull().default("activa"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_condition_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_condition_status_check",
      sql`${table.status} IN ('activa','resuelta','inactiva')`,
    ),
  ],
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
    /** Denominación común internacional (principio activo), si se conoce. */
    genericName: text("generic_name"),
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
    createdBy: text("created_by").references(() => user.id),
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
    /** Certeza del diagnóstico codificado: presuntivo, definitivo o repetido. */
    diagnosisType: text("diagnosis_type"),
    /** Pieza FDI a la que se refiere el diagnóstico, si aplica. */
    toothNumber: smallint("tooth_number"),
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
    check("clinical_note_kind_check", sql`${table.kind} IN ('evolucion','adenda')`),
    check(
      "clinical_note_diagnosis_type_check",
      sql`${table.diagnosisType} IS NULL OR (${table.diagnosisCode} IS NOT NULL AND ${table.diagnosisType} IN ('presuntivo','definitivo','repetido'))`,
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
    /** Subtipo de imagen diagnóstica (@odentia/clinical IMAGE_TYPES). */
    imageType: text("image_type"),
    /** Fecha de toma; la de subida es created_at. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    /** Origen: equipo, sala o centro externo. */
    source: text("source"),
    reportStatus: text("report_status"),
    /** Miniatura (WebP) generada al subir una imagen; nula en PDF y DICOM. */
    thumbnailKey: text("thumbnail_key"),
    // Retiro: el archivo nunca se borra; queda fuera de la galería con motivo y traza.
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: text("retired_by").references(() => user.id),
    retireReason: text("retire_reason"),
  },
  (table) => [
    index("patient_document_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_document_image_type_check",
      sql`${table.imageType} IS NULL OR (${table.category} = 'radiografia' AND ${table.imageType} IN ('periapical','bitewing','oclusal','panoramica','cefalometrica','tomografia')) OR (${table.category} = 'foto_clinica' AND ${table.imageType} IN ('foto_intraoral','foto_extraoral'))`,
    ),
    check(
      "patient_document_report_status_check",
      sql`${table.reportStatus} IS NULL OR ${table.reportStatus} IN ('pendiente','informado','no_requiere')`,
    ),
    check(
      "patient_document_source_check",
      sql`${table.source} IS NULL OR char_length(${table.source}) BETWEEN 1 AND 120`,
    ),
    check(
      "patient_document_retired_check",
      sql`(${table.retiredAt} IS NULL) = (${table.retireReason} IS NULL) AND (${table.retireReason} IS NULL OR char_length(${table.retireReason}) BETWEEN 1 AND 2000)`,
    ),
    check(
      "patient_document_category_check",
      sql`${table.category} IN ('consentimiento','radiografia','foto_clinica','informe','presupuesto','receta','comprobante_pago','otro')`,
    ),
  ],
)

/**
 * Bitácora de consultas a la historia clínica: quién abrió qué parte de la
 * ficha de quién. Append-only; una fila por usuario, paciente, recurso y hora
 * para dejar traza sin registrar cada petición de la misma lectura.
 */
export const clinicalAccessLog = pgTable(
  "clinical_access_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    /** Parte de la ficha consultada (subruta clínica normalizada). */
    resource: text("resource").notNull(),
    /** Inicio de la hora en que ocurrió la consulta. */
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
    hits: integer("hits").notNull().default(1),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
    }),
    uniqueIndex("clinical_access_log_bucket_uidx").on(
      table.organizationId,
      table.patientId,
      table.userId,
      table.resource,
      table.bucket,
    ),
    index("clinical_access_log_org_patient_idx").on(
      table.organizationId,
      table.patientId,
      table.lastAt,
    ),
  ],
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
    /**
     * Hallazgo tratado: el tratamiento indicado para él se realizó. Resolver no
     * es anular: el hallazgo estuvo vigente hasta esa fecha.
     */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedByPlanItemId: uuid("resolved_by_plan_item_id").references(
      (): AnyPgColumn => treatmentPlanItem.id,
    ),
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
    /** Cita que motivó la atención; nula en atenciones sin cita o históricas. */
    appointmentId: uuid("appointment_id"),
    reason: text("reason"),
    /** Relato de la enfermedad actual y su tiempo (NTS 139: anamnesis de la consulta). */
    presentIllness: text("present_illness"),
    illnessDuration: text("illness_duration"),
    /** Signos vitales con claves de @odentia/clinical (LOINC y UCUM). */
    vitals: jsonb("vitals"),
    evolution: text("evolution"),
    indications: text("indications"),
    nextStep: text("next_step"),
    prognosis: text("prognosis"),
    /** Exámenes auxiliares solicitados o con resultado. */
    auxiliaryExams: text("auxiliary_exams"),
    examination: jsonb("examination"),
    nextAppointmentAt: timestamp("next_appointment_at", { withTimezone: true }),
    /** Hora de inicio declarada (por defecto, al abrir). */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** Hora de fin declarada al cerrar. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: text("finalized_by").references(() => user.id),
    /** Instantánea de la firma del profesional al cerrar (nombre, título y colegiatura). */
    signerName: text("signer_name"),
    signerTitle: text("signer_title"),
    signerRegistration: text("signer_registration"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    ...timestamps,
  },
  (table) => [
    index("encounter_org_patient_idx").on(table.organizationId, table.patientId),
    uniqueIndex("encounter_patient_open_uidx").on(table.patientId).where(sql`status = 'borrador'`),
    uniqueIndex("encounter_appointment_active_uidx")
      .on(table.organizationId, table.appointmentId)
      .where(sql`appointment_id IS NOT NULL AND status <> 'anulada'`),
    foreignKey({
      columns: [table.organizationId, table.patientId, table.appointmentId],
      foreignColumns: [appointment.organizationId, appointment.patientId, appointment.id],
      name: "encounter_appointment_fk",
    }),
    check("encounter_status_check", sql`${table.status} IN ('borrador','finalizada','anulada')`),
    check(
      "encounter_void_check",
      sql`(${table.status} = 'anulada') = (${table.voidedAt} IS NOT NULL) AND (${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)`,
    ),
    check(
      "encounter_end_check",
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
  ],
)

/**
 * Diagnóstico registrado en una atención: CIE-10 con tipo HIS (presuntivo,
 * definitivo o repetido) y sitio dental. Se anula en borrador con motivo; el
 * estado activo/resuelto alimenta la lista de problemas del paciente.
 */
export const encounterDiagnosis = pgTable(
  "encounter_diagnosis",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    /** Nulo solo en diagnósticos históricos registrados fuera de una atención. */
    encounterId: uuid("encounter_id").references(() => encounter.id),
    cie10Code: text("cie10_code")
      .notNull()
      .references(() => cie10Code.code),
    /** Nulo solo en históricos migrados sin clasificar. */
    diagnosisType: text("diagnosis_type"),
    toothNumber: smallint("tooth_number"),
    surfaces: text("surfaces").array().notNull().default([]),
    note: text("note"),
    status: text("status").notNull().default("activo"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Nota de evolución de la que proviene un diagnóstico histórico. */
    legacyNoteId: uuid("legacy_note_id").references((): AnyPgColumn => clinicalNote.id),
    createdBy: text("created_by").references(() => user.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
      name: "encounter_diagnosis_patient_fk",
    }),
    index("encounter_diagnosis_org_patient_idx").on(table.organizationId, table.patientId),
    index("encounter_diagnosis_encounter_idx").on(table.organizationId, table.encounterId),
    uniqueIndex("encounter_diagnosis_legacy_note_uidx")
      .on(table.legacyNoteId)
      .where(sql`legacy_note_id IS NOT NULL`),
    check(
      "encounter_diagnosis_type_check",
      sql`(${table.diagnosisType} IS NULL AND ${table.legacyNoteId} IS NOT NULL) OR ${table.diagnosisType} IN ('presuntivo','definitivo','repetido')`,
    ),
    check("encounter_diagnosis_status_check", sql`${table.status} IN ('activo','resuelto')`),
    check(
      "encounter_diagnosis_void_check",
      sql`(${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)`,
    ),
    check(
      "encounter_diagnosis_origin_check",
      sql`${table.encounterId} IS NOT NULL OR ${table.legacyNoteId} IS NOT NULL`,
    ),
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
    // Todo servicio tiene tarifa explícita (>= 0; 0 = incluido sin costo).
    priceCents: integer("price_cents").notNull(),
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
    check("service_catalog_price_check", sql`${table.priceCents} >= 0`),
  ],
)
/** Procedimiento de una sesión; completar la indicación es una decisión explícita. */
export const encounterProcedure = pgTable(
  "encounter_procedure",
  {
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
    /** Unidades del acto (p. ej. 3 sellantes); el cargo es precio × cantidad. */
    quantity: smallint("quantity").notNull().default(1),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    // Snapshot del costo al registrar el acto (tarifario o ítem del plan);
    // el acto libre (sin servicio) no tiene precio y nunca genera cargo.
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }),
    codings: jsonb("codings").$type<ProcedureCodingSnapshot[]>().notNull().default([]),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Anulación en borrador: el acto queda en la traza, sin cargo ni sesión. */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    check("encounter_procedure_quantity_check", sql`${table.quantity} BETWEEN 1 AND 99`),
    check(
      "encounter_procedure_void_check",
      sql`(${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)`,
    ),
    check(
      "encounter_procedure_price_check",
      sql`${table.priceCents} IS NULL OR ${table.priceCents} >= 0`,
    ),
    check(
      "encounter_procedure_price_currency_check",
      sql`(${table.priceCents} IS NULL) = (${table.currency} IS NULL)`,
    ),
  ],
)

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

/** Alternativas excluyentes para un mismo problema clínico. */
export const treatmentOptionGroup = pgTable(
  "treatment_option_group",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => treatmentPlan.id),
    title: text("title").notNull(),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("treatment_option_group_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_option_group_org_plan_idx").on(table.organizationId, table.planId),
  ],
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
    revisionNumber: integer("revision_number").notNull().default(1),
    supersedesBudgetId: uuid("supersedes_budget_id").references(
      (): AnyPgColumn => treatmentBudget.id,
    ),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    decisionContactId: uuid("decision_contact_id").references(() => contact.id),
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
    uniqueIndex("treatment_budget_org_number_uidx").on(
      table.organizationId,
      table.budgetNumber,
      table.revisionNumber,
    ),
    check(
      "treatment_budget_status_check",
      sql`${table.status} IN ('borrador','presentado','aceptado','parcial','rechazado','pospuesto','cancelado','sustituido','historico')`,
    ),
    check("treatment_budget_revision_check", sql`${table.revisionNumber} > 0`),
    index("treatment_budget_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_budget_org_plan_idx").on(table.organizationId, table.planId),
  ],
)
/** Indicación longitudinal: decisión vigente propia, propuesta y oferta snapshot.
 * La atención de origen y las versiones económicas conservan la evidencia histórica. */
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
    optionGroupId: uuid("option_group_id").references(() => treatmentOptionGroup.id),
    supersedesItemId: uuid("supersedes_item_id").references(
      (): AnyPgColumn => treatmentPlanItem.id,
    ),
    /** Hallazgo del odontograma que motivó la indicación (trazabilidad clínica explícita). */
    odontogramEntryId: uuid("odontogram_entry_id").references(() => odontogramEntry.id),
    isRecommended: boolean("is_recommended").notNull().default(false),
    decisionStatus: text("decision_status").notNull().default("pendiente"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByContactId: uuid("decided_by_contact_id").references(() => contact.id),
    decidedByName: text("decided_by_name"),
    statusReason: text("status_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
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
    /** Fase del plan (urgencia → mantenimiento); la propone la especialidad. */
    phase: text("phase").notNull().default("basica"),
    /** Orden de ejecución dentro del plan y la fase. */
    sortOrder: integer("sort_order").notNull().default(0),
    /** Sesiones previstas; las hechas son sus procedimientos no anulados. */
    plannedSessions: smallint("planned_sessions").notNull().default(1),
    sourceEncounterId: uuid("source_encounter_id").references(() => encounter.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("treatment_plan_item_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "treatment_plan_item_phase_check",
      sql`${table.phase} IN ('urgencia','basica','quirurgica','rehabilitadora','mantenimiento')`,
    ),
    check(
      "treatment_plan_item_planned_sessions_check",
      sql`${table.plannedSessions} BETWEEN 1 AND 60`,
    ),
    index("treatment_plan_item_org_service_idx").on(table.organizationId, table.serviceId),
    index("treatment_plan_item_org_budget_idx").on(table.organizationId, table.budgetId),
    index("treatment_plan_item_org_plan_idx").on(table.organizationId, table.planId),
    check(
      "treatment_plan_item_status_check",
      sql`${table.status} IN ('pendiente','programado','en_curso','suspendido','realizado','cancelado','reemplazado')`,
    ),
    check(
      "treatment_plan_item_decision_status_check",
      sql`${table.decisionStatus} IN ('pendiente','aceptado','pospuesto','rechazado','reemplazado')`,
    ),
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
    budgetId: uuid("budget_id").references(() => treatmentBudget.id),
    encounterProcedureId: uuid("encounter_procedure_id").references(() => encounterProcedure.id),
    prescriptionId: uuid("prescription_id").references(() => prescription.id),
    followUpId: uuid("follow_up_id").references(() => clinicalFollowUp.id),
    paymentId: uuid("payment_id").references(() => patientPayment.id),
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

/**
 * Ubigeo del INEI (departamento, provincia y distrito). Catálogo global sin
 * organización ni RLS, como CIE-10: se carga desde la fuente oficial.
 */
export const ubigeo = pgTable(
  "ubigeo",
  {
    code: char("code", { length: 6 }).primaryKey(),
    department: text("department").notNull(),
    province: text("province"),
    district: text("district"),
  },
  (table) => [
    check("ubigeo_code_check", sql`${table.code} ~ '^[0-9]{6}$'`),
    index("ubigeo_department_idx").on(table.department),
  ],
)

/**
 * Consentimiento para el tratamiento de datos personales (Ley 29733): por
 * versión del aviso, con sus finalidades, quién lo otorga y su revocación.
 */
export const patientDataConsent = pgTable(
  "patient_data_consent",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    noticeVersion: integer("notice_version").notNull(),
    noticeText: text("notice_text").notNull(),
    /** Finalidades aceptadas: atencion (siempre), recordatorios, comunicaciones. */
    purposes: text("purposes").array().notNull(),
    /** Persona que otorga: el paciente o su representante legal. */
    grantedByContactId: uuid("granted_by_contact_id").references(() => contact.id),
    grantedByName: text("granted_by_name").notNull(),
    channel: text("channel").notNull(),
    recordedBy: text("recorded_by").references(() => user.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    index("patient_data_consent_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_data_consent_channel_check",
      sql`${table.channel} IN ('presencial','formulario_publico','portal')`,
    ),
    check(
      "patient_data_consent_revoke_check",
      sql`(${table.revokedAt} IS NULL) = (${table.revokeReason} IS NULL)`,
    ),
  ],
)

/** Antecedentes familiares por parentesco y condición (CIE-10 opcional). */
export const patientFamilyHistory = pgTable(
  "patient_family_history",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    condition: text("condition").notNull(),
    cie10Code: text("cie10_code").references(() => cie10Code.code),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_family_history_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_family_history_relationship_check",
      sql`${table.relationship} IN ('madre','padre','hijo','conyuge','hermano','abuelo','tio','otro_familiar')`,
    ),
  ],
)

/** Controles longitudinales; una cita programada no equivale a un control realizado. */
export const clinicalFollowUp = pgTable(
  "clinical_follow_up",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    encounterProcedureId: uuid("encounter_procedure_id").references(() => encounterProcedure.id),
    originEncounterId: uuid("origin_encounter_id").references(() => encounter.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pendiente"),
    appointmentId: uuid("appointment_id"),
    legacyScheduledAt: timestamp("legacy_scheduled_at", { withTimezone: true }),
    completedEncounterId: uuid("completed_encounter_id").references(() => encounter.id),
    outcome: text("outcome"),
    cancelledReason: text("cancelled_reason"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId, table.appointmentId],
      foreignColumns: [appointment.organizationId, appointment.patientId, appointment.id],
      name: "clinical_follow_up_appointment_fk",
    }),
    index("clinical_follow_up_appointment_idx").on(table.organizationId, table.appointmentId),
    check(
      "clinical_follow_up_reservation_check",
      sql`${table.status} <> 'programado' OR ${table.appointmentId} IS NOT NULL`,
    ),
    index("clinical_follow_up_org_patient_idx").on(table.organizationId, table.patientId),
    index("clinical_follow_up_item_idx").on(table.organizationId, table.planItemId),
    index("clinical_follow_up_due_idx").on(table.organizationId, table.dueAt),
    check("clinical_follow_up_kind_check", sql`${table.kind} IN ('tratamiento','mantenimiento')`),
    check(
      "clinical_follow_up_status_check",
      sql`${table.status} IN ('pendiente','programado','realizado','cancelado')`,
    ),
    check(
      "clinical_follow_up_treatment_check",
      sql`${table.kind} <> 'tratamiento' OR ${table.planItemId} IS NOT NULL`,
    ),
  ],
)

export const DICTATION_KINDS = ["nota", "diagnostico", "plan", "control"] as const
export type DictationKind = (typeof DICTATION_KINDS)[number]

/**
 * Sugerencia del asistente clínico a partir de lo que dictó el odontólogo.
 * No es parte de la historia: es un borrador de un registro que solo existe
 * cuando el odontólogo que lleva la atención lo confirma, con la misma
 * operación y las mismas validaciones que si lo escribiera. `por_revisar`:
 * falta algo que solo una persona puede elegir (una prestación, un código).
 * Guarda el fragmento dictado que la originó, no el dictado completo.
 */
export const encounterDictationSuggestion = pgTable(
  "encounter_dictation_suggestion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounter.id, { onDelete: "cascade" }),
    dentistUserId: text("dentist_user_id")
      .notNull()
      .references(() => user.id),
    kind: text("kind").$type<DictationKind>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Lo que dijo el odontólogo y dio lugar a la sugerencia. */
    sourceText: text("source_text").notNull().default(""),
    status: text("status").notNull().default("lista"),
    /** Por qué hay que revisarla antes de confirmar. */
    note: text("note"),
    /** Registro que creó al confirmarse (diagnóstico, indicación o control). */
    entityId: uuid("entity_id"),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("encounter_dictation_suggestion_idx").on(table.organizationId, table.encounterId, table.status),
    check("encounter_dictation_suggestion_kind_check", sql`${table.kind} IN ('nota','diagnostico','plan','control')`),
    check(
      "encounter_dictation_suggestion_status_check",
      sql`${table.status} IN ('lista','por_revisar','confirmada','descartada')`,
    ),
  ],
)

export const prescription = pgTable(
  "prescription",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    prescriptionNumber: integer("prescription_number").notNull(),
    status: text("status").notNull().default("emitida"),
    notes: text("notes"),
    /** Diagnóstico que justifica la receta y fecha hasta la que es válida. */
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    validUntil: date("valid_until"),
    /** Instantánea de quien prescribe (perfil profesional al emitir). */
    prescriberName: text("prescriber_name"),
    prescriberTitle: text("prescriber_title"),
    prescriberRegistration: text("prescriber_registration"),
    issuedBy: text("issued_by").references(() => user.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").references(() => user.id),
    cancelReason: text("cancel_reason"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("prescription_org_number_uidx").on(table.organizationId, table.prescriptionNumber),
    index("prescription_org_patient_idx").on(table.organizationId, table.patientId),
    index("prescription_encounter_idx").on(table.organizationId, table.encounterId),
    index("prescription_item_idx").on(table.organizationId, table.planItemId),
    check("prescription_status_check", sql`${table.status} IN ('emitida','anulada')`),
  ],
)

export const prescriptionItem = pgTable(
  "prescription_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescription.id, { onDelete: "cascade" }),
    medicationName: text("medication_name").notNull(),
    /** Denominación Común Internacional, concentración y forma farmacéutica. */
    genericName: text("generic_name"),
    brandName: text("brand_name"),
    strength: text("strength"),
    dosageForm: text("dosage_form"),
    /** Código ATC de la OMS cuando la DCI es conocida. */
    atcCode: text("atc_code"),
    dose: text("dose").notNull(),
    route: text("route").notNull(),
    frequency: text("frequency").notNull(),
    duration: text("duration").notNull(),
    quantity: integer("quantity"),
    instructions: text("instructions"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("prescription_item_org_patient_idx").on(table.organizationId, table.patientId),
    index("prescription_item_prescription_idx").on(table.prescriptionId),
    check(
      "prescription_item_quantity_check",
      sql`${table.quantity} IS NULL OR ${table.quantity} > 0`,
    ),
  ],
)

/** Cargos, pagos y aplicaciones se corrigen por anulación, nunca por borrado. */
export const patientCharge = pgTable(
  "patient_charge",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    budgetItemId: uuid("budget_item_id").references(() => treatmentBudgetItem.id),
    encounterProcedureId: uuid("encounter_procedure_id").references(() => encounterProcedure.id),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("patient_charge_org_patient_idx").on(table.organizationId, table.patientId),
    index("patient_charge_item_idx").on(table.organizationId, table.planItemId),
    index("patient_charge_budget_item_idx").on(table.organizationId, table.budgetItemId),
    check("patient_charge_amount_check", sql`${table.amountCents} > 0`),
  ],
)

export const patientPayment = pgTable(
  "patient_payment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    payerContactId: uuid("payer_contact_id").references(() => contact.id),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    method: text("method").notNull(),
    reference: text("reference"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("patient_payment_org_patient_idx").on(table.organizationId, table.patientId),
    check("patient_payment_amount_check", sql`${table.amountCents} > 0`),
    check(
      "patient_payment_method_check",
      sql`${table.method} IN ('efectivo','tarjeta','transferencia','yape','plin','otro')`,
    ),
  ],
)

export const patientPaymentApplication = pgTable(
  "patient_payment_application",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => patientPayment.id),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => patientCharge.id),
    amountCents: integer("amount_cents").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("payment_application_org_patient_idx").on(table.organizationId, table.patientId),
    index("payment_application_payment_idx").on(table.organizationId, table.paymentId),
    index("payment_application_charge_idx").on(table.organizationId, table.chargeId),
    check("payment_application_amount_check", sql`${table.amountCents} > 0`),
  ],
)

export const patientPaymentRefund = pgTable(
  "patient_payment_refund",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => patientPayment.id),
    amountCents: integer("amount_cents").notNull(),
    refundedAt: timestamp("refunded_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payment_refund_org_patient_idx").on(table.organizationId, table.patientId),
    index("payment_refund_payment_idx").on(table.organizationId, table.paymentId),
    check("payment_refund_amount_check", sql`${table.amountCents} > 0`),
  ],
)

export const patientResponsibility = pgTable(
  "patient_responsibility",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    contactId: uuid("contact_id").notNull(),
    kind: text("kind").notNull(),
    startsAt: date("starts_at").notNull(),
    endsAt: date("ends_at"),
    evidenceDocumentId: uuid("evidence_document_id").references(() => patientDocument.id),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    foreignKey({
      name: "patient_responsibility_contact_fk",
      columns: [table.organizationId, table.patientId, table.contactId],
      foreignColumns: [
        patientContact.organizationId,
        patientContact.patientId,
        patientContact.contactId,
      ],
    }),
    index("patient_responsibility_org_patient_idx").on(table.organizationId, table.patientId),
    uniqueIndex("patient_responsibility_active_uidx")
      .on(table.organizationId, table.patientId, table.contactId, table.kind)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "patient_responsibility_kind_check",
      sql`${table.kind} IN ('representante_legal','autorizado_informacion','responsable_economico','acompanante')`,
    ),
    check(
      "patient_responsibility_dates_check",
      sql`${table.endsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`,
    ),
  ],
)
