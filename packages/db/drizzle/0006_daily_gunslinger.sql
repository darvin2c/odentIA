CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"branch_id" uuid,
	"dentist_user_id" text NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"reason" text,
	"evolution" text,
	"indications" text,
	"next_step" text,
	"next_appointment_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encounter_procedure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"tooth_number" smallint,
	"description" text NOT NULL,
	"diagnosis_code" text,
	"plan_item_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encounter_tooth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_plan_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"tooth_number" smallint,
	"title" text NOT NULL,
	"detail" text,
	"diagnosis_code" text,
	"price_cents" integer,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"encounter_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "kind" text DEFAULT 'evolucion' NOT NULL;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "avatar_storage_key" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "tooth_number" smallint;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_dentist_user_id_user_id_fk" FOREIGN KEY ("dentist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_finalized_by_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_diagnosis_code_cie10_code_code_fk" FOREIGN KEY ("diagnosis_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_tooth" ADD CONSTRAINT "encounter_tooth_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_tooth" ADD CONSTRAINT "encounter_tooth_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_diagnosis_code_cie10_code_code_fk" FOREIGN KEY ("diagnosis_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encounter_org_patient_idx" ON "encounter" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_patient_open_uidx" ON "encounter" USING btree ("patient_id") WHERE status = 'borrador';--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_tooth_encounter_tooth_uidx" ON "encounter_tooth" USING btree ("encounter_id","tooth_number");--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_patient_idx" ON "treatment_plan_item" USING btree ("organization_id","patient_id");--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> RLS: aislamiento por tenant en tablas de atención y plan.
ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "encounter"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "encounter_tooth" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_tooth" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "encounter_tooth"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "encounter_procedure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_procedure" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "encounter_procedure"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "treatment_plan_item"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
--> Borrado clínico prohibido a nivel DB; encounter conserva UPDATE (borrador editable).
REVOKE DELETE ON "encounter", "encounter_tooth", "encounter_procedure", "treatment_plan_item" FROM "dentalagent_app";--> statement-breakpoint
--> Las piezas son el set editable del borrador, no registros clínicos.
GRANT DELETE ON "encounter_tooth" TO "dentalagent_app";--> statement-breakpoint
CREATE POLICY "draft_teeth_delete" ON "encounter_tooth" AS RESTRICTIVE FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "encounter"
    WHERE "encounter"."id" = "encounter_tooth"."encounter_id"
      AND "encounter"."organization_id" = "encounter_tooth"."organization_id"
      AND "encounter"."status" = 'borrador'
  ));