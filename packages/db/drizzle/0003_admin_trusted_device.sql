CREATE TABLE "admin"."admin_trusted_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"factor_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"country" text,
	"password_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin"."admin_session_verification" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "admin"."admin_trusted_device" ADD CONSTRAINT "admin_trusted_device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_trusted_device_token_uidx" ON "admin"."admin_trusted_device" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_trusted_device_user_idx" ON "admin"."admin_trusted_device" USING btree ("user_id");--> statement-breakpoint
-- La marca puede venir de un equipo reconocido (ADR 0090).
ALTER TABLE admin.admin_session_verification DROP CONSTRAINT admin_session_verification_method_check;--> statement-breakpoint
ALTER TABLE admin.admin_session_verification ADD CONSTRAINT admin_session_verification_method_check CHECK ((method = ANY (ARRAY['totp'::text, 'recovery'::text, 'device'::text])));
