CREATE TABLE "encounter_dictation_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"dentist_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'lista' NOT NULL,
	"note" text,
	"entity_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_dictation_suggestion_kind_check" CHECK ("encounter_dictation_suggestion"."kind" IN ('nota','diagnostico','plan','control')),
	CONSTRAINT "encounter_dictation_suggestion_status_check" CHECK ("encounter_dictation_suggestion"."status" IN ('lista','por_revisar','confirmada','descartada'))
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "clinical_assistant_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_dentist_user_id_user_id_fk" FOREIGN KEY ("dentist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encounter_dictation_suggestion_idx" ON "encounter_dictation_suggestion" USING btree ("organization_id","encounter_id","status");--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "encounter_dictation_suggestion"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Una sugerencia se confirma o se descarta; no se borra mientras exista la atención.
GRANT SELECT, INSERT, UPDATE ON "encounter_dictation_suggestion" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "encounter_dictation_suggestion" FROM dentalagent_app;
