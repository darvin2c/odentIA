import { sql } from "drizzle-orm"
import { bigint, boolean, check, date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { orgFk } from "./crm.js"

/**
 * Lo que resultó de cada pregunta a Argos sobre Reportes (ADR 0070). No guarda
 * lo escrito: solo la cifra y la agrupación que eligió y cómo terminó, para
 * sumar las más pedidas y las que no sabe sin leer lo que escribe el equipo.
 * Las que pasaron por el modelo cuentan para las preguntas del mes (ADR 0085).
 */
export const REPORT_QUESTION_OUTCOMES = ["respondida", "pregunta", "no_sabe", "clinico", "accion", "otro", "no_pudo"] as const

export const reportQuestion = pgTable("report_question", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  /** Clave del catálogo de cifras (`REPORT_FIGURES`); nula si no eligió ninguna. */
  figure: text("figure"),
  groupBy: text("group_by"),
  /**
   * La consulta que corrió Argos sobre las vistas del negocio (ADR 0075,
   * decisión D2): se guarda la consulta, nunca el texto de la pregunta.
   */
  query: text("query"),
  /**
   * Lo que el modelo devolvió además de la consulta (`ArgosStoredPlan` de los
   * servicios): las frases con huecos, «Así lo calculé», su título, su pantalla
   * y las consultas para seguir. Plantillas y consultas, nunca datos ni el
   * texto de la pregunta: con esto se fija, se descarga y se sigue sin volver
   * a llamar al modelo.
   */
  plan: jsonb("plan"),
  /**
   * La pregunta pasó por un modelo que se paga (el de decisión o el que escribe
   * la consulta): solo esas cuentan para las preguntas del mes (ADR 0085),
   * salvo las que no pudieron (D6). Tocar una opción o el modelo de demostración no cuentan.
   */
  usedModel: boolean("used_model").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("report_question_org_date_idx").on(table.organizationId, table.createdAt),
  check("report_question_outcome_check", sql`${table.outcome} in ('respondida','parcial','pregunta','no_sabe','clinico','accion','ayuda','otro','no_pudo')`),
])

/**
 * Una respuesta de Argos fijada en el Resumen (decisión 8): se guarda la
 * pregunta ya entendida, nunca la imagen ni las cifras. La de las 32 cifras
 * (ADR 0070) guarda la cifra, la agrupación y lo que se destaca, y se
 * recalcula con el periodo y la sede de la pantalla; la del Argos de las
 * vistas (ADR 0075, D5) guarda su consulta y sus frases en `argos` y se
 * vuelve a correr tal cual. Una de las dos, nunca ambas. Hasta cuatro por
 * clínica, compartidas por quienes ven Reportes.
 */
export const REPORT_PIN_LIMIT = 4

export const reportPin = pgTable("report_pin", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  figure: text("figure"),
  groupBy: text("group_by").notNull().default("total"),
  /** Lo que se destaca dentro del grupo (un canal); vacío si nada. */
  focus: text("focus").notNull().default(""),
  /** La respuesta del Argos de las vistas: consulta, frases, título y pantalla (`ArgosStoredAnswer`). */
  argos: jsonb("argos"),
  createdBy: text("created_by").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("report_pin_question_uidx").on(table.organizationId, table.figure, table.groupBy, table.focus),
  // La misma consulta no se fija dos veces.
  uniqueIndex("report_pin_argos_uidx").on(table.organizationId, sql`md5(${table.argos} ->> 'sql')`).where(sql`${table.argos} IS NOT NULL`),
  check("report_pin_kind_check", sql`(${table.figure} IS NULL) <> (${table.argos} IS NULL)`),
])

/**
 * Metas del mes (decisión 9): lo cobrado y los pacientes nuevos, de toda la
 * clínica. Cada fila vale desde su mes hasta que otra la reemplace, así que
 * cambiar la meta no reescribe los meses pasados; `amount` nulo quita la meta
 * desde ese mes. Lo cobrado va en centavos de su moneda.
 */
export const REPORT_GOAL_METRICS = ["cobrado", "pacientes_nuevos"] as const

export const reportGoal = pgTable("report_goal", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  metric: text("metric").notNull(),
  /** Primer día del mes desde el que vale, en la zona de la clínica. */
  fromMonth: date("from_month", { mode: "string" }).notNull(),
  amount: bigint("amount", { mode: "number" }),
  currency: text("currency"),
  setBy: text("set_by").notNull().references(() => user.id),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("report_goal_month_uidx").on(table.organizationId, table.metric, table.fromMonth),
  check("report_goal_metric_check", sql`${table.metric} in ('cobrado','pacientes_nuevos')`),
  check("report_goal_amount_check", sql`${table.amount} is null or ${table.amount} > 0`),
  check("report_goal_currency_check", sql`${table.metric} <> 'cobrado' or ${table.amount} is null or ${table.currency} is not null`),
  check("report_goal_month_check", sql`extract(day from ${table.fromMonth}) = 1`),
])

/** El resumen del lunes (decisión 10): cada persona lo prende para sí; nace apagado. */
export const reportDigest = pgTable("report_digest", {
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("report_digest_user_uidx").on(table.organizationId, table.userId),
])

/**
 * Cada resumen del lunes, reservado antes de enviarlo: una fila por persona y
 * semana (`week`, el lunes en que empezó). Un envío incierto no se repite.
 */
export const REPORT_DIGEST_STATES = ["reclamado", "enviado", "incierto", "omitido"] as const

export const reportDigestSend = pgTable("report_digest_send", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  week: date("week", { mode: "string" }).notNull(),
  state: text("state").notNull().default("reclamado"),
  /** Por qué no salió (`sin_movimientos`, `sin_permiso`…) o el error del envío, recortado. */
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("report_digest_send_week_uidx").on(table.organizationId, table.userId, table.week),
  check("report_digest_send_state_check", sql`${table.state} in ('reclamado','enviado','incierto','omitido')`),
])
