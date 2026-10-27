import { sql } from "drizzle-orm"
import { check, date, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { organization, user } from "./auth.js"
import { adminSchema } from "./schemas.js"

/**
 * Las demos para presentar (lienzo «Demos para presentar», ADR 0096): una
 * clínica inventada que la administración crea desde «Clínicas», con su
 * receta (producto, tipo, tamaño, meses de historia y país). La clínica es
 * una organización como cualquiera, marcada demo en su suscripción; esta fila
 * guarda con qué se armó, para volver a empezar igual, y hasta qué día está
 * al día. Solo el rol owner la toca: es de la administración.
 *
 * - `status`: `pendiente` (la tomará el worker), `creando`, `lista` o
 *   `fallida`. Crear y volver a empezar corren en una sola transacción: una
 *   demo nunca queda a medias.
 * - `progress`: lo que muestra el avance (`{ step, done, total }`); lo
 *   escribe el worker fuera de la transacción.
 * - `historyThrough`: hasta qué día tiene agenda. Cada noche el worker cierra
 *   los días que pasaron y agrega los que entran (`advancedOn`).
 * - `openedAt`: la última vez que alguien la abrió desde la administración;
 *   junto con las sesiones de la clínica dice si se usa (a los 60 días sin
 *   abrirse se borra sola).
 */
export const DEMO_STATUSES = ["pendiente", "creando", "lista", "fallida"] as const
export type DemoStatus = (typeof DEMO_STATUSES)[number]
export const DEMO_SIZES = ["pequeno", "mediano", "grande"] as const
export type DemoSize = (typeof DEMO_SIZES)[number]
export const DEMO_MONTHS = [6, 12, 24] as const

export interface DemoProgress {
  step: string
  done: number
  total: number
}

export const saasDemo = adminSchema.table(
  "saas_demo",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** La clínica de la demo; se vacía mientras se vuelve a armar y al borrarla. */
    organizationId: text("organization_id"),
    product: text("product").notNull(),
    kind: text("kind").notNull(),
    size: text("size").notNull(),
    months: integer("months").notNull(),
    countryCode: text("country_code").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Quien la presenta: entra como propietario. */
    presenterUserId: text("presenter_user_id").notNull(),
    createdBy: text("created_by").notNull(),
    /** La semilla del generador: volver a empezar arma la misma demo. */
    seed: integer("seed").notNull(),
    status: text("status").notNull().default("pendiente"),
    progress: jsonb("progress").$type<DemoProgress>(),
    error: text("error"),
    historyThrough: date("history_through"),
    /** El día que el worker la puso al día por última vez (una vez por día de la clínica). */
    advancedOn: date("advanced_on"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /** El worker la marca mientras la arma: si deja de latir, se da por fallida. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "saas_demo_organization_id_fkey",
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete("set null"),
    foreignKey({
      name: "saas_demo_presenter_user_id_fkey",
      columns: [table.presenterUserId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "saas_demo_created_by_fkey",
      columns: [table.createdBy],
      foreignColumns: [user.id],
    }),
    uniqueIndex("saas_demo_organization_uidx").on(table.organizationId),
    uniqueIndex("saas_demo_slug_uidx").on(table.slug),
    index("saas_demo_status_idx").on(table.status),
    check("saas_demo_product_check", sql`${table.product} IN ('dental','medical')`),
    check("saas_demo_size_check", sql`${table.size} IN ('pequeno','mediano','grande')`),
    check("saas_demo_months_check", sql`${table.months} IN (6, 12, 24)`),
    check("saas_demo_status_check", sql`${table.status} IN ('pendiente','creando','lista','fallida')`),
  ],
)
