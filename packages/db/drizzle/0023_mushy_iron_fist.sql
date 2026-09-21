--> Tarifa desconocida no implica gratuidad: se conserva la oferta inactiva para revisión.
UPDATE "service_catalog" SET "price_cents" = 0, "is_active" = false WHERE "price_cents" IS NULL;--> statement-breakpoint
--> Reconstrucción histórica: prima el snapshot del plan; solo actos directos usan la tarifa disponible.
ALTER TABLE "encounter_procedure" ADD COLUMN "price_cents" integer;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "currency" char(3);--> statement-breakpoint
UPDATE "encounter_procedure" ep SET "price_cents" = sc."price_cents", "currency" = sc."currency"
FROM "service_catalog" sc
WHERE ep."service_id" = sc."id" AND ep."plan_item_id" IS NULL;--> statement-breakpoint
UPDATE "encounter_procedure" ep SET "price_cents" = tpi."price_cents", "currency" = CASE WHEN tpi."price_cents" IS NULL THEN NULL ELSE tpi."currency" END
FROM "treatment_plan_item" tpi
WHERE ep."plan_item_id" = tpi."id";--> statement-breakpoint
ALTER TABLE "service_catalog" ALTER COLUMN "price_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_price_check" CHECK ("encounter_procedure"."price_cents" IS NULL OR "encounter_procedure"."price_cents" >= 0);--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_price_currency_check" CHECK (("encounter_procedure"."price_cents" IS NULL) = ("encounter_procedure"."currency" IS NULL));--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_price_check" CHECK ("service_catalog"."price_cents" >= 0);