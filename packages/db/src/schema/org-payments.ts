import { sql } from "drizzle-orm"
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { organization } from "./auth.js"

/**
 * Medios de pago aceptados por la clínica (tablero P3/fase 1, issue 57).
 * `typeCode` sigue la lista UN/CEFACT 4461 (UBL 2.1 / EN 16931):
 * 10 efectivo, 48 tarjeta, 30 transferencia, 68 billetera/servicio en línea,
 * 20 cheque, 1 no definido. Solo el efectivo (10) se cuenta al cerrar caja;
 * los demás piden número de operación. Apagar un medio (`isActive=false`)
 * lo quita del cobro; los cobros anteriores conservan su snapshot y cuadran.
 */
export const organizationPaymentMethod = pgTable(
  "organization_payment_method",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    typeCode: text("type_code").notNull().default("1"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_payment_method_org_id_uidx").on(table.organizationId, table.id),
    check("organization_payment_method_type_check", sql`${table.typeCode} IN ('10','48','30','68','20','1')`),
    check("organization_payment_method_sort_check", sql`${table.sortOrder} >= 0`),
    check("organization_payment_method_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 120`),
    index("organization_payment_method_org_active_idx").on(
      table.organizationId,
      table.isActive,
    ),
    index("organization_payment_method_org_sort_idx").on(
      table.organizationId,
      table.sortOrder,
      table.id,
    ),
  ],
)
