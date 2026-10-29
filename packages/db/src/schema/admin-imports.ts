import { sql } from "drizzle-orm"
import { check, foreignKey, integer, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { organization, user } from "./auth.js"
import { adminSchema } from "./schemas.js"

/**
 * La carga de los datos de una clínica nueva (ADR 0104): cada fila del origen
 * que ya entró, con la persona que quedó. Volver a cargar el mismo plan, o
 * seguir una carga cortada, no crea otra ficha: la clave de la fila ya está
 * aquí. Solo el rol owner la toca: la carga la hace la administración.
 *
 * - `sourceKey`: la clave de la fila en el plan (su número de historia, o la
 *   huella que le dio la preparación).
 * - `outcome`: `creada` (la carga creó a la persona) o `existente` (ya estaba
 *   en la clínica con ese documento y no se tocó).
 * - `contactId` no es una clave foránea a propósito. La fila es de odentIA,
 *   no actividad de la persona: no debe impedir que su ficha pase a su
 *   contacto real (`is_placeholder_person` mira toda clave foránea a
 *   `contact`). Y si la persona se reemplaza o se borra, la fila queda, así
 *   que volver a cargar el plan no la trae de vuelta.
 */
export const CLINIC_IMPORT_OUTCOMES = ["creada", "existente"] as const
export type ClinicImportOutcome = (typeof CLINIC_IMPORT_OUTCOMES)[number]

export const clinicImportRow = adminSchema.table(
  "clinic_import_row",
  {
    organizationId: text("organization_id").notNull(),
    sourceKey: text("source_key").notNull(),
    contactId: uuid("contact_id").notNull(),
    outcome: text("outcome").notNull(),
    /** Huella del plan con que entró. */
    planSha256: text("plan_sha256").notNull(),
    /** De qué archivo y fila del origen salió. */
    originFile: text("origin_file"),
    originRow: integer("origin_row"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "clinic_import_row_pkey", columns: [table.organizationId, table.sourceKey] }),
    foreignKey({
      name: "clinic_import_row_organization_id_fkey",
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "clinic_import_row_created_by_fkey",
      columns: [table.createdBy],
      foreignColumns: [user.id],
    }),
    check("clinic_import_row_outcome_check", sql`${table.outcome} IN ('creada','existente')`),
  ],
)
