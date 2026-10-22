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
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
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
import { catalogSchema } from "./schemas.js"

/**
 * Listas de diagnósticos (ADR 0041): CIE-10 y CIE-11 de la OMS y, preparadas
 * sin cargar, las nacionales. Globales, SIN org_id, SIN RLS y de solo lectura
 * para la aplicación; las carga `seed:diagnoses` con el rol owner.
 */
export const diagnosisCodeSystem = catalogSchema.table("diagnosis_code_system", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  publisher: text("publisher").notNull(),
  country: char("country", { length: 2 }),
  uri: text("uri").notNull(),
})

/**
 * Cada archivo cargado de una lista: su edición, de dónde salió, su SHA-256 y
 * su licencia. `official` es falso en las semillas de desarrollo, que no son
 * la lista oficial.
 */
export const diagnosisCodeRelease = catalogSchema.table(
  "diagnosis_code_release",
  {
    systemKey: text("system_key")
      .notNull()
      .references(() => diagnosisCodeSystem.key),
    edition: text("edition").notNull(),
    official: boolean("official").notNull(),
    license: text("license").notNull(),
    sourceUrl: text("source_url"),
    sourceSha256: text("source_sha256"),
    codeCount: integer("code_count").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.systemKey, table.edition] }),
    check("diagnosis_code_release_sha_check", sql`${table.sourceSha256} IS NULL OR ${table.sourceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
)

/**
 * Un código de una lista: (lista, código), con la edición de la que viene,
 * su título y, en la CIE-11, su URI. `searchText` es el código y el título sin
 * tildes ni mayúsculas (índice de trigramas) e `isCategory` marca las
 * categorías con subcódigos, que no se registran como diagnóstico. Qué
 * capítulos van primero lo dice el producto (ADR 0079). Nunca se borra un código: los diagnósticos lo
 * referencian.
 */
export const diagnosisCatalog = catalogSchema.table(
  "diagnosis_code",
  {
    systemKey: text("system_key")
      .notNull()
      .references(() => diagnosisCodeSystem.key),
    code: text("code").notNull(),
    edition: text("edition").notNull(),
    title: text("title").notNull(),
    uri: text("uri"),
    isCategory: boolean("is_category").notNull().default(false),
    searchText: text("search_text").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.systemKey, table.code] }),
    foreignKey({
      columns: [table.systemKey, table.edition],
      foreignColumns: [diagnosisCodeRelease.systemKey, diagnosisCodeRelease.edition],
      name: "diagnosis_code_release_fk",
    }),
  ],
)

/**
 * Lista y código de un diagnóstico guardado: la FK compuesta al catálogo y
 * que los dos vayan juntos.
 */
export function diagnosisCodeRef(
  name: string,
  table: { diagnosisSystem: AnyPgColumn; diagnosisCode: AnyPgColumn },
) {
  return [
    foreignKey({
      columns: [table.diagnosisSystem, table.diagnosisCode],
      foreignColumns: [diagnosisCatalog.systemKey, diagnosisCatalog.code],
      name: `${name}_diagnosis_fk`,
    }),
    check(
      `${name}_diagnosis_pair_check`,
      sql`(${table.diagnosisSystem} IS NULL) = (${table.diagnosisCode} IS NULL)`,
    ),
  ]
}

/** Ficha clínica independiente de sus interlocutores y responsables CRM. */
export const patient = pgTable(
  "patient",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    /**
     * La persona que es este paciente (ADR 0001 y 0044): su identidad —nombre,
     * documento, nacimiento, sexo, teléfono, correo y si está archivada— vive
     * solo en ella. La base mantiene su vínculo `self` en `patient_contact`.
     */
    personId: uuid("person_id").notNull(),
    bloodGroup: text("blood_group").$type<BloodGroup>(),
    patientNumber: integer("patient_number").notNull(),
    /** Nacionalidad (ISO 3166-1 alfa-2). */
    nationality: char("nationality", { length: 2 }),
    avatarStorageKey: text("avatar_storage_key"),
    /** Lugar de nacimiento: país (ISO 3166-1 alfa-2) y ciudad o localidad escrita. */
    birthCountry: char("birth_country", { length: 2 }),
    birthPlace: text("birth_place"),
    /** Referencia del domicilio («frente al parque»): solo en clínicas de Perú. */
    addressReference: text("address_reference"),
    insurerName: text("insurer_name"),
    affiliationNumber: text("affiliation_number"),
    /** Clasificación del estado físico de la ASA (I–VI). */
    asaClass: text("asa_class"),
    maritalStatus: text("marital_status"),
    educationLevel: text("education_level"),
    occupation: text("occupation"),
    /**
     * Domicilio internacional (HL7 FHIR Address): calle y número en `address`,
     * localidad (`city`), nivel intermedio (`district`, la provincia en Perú),
     * región (`state`: código ISO 3166-2 si el país tiene lista, o escrita),
     * código postal y país (ISO 3166-1 alfa-2).
     */
    address: text("address"),
    addressCity: text("address_city"),
    addressDistrict: text("address_district"),
    addressRegion: text("address_region"),
    addressPostalCode: text("address_postal_code"),
    addressCountry: char("address_country", { length: 2 }),
    /** «Procedencia»: dato censal que solo se pide en clínicas de Perú. */
    origin: text("origin"),
    /** Tipo general del seguro (`INSURANCE_TYPES`), igual en todos los países. */
    insuranceType: text("insurance_type"),
    /** Régimen con nombre propio del país (SIS, EsSalud, EPS en Perú), si lo tiene. */
    insuranceScheme: text("insurance_scheme"),
    /**
     * «Cómo nos conoció», de una lista fija (`REFERRAL_KINDS` de
     * `@odentia/clinical`, decisión 3 de Reportes v2). `referral_source` es lo
     * que dijo cuando es «otro»; con otra opción va vacío.
     */
    referralKind: text("referral_kind"),
    referralSource: text("referral_source"),
    registeredBranchId: uuid("registered_branch_id").references(() => branch.id),
    /** Revisión de antecedentes (agregado transaccional de salud). */
    healthRevision: integer("health_revision").notNull().default(0),
    healthReviewStatus: jsonb("health_review_status")
      .notNull()
      .default({ allergies: "unknown", conditions: "unknown", medications: "unknown" }),
    healthReviewedAt: timestamp("health_reviewed_at", { withTimezone: true }),
    healthReviewedBy: text("health_reviewed_by").references(() => user.id),
    /**
     * Última vez que alguien revisó sus alergias con el paciente («Sin
     * cambios», agregar o quitar una; tablero 7). Pasados 6 meses, la atención
     * pide preguntarle si tiene alergias nuevas.
     */
    allergiesReviewedAt: timestamp("allergies_reviewed_at", { withTimezone: true }),
    allergiesReviewedBy: text("allergies_reviewed_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("patient_org_id_uidx").on(table.organizationId, table.id),
    // Una persona tiene a lo sumo una ficha, siempre de su misma organización.
    uniqueIndex("patient_org_person_uidx").on(table.organizationId, table.personId),
    foreignKey({
      name: "patient_person_fk",
      columns: [table.organizationId, table.personId],
      foreignColumns: [contact.organizationId, contact.id],
    }),
    check(
      "patient_blood_group_check",
      sql`${table.bloodGroup} IS NULL OR ${table.bloodGroup} IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')`,
    ),
    check(
      "patient_insurance_type_check",
      sql`${table.insuranceType} IS NULL OR ${table.insuranceType} IN ('PUBLICO','PRIVADO','PARTICULAR','OTRO')`,
    ),
    check(
      "patient_insurance_scheme_check",
      sql`${table.insuranceScheme} IS NULL OR (${table.insuranceType} IS NOT NULL AND char_length(${table.insuranceScheme}) BETWEEN 1 AND 20)`,
    ),
    check(
      "patient_address_lengths_check",
      sql`(${table.addressCity} IS NULL OR char_length(${table.addressCity}) BETWEEN 1 AND 100) AND (${table.addressDistrict} IS NULL OR char_length(${table.addressDistrict}) BETWEEN 1 AND 100) AND (${table.addressRegion} IS NULL OR char_length(${table.addressRegion}) BETWEEN 1 AND 100) AND (${table.addressPostalCode} IS NULL OR char_length(${table.addressPostalCode}) BETWEEN 1 AND 20) AND (${table.birthPlace} IS NULL OR char_length(${table.birthPlace}) BETWEEN 1 AND 200)`,
    ),
    check(
      "patient_marital_status_check",
      // HL7 v3 MaritalStatus o la palabra de un país con su prefijo ISO («PE:conviviente»).
      sql`${table.maritalStatus} IS NULL OR ${table.maritalStatus} IN ('S','M','T','L','D','W') OR ${table.maritalStatus} ~ '^[A-Z]{2}:[a-z_]{1,40}$'`,
    ),
    check(
      "patient_education_level_check",
      // CINE (ISCED) 2011, niveles 0 a 8.
      sql`${table.educationLevel} IS NULL OR ${table.educationLevel} IN ('0','1','2','3','4','5','6','7','8')`,
    ),
    check(
      "patient_referral_kind_check",
      sql`${table.referralKind} IS NULL OR ${table.referralKind} IN ('recomendacion','redes_sociales','google_mapas','paso_por_aqui','convenio','otro')`,
    ),
    check("patient_referral_source_check", sql`${table.referralSource} IS NULL OR ${table.referralKind} = 'otro'`),
    check(
      "patient_asa_class_check",
      sql`${table.asaClass} IS NULL OR ${table.asaClass} IN ('I','II','III','IV','V','VI')`,
    ),
    uniqueIndex("patient_org_number_uidx").on(table.organizationId, table.patientNumber),
    // El documento es único en la persona (`contact_org_doc_uidx`).
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
    /** Parentesco con HL7 v3 RoleCode (`KINSHIP`), si se conoce. */
    kinship: text("kinship"),
    isPreferred: boolean("is_preferred").notNull().default(false),
    /**
     * Contacto de emergencia (decisión 25): una marca sobre una persona
     * vinculada, como `Patient.contact` con `relationship` C de HL7 v2-0131.
     * Nunca la propia persona.
     */
    isEmergency: boolean("is_emergency").notNull().default(false),
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
    check("patient_contact_emergency_check", sql`NOT (${table.isEmergency} AND ${table.relationship} = 'self')`),
    check(
      "patient_contact_kinship_check",
      sql`${table.kinship} IS NULL OR ${table.kinship} IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB','FRND','NBOR')`,
    ),
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
    /** Quién del equipo lo creó; vacío si lo emitió el sistema para un enlace de reserva. */
    createdBy: text("created_by").references(() => user.id),
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
    /** Cómo se escribió; elegida de la lista, su nombre en la lista. Nunca se reescribe al codificarla. */
    substance: text("substance").notNull(),
    /**
     * La sustancia en su lista (ADR 0072): ATC de la OMS para medicamentos y sus
     * grupos, o la lista propia de odentIA para lo demás. Sin código, «sin
     * codificar»: el aviso al recetar compara el texto.
     */
    substanceSystem: text("substance_system"),
    substanceCode: text("substance_code"),
    /** Tipo de alérgeno; nulo en registros anteriores o cuando no se precisó. */
    category: text("category"),
    reaction: text("reaction"),
    /** Sin valor por defecto: lo no declarado se guarda como «desconocida». */
    severity: text("severity").notNull(),
    /** Alergia (inmunológica) o intolerancia; criticidad y verificación como HL7 FHIR AllergyIntolerance. */
    kind: text("kind").notNull().default("alergia"),
    criticality: text("criticality"),
    verification: text("verification").notNull().default("no_confirmada"),
    /** Quién la dijo (FHIR `asserter`): el equipo al registrarla o el paciente en su formulario. */
    source: text("source").notNull().default("equipo"),
    isActive: boolean("is_active").notNull().default(true),
    /** Quitarla no la borra: queda en «Alergias quitadas» con quién, cuándo y por qué. */
    removedReason: text("removed_reason"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: text("removed_by").references(() => user.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_allergy_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_allergy_substance_system_check",
      sql`${table.substanceSystem} IS NULL OR ${table.substanceSystem} IN ('atc','odentia')`,
    ),
    check(
      "patient_allergy_substance_code_check",
      sql`(${table.substanceSystem} IS NULL) = (${table.substanceCode} IS NULL)`,
    ),
    check("patient_allergy_source_check", sql`${table.source} IN ('equipo','paciente')`),
    check(
      "patient_allergy_removed_reason_check",
      sql`${table.removedReason} IS NULL OR ${table.removedReason} IN ('ya_no','otra_cosa','error')`,
    ),
    // Una alergia vigente no tiene motivo de quitada.
    check(
      "patient_allergy_removed_check",
      sql`NOT (${table.isActive} AND ${table.removedReason} IS NOT NULL)`,
    ),
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
    /** Código de la lista de diagnósticos cuando el clínico lo precisa; el nombre declarado se conserva. */
    diagnosisSystem: text("diagnosis_system"),
    diagnosisCode: text("diagnosis_code"),
    status: text("status").notNull().default("activa"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_condition_org_patient_idx").on(table.organizationId, table.patientId),
    ...diagnosisCodeRef("patient_condition", table),
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
    /** Código ATC de la OMS cuando la DCI es de la lista; lo escrito a mano queda sin código. */
    atcCode: text("atc_code"),
    /** La dosis en palabras («500 mg»); con número y unidad UCUM también por separado. */
    dose: text("dose"),
    doseValue: numeric("dose_value", { precision: 10, scale: 3 }),
    doseUnit: text("dose_unit"),
    /** La frecuencia en palabras; elegida de la lista, también su código (`MEDICATION_FREQUENCIES`). */
    frequency: text("frequency"),
    frequencyCode: text("frequency_code"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_medication_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_medication_dose_unit_check",
      sql`${table.doseUnit} IS NULL OR ${table.doseUnit} IN ('mg','g','ug','mL','[iU]','{tbl}','{cap}','{drop}','{puff}')`,
    ),
    check(
      "patient_medication_frequency_code_check",
      sql`${table.frequencyCode} IS NULL OR ${table.frequencyCode} IN ('cada_8_h','cada_12_h','cada_24_h','segun_necesidad')`,
    ),
    check(
      "patient_medication_dose_check",
      sql`(${table.doseValue} IS NULL) = (${table.doseUnit} IS NULL) AND (${table.doseValue} IS NULL OR ${table.doseValue} > 0)`,
    ),
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
    // El diagnóstico es de la atención (`encounter_diagnosis`), no de una nota: una sola vía.
    /** Pieza FDI a la que se refiere la nota, si aplica. */
    // Sitio (ADR 0079): sistema, código y calificadores, como bodySite de FHIR.
    siteSystem: text("site_system"),
    siteCode: text("site_code"),
    siteQualifiers: text("site_qualifiers").array().notNull().default([]),
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
    /** Subtipo de imagen diagnóstica: sus valores los dice el producto (ADR 0079). */
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
      sql`${table.imageType} IS NULL OR ${table.category} IN ('radiografia','foto_clinica')`,
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
      // Los documentos que genera la clínica (presupuesto, receta, comprobante) no
      // se guardan como archivo: se leen de su registro.
      sql`${table.category} IN ('consentimiento','radiografia','foto_clinica','informe','otro')`,
    ),
  ],
)

/**
 * Bitácora de consultas a la historia clínica: quién abrió qué parte de la
 * ficha de quién. Append-only; una fila por usuario, paciente, recurso y hora
 * para dejar traza sin registrar cada petición de la misma lectura.
 *
 * Un solo índice: la clave primaria es la propia franja, con `bucket` antes
 * que `user_id` para servir también al listado por paciente. `last_at` y
 * `hits` quedan fuera de todo índice para que contar «una vez más» sea una
 * actualización HOT; `0001_base_reglas.sql` fija además `fillfactor = 90`, que
 * drizzle no declara en tablas.
 */
export const clinicalAccessLog = pgTable(
  "clinical_access_log",
  {
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
    primaryKey({
      name: "clinical_access_log_pkey",
      columns: [
        table.organizationId,
        table.patientId,
        table.bucket,
        table.userId,
        table.resource,
      ],
    }),
  ],
)

/**
 * Pedido de la persona sobre sus datos (issue 50, ADR 0080): una copia, una
 * corrección o no recibir mensajes. Lo pide la propia persona o su
 * representante legal (una persona vinculada al paciente); se responde en
 * `DATA_REQUEST_DAYS` días corridos desde el día siguiente, en cualquier país.
 * Pendiente → respondida o denegada; nada se borra.
 */
export const patientDataRequest = pgTable(
  "patient_data_request",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    kind: text("kind").notNull(),
    /** Quien lo pide: la propia persona o su representante legal. */
    requesterContactId: uuid("requester_contact_id").notNull(),
    /** Por dónde llegó el pedido. */
    channel: text("channel").notNull(),
    /** Día en que lo pidió y día límite para responder (en la zona de la clínica). */
    requestedOn: date("requested_on").notNull(),
    dueOn: date("due_on").notNull(),
    /** Lo que dijo, si se anotó. */
    said: text("said"),
    status: text("status").notNull().default("pendiente"),
    /** Cómo se comprobó que es ella o su representante; nunca por el teléfono. */
    verifiedHow: text("verified_how"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by").references(() => user.id),
    /** Qué se entregó o hizo, o por qué se denegó. */
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "patient_data_request_requester_fk",
      columns: [table.organizationId, table.patientId, table.requesterContactId],
      foreignColumns: [patientContact.organizationId, patientContact.patientId, patientContact.contactId],
    }),
    index("patient_data_request_org_patient_idx").on(table.organizationId, table.patientId),
    index("patient_data_request_org_pending_idx")
      .on(table.organizationId, table.dueOn)
      .where(sql`${table.status} = 'pendiente'`),
    check("patient_data_request_kind_check", sql`${table.kind} IN ('copia','corregir','mensajes')`),
    check(
      "patient_data_request_channel_check",
      sql`${table.channel} IN ('clinica','whatsapp','correo','portal')`,
    ),
    check(
      "patient_data_request_status_check",
      sql`${table.status} IN ('pendiente','respondida','denegada')`,
    ),
    check(
      "patient_data_request_verified_check",
      sql`${table.verifiedHow} IS NULL OR ${table.verifiedHow} IN ('documento','portal','representante')`,
    ),
    check(
      "patient_data_request_resolved_check",
      sql`(${table.status} = 'pendiente') = (${table.resolvedAt} IS NULL)`,
    ),
    check("patient_data_request_due_check", sql`${table.dueOn} >= ${table.requestedOn}`),
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
    professionalUserId: text("professional_user_id")
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
    prognosis: text("prognosis"),
    examination: jsonb("examination"),
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
    /**
     * Por qué se cerró con un consentimiento sin firmar (avisa sin bloquear,
     * decisión 3 de la fase 3). Historia como el resto: no cambia al cerrar.
     */
    consentSkipReason: text("consent_skip_reason"),
    ...timestamps,
  },
  (table) => [
    index("encounter_org_patient_idx").on(table.organizationId, table.patientId),
    uniqueIndex("encounter_org_patient_id_uidx").on(table.organizationId, table.patientId, table.id),
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
    check(
      "encounter_consent_skip_reason_check",
      sql`${table.consentSkipReason} IS NULL OR char_length(${table.consentSkipReason}) BETWEEN 1 AND 2000`,
    ),
  ],
)

/**
 * Diagnóstico registrado en una atención: lista y código (CIE-10 o CIE-11),
 * su certeza y sitio dental. Se anula en borrador con motivo; el
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
    diagnosisSystem: text("diagnosis_system").notNull(),
    diagnosisCode: text("diagnosis_code").notNull(),
    /**
     * HL7 FHIR Condition.verificationStatus: provisional («Presuntivo») o
     * confirmed («Definitivo»). Nulo solo en históricos migrados sin clasificar.
     */
    diagnosisType: text("diagnosis_type"),
    /**
     * «Ya diagnosticado antes» (decisión 11): la persona ya tenía este código,
     * en la misma lista, en otra atención. Lo marca el sistema al registrarlo.
     */
    previouslyDiagnosed: boolean("previously_diagnosed").notNull().default(false),
    // Sitio (ADR 0079): sistema, código y calificadores, como bodySite de FHIR.
    siteSystem: text("site_system"),
    siteCode: text("site_code"),
    siteQualifiers: text("site_qualifiers").array().notNull().default([]),
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
      sql`(${table.diagnosisType} IS NULL AND ${table.legacyNoteId} IS NOT NULL) OR ${table.diagnosisType} IN ('provisional','confirmed')`,
    ),
    ...diagnosisCodeRef("encounter_diagnosis", table),
    index("encounter_diagnosis_org_code_idx").on(
      table.organizationId,
      table.diagnosisSystem,
      table.diagnosisCode,
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

/** Sitios vistos en una atención (ADR 0079): piezas en odontología. */
export const encounterSite = pgTable(
  "encounter_site",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounter.id, { onDelete: "cascade" }),
    siteSystem: text("site_system").notNull(),
    siteCode: text("site_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("encounter_site_encounter_site_uidx").on(table.encounterId, table.siteSystem, table.siteCode),
  ],
)

/** Sistemas de codificación de procedimientos (catálogo global, SIN org_id, SIN RLS). */
export const procedureCodeSystem = catalogSchema.table("procedure_code_system", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  publisher: text("publisher").notNull(),
  country: char("country", { length: 2 }),
  license: text("license").notNull(),
  sourceUrl: text("source_url").notNull(),
})

/**
 * Códigos de procedimiento por sistema y versión (global, SIN org_id, SIN RLS,
 * solo lectura en runtime como diagnosis_code). La versión es la del publicador
 * (p. ej. RM-550-2023-MINSA para CPMS), nunca un correlativo interno.
 */
export const procedureCode = catalogSchema.table(
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
 * Global, SIN org_id, SIN RLS, solo lectura en runtime como diagnosis_code. La
 * versión es la del publicador (p. ej. RM-550-2023-MINSA para CPMS), nunca un
 * correlativo interno. `isCurrent` marca la edición vigente por sistema
 * (índice parcial único): el seed solo activa la edición importada y jamás
 * reactiva versiones anteriores. `scope` describe el ámbito extraído de la
 * estructura oficial (p. ej. secciones 1.3+2.7) y `expectedCount` las filas
 * oficiales del ámbito para conciliar cobertura en el seed.
 */
export const procedureCatalogRelease = catalogSchema.table(
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

/**
 * Biblioteca de odentIA (ADR 0069): tratamientos de consultorio con nombre
 * propio, iguales en todos los países. Global y de solo lectura para el rol
 * app. `kind` es el tipo de tratamiento (uso interno: fase del plan, palabras
 * del agente y qué especialidad del país lo recibe); la columna se sigue
 * llamando `specialty`. `product` dice de qué producto es (ADR 0079); lo
 * dental de cada uno (caras y lo que deja en la pieza) va en
 * `dental_template_rule`. `isCommon` lo pone en «Más usados». El precio nunca
 * vive aquí.
 */
export const treatmentTemplate = catalogSchema.table(
  "treatment_template",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("specialty").notNull(),
    scope: text("scope").notNull(),
    product: text("product").notNull().default("dental"),
    isCommon: boolean("is_common").notNull().default(false),
    /**
     * Variante que separa la norma de un país (p. ej. la exodoncia por número
     * de raíces de la CUPS): se ofrece solo donde la lista del país le da un
     * código, para no repetir el tratamiento general en los demás.
     */
    codedOnly: boolean("coded_only").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("treatment_template_key_uidx").on(table.key),
    check("treatment_template_product_check", sql`${table.product} IN ('dental','medical')`),
  ],
)

/**
 * El código de un tratamiento en la lista de cada país (ADR 0069): uno por
 * lista y edición. Es el código de la lista que incluye al tratamiento: el
 * exacto si la lista es fina; si es gruesa, el que la norma usa para él, así
 * que varios tratamientos pueden compartir uno. Nunca un código inventado ni
 * de otro país. Global, SIN org_id, SIN RLS.
 */
export const treatmentTemplateCode = catalogSchema.table(
  "treatment_template_code",
  {
    templateId: uuid("template_id")
      .notNull()
      .references(() => treatmentTemplate.id, { onDelete: "cascade" }),
    systemKey: text("system_key").notNull(),
    code: text("code").notNull(),
    version: text("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.systemKey, table.code, table.version] }),
    foreignKey({
      columns: [table.systemKey, table.code, table.version],
      foreignColumns: [procedureCode.systemKey, procedureCode.code, procedureCode.version],
    }),
    index("treatment_template_code_reverse_idx").on(table.systemKey, table.code, table.version),
    uniqueIndex("treatment_template_code_list_uidx").on(table.templateId, table.systemKey, table.version),
  ],
)

/**
 * Especialidad de la clínica (p. ej. «Endodoncia»): la única lista de
 * especialidades (ADR 0039). Nace con las del perfil de su país (ADR 0069) y
 * la clínica la renombra, archiva o amplía. El servicio apunta a una; quien la atiende va en
 * `professional_specialty`.
 */
export const orgSpecialty = pgTable(
  "org_specialty",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    /** Clave estable por organización: la de la biblioteca o la que sale del nombre. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("org_specialty_org_key_uidx").on(table.organizationId, table.key),
    uniqueIndex("org_specialty_org_id_uidx").on(table.organizationId, table.id),
    index("org_specialty_org_active_idx").on(table.organizationId, table.isActive),
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
    /** Código interno de la clínica (opcional), distinto del código oficial. */
    code: text("code"),
    /**
     * Código oficial de un servicio propio en la lista del país (ADR 0069):
     * obligatorio donde la lista lo es. Uno de la biblioteca lo toma de su
     * tratamiento y deja estas columnas vacías.
     */
    procedureSystem: text("procedure_system"),
    procedureCode: text("procedure_code"),
    procedureVersion: text("procedure_version"),
    name: text("name").notNull(),
    /**
     * La especialidad de la clínica, una sola (decisión 3 de la fase 4). La
     * agenda ofrece el servicio a quien la atiende. Del legado puede faltar.
     */
    specialtyId: uuid("specialty_id"),
    scope: text("scope"),
    // Todo servicio tiene tarifa explícita (>= 0; 0 = incluido sin costo).
    priceCents: integer("price_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    durationMin: integer("duration_min"),
    // Cómo se cobra: 'treatment' una vez por tratamiento, 'session' en cada visita atendida.
    billingMode: text("billing_mode").notNull().default("treatment"),
    /**
     * Cómo dice el precio el agente (`PRICE_DISCLOSURES`). Solo cambia lo que
     * se le dice a una persona: caja y presupuesto usan siempre la tarifa.
     * Un servicio nuevo nace «solo con evaluación».
     */
    priceDisclosure: text("price_disclosure").notNull().default("evaluacion"),
    /** La evaluación que ofrece el agente cuando el precio no es exacto. */
    evaluationServiceId: uuid("evaluation_service_id").references((): AnyPgColumn => serviceCatalog.id),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("service_catalog_org_code_uidx")
      .on(table.organizationId, table.code)
      .where(sql`"code" IS NOT NULL`),
    index("service_catalog_org_active_idx").on(table.organizationId, table.isActive),
    index("service_catalog_org_specialty_idx").on(table.organizationId, table.specialtyId),
    foreignKey({
      name: "service_catalog_specialty_fk",
      columns: [table.organizationId, table.specialtyId],
      foreignColumns: [orgSpecialty.organizationId, orgSpecialty.id],
    }),
    index("service_catalog_template_idx").on(table.templateId),
    foreignKey({
      name: "service_catalog_procedure_fk",
      columns: [table.procedureSystem, table.procedureCode, table.procedureVersion],
      foreignColumns: [procedureCode.systemKey, procedureCode.code, procedureCode.version],
    }),
    check(
      "service_catalog_procedure_check",
      sql`(${table.procedureSystem} IS NULL) = (${table.procedureCode} IS NULL) AND (${table.procedureCode} IS NULL) = (${table.procedureVersion} IS NULL) AND (${table.procedureCode} IS NULL OR ${table.templateId} IS NULL)`,
    ),
    check("service_catalog_price_check", sql`${table.priceCents} >= 0`),
    check("service_catalog_billing_mode_check", sql`${table.billingMode} IN ('treatment','session')`),
    check("service_catalog_price_disclosure_check", sql`${table.priceDisclosure} IN ('exacto','desde','evaluacion')`),
  ],
)

/**
 * Cómo dice un precio el agente: el número tal cual, como mínimo («desde») o
 * ninguno, ofreciendo la evaluación. Vale para servicios y para cada servicio
 * de una promoción.
 */
export const PRICE_DISCLOSURES = ["exacto", "desde", "evaluacion"] as const
export type PriceDisclosure = (typeof PRICE_DISCLOSURES)[number]
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
    scope: text("scope"),
    // Sitio (ADR 0079): sistema, código y calificadores, como bodySite de FHIR.
    siteSystem: text("site_system"),
    siteCode: text("site_code"),
    siteQualifiers: text("site_qualifiers").array().notNull().default([]),
    description: text("description").notNull(),
    /** Unidades del acto (p. ej. 3 sellantes); el cargo es precio × cantidad. */
    quantity: smallint("quantity").notNull().default(1),
    diagnosisSystem: text("diagnosis_system"),
    diagnosisCode: text("diagnosis_code"),
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
    ...diagnosisCodeRef("encounter_procedure", table),
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
 * presupuesto y puede continuar en múltiples visitas. Hay un plan abierto por
 * persona (ADR 0034): la primera indicación lo crea solo y guarda en
 * `originEncounterId` la atención donde nació; no se cierra con ella. */
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
 * no en un join mutable a la oferta vigente. Un solo borrador por persona
 * (salvo el de una revisión): crece con cada atención (decisión 12). */
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
    currency: char("currency", { length: 3 }).notNull(),
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
      sql`${table.status} IN ('borrador','presentado','aceptado','parcial','rechazado','pospuesto','cancelado','sustituido')`,
    ),
    check("treatment_budget_revision_check", sql`${table.revisionNumber} > 0`),
    index("treatment_budget_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_budget_org_plan_idx").on(table.organizationId, table.planId),
    uniqueIndex("treatment_budget_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("treatment_budget_org_patient_id_uidx").on(table.organizationId, table.patientId, table.id),
    // Un solo borrador por persona: el de una revisión va aparte (se elige al crearla).
    uniqueIndex("treatment_budget_one_draft_uidx")
      .on(table.organizationId, table.patientId)
      .where(sql`status = 'borrador' AND supersedes_budget_id IS NULL`),
  ],
)

/**
 * Opción de un presupuesto (decisión 13): dos o tres caminos para lo mismo,
 * cada uno con sus líneas y su propio total, nunca sumados. Todo presupuesto
 * tiene al menos una; con una sola, la pantalla no habla de opciones. Una es la
 * recomendada mientras se decide; al elegir, la elegida queda `elegida` y las
 * demás `no_elegida`. La posición da la letra que ve la persona (1 = «A»).
 */
export const treatmentBudgetOption = pgTable(
  "treatment_budget_option",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    budgetId: uuid("budget_id").notNull(),
    position: smallint("position").notNull(),
    isRecommended: boolean("is_recommended").notNull().default(false),
    decision: text("decision").notNull().default("pendiente"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId, table.budgetId],
      foreignColumns: [treatmentBudget.organizationId, treatmentBudget.patientId, treatmentBudget.id],
      name: "treatment_budget_option_budget_fk",
    }),
    uniqueIndex("treatment_budget_option_org_budget_id_uidx").on(
      table.organizationId,
      table.budgetId,
      table.id,
    ),
    uniqueIndex("treatment_budget_option_position_uidx").on(table.budgetId, table.position),
    uniqueIndex("treatment_budget_option_recommended_uidx")
      .on(table.budgetId)
      .where(sql`is_recommended`),
    uniqueIndex("treatment_budget_option_chosen_uidx")
      .on(table.budgetId)
      .where(sql`decision = 'elegida'`),
    index("treatment_budget_option_org_patient_idx").on(table.organizationId, table.patientId),
    check("treatment_budget_option_position_check", sql`${table.position} BETWEEN 1 AND 3`),
    check(
      "treatment_budget_option_decision_check",
      sql`${table.decision} IN ('pendiente','elegida','no_elegida')`,
    ),
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
    supersedesItemId: uuid("supersedes_item_id").references(
      (): AnyPgColumn => treatmentPlanItem.id,
    ),
    /**
     * Decisión vigente. `no_elegida`: el tratamiento solo estaba en una opción
     * del presupuesto que la persona no eligió (decisión 13); no es un «no».
     */
    decisionStatus: text("decision_status").notNull().default("pendiente"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByContactId: uuid("decided_by_contact_id").references(() => contact.id),
    decidedByName: text("decided_by_name"),
    statusReason: text("status_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    scope: text("scope"),
    // Sitio (ADR 0079): sistema, código y calificadores, como bodySite de FHIR.
    siteSystem: text("site_system"),
    siteCode: text("site_code"),
    siteQualifiers: text("site_qualifiers").array().notNull().default([]),
    title: text("title").notNull(),
    detail: text("detail"),
    diagnosisSystem: text("diagnosis_system"),
    diagnosisCode: text("diagnosis_code"),
    codings: jsonb("codings").$type<ProcedureCodingSnapshot[]>().notNull().default([]),
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").notNull().default("pendiente"),
    /** Fase del plan: sus valores los dice el producto (ADR 0079); la propone el tipo de tratamiento. */
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
    ...diagnosisCodeRef("treatment_plan_item", table),
    index("treatment_plan_item_org_patient_idx").on(table.organizationId, table.patientId),
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
      sql`${table.decisionStatus} IN ('pendiente','aceptado','pospuesto','rechazado','reemplazado','no_elegida')`,
    ),
    uniqueIndex("treatment_plan_item_org_patient_id_uidx").on(
      table.organizationId,
      table.patientId,
      table.id,
    ),
  ],
)
/** Línea económica cotizada en un presupuesto: snapshot de lo realmente
 * cotizado (no un join mutable). Cada línea es de una opción del presupuesto
 * (`optionId`); el mismo tratamiento puede estar en varias opciones, una vez
 * en cada una: UNIQUE(optionId,planItemId). Append-only tras entregar: solo
 * `decision` cambia al decidir (`no_elegida` en las opciones que no se eligieron).
 *
 * `priceCents` es el precio final acordado por unidad (total en modo
 * `treatment`, por sesión en modo `session`); `tariffPriceCents` congela la
 * tarifa original y `priceReason` el motivo cuando el final baja de la
 * referencia (tarifa, o mínimo `from` con promoción). `promotionId`/`Name`/
 * `Mode` congelan la promoción aplicada; el histórico nunca relee la
 * promoción vigente. `billingMode` + `sessionsPlanned` congelan cómo se cobra
 * la línea (una vez o por visita atendida, con tope de visitas). */
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
    optionId: uuid("option_id").notNull(),
    planItemId: uuid("plan_item_id")
      .notNull()
      .references(() => treatmentPlanItem.id),
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    title: text("title").notNull(),
    scope: text("scope"),
    // Sitio (ADR 0079): sistema, código y calificadores, como bodySite de FHIR.
    siteSystem: text("site_system"),
    siteCode: text("site_code"),
    siteQualifiers: text("site_qualifiers").array().notNull().default([]),
    codings: jsonb("codings").$type<ProcedureCodingSnapshot[]>().notNull().default([]),
    priceCents: integer("price_cents"),
    /** Tarifa original al cotizar (por unidad); null = sin tarifa conocida. */
    tariffPriceCents: integer("tariff_price_cents"),
    /** Motivo del ajuste; obligatorio si el final baja de la referencia. */
    priceReason: text("price_reason"),
    /** Promoción aplicada (snapshot; el histórico no relee la vigente). */
    promotionId: uuid("promotion_id"),
    promotionName: text("promotion_name"),
    promotionMode: text("promotion_mode"),
    /** Cómo se cobra la línea: 'treatment' una vez, 'session' por visita. */
    billingMode: text("billing_mode").notNull().default("treatment"),
    /** Tope de visitas con cargo en modo `session` (snapshot al cotizar). */
    sessionsPlanned: smallint("sessions_planned"),
    currency: char("currency", { length: 3 }).notNull(),
    decision: text("decision").notNull().default("pendiente"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("treatment_budget_item_option_plan_uidx").on(table.optionId, table.planItemId),
    // La opción es del mismo presupuesto y de la misma organización que la línea.
    foreignKey({
      columns: [table.organizationId, table.budgetId, table.optionId],
      foreignColumns: [
        treatmentBudgetOption.organizationId,
        treatmentBudgetOption.budgetId,
        treatmentBudgetOption.id,
      ],
      name: "treatment_budget_item_option_fk",
    }),
    index("treatment_budget_item_org_patient_idx").on(table.organizationId, table.patientId),
    index("treatment_budget_item_org_budget_idx").on(table.organizationId, table.budgetId),
    index("treatment_budget_item_org_plan_idx").on(table.organizationId, table.planId),
    index("treatment_budget_item_org_promotion_idx").on(table.organizationId, table.promotionId),
    check(
      "treatment_budget_item_billing_mode_check",
      sql`${table.billingMode} IN ('treatment','session')`,
    ),
    check(
      "treatment_budget_item_promotion_mode_check",
      sql`${table.promotionMode} IS NULL OR ${table.promotionMode} IN ('fixed','from')`,
    ),
    check(
      "treatment_budget_item_promotion_check",
      sql`(${table.promotionId} IS NULL) = (${table.promotionName} IS NULL)`,
    ),
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

/**
 * Lo aceptado que se agendó (ADR 0034): la cita sabe qué tratamientos son y
 * su atención los trae. Mismo paciente que la cita y que el tratamiento (claves
 * compuestas); queda como historia aunque la cita se cancele.
 */
export const appointmentPlanItem = pgTable(
  "appointment_plan_item",
  {
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    appointmentId: uuid("appointment_id").notNull(),
    planItemId: uuid("plan_item_id").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.appointmentId, table.planItemId] }),
    foreignKey({
      columns: [table.organizationId, table.patientId, table.appointmentId],
      foreignColumns: [appointment.organizationId, appointment.patientId, appointment.id],
      name: "appointment_plan_item_appointment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.patientId, table.planItemId],
      foreignColumns: [
        treatmentPlanItem.organizationId,
        treatmentPlanItem.patientId,
        treatmentPlanItem.id,
      ],
      name: "appointment_plan_item_plan_item_fk",
    }),
    index("appointment_plan_item_plan_item_idx").on(table.organizationId, table.planItemId),
  ],
)

/** Contexto versionado del documento (append-only): cada corrección agrega una
 * versión; las lecturas usan la vigente. Blob/original inmutables en
 * patient_document (sin encounterId ni sitios: viven aquí). */
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
    // Sitios del papel (ADR 0079): un sistema y sus códigos.
    siteSystem: text("site_system"),
    siteCodes: text("site_codes").array().notNull().default(sql`'{}'`),
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

/**
 * Tomografía (u otro estudio DICOM de muchos archivos) de un documento de la
 * ficha: el estudio, su tamaño y cuándo terminó la subida (ADR 0055). El
 * documento sigue siendo uno; sus archivos viven en `imaging_study_file`.
 */
export const imagingStudy = pgTable(
  "imaging_study",
  {
    documentId: uuid("document_id").primaryKey(),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    /** StudyInstanceUID (0020,000D): el mismo estudio no se guarda dos veces. */
    studyInstanceUid: text("study_instance_uid").notNull(),
    /** Nombre del paciente que trae el archivo (0010,0010): solo avisa, nunca identifica. */
    dicomPatientName: text("dicom_patient_name"),
    modality: text("modality"),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    /** Cortes de la serie que se reconstruye (la mayor del estudio). */
    sliceCount: integer("slice_count").notNull(),
    /** Tamaño del vóxel en mm (Pixel Spacing de la serie), si lo declara. */
    voxelMm: real("voxel_mm"),
    /** Miniatura (WebP) que arma el navegador con el corte del medio. */
    thumbnailKey: text("thumbnail_key"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.documentId],
      foreignColumns: [patientDocument.organizationId, patientDocument.id],
      name: "imaging_study_document_fk",
    }).onDelete("cascade"),
    uniqueIndex("imaging_study_org_document_uidx").on(table.organizationId, table.documentId),
    index("imaging_study_org_patient_study_idx").on(
      table.organizationId,
      table.patientId,
      table.studyInstanceUid,
    ),
    check("imaging_study_file_count_check", sql`${table.fileCount} BETWEEN 1 AND 5000`),
    check(
      "imaging_study_total_bytes_check",
      sql`${table.totalBytes} BETWEEN 1 AND 1073741824`,
    ),
    check(
      "imaging_study_slice_count_check",
      sql`${table.sliceCount} BETWEEN 1 AND 20000`,
    ),
    check(
      "imaging_study_uid_check",
      sql`char_length(${table.studyInstanceUid}) BETWEEN 1 AND 64`,
    ),
  ],
)

/** Un archivo DICOM del estudio: dónde está y si ya se comprobó que llegó. */
export const imagingStudyFile = pgTable(
  "imaging_study_file",
  {
    organizationId: orgFk("organization_id"),
    documentId: uuid("document_id").notNull(),
    fileIndex: integer("file_index").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** SOPInstanceUID (0008,0018): reconoce el archivo al retomar la subida. */
    sopInstanceUid: text("sop_instance_uid").notNull(),
    seriesInstanceUid: text("series_instance_uid").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.fileIndex] }),
    foreignKey({
      columns: [table.organizationId, table.documentId],
      foreignColumns: [imagingStudy.organizationId, imagingStudy.documentId],
      name: "imaging_study_file_study_fk",
    }).onDelete("cascade"),
    uniqueIndex("imaging_study_file_sop_uidx").on(table.documentId, table.sopInstanceUid),
    check("imaging_study_file_size_check", sql`${table.sizeBytes} BETWEEN 1 AND 1073741824`),
  ],
)

/**
 * Medida guardada en una tomografía (decisión 3 del lienzo, ADR 0056): quién y
 * cuándo, sin cambiar el archivo. Puntos en mm dentro del volumen; quitarla la
 * retira con su traza.
 */
export const imagingMeasurement = pgTable(
  "imaging_measurement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull(),
    kind: text("kind").notNull(),
    /** Vista donde se marcó: panorámica, transversal, axial, coronal o sagital. */
    view: text("view").notNull(),
    /** Puntos [[x, y, z], …] en mm dentro del volumen. */
    points: jsonb("points").$type<[number, number, number][]>().notNull(),
    /** mm en una distancia, grados en un ángulo. */
    value: real("value").notNull(),
    /** Pieza (FDI) a la altura de la medida, si se sabe. */
    // Sitio (ADR 0079): sistema, código y calificadores, como bodySite de FHIR.
    siteSystem: text("site_system"),
    siteCode: text("site_code"),
    siteQualifiers: text("site_qualifiers").array().notNull().default([]),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: text("retired_by").references(() => user.id),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.documentId],
      foreignColumns: [imagingStudy.organizationId, imagingStudy.documentId],
      name: "imaging_measurement_study_fk",
    }).onDelete("cascade"),
    index("imaging_measurement_org_document_idx").on(table.organizationId, table.documentId),
    check("imaging_measurement_kind_check", sql`${table.kind} IN ('distancia','angulo')`),
    check(
      "imaging_measurement_view_check",
      sql`${table.view} IN ('panoramica','transversal','axial','coronal','sagital')`,
    ),
    check(
      "imaging_measurement_value_check",
      sql`${table.value} >= 0 AND (${table.kind} <> 'angulo' OR ${table.value} <= 180)`,
    ),
    check(
      "imaging_measurement_retired_check",
      sql`(${table.retiredAt} IS NULL) = (${table.retiredBy} IS NULL)`,
    ),
  ],
)

/**
 * Consentimiento para el tratamiento de datos personales (la ley de cada país; en Perú, la Ley 29733): por
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

/**
 * Antecedentes familiares por parentesco (HL7 v3 RoleCode, solo familiares) y
 * condición, con su código de diagnóstico opcional.
 */
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
    diagnosisSystem: text("diagnosis_system"),
    diagnosisCode: text("diagnosis_code"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("patient_family_history_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "patient_family_history_relationship_check",
      sql`${table.relationship} IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB')`,
    ),
    ...diagnosisCodeRef("patient_family_history", table),
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
    professionalUserId: text("professional_user_id")
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
    diagnosisSystem: text("diagnosis_system"),
    diagnosisCode: text("diagnosis_code"),
    validUntil: date("valid_until"),
    /**
     * Por qué se recetó igual pese al aviso de alergia (decisión 10): lo escribe
     * quien prescribe y queda en la receta. Sin aviso, vacío.
     */
    allergyOverrideReason: text("allergy_override_reason"),
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
    ...diagnosisCodeRef("prescription", table),
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
    branchId: uuid("branch_id").references(() => branch.id),
    /** Promoción aplicada al cobrar/presupuestar: snapshot, el histórico nunca relee la regla. */
    promotionId: text("promotion_id"),
    promotionName: text("promotion_name"),
    /** Motivo del último cambio de importe/descripción (auditoría de corrección en Cobrar). */
    editReason: text("edit_reason"),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    notes: text("notes"),
    /**
     * Producto vendido desde «Cobrar» y cuántas unidades de uso (ADR 0067).
     * Al crearse descuenta de la sede; anular el concepto lo devuelve. El
     * vínculo compuesto con `product` vive en la migración de reglas.
     */
    productId: uuid("product_id"),
    productQuantity: integer("product_quantity"),
    /**
     * Clave del formulario que creó el concepto (una venta desde «Cobrar»): un
     * reintento tras un corte devuelve el mismo concepto y no vende ni
     * descuenta dos veces.
     */
    requestKey: text("request_key"),
    /**
     * Una devolución no reescribe el concepto: lo anula y deja otro con lo que
     * queda (ADR 0068). Este apunta al primero de la cadena, que es el que
     * guarda las salidas del inventario; nulo en el concepto original.
     */
    originalChargeId: uuid("original_charge_id"),
    /**
     * Lo devuelto de la cadena hasta este concepto: lo cobrado de un tratamiento
     * es importe + devuelto, para que una devolución no deje «por generar» lo
     * que ya se cobró.
     */
    returnedCents: integer("returned_cents").notNull().default(0),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    uniqueIndex("patient_charge_org_id_uidx").on(table.organizationId, table.id),
    index("patient_charge_original_idx")
      .on(table.organizationId, table.originalChargeId)
      .where(sql`"original_charge_id" IS NOT NULL`),
    check("patient_charge_returned_check", sql`${table.returnedCents} >= 0`),
    uniqueIndex("patient_charge_org_request_key_uidx")
      .on(table.organizationId, table.requestKey)
      .where(sql`"request_key" IS NOT NULL`),
    index("patient_charge_org_patient_idx").on(table.organizationId, table.patientId),
    index("patient_charge_item_idx").on(table.organizationId, table.planItemId),
    index("patient_charge_budget_item_idx").on(table.organizationId, table.budgetItemId),
    check("patient_charge_amount_check", sql`${table.amountCents} > 0`),
    check(
      "patient_charge_product_check",
      sql`(${table.productId} IS NULL) = (${table.productQuantity} IS NULL) AND (${table.productQuantity} IS NULL OR ${table.productQuantity} BETWEEN 1 AND 9999)`,
    ),
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
    /** Ticket del cobro atómico (un ticket agrupa un pago por medio). */
    ticketId: uuid("ticket_id").references(() => paymentTicket.id),
    branchId: uuid("branch_id").references(() => branch.id),
    /** Medio configurado por la clínica; nombre/tipo congelados al cobrar. */
    paymentMethodId: uuid("payment_method_id"),
    /** Nombre del medio congelado al cobrar (el único: antes se guardaba dos veces). */
    methodName: text("method_name").notNull(),
    /** Tipo UN/CEFACT 4461 congelado, independiente del nombre del medio. */
    methodTypeCode: text("method_type_code"),
    payerContactId: uuid("payer_contact_id").references(() => contact.id),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
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
    // El tipo congelado es de la lista UN/CEFACT 4461, igual que el del medio.
    check(
      "patient_payment_method_type_check",
      sql`${table.methodTypeCode} IS NULL OR ${table.methodTypeCode} IN ('10','48','30','68','20','1')`,
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
    /** Ticket cuyo cobro originó la aplicación (nulo = histórico manual anterior). */
    ticketId: uuid("ticket_id").references(() => paymentTicket.id),
    /**
     * La aplicación que esta reemplaza al pasar a un concepto rebajado por una
     * devolución (ADR 0068): lo cobrado por tratamiento cuenta solo la diferencia.
     */
    replacesApplicationId: uuid("replaces_application_id"),
    /** La devolución que anuló esta aplicación: lo cobrado por tratamiento la resta el día que pasó. */
    returnId: uuid("return_id"),
    amountCents: integer("amount_cents").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    uniqueIndex("payment_application_org_id_uidx").on(table.organizationId, table.id),
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
    /** La devolución de un cobro que pagó este dinero (nulo: «Devolver dinero» del saldo a favor). */
    returnId: uuid("return_id"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payment_refund_org_patient_idx").on(table.organizationId, table.patientId),
    index("payment_refund_payment_idx").on(table.organizationId, table.paymentId),
    check("payment_refund_amount_check", sql`${table.amountCents} > 0`),
  ],
)

/** Ticket numerado del cobro atómico: un ticket agrupa un pago por medio. Inmutable salvo anulación. */
export const paymentTicket = pgTable(
  "payment_ticket",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    /** Número único por organización, sin saltos: lo asigna el contador bajo lock. */
    ticketNumber: integer("ticket_number").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    totalCents: integer("total_cents").notNull(),
    /** Crédito previo aplicado automáticamente (lo más antiguo primero). */
    creditAppliedCents: integer("credit_applied_cents").notNull().default(0),
    cashReceivedCents: integer("cash_received_cents"),
    changeCents: integer("change_cents"),
    payerContactId: uuid("payer_contact_id").references(() => contact.id),
    /** Clave de idempotencia del cobro (requestId del cliente). */
    requestId: uuid("request_id"),
    /** Snapshot inmutable: paciente, emisor, sede, líneas, medios, precios y promociones. */
    snapshot: jsonb("snapshot").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("payment_ticket_org_patient_idx").on(table.organizationId, table.patientId),
    index("payment_ticket_org_branch_idx").on(table.organizationId, table.branchId),
    uniqueIndex("payment_ticket_org_number_uidx").on(table.organizationId, table.ticketNumber),
    uniqueIndex("payment_ticket_org_request_uidx")
      .on(table.organizationId, table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
    check("payment_ticket_total_check", sql`${table.totalCents} >= 0`),
  ],
)

/** Contador de tickets por organización: se incrementa en la misma transacción del cobro (sin saltos por rollback). */
export const ticketCounter = pgTable("ticket_counter", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id),
  nextNumber: integer("next_number").notNull().default(1),
  /** Las devoluciones se numeran aparte de los tickets, también sin saltos. */
  nextReturnNumber: integer("next_return_number").notNull().default(1),
})

/**
 * Devolución de un cobro (ADR 0068): el paciente devuelve algo o pide su
 * dinero otro día. La venta del ticket queda en pie y esta la rebaja; el
 * dinero se le paga en el mismo paso o queda a favor. Inmutable, sin borrado.
 */
export const paymentReturn = pgTable(
  "payment_return",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    /** El ticket del que sale: sigue valiendo, con la devolución anotada. */
    ticketId: uuid("ticket_id").notNull(),
    /** Sede donde se devolvió: de su caja sale el dinero. */
    branchId: uuid("branch_id").notNull(),
    /** Número único por organización, sin saltos (`ticket_counter.next_return_number`). */
    returnNumber: integer("return_number").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    totalCents: integer("total_cents").notNull(),
    /** «pagado»: se le devolvió el dinero; «a_favor»: queda en su cuenta. */
    outcome: text("outcome").notNull(),
    /** Medio con que se le pagó, congelado (nulo si quedó a favor). */
    paymentMethodId: uuid("payment_method_id"),
    methodName: text("method_name"),
    methodTypeCode: text("method_type_code"),
    reason: text("reason").notNull(),
    /** Clave del formulario: un reintento devuelve la misma devolución. */
    requestId: uuid("request_id").notNull(),
    /** Lo que se imprime y se envía: clínica, sede, paciente, ticket, líneas y medio. */
    snapshot: jsonb("snapshot").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_return_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("payment_return_org_number_uidx").on(table.organizationId, table.returnNumber),
    uniqueIndex("payment_return_org_request_uidx").on(table.organizationId, table.requestId),
    index("payment_return_org_ticket_idx").on(table.organizationId, table.ticketId),
    index("payment_return_org_patient_idx").on(table.organizationId, table.patientId),
    check("payment_return_total_check", sql`${table.totalCents} > 0`),
    check("payment_return_outcome_check", sql`${table.outcome} IN ('pagado','a_favor')`),
    check(
      "payment_return_method_check",
      sql`(${table.outcome} = 'pagado') = (${table.methodName} IS NOT NULL) AND (${table.methodTypeCode} IS NULL OR ${table.methodTypeCode} IN ('10','48','30','68','20','1'))`,
    ),
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
      sql`${table.kind} IN ('representante_legal','autorizado_informacion','responsable_economico')`,
    ),
    check(
      "patient_responsibility_dates_check",
      sql`${table.endsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`,
    ),
  ],
)
