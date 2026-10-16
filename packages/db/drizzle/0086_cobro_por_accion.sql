-- Cobro por acción (ADR 0030), fase 2: contar sin cobrar.
-- El plan lleva el crédito que devuelve la cuota, el precio base de cada
-- acción, hasta dónde se negocia y la prueba; la clínica, su descuento.
ALTER TABLE "saas_plan" ADD COLUMN "credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "conversation_micros" bigint;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "consultation_micros" bigint;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "recovery_micros" bigint;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "max_discount_bps" integer DEFAULT 6000 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "seller_discount_bps" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "trial_credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "trial_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "trial_max_credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "trial_max_days" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_plan_default_uidx" ON "saas_plan" USING btree ("is_default") WHERE "saas_plan"."is_default";--> statement-breakpoint
ALTER TABLE "saas_plan" ADD CONSTRAINT "saas_plan_action_check" CHECK ("saas_plan"."credit_cents" >= 0 AND coalesce("saas_plan"."conversation_micros", 0) >= 0 AND coalesce("saas_plan"."consultation_micros", 0) >= 0 AND coalesce("saas_plan"."recovery_micros", 0) >= 0);--> statement-breakpoint
ALTER TABLE "saas_plan" ADD CONSTRAINT "saas_plan_discount_check" CHECK ("saas_plan"."max_discount_bps" BETWEEN 0 AND 9000 AND "saas_plan"."seller_discount_bps" BETWEEN 0 AND "saas_plan"."max_discount_bps");--> statement-breakpoint
ALTER TABLE "saas_plan" ADD CONSTRAINT "saas_plan_trial_check" CHECK ("saas_plan"."trial_credit_cents" >= 0 AND "saas_plan"."trial_days" BETWEEN 1 AND 365 AND "saas_plan"."trial_max_credit_cents" >= "saas_plan"."trial_credit_cents" AND "saas_plan"."trial_max_days" >= "saas_plan"."trial_days");--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "discount_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD CONSTRAINT "saas_subscription_discount_check" CHECK ("saas_subscription"."discount_bps" BETWEEN 0 AND 9000);--> statement-breakpoint
CREATE TABLE "saas_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"encounter_id" uuid,
	"appointment_id" uuid,
	"channel" text,
	"window_start" timestamp with time zone,
	"detail" text NOT NULL,
	"currency" char(3),
	"base_price_micros" bigint,
	"price_micros" bigint,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"charge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_action_kind_check" CHECK ("saas_action"."kind" IN ('conversacion','consulta','cita')),
	CONSTRAINT "saas_action_price_check" CHECK (("saas_action"."base_price_micros" IS NULL) = ("saas_action"."price_micros" IS NULL) AND coalesce("saas_action"."price_micros", 0) >= 0 AND "saas_action"."discount_bps" BETWEEN 0 AND 9000)
);
--> statement-breakpoint
ALTER TABLE "saas_action" ADD CONSTRAINT "saas_action_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_action_org_dedupe_uidx" ON "saas_action" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "saas_action_org_occurred_idx" ON "saas_action" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "saas_action_org_contact_idx" ON "saas_action" USING btree ("organization_id","contact_id","kind","occurred_at");--> statement-breakpoint
ALTER TABLE "saas_action" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_action" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_action"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Libro: la aplicación registra y lee; el cobro anota el cargo con owner.
GRANT SELECT, INSERT ON "saas_action" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "saas_action" FROM dentalagent_app;
--> statement-breakpoint
-- Nunca se llenó: el uso se lee de `ai_usage` y lo que se cobra, de `saas_action`.
DROP TABLE "saas_usage_daily";
