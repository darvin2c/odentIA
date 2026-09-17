-- Validar los vínculos legados antes de modificar datos; nunca adivinar nombres o responsables.
DO $$
DECLARE invalid_id uuid;
BEGIN
  SELECT p.id INTO invalid_id FROM patient p LEFT JOIN contact c ON c.id = p.contact_id
  LEFT JOIN contact g ON g.id = p.guardian_contact_id
  WHERE c.id IS NULL OR c.organization_id <> p.organization_id OR btrim(c.display_name) = ''
     OR (p.guardian_contact_id IS NOT NULL AND (g.id IS NULL OR g.organization_id <> p.organization_id))
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN RAISE EXCEPTION 'Paciente %: nombre o vínculo de organización inválido; corregir con datos verificados', invalid_id; END IF;
  SELECT i.id INTO invalid_id FROM contact_identity i JOIN contact c ON c.id = i.contact_id
  WHERE i.organization_id <> c.organization_id LIMIT 1;
  IF invalid_id IS NOT NULL THEN RAISE EXCEPTION 'Identidad %: vínculo de organización inválido', invalid_id; END IF;
  SELECT v.id INTO invalid_id FROM conversation v JOIN contact c ON c.id = v.contact_id
  JOIN channel_connection cc ON cc.id = v.channel_connection_id
  WHERE v.organization_id <> c.organization_id OR v.organization_id <> cc.organization_id LIMIT 1;
  IF invalid_id IS NOT NULL THEN RAISE EXCEPTION 'Conversación %: vínculo de organización inválido', invalid_id; END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "patient_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"relationship_detail" text,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_contact_relationship_check" CHECK ("patient_contact"."relationship" IN ('self','guardian','family','other')),
	CONSTRAINT "patient_contact_detail_check" CHECK (length("patient_contact"."relationship_detail") <= 100)
);
--> statement-breakpoint
CREATE TABLE "patient_registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"submission_id" uuid,
	"payload_hash" text,
	"entry_point" text NOT NULL,
	"respondent" text,
	"actor_user_id" text,
	"context_contact_id" uuid,
	"conversation_id" uuid,
	"link_id" uuid,
	"form_version" integer,
	"answers" jsonb NOT NULL,
	"privacy_notice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_registration_entry_check" CHECK ("patient_registration"."entry_point" IN ('platform','public_link','qr','conversation','legacy')),
	CONSTRAINT "patient_registration_respondent_check" CHECK ("patient_registration"."respondent" IS NULL OR "patient_registration"."respondent" IN ('patient','representative','staff'))
);
--> statement-breakpoint
CREATE TABLE "patient_registration_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_registration_config" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"fields" jsonb NOT NULL,
	"privacy_notice" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT "patient_contact_id_contact_id_fk";
--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT "patient_guardian_contact_id_contact_id_fk";
--> statement-breakpoint
DROP INDEX "patient_org_contact_uidx";--> statement-breakpoint
ALTER TABLE "patient_anamnesis" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "display_name" text;--> statement-breakpoint
UPDATE patient p SET display_name = c.display_name FROM contact c WHERE c.id = p.contact_id;--> statement-breakpoint
ALTER TABLE patient ALTER COLUMN display_name SET NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "blood_group" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "contact_identity_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_org_id_uidx" ON "patient" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_org_id_uidx" ON "contact" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identity_org_id_uidx" ON "contact_identity" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_org_id_uidx" ON "conversation" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_link_org_id_uidx" ON "patient_registration_link" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_organization_id_contact_id_contact_organization_id_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_context_contact_id_contact_organization_id_id_fk" FOREIGN KEY ("organization_id","context_contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_conversation_id_conversation_organization_id_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_link_id_patient_registration_link_organization_id_id_fk" FOREIGN KEY ("organization_id","link_id") REFERENCES "public"."patient_registration_link"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_organization_id_contact_id_contact_organization_id_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_organization_id_conversation_id_conversation_organization_id_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_config" ADD CONSTRAINT "patient_registration_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_org_patient_contact_uidx" ON "patient_contact" USING btree ("organization_id","patient_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_self_patient_uidx" ON "patient_contact" USING btree ("organization_id","patient_id") WHERE "patient_contact"."relationship" = 'self';--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_self_contact_uidx" ON "patient_contact" USING btree ("organization_id","contact_id") WHERE "patient_contact"."relationship" = 'self';--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_preferred_uidx" ON "patient_contact" USING btree ("organization_id","patient_id") WHERE "patient_contact"."is_preferred";--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_org_patient_uidx" ON "patient_registration" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_submission_uidx" ON "patient_registration" USING btree ("organization_id","submission_id") WHERE "patient_registration"."submission_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_link_token_uidx" ON "patient_registration_link" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_organization_id_contact_identity_id_contact_identity_organization_id_id_fk" FOREIGN KEY ("organization_id","contact_identity_id") REFERENCES "public"."contact_identity"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO patient_contact (organization_id, patient_id, contact_id, relationship, is_preferred, created_at, updated_at)
SELECT organization_id, id, contact_id, 'self', guardian_contact_id IS NULL OR guardian_contact_id = contact_id, created_at, updated_at
FROM patient;--> statement-breakpoint
INSERT INTO patient_contact (organization_id, patient_id, contact_id, relationship, is_preferred, created_at, updated_at)
SELECT organization_id, id, guardian_contact_id, 'guardian', true, created_at, updated_at
FROM patient WHERE guardian_contact_id IS NOT NULL AND guardian_contact_id <> contact_id;--> statement-breakpoint
INSERT INTO audit_event (organization_id, action, entity, entity_id, metadata)
SELECT organization_id, 'migration.patient_guardian_same_as_self', 'patient', id::text,
jsonb_build_object('contactId', contact_id, 'migration', '0017')
FROM patient WHERE guardian_contact_id = contact_id;--> statement-breakpoint
INSERT INTO patient_registration (organization_id, patient_id, entry_point, answers, created_at)
SELECT organization_id, id, 'legacy', '{}'::jsonb, created_at FROM patient;--> statement-breakpoint
WITH candidates AS (
  SELECT v.id AS conversation_id, (array_agg(i.id))[1] AS identity_id
  FROM conversation v
  JOIN channel_connection cc ON cc.id = v.channel_connection_id AND cc.organization_id = v.organization_id
  JOIN contact_identity i ON i.contact_id = v.contact_id AND i.organization_id = v.organization_id AND i.channel = cc.channel
  GROUP BY v.id, cc.channel, v.external_thread_id
  HAVING count(*) = 1 AND (
    (cc.channel = 'whatsapp' AND regexp_replace(v.external_thread_id, '[^0-9]', '', 'g') = regexp_replace((array_agg(i.external_user_id))[1], '[^0-9]', '', 'g'))
    OR (cc.channel = 'telegram' AND v.external_thread_id !~ '^tg:-')
  )
)
UPDATE conversation v SET contact_identity_id = c.identity_id FROM candidates c WHERE v.id = c.conversation_id;--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "contact_id";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "guardian_contact_id";--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_blood_group_check" CHECK ("patient"."blood_group" IS NULL OR "patient"."blood_group" IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown'));
--> statement-breakpoint
ALTER TABLE patient_contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_contact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON patient_contact USING (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE patient_registration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_registration FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON patient_registration USING (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE patient_registration_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_registration_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON patient_registration_link USING (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE patient_registration_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_registration_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON patient_registration_config USING (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_contact, patient_registration_config, patient_registration_link TO dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT ON patient_registration TO dentalagent_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON patient_registration FROM dentalagent_app;