-- Personal interno y segundo factor (AuthCore, slice admin-core).
-- Staff separado de member/OrgRole; auditoría append-only; TOTP estándar de
-- Better Auth (tabla two_factor + bandera en "user").

CREATE TABLE "admin_staff" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE "admin_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "actor_user_id" text,
  "actor_role" text,
  "action" text NOT NULL,
  "organization_id" text,
  "entity_id" text,
  "metadata" jsonb
);--> statement-breakpoint
CREATE TABLE "admin_invitation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "role" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "token_hash" text NOT NULL UNIQUE,
  "delivery_status" text NOT NULL DEFAULT 'pending',
  "invited_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "accepted_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE "admin_session_verification" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "factor_id" text NOT NULL,
  "method" text NOT NULL,
  "verified_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz
);--> statement-breakpoint
CREATE TABLE "two_factor" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "verified" boolean NOT NULL DEFAULT true,
  "failed_verification_count" integer NOT NULL DEFAULT 0,
  "locked_until" timestamptz
);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit" ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_actor_idx" ON "admin_audit" ("actor_user_id");--> statement-breakpoint
CREATE INDEX "admin_invitation_email_idx" ON "admin_invitation" ("email");--> statement-breakpoint
CREATE INDEX "admin_session_verification_session_idx" ON "admin_session_verification" ("session_id");--> statement-breakpoint
CREATE INDEX "admin_session_verification_user_idx" ON "admin_session_verification" ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" ("user_id");--> statement-breakpoint
ALTER TABLE "admin_staff" ADD CONSTRAINT "admin_staff_role_check" CHECK ("role" IN ('admin', 'support'));--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_actor_role_check" CHECK ("actor_role" IS NULL OR "actor_role" IN ('admin', 'support', 'system'));--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_role_check" CHECK ("role" IN ('admin', 'support'));--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_status_check" CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'));--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_delivery_check" CHECK ("delivery_status" IN ('pending', 'sent', 'uncertain'));--> statement-breakpoint
ALTER TABLE "admin_session_verification" ADD CONSTRAINT "admin_session_verification_method_check" CHECK ("method" IN ('totp', 'recovery'));--> statement-breakpoint
-- Tablas globales internas: el rol app no las toca (el servicio admin usa
-- owner tras el guard). two_factor la opera Better Auth con rol app.
REVOKE ALL ON "admin_staff", "admin_audit", "admin_invitation", "admin_session_verification" FROM "dentalagent_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON "admin_audit" FROM "dentalagent_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factor" TO "dentalagent_app";
