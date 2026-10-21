import { sql } from "drizzle-orm"
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { channelConnection, orgFk, timestamps } from "./crm.js"

/**
 * Cubetas de rate limit del widget público. SIN organization_id y SIN RLS
 * (igual que `inbound_event`): la ruta pública aún opera con ownerDb y la
 * clave ya incluye la conexión (`webchat:<operación>:<conexión>:<ámbito>`).
 * Tabla operativa mutable (contadores por ventana), no ledger de negocio: las
 * filas expiran por `window_start` y se purgan por antigüedad.
 */
export const webchatRateLimit = pgTable(
  "webchat_rate_limit",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [index("webchat_rate_limit_window_idx").on(table.windowStart)],
)

/**
 * Los sitios donde se cargó el chat web de una clínica (decisión 8 del pulido
 * de la Bandeja). El primero se permite solo; los demás esperan el sí de la
 * clínica («¿Es tuyo? Permitir · Bloquear») y mientras tanto ahí el chat dice
 * «No disponible». El navegador solo deja mostrarlo en los permitidos
 * (`frame-ancestors`). Así nadie gasta las conversaciones de la clínica
 * copiando su línea en otro sitio.
 */
export const WEBCHAT_SITE_STATUSES = ["permitido", "pendiente", "bloqueado"] as const
export type WebchatSiteStatus = (typeof WEBCHAT_SITE_STATUSES)[number]

export const webchatSite = pgTable(
  "webchat_site",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => channelConnection.id, { onDelete: "cascade" }),
    /** Esquema, dominio y puerto del sitio, como lo dice el navegador: «https://sonrisa.pe». */
    origin: text("origin").notNull(),
    status: text("status").$type<WebchatSiteStatus>().notNull().default("pendiente"),
    /** Cuándo cargó el chat por primera vez. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Quién lo permitió o lo bloqueó; nulo en el primero, que se registra solo. */
    decidedByUserId: text("decided_by_user_id").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check("webchat_site_status_check", sql`${table.status} in ('permitido','pendiente','bloqueado')`),
    uniqueIndex("webchat_site_connection_origin_uidx").on(table.connectionId, table.origin),
  ],
)
