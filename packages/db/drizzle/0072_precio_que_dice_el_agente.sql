ALTER TABLE "service_catalog" ADD COLUMN "price_disclosure" text DEFAULT 'evaluacion' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "evaluation_service_id" uuid;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD COLUMN "price_disclosure" text DEFAULT 'exacto' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_evaluation_service_id_service_catalog_id_fk" FOREIGN KEY ("evaluation_service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_price_disclosure_check" CHECK ("service_catalog"."price_disclosure" IN ('exacto','desde','evaluacion'));--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_disclosure_check" CHECK ("promotion_service_price"."price_disclosure" IN ('exacto','desde','evaluacion'));--> statement-breakpoint
-- Lo que ya existía sigue diciéndose como hasta hoy: el precio exacto. Solo lo
-- nuevo nace «solo con evaluación».
UPDATE "service_catalog" SET "price_disclosure" = 'exacto';--> statement-breakpoint
UPDATE "promotion_service_price" SET "price_disclosure" = 'desde' WHERE "mode" = 'from';
