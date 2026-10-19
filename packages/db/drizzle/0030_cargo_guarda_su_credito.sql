ALTER TABLE "saas_charge" ADD COLUMN "credit_cents" integer;--> statement-breakpoint
-- Los cargos del cobro por acción ya emitidos toman el crédito que hoy tiene su plan: es el único dato que hay.
UPDATE "saas_charge" c SET "credit_cents" = p."credit_cents" FROM "saas_plan" p
WHERE p."id" = c."plan_id" AND c."dedupe_key" LIKE 'ciclo:%';--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_credit_check" CHECK ("saas_charge"."credit_cents" IS NULL OR "saas_charge"."credit_cents" >= 0);