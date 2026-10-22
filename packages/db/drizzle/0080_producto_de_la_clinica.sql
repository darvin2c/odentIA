-- El producto de la clínica (ADR 0079): qué hace lo común en cada momento lo
-- decide `services/src/products.ts`. Las clínicas de hoy son dentales.
ALTER TABLE "org_profile" ADD COLUMN "product" text DEFAULT 'dental' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_product_check" CHECK ("org_profile"."product" IN ('dental','medical'));