import { sql } from "drizzle-orm"
import { bigint, check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { adminSchema } from "./schemas.js"

/**
 * Cada vuelta del servicio `backup` (infra/prod/backup): el volcado se restaura
 * en una base temporal de su propio contenedor y solo si se restaura y tiene sus
 * migraciones y datos se sube al bucket. Esta fila dice cómo terminó; con ella
 * el worker abre el caso «Backup sin verificar» en Soporte y el Inicio de la
 * administración lo muestra. La escribe el contenedor con el rol owner; la
 * aplicación no la ve.
 *
 * - `status`: `verificado` (restaurado y subido) o `fallido`.
 * - `step`: dónde falló (`volcado`, `restauracion`, `comprobacion` o `subida`).
 * - `migrations`, `organizations` y `patients`: lo que tenía la base restaurada.
 */
export const BACKUP_STATUSES = ["verificado", "fallido"] as const
export type BackupStatus = (typeof BACKUP_STATUSES)[number]

export const platformBackup = adminSchema.table(
  "platform_backup",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<BackupStatus>().notNull(),
    step: text("step"),
    object: text("object"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    migrations: integer("migrations"),
    organizations: integer("organizations"),
    patients: integer("patients"),
    detail: text("detail"),
  },
  (table) => [
    check("platform_backup_status_check", sql`${table.status} in ('verificado', 'fallido')`),
    check(
      "platform_backup_step_check",
      sql`${table.step} is null or ${table.step} in ('volcado', 'restauracion', 'comprobacion', 'subida')`,
    ),
    // Un verificado dice qué subió y qué tenía; un fallido, dónde falló.
    check(
      "platform_backup_result_check",
      sql`(${table.status} = 'verificado' and ${table.object} is not null and ${table.migrations} is not null and ${table.step} is null) or (${table.status} = 'fallido' and ${table.step} is not null)`,
    ),
    index("platform_backup_finished_idx").on(table.finishedAt.desc()),
  ],
)
