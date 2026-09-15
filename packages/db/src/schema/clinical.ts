import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
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
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { contact } from "./crm.js";
import { timestamps, orgFk } from "./crm.js";
import { branch } from "./org.js";

/**
 * Paciente dental (ficha clínica). Un contacto CRM se "convierte en paciente"
 * (1:1 por org vía unique). NTS 139-MINSA/2018: la filiación sigue la ficha
 * odontológica MINSA; los registros clínicos son append-only (ver migración:
 * REVOKE UPDATE/DELETE) con autor+timestamp como prerrequisito de firma.
 */
export const patient = pgTable(
  "patient",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id),
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
    guardianContactId: uuid("guardian_contact_id").references(() => contact.id),
    dataConsentAt: timestamp("data_consent_at", { withTimezone: true }),
    dataConsentBy: text("data_consent_by").references(() => user.id),
    registeredBranchId: uuid("registered_branch_id").references(() => branch.id),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("patient_org_contact_uidx").on(table.organizationId, table.contactId),
    uniqueIndex("patient_org_number_uidx").on(table.organizationId, table.patientNumber),
    uniqueIndex("patient_org_doc_uidx")
      .on(table.organizationId, table.docType, table.docNumber)
      .where(sql`"doc_number" IS NOT NULL`),
  ],
);

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
);

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
);

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
);

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
  (table) => [index("patient_medication_org_patient_idx").on(table.organizationId, table.patientId)],
);

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
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("patient_anamnesis_patient_version_uidx").on(table.patientId, table.version),
    index("patient_anamnesis_org_patient_idx").on(table.organizationId, table.patientId),
  ],
);

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
  (table) => [index("clinical_note_org_patient_created_idx").on(table.organizationId, table.patientId, table.createdAt)],
);

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
    encounterId: uuid("encounter_id").references(() => encounter.id),
    toothNumber: smallint("tooth_number"),
    uploadedBy: text("uploaded_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("patient_document_org_patient_idx").on(table.organizationId, table.patientId)],
);

/** Odontograma FDI por pieza/superficie; anulación lógica (status='anulado'). */
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
    status: text("status").notNull().default("registrado"),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    note: text("note"),
    createdBy: text("created_by").references(() => user.id),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    ...timestamps,
  },
  (table) => [index("odontogram_entry_org_patient_tooth_idx").on(table.organizationId, table.patientId, table.toothNumber)],
);

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
    nextAppointmentAt: timestamp("next_appointment_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: text("finalized_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("encounter_org_patient_idx").on(table.organizationId, table.patientId),
    uniqueIndex("encounter_patient_open_uidx")
      .on(table.patientId)
      .where(sql`status = 'borrador'`),
  ],
);

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
  (table) => [uniqueIndex("encounter_tooth_encounter_tooth_uidx").on(table.encounterId, table.toothNumber)],
);

/** Procedimiento realizado durante una atención; puede cerrar un ítem del plan. */
export const encounterProcedure = pgTable(
  "encounter_procedure",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounter.id, { onDelete: "cascade" }),
    toothNumber: smallint("tooth_number"),
    description: text("description").notNull(),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    planItemId: uuid("plan_item_id").references(() => treatmentPlanItem.id),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** Plan de tratamiento = lista de ítems del paciente (sin tabla cabecera). */
export const treatmentPlanItem = pgTable(
  "treatment_plan_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    toothNumber: smallint("tooth_number"),
    title: text("title").notNull(),
    detail: text("detail"),
    diagnosisCode: text("diagnosis_code").references(() => cie10Code.code),
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }).notNull().default("PEN"),
    status: text("status").notNull().default("pendiente"),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [index("treatment_plan_item_org_patient_idx").on(table.organizationId, table.patientId)],
);

/** Catálogo CIE-10 global (SIN org_id, SIN RLS, read-only en runtime). */
export const cie10Code = pgTable("cie10_code", {
  code: text("code").primaryKey(),
  description: text("description").notNull(),
});
