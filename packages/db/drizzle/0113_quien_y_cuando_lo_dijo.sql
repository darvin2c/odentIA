ALTER TABLE "patient_health_declaration" DROP CONSTRAINT "patient_health_declaration_via_check";--> statement-breakpoint
ALTER TABLE "patient_health_declaration" DROP CONSTRAINT "patient_health_declaration_respondent_check";--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD COLUMN "declarant_name" text;--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD COLUMN "declarant_relation" text;--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD COLUMN "said_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD CONSTRAINT "patient_health_declaration_via_check" CHECK ("patient_health_declaration"."via" IN ('enlace','registro','formulario'));--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD CONSTRAINT "patient_health_declaration_respondent_check" CHECK ("patient_health_declaration"."respondent" IN ('patient','representative','staff'));