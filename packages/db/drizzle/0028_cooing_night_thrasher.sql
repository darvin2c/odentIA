CREATE TABLE "portal_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"grant_id" uuid,
	"session_id" uuid,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_challenge_challenge_unique" UNIQUE("challenge"),
	CONSTRAINT "portal_challenge_type_check" CHECK ("portal_challenge"."type" IN ('registro','autenticacion'))
);
--> statement-breakpoint
CREATE TABLE "portal_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text DEFAULT 'activo' NOT NULL,
	"verified_method" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_grant_status_check" CHECK ("portal_grant"."status" IN ('activo','revocado')),
	CONSTRAINT "portal_grant_verified_method_check" CHECK ("portal_grant"."verified_method" IN ('presencial_documento','representacion_verificada')),
	CONSTRAINT "portal_grant_revoked_check" CHECK (("portal_grant"."status" <> 'revocado') = ("portal_grant"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "portal_passkey" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"nickname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "portal_passkey_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "portal_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"portal_enabled" boolean DEFAULT false NOT NULL,
	"requests_enabled" boolean DEFAULT true NOT NULL,
	"public_requests_enabled" boolean DEFAULT true NOT NULL,
	"channel_requests_enabled" boolean DEFAULT true NOT NULL,
	"auto_approve_verified" boolean DEFAULT false NOT NULL,
	"allowed_channel_ids" text[] DEFAULT '{}' NOT NULL,
	"link_ttl_minutes" integer DEFAULT 4320 NOT NULL,
	"session_ttl_hours" integer DEFAULT 48 NOT NULL,
	"grant_ttl_days" integer,
	"allowed_scope" jsonb DEFAULT '{"appointments":true,"budgets":true,"account":true,"documents":true}'::jsonb NOT NULL,
	"passkeys_enabled" boolean DEFAULT true NOT NULL,
	"assisted_recovery_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"contact_text" text,
	"patient_hint" text,
	"conversation_id" uuid,
	"contact_id" uuid,
	"trigger_message_id" uuid,
	"task_id" uuid,
	"idempotency_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_request_channel_check" CHECK ("portal_request"."channel" IN ('web_publica','conversacion')),
	CONSTRAINT "portal_request_status_check" CHECK ("portal_request"."status" IN ('pendiente','aprobada','rechazada','expirada'))
);
--> statement-breakpoint
CREATE TABLE "portal_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"grant_id" uuid,
	"request_id" uuid,
	"method" text NOT NULL,
	"verified_by" text,
	"evidence_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_verification_method_check" CHECK ("portal_verification"."method" IN ('presencial_documento','representacion_verificada'))
);
--> statement-breakpoint
ALTER TABLE "portal_session" ALTER COLUMN "link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_session" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "portal_session" ADD COLUMN "auth_method" text DEFAULT 'enlace_pin' NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_session" ADD COLUMN "passkey_id" uuid;--> statement-breakpoint
ALTER TABLE "portal_challenge" ADD CONSTRAINT "portal_challenge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_challenge" ADD CONSTRAINT "portal_challenge_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_passkey" ADD CONSTRAINT "portal_passkey_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_passkey" ADD CONSTRAINT "portal_passkey_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_passkey" ADD CONSTRAINT "portal_passkey_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_request" ADD CONSTRAINT "portal_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_request" ADD CONSTRAINT "portal_request_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_request" ADD CONSTRAINT "portal_request_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_request" ADD CONSTRAINT "portal_request_trigger_message_id_message_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_request" ADD CONSTRAINT "portal_request_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_request" ADD CONSTRAINT "portal_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_request_id_portal_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."portal_request"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_challenge_org_expires_idx" ON "portal_challenge" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_grant_org_id_uidx" ON "portal_grant" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_grant_org_pair_active_uidx" ON "portal_grant" USING btree ("organization_id","patient_id","contact_id") WHERE "status" = 'activo';--> statement-breakpoint
CREATE INDEX "portal_grant_org_patient_idx" ON "portal_grant" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "portal_grant_org_contact_idx" ON "portal_grant" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_passkey_org_id_uidx" ON "portal_passkey" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "portal_passkey_org_grant_idx" ON "portal_passkey" USING btree ("organization_id","grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_request_org_id_uidx" ON "portal_request" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_request_org_idempotency_uidx" ON "portal_request" USING btree ("organization_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_request_org_status_idx" ON "portal_request" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "portal_request_org_conversation_idx" ON "portal_request" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "portal_verification_org_pair_idx" ON "portal_verification" USING btree ("organization_id","patient_id","contact_id");--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_passkey_id_portal_passkey_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."portal_passkey"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_session_org_grant_idx" ON "portal_session" USING btree ("organization_id","grant_id");
--> statement-breakpoint
-- Portal: blindaje en DB que drizzle no expresa (estilo 0026_saas_invariants).
-- Tablas nuevas: portal_policy, portal_grant, portal_verification,
-- portal_request, portal_passkey, portal_challenge.
-- 1. Forma del alcance del grant (el servicio valida; esto lo blinda en DB).
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_scope_check" CHECK (
  jsonb_typeof("scope") = 'object'
  AND "scope" ? 'appointments' AND "scope" ? 'budgets'
  AND "scope" ? 'account' AND "scope" ? 'documents'
);--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_ttl_check" CHECK (
  "link_ttl_minutes" BETWEEN 1 AND 43200
  AND "session_ttl_hours" BETWEEN 1 AND 168
  AND ("grant_ttl_days" IS NULL OR "grant_ttl_days" BETWEEN 1 AND 3650)
);--> statement-breakpoint
-- 2. Corte limpio: los enlaces pendientes y sesiones vivas anteriores al corte
-- quedan invalidados. El canje jamás crea grants: todo acceso nuevo nace de
-- verificación explícita del staff (grant) + emisión con PIN asistido o QR.
UPDATE "portal_link" SET "status" = 'revocado', "revoked_at" = now(), "updated_at" = now()
  WHERE "status" = 'pendiente';--> statement-breakpoint
UPDATE "portal_session" SET "revoked_at" = now(), "updated_at" = now()
  WHERE "revoked_at" IS NULL AND "expires_at" > now();--> statement-breakpoint
-- 3. RLS por tenant (FORCE como el resto del dominio).
ALTER TABLE "portal_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_policy"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "portal_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_grant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_grant"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "portal_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_verification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_verification"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "portal_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_request"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "portal_passkey" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_passkey" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_passkey"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "portal_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_challenge" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_challenge"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- 4. Grants mínimos para dentalagent_app: lectura/escritura operativa sin
-- borrado en caliente; verificación y challenges son append-only con UPDATE
-- solo para liquidar (task de solicitud, challenge usado).
GRANT SELECT, INSERT, UPDATE ON "portal_policy", "portal_grant", "portal_request", "portal_challenge" TO dentalagent_app;--> statement-breakpoint
REVOKE DELETE ON "portal_policy", "portal_grant", "portal_request", "portal_challenge" FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "portal_verification" TO dentalagent_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "portal_verification" FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "portal_passkey" TO dentalagent_app;--> statement-breakpoint
REVOKE DELETE ON "portal_passkey" FROM dentalagent_app;