/**
 * Config SOLO para introspección de esquema (no arranca servidor).
 * Regenerar el esquema auth en @odentia/db:
 *
 *   pnpm dlx @better-auth/cli@latest generate \
 *     --config packages/auth/src/dev-config.ts \
 *     --output packages/db/src/schema/auth.ts --yes
 *
 * Debe listar las tablas: user, session, account, verification,
 * organization, member, invitation.
 */
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"

export const auth = betterAuth({
  appName: "odentIA",
  secret: "introspection-only",
  // El adapter nunca se usa: el CLI solo lee opciones/plugins.
  database: drizzleAdapter({} as never, { provider: "pg" }),
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  plugins: [organization()],
})
