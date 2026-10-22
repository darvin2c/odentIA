import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { scheduleRoom } from "./agenda.js"
import { user } from "./auth.js"
import { orgFk, timestamps } from "./crm.js"
import { branch } from "./org.js"

/** Días de semana: 0 = domingo … 6 = sábado (coincide con getUTCDay trasladado a zona). */
export const SCHEDULE_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

/** Bloqueos y ausencias comparten tabla; el motivo distingue el caso. */
export const SCHEDULE_BLOCK_KINDS = ["bloqueo", "ausencia"] as const
export type ScheduleBlockKind = (typeof SCHEDULE_BLOCK_KINDS)[number]

/**
 * Horario semanal de un profesional en una sede. Los minutos son hora local
 * de la sucursal (zona branch.timezone ?? organización). Sin fila activa, el
 * profesional no ofrece huecos: la configuración es explícita.
 *
 * Con su historia (decisión 4 de Reportes; ADR 0060): cambiar el horario no
 * borra el anterior, lo cierra. Cada fila vale desde `validFrom` hasta el día
 * antes de `validUntil` (días de la sede); la vigente es la activa, sin
 * `validUntil`. Agenda y reservas leen solo la activa; Reportes lee la de
 * cada día.
 */
export const professionalSchedule = pgTable(
  "professional_schedule",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    professionalUserId: text("professional_user_id")
      .notNull()
      .references(() => user.id),
    weekday: smallint("weekday").notNull(),
    startMin: smallint("start_min").notNull(),
    endMin: smallint("end_min").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /** Primer día en que vale (día de la sede). */
    validFrom: date("valid_from").notNull().default(sql`current_date`),
    /** Día en que dejó de valer; nulo mientras es el vigente. */
    validUntil: date("valid_until"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("professional_schedule_org_id_uidx").on(table.organizationId, table.id),
    index("professional_schedule_org_branch_professional_idx").on(
      table.organizationId,
      table.branchId,
      table.professionalUserId,
    ),
    index("professional_schedule_org_valid_idx").on(table.organizationId, table.validFrom),
    check("professional_schedule_weekday_check", sql`${table.weekday} between 0 and 6`),
    check(
      "professional_schedule_range_check",
      sql`${table.startMin} >= 0 and ${table.endMin} <= 1440 and ${table.endMin} > ${table.startMin}`,
    ),
  ],
)

/**
 * Excepción puntual: bloqueo de agenda o ausencia del profesional. Con
 * `professionalUserId` nulo afecta a toda la sede; con `roomId` nulo, a todos
 * las unidades dentales. El rango es UTC; la UI lo edita en la zona de la sucursal.
 */
export const scheduleBlock = pgTable(
  "schedule_block",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    professionalUserId: text("professional_user_id").references(() => user.id),
    roomId: uuid("room_id").references(() => scheduleRoom.id),
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
