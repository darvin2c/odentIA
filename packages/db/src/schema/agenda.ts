import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { patient, serviceCatalog } from "./clinical.js"
import { contact, conversation, orgFk, timestamps } from "./crm.js"
import { branch } from "./org.js"

/**
 * Estados de la cita. Los ocupantes bloquean profesional y sillón en la
 * constraint de exclusión; `cancelada` y `no_asistio` liberan el recurso.
 */
export const APPOINTMENT_STATUSES = [
  "programada",
  "confirmada",
  "atendida",
  "no_asistio",
  "cancelada",
] as const
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

/** Estados que ocupan el recurso (constraint de exclusión parcial en DB). */
export const OCCUPYING_STATUSES: readonly AppointmentStatus[] = ["programada", "confirmada"]

/** Sillón/consultorio reservable de una sucursal. Sin tabla sala: si una
 * organización la necesita, colgará de aquí y la cita seguirá sin duplicarla. */
export const scheduleChair = pgTable(
  "schedule_chair",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("schedule_chair_org_id_uidx").on(table.organizationId, table.id),
    index("schedule_chair_org_branch_idx").on(table.organizationId, table.branchId),
  ],
)

/**
 * Reserva real de agenda: profesional + sillón + rango UTC + sucursal. La
 * hora de interfaz se interpreta con `branch.timezone ?? org timezone`.
 * La exclusión anti-solapamiento (btree_gist + tstzrange) vive en la
 * migración: drizzle no declara EXCLUDE.
 */
export const appointment = pgTable(
  "appointment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id),
    dentistUserId: text("dentist_user_id")
      .notNull()
      .references(() => user.id),
    chairId: uuid("chair_id")
      .notNull()
      .references(() => scheduleChair.id),
    /** Motivo/servicio; snapshot de nombre para que el histórico no siga al catálogo. */
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    serviceName: text("service_name"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    durationMin: integer("duration_min").notNull(),
    status: text("status").notNull().default("programada"),
    reason: text("reason"),
    source: text("source").notNull().default("recepcion"),
    conversationId: uuid("conversation_id").references(() => conversation.id),
    /** Bloqueo optimista en mover/editar. */
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("appointment_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("appointment_org_patient_id_uidx").on(
      table.organizationId,
      table.patientId,
      table.id,
    ),
    index("appointment_org_branch_range_idx").on(
      table.organizationId,
      table.branchId,
      table.startsAt,
    ),
    index("appointment_org_dentist_range_idx").on(
      table.organizationId,
      table.dentistUserId,
      table.startsAt,
    ),
    index("appointment_org_patient_idx").on(table.organizationId, table.patientId),
    check(
      "appointment_status_check",
      sql`${table.status} in ('programada','confirmada','atendida','no_asistio','cancelada')`,
    ),
    check("appointment_range_check", sql`${table.endsAt} > ${table.startsAt}`),
    check("appointment_duration_check", sql`${table.durationMin} > 0`),
  ],
)

/**
 * Enlace personal y efímero para que la persona de una conversación elija ella
 * misma su cita viendo los horarios libres. Solo se guarda la huella del
 * enlace; vale para la persona de esa conversación (sea ya paciente o no) y
 * deja de servir al reservar, al vencer o al revocarse. No da acceso a nada más que elegir día y
 * hora: ni historia, ni presupuestos, ni tarifas.
 */
export const appointmentBookingLink = pgTable(
  "appointment_booking_link",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id),
    /**
     * Para quién es la cita. Vacío cuando la persona aún no es paciente: lo
     * será al completar su registro en la misma página, antes de reservar.
     */
    patientId: uuid("patient_id").references(() => patient.id),
    /** Servicio del que se habló en la conversación; sin él se reserva una cita regular de la sede. */
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    /** Sede ya elegida en la conversación; sin ella la persona la elige en la página. */
    branchId: uuid("branch_id").references(() => branch.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    appointmentId: uuid("appointment_id").references(() => appointment.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("appointment_booking_link_token_uidx").on(table.tokenHash),
    index("appointment_booking_link_conversation_idx").on(table.organizationId, table.conversationId),
  ],
)
