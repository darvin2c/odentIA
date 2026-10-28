ALTER TABLE "org_profile" DROP CONSTRAINT "org_profile_diagnosis_system_check";--> statement-breakpoint
ALTER TABLE "catalog"."diagnosis_code" ADD COLUMN "official_title" text;--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_diagnosis_system_check" CHECK ("org_profile"."diagnosis_system" IS NULL OR "org_profile"."diagnosis_system" IN ('ICD-10','ICD-11','ICD-10-PE'));