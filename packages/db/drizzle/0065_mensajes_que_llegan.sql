CREATE TABLE "channel_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text DEFAULT 'utility' NOT NULL,
	"status" text DEFAULT 'en_revision' NOT NULL,
	"reason" text,
	"body" text DEFAULT '' NOT NULL,
	"variables" integer DEFAULT 0 NOT NULL,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"message_key" text,
	"requested_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "automation_consent_org_contact_purpose_channel_uidx";--> statement-breakpoint
-- El permiso deja de ser por canal: queda una fila por persona y finalidad. Si
-- en algún canal estaba dado de baja, gana la baja.
DELETE FROM "automation_consent" a USING "automation_consent" b
WHERE a.organization_id = b.organization_id AND a.contact_id = b.contact_id AND a.purpose = b.purpose
  AND (b.status > a.status OR (b.status = a.status AND b.id < a.id));--> statement-breakpoint
ALTER TABLE "automation_consent" ALTER COLUMN "source" SET DEFAULT 'presencial';--> statement-breakpoint
ALTER TABLE "automation_job" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "reply_buttons" jsonb;--> statement-breakpoint
ALTER TABLE "patient_registration_config" ADD COLUMN "ask_reminders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_registration_config" ADD COLUMN "ask_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_template" ADD CONSTRAINT "channel_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_template" ADD CONSTRAINT "channel_template_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_template_connection_name_language_uidx" ON "channel_template" USING btree ("connection_id","name","language");--> statement-breakpoint
CREATE INDEX "channel_template_org_message_idx" ON "channel_template" USING btree ("organization_id","message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_consent_org_contact_purpose_uidx" ON "automation_consent" USING btree ("organization_id","contact_id","purpose");--> statement-breakpoint
ALTER TABLE "automation_consent" DROP COLUMN "channel";--> statement-breakpoint
ALTER TABLE "channel_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_template" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON "channel_template" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "channel_template" TO dentalagent_app;
