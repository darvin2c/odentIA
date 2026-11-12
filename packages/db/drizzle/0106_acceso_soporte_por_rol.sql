CREATE TABLE "admin"."support_access_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"staff_user_id" text NOT NULL,
	"pass_hash" text NOT NULL,
	"pass_expires_at" timestamp with time zone NOT NULL,
	"session_hash" text,
	"redeemed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_session_redeem_check" CHECK (("admin"."support_access_session"."redeemed_at" is null) = ("admin"."support_access_session"."session_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "support_access_audit" DROP CONSTRAINT "support_access_audit_action_check";--> statement-breakpoint
ALTER TABLE "support_access_grant" DROP CONSTRAINT "support_access_grant_scope_check";--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD COLUMN "view_role" text;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD COLUMN "staff_user_id" text;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "support_case" ADD COLUMN "access_requested_role" text;--> statement-breakpoint
ALTER TABLE "support_case" ADD COLUMN "access_requested_minutes" integer;--> statement-breakpoint
ALTER TABLE "support_case" ADD COLUMN "access_requested_by" text;--> statement-breakpoint
-- Antes de las reglas nuevas: cada permiso cerrado dice por qué terminó, los vencidos se cierran a su hora
-- y, si una clínica quedó con varios abiertos a la vez, queda solo el más nuevo.
UPDATE "support_access_grant" SET "end_reason" = 'quitado' WHERE "revoked_at" IS NOT NULL;--> statement-breakpoint
UPDATE "support_access_grant" SET "revoked_at" = "expires_at", "end_reason" = 'vencido' WHERE "revoked_at" IS NULL AND "expires_at" <= now();--> statement-breakpoint
UPDATE "support_access_grant" g SET "revoked_at" = now(), "end_reason" = 'reemplazado'
  WHERE g."revoked_at" IS NULL AND EXISTS (
    SELECT 1 FROM "support_access_grant" n
    WHERE n."organization_id" = g."organization_id" AND n."revoked_at" IS NULL
      AND (n."created_at", n."id") > (g."created_at", g."id")
  );--> statement-breakpoint
ALTER TABLE "admin"."support_access_session" ADD CONSTRAINT "support_access_session_grant_id_support_access_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."support_access_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."support_access_session" ADD CONSTRAINT "support_access_session_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_session_pass_uidx" ON "admin"."support_access_session" USING btree ("pass_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_session_session_uidx" ON "admin"."support_access_session" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "support_access_session_grant_idx" ON "admin"."support_access_session" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_access_requested_by_user_id_fk" FOREIGN KEY ("access_requested_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_grant_one_open_uidx" ON "support_access_grant" USING btree ("organization_id") WHERE "support_access_grant"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_action_check" CHECK ("support_access_audit"."action" in ('vista_diagnostica','denegado_sin_permiso','revocado','autorizado','pase','entrada','denegado_pase','denegado_solo_lectura'));--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_role_check" CHECK (("support_access_grant"."scope" = 'rol') = ("support_access_grant"."view_role" is not null));--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_reason_check" CHECK ("support_access_grant"."reason" is null or char_length("support_access_grant"."reason") between 1 and 500);--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_end_check" CHECK (("support_access_grant"."revoked_at" is null) = ("support_access_grant"."end_reason" is null) and ("support_access_grant"."end_reason" is null or "support_access_grant"."end_reason" in ('quitado','reemplazado','vencido','caso_resuelto','sin_quien_lo_dio')));--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_scope_check" CHECK ("support_access_grant"."scope" in ('diagnostico','rol'));