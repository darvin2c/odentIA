ALTER TABLE "encounter" ADD COLUMN "present_illness" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "illness_duration" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "vitals" jsonb;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "prognosis" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "auxiliary_exams" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "quantity" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "diagnosis_code" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "prescriber_name" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "prescriber_title" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "prescriber_registration" text;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "generic_name" text;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "strength" text;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "dosage_form" text;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "atc_code" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_diagnosis_code_cie10_code_code_fk" FOREIGN KEY ("diagnosis_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_quantity_check" CHECK ("encounter_procedure"."quantity" BETWEEN 1 AND 99);