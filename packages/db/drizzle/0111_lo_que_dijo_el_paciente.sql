CREATE TABLE "patient_health_declaration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"via" text NOT NULL,
	"respondent" text NOT NULL,
	"health" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_health_declaration_via_check" CHECK ("patient_health_declaration"."via" IN ('enlace')),
	CONSTRAINT "patient_health_declaration_respondent_check" CHECK ("patient_health_declaration"."respondent" IN ('patient','representative'))
);
--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "submitted_via" text;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "finalized_by" text;--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD CONSTRAINT "patient_health_declaration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD CONSTRAINT "patient_health_declaration_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_health_declaration_org_patient_idx" ON "patient_health_declaration" USING btree ("organization_id","patient_id","created_at");--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_finalized_by_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_submitted_via_check" CHECK ("clinical_form_response"."submitted_via" is null or "clinical_form_response"."submitted_via" in ('portal','enlace'));