// Estados OAuth de buzones (Gmail / Microsoft 365): nonces de un solo uso y
// corta duración que vinculan el flujo con usuario + organización.
// El `state` que viaja al proveedor es nonce firmada con HMAC (SECRETS_KEY);
// el codeVerifier PKCE NUNCA sale del servidor y vive solo en esta tabla.
// La tabla NO es append-only: las filas se borran al consumir o caducar.
// RLS, CHECK y permisos en `0001_base_reglas.sql`.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { orgFk } from "./crm.js"

export const mailboxOauthState = pgTable("mailbox_oauth_state", {
  /** Nonce aleatoria (hex 32 bytes): parte pública del `state` OAuth. */
  nonce: text("nonce").primaryKey(),
  organizationId: orgFk("organization_id"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** "gmail" | "microsoft365": el callback rechaza cualquier otro valor. */
  provider: text("provider").notNull(),
  /** Verifier PKCE (43-128 caracteres): solo servidor, un solo uso. */
  codeVerifier: text("code_verifier").notNull(),
  /** redirect_uri exacta registrada ante el proveedor. */
  redirectUri: text("redirect_uri").notNull(),
  /** Corta duración (10 min): pasado este punto el callback la rechaza. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
