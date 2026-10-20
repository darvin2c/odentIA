ALTER TABLE "patient" ADD COLUMN "allergies_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "allergies_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "substance_system" text;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "substance_code" text;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "source" text DEFAULT 'equipo' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "removed_reason" text;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "removed_by" text;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD COLUMN "atc_code" text;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD COLUMN "dose_value" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "patient_medication" ADD COLUMN "dose_unit" text;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD COLUMN "frequency_code" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "allergy_override_reason" text;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_allergies_reviewed_by_user_id_fk" FOREIGN KEY ("allergies_reviewed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_substance_system_check" CHECK ("patient_allergy"."substance_system" IS NULL OR "patient_allergy"."substance_system" IN ('atc','odentia'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_substance_code_check" CHECK (("patient_allergy"."substance_system" IS NULL) = ("patient_allergy"."substance_code" IS NULL));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_source_check" CHECK ("patient_allergy"."source" IN ('equipo','paciente'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_removed_reason_check" CHECK ("patient_allergy"."removed_reason" IS NULL OR "patient_allergy"."removed_reason" IN ('ya_no','otra_cosa','error'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_removed_check" CHECK (NOT ("patient_allergy"."is_active" AND "patient_allergy"."removed_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_dose_unit_check" CHECK ("patient_medication"."dose_unit" IS NULL OR "patient_medication"."dose_unit" IN ('mg','g','ug','mL','[iU]','{tbl}','{cap}','{drop}','{puff}'));--> statement-breakpoint
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_frequency_code_check" CHECK ("patient_medication"."frequency_code" IS NULL OR "patient_medication"."frequency_code" IN ('cada_8_h','cada_12_h','cada_24_h','segun_necesidad'));--> statement-breakpoint
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_dose_check" CHECK (("patient_medication"."dose_value" IS NULL) = ("patient_medication"."dose_unit" IS NULL) AND ("patient_medication"."dose_value" IS NULL OR "patient_medication"."dose_value" > 0));