import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { scheduleChair } from "./agenda.js"
import { user } from "./auth.js"
import { patient, serviceCatalog } from "./clinical.js"
import { contact, orgFk, timestamps } from "./crm.js"
import { branch } from "./org.js"

/** Días de semana: 0 = domingo … 6 = sábado (coincide con getUTCDay trasladado a zona). */
export const SCHEDULE_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

/** Prioridades de la lista de espera. */
export const WAITLIST_PRIORITIES = ["alta", "normal", "baja"] as const
export type WaitlistPriority = (typeof WAITLIST_PRIORITIES)[number]

/** Estados de la lista de espera. */
export const WAITLIST_STATUSES = ["en_espera", "ofrecida", "confirmada", "cancelada"] as const
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

/** Bloqueos y ausencias comparten tabla; el motivo distingue el caso. */
export const SCHEDULE_BLOCK_KINDS = ["bloqueo", "ausencia"] as const
export type ScheduleBlockKind = (typeof SCHEDULE_BLOCK_KINDS)[number]

/**
 * Horario semanal de un profesional en una sede. Los minutos son hora local
 * de la sucursal (zona branch.timezone ?? organización). Sin fila activa, el
 * profesional no ofrece huecos: la configuración es explícita.
 */
export const professionalSchedule = pgTable(
  "professional_schedule",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    dentistUserId: text("dentist_user_id")
      .notNull()
      .references(() => user.id),
    weekday: smallint("weekday").notNull(),
    startMin: smallint("start_min").notNull(),
    endMin: smallint("end_min").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("professional_schedule_org_id_uidx").on(table.organizationId, table.id),
    index("professional_schedule_org_branch_dentist_idx").on(
      table.organizationId,
      table.branchId,
      table.dentistUserId,
    ),
    check("professional_schedule_weekday_check", sql`${table.weekday} between 0 and 6`),
    check(
      "professional_schedule_range_check",
      sql`${table.startMin} >= 0 and ${table.endMin} <= 1440 and ${table.endMin} > ${table.startMin}`,
    ),
  ],
)

/**
 * Excepción puntual: bloqueo de agenda o ausencia del profesional. Con
 * `dentistUserId` nulo afecta a toda la sede; con `chairId` nulo, a todos
 * los sillones. El rango es UTC; la UI lo edita en la zona de la sucursal.
 */
export const scheduleBlock = pgTable(
  "schedule_block",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    dentistUserId: text("dentist_user_id").references(() => user.id),
    chairId: uuid("chair_id").references(() => scheduleChair.id),
    kind: text("kind").notNull().default("bloqueo"),
    reason: text("reason"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("schedule_block_org_id_uidx").on(table.organizationId, table.id),
    index("schedule_block_org_branch_range_idx").on(
      table.organizationId,
      table.branchId,
      table.startsAt,
    ),
    check("schedule_block_range_check", sql`${table.endsAt} > ${table.startsAt}`),
    check("schedule_block_kind_check", sql`${table.kind} in ('bloqueo','ausencia')`),
  ],
)

/**
 * Lista de espera por sede. `contactId` cubre el caso de interesado aún sin
 * ficha de paciente; `serviceId` conserva el servicio ofrecido para reservar
 * con la misma prestación al confirmar.
 */
export const waitlistEntry = pgTable(
  "waitlist_entry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    patientId: uuid("patient_id").references(() => patient.id),
    contactId: uuid("contact_id").references(() => contact.id),
    dentistUserId: text("dentist_user_id").references(() => user.id),
    serviceId: uuid("service_id").references(() => serviceCatalog.id),
    serviceName: text("service_name"),
    priority: text("priority").notNull().default("normal"),
    status: text("status").notNull().default("en_espera"),
    notes: text("notes"),
    offeredStartsAt: timestamp("offered_starts_at", { withTimezone: true }),
    offeredEndsAt: timestamp("offered_ends_at", { withTimezone: true }),
    offeredChairId: uuid("offered_chair_id").references(() => scheduleChair.id),
    confirmedAppointmentId: uuid("confirmed_appointment_id"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("waitlist_entry_org_id_uidx").on(table.organizationId, table.id),
    index("waitlist_entry_org_branch_status_idx").on(
      table.organizationId,
      table.branchId,
      table.status,
    ),
    check("waitlist_entry_priority_check", sql`${table.priority} in ('alta','normal','baja')`),
    check(
      "waitlist_entry_status_check",
      sql`${table.status} in ('en_espera','ofrecida','confirmada','cancelada')`,
    ),
    check(
      "waitlist_entry_subject_check",
      sql`${table.patientId} is not null or ${table.contactId} is not null`,
    ),
  ],
)
