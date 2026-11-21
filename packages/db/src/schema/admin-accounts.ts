import { sql } from "drizzle-orm"
import { check, foreignKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { organization } from "./auth.js"
import { adminSchema } from "./schemas.js"

/**
 * La cuenta de cliente (ADR 0210, paso 3 del lienzo A): a quién le cobra y le da soporte la
 * administración, en cualquier app del grupo. No es la cuenta de la persona (`auth.user`).
 * La suscripción, los cargos, los pagos, lo que se cuenta para cobrar y los casos de
 * soporte cuelgan de ella; sus columnas se siguen llamando `organization_id`.
 *
 * - Una clínica es una cuenta con el mismo id que su organización (`id = organization_id`):
 *   la crea la base al crear la clínica (`saas_account_on_org_create`) y se va con ella.
 *   Su app es la de su producto, que no cambia (ADR 0087): no se guarda dos veces.
 * - Una cuenta de una app que es otro sistema (gestorIA) no tiene organización: guarda su
 *   app y su referencia en ese sistema (`external_ref`, la tienda), una cuenta por cada una.
 *   Su id nunca es el de una clínica, porque toda clínica ya tiene la suya con ese id: la
 *   RLS de la clínica (`organization_id` = la clínica de la sesión) nunca la alcanza.
 *
 * Solo la conexión propietaria la lee y la escribe (sin `GRANT`): las claves foráneas de las
 * tablas de la clínica la comprueban con el dueño de la tabla, sin dársela al rol app.
 */
/**
 * Las apps que son otro sistema y pueden tener cuentas sin clínica (las de `ACCOUNT_APPS` cuyo
 * `ACCOUNT_APP_INFO.product` es nulo; `apps.test.ts` de `@odentia/auth` exige que coincidan).
 * Una cuenta de odentIA, latidIA o vistIA siempre es una clínica.
 */
export const SAAS_ACCOUNT_EXTERNAL_APPS = ["gestoria"] as const

export const saasAccount = adminSchema.table(
  "saas_account",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    app: text("app"),
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "saas_account_organization_id_fkey",
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete("cascade"),
    uniqueIndex("saas_account_organization_uidx").on(table.organizationId),
    uniqueIndex("saas_account_external_uidx").on(table.app, table.externalRef),
    check(
      "saas_account_kind_check",
      sql`(organization_id IS NOT NULL AND id = organization_id AND app IS NULL AND external_ref IS NULL)
        OR (organization_id IS NULL AND app IN (${sql.raw(SAAS_ACCOUNT_EXTERNAL_APPS.map((app) => `'${app}'`).join(","))})
          AND external_ref IS NOT NULL AND length(trim(external_ref)) BETWEEN 1 AND 200)`,
    ),
  ],
)

/** La columna `organization_id` de una tabla del cobro o del soporte: la cuenta que paga o pregunta. */
export function accountFk(name: string) {
  return text(name)
    .notNull()
    .references(() => saasAccount.id)
}
