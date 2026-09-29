import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

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
