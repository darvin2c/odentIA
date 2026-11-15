CREATE TABLE "appointment_visit_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"reason" text,
	"pain" text,
	"pain_level" integer,
	"more" text,
	"told_purpose" text,
	"respondent_contact_id" uuid NOT NULL,
	"submitted_via" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_by" text,
	"seen_at" timestamp with time zone,
	"seen_encounter_id" uuid,
	CONSTRAINT "appointment_visit_answer_pain_check" CHECK ("appointment_visit_answer"."pain" is null or "appointment_visit_answer"."pain" in ('si','no')),
	CONSTRAINT "appointment_visit_answer_pain_level_check" CHECK ("appointment_visit_answer"."pain_level" is null or ("appointment_visit_answer"."pain_level" between 0 and 10 and "appointment_visit_answer"."pain" = 'si')),
	CONSTRAINT "appointment_visit_answer_via_check" CHECK ("appointment_visit_answer"."submitted_via" in ('enlace','portal')),
	CONSTRAINT "appointment_visit_answer_seen_check" CHECK (("appointment_visit_answer"."seen_at" is null) = ("appointment_visit_answer"."seen_by" is null) and ("appointment_visit_answer"."seen_encounter_id" is null or "appointment_visit_answer"."seen_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "appointment_visit_answer" ADD CONSTRAINT "appointment_visit_answer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_visit_answer" ADD CONSTRAINT "appointment_visit_answer_seen_by_user_id_fk" FOREIGN KEY ("seen_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_visit_answer" ADD CONSTRAINT "appointment_visit_answer_appointment_fk" FOREIGN KEY ("organization_id","patient_id","appointment_id") REFERENCES "public"."appointment"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_visit_answer" ADD CONSTRAINT "appointment_visit_answer_seen_encounter_fk" FOREIGN KEY ("organization_id","patient_id","seen_encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_visit_answer_appointment_uidx" ON "appointment_visit_answer" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "appointment_visit_answer_org_patient_idx" ON "appointment_visit_answer" USING btree ("organization_id","patient_id");