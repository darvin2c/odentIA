import { sql } from "drizzle-orm"
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organization, user } from "./auth.js"
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
export type SaasAccountExternalApp = (typeof SAAS_ACCOUNT_EXTERNAL_APPS)[number]

export function isSaasAccountExternalApp(value: unknown): value is SaasAccountExternalApp {
  return typeof value === "string" && (SAAS_ACCOUNT_EXTERNAL_APPS as readonly string[]).includes(value)
}

export const saasAccount = adminSchema.table(
  "saas_account",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    app: text("app"),
    externalRef: text("external_ref"),
    /**
     * Lo que la app dice de una cuenta suya (`cuenta.abierta`, ADR 0211): su nombre, su país
     * (ISO 3166-1 alfa-2) y su dueño (el id de la persona en la cuenta única, sin clave foránea:
     * es lo que dijo la app, y la cuenta de la persona vive aparte). Nulos en una clínica, que
     * los tiene en su organización. `synced_at` es la hora del último aviso aplicado: uno más
     * viejo que llega tarde no la pisa.
     */
    name: text("name"),
    country: char("country", { length: 2 }),
    ownerUserId: text("owner_user_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
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
    check(
      "saas_account_app_data_check",
      sql`CASE WHEN organization_id IS NOT NULL THEN name IS NULL AND country IS NULL AND owner_user_id IS NULL AND synced_at IS NULL
        ELSE (name IS NULL OR length(trim(name)) BETWEEN 1 AND 200) AND (country IS NULL OR country ~ '^[A-Z]{2}$') END`,
    ),
  ],
)

/**
 * Los avisos que una app ya le dio a la administración (ADR 0211): la clave de cada uno
 * (`webhook-id`) por app. El efecto y esta fila se escriben en la misma transacción, así que un
 * aviso repetido con la misma clave se reconoce y no se cuenta dos veces. Solo se agrega; sin
 * `GRANT`: lo escribe la conexión propietaria al recibir el aviso.
 */
export const appContractMessage = adminSchema.table(
  "app_contract_message",
  {
    app: text("app").notNull(),
    id: text("id").notNull(),
    type: text("type").notNull(),
    /** La cuenta a la que se aplicó. */
    accountId: text("account_id").references(() => saasAccount.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "app_contract_message_pkey", columns: [table.app, table.id] }),
    check("app_contract_message_id_check", sql`length(${table.id}) BETWEEN 1 AND 200`),
  ],
)

/** Lo que la administración le pide a una app (los `type` de `adminRequest` de `@odentia/contract`). */
export const APP_CONTRACT_REQUEST_TYPES = ["cuenta.abrir", "soporte.entrar", "equipo.quitar"] as const
export type AppContractRequestType = (typeof APP_CONTRACT_REQUEST_TYPES)[number]
/** Pendiente hasta que la app responde; hecho o falló es lo que respondió (no cambia después). */
export const APP_CONTRACT_REQUEST_STATUSES = ["pendiente", "hecho", "fallo"] as const
export type AppContractRequestStatus = (typeof APP_CONTRACT_REQUEST_STATUSES)[number]

/**
 * Lo que la administración le pide a una app que es otro sistema (ADR 0214): la bandeja de
 * salida de esos pedidos. Se escribe en la transacción de quien lo pide y lo envía la API en el
 * momento o el trabajador después, como los avisos de la cuenta: su `id` es su clave
 * (`webhook-id`) y no cambia al reintentar, así que la app reconoce un repetido. Los de una misma
 * cuenta salen en orden. Sin `GRANT`: solo la conexión propietaria.
 */
export const appContractRequest = adminSchema.table(
  "app_contract_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    app: text("app").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => saasAccount.id, { onDelete: "cascade" }),
    type: text("type").$type<AppContractRequestType>().notNull(),
    /** El pedido tal cual sale (su cuerpo firmado). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Quién del equipo lo pidió. */
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    status: text("status").$type<AppContractRequestStatus>().notNull().default("pendiente"),
    /** Lo que dijo la app al responder (por qué falló, o qué hizo). */
    resultMessage: text("result_message"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "app_contract_request_app_check",
      sql`${table.app} IN (${sql.raw(SAAS_ACCOUNT_EXTERNAL_APPS.map((app) => `'${app}'`).join(","))})`,
    ),
    check(
      "app_contract_request_type_check",
      sql`${table.type} IN (${sql.raw(APP_CONTRACT_REQUEST_TYPES.map((type) => `'${type}'`).join(","))})`,
    ),
    check(
      "app_contract_request_status_check",
      sql`${table.status} IN (${sql.raw(APP_CONTRACT_REQUEST_STATUSES.map((status) => `'${status}'`).join(","))}) AND (${table.status} = 'pendiente') = (${table.doneAt} IS NULL)`,
    ),
    index("app_contract_request_pending_idx")
      .on(table.app, table.nextAttemptAt)
      .where(sql`status = 'pendiente'`),
    index("app_contract_request_account_idx").on(table.accountId, table.createdAt),
  ],
)

/** La columna `organization_id` de una tabla del cobro o del soporte: la cuenta que paga o pregunta. */
export function accountFk(name: string) {
  return text(name)
    .notNull()
    .references(() => saasAccount.id)
}
