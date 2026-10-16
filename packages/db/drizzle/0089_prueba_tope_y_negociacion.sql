-- Cobro por acción (ADR 0030), fase 3: prueba y descuento negociados con
-- aprobación, tope de gasto, ciclo de facturación y tarifas de WhatsApp para
-- la estimación que ve la clínica.
ALTER TABLE "saas_subscription" ADD COLUMN "trial_credit_cents" integer;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "trial_days" integer;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "spend_cap_cents" integer;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "billing_cycle" text DEFAULT 'mensual' NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD CONSTRAINT "saas_subscription_terms_check" CHECK (("saas_subscription"."trial_credit_cents" IS NULL OR "saas_subscription"."trial_credit_cents" >= 0) AND ("saas_subscription"."trial_days" IS NULL OR "saas_subscription"."trial_days" BETWEEN 1 AND 365) AND ("saas_subscription"."spend_cap_cents" IS NULL OR "saas_subscription"."spend_cap_cents" >= 0) AND "saas_subscription"."billing_cycle" IN ('mensual','quincenal'));--> statement-breakpoint
CREATE TABLE "saas_negotiation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"discount_bps" integer,
	"trial_credit_cents" integer,
	"trial_days" integer,
	"note" text,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_negotiation_kind_check" CHECK ("saas_negotiation"."kind" IN ('descuento','prueba')),
	CONSTRAINT "saas_negotiation_status_check" CHECK ("saas_negotiation"."status" IN ('pendiente','aprobada','rechazada'))
);
--> statement-breakpoint
ALTER TABLE "saas_negotiation" ADD CONSTRAINT "saas_negotiation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_negotiation" ADD CONSTRAINT "saas_negotiation_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_negotiation" ADD CONSTRAINT "saas_negotiation_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_negotiation_org_status_idx" ON "saas_negotiation" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "saas_negotiation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_negotiation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_negotiation"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- La decide la administración de odentIA (owner); la clínica no la ve ni la escribe.
REVOKE ALL ON "saas_negotiation" FROM dentalagent_app;
--> statement-breakpoint
CREATE TABLE "saas_whatsapp_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"category" text NOT NULL,
	"currency" char(3) NOT NULL,
	"price_micros" bigint NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_whatsapp_rate_category_check" CHECK ("saas_whatsapp_rate"."category" IN ('marketing','utility','authentication')),
	CONSTRAINT "saas_whatsapp_rate_price_check" CHECK ("saas_whatsapp_rate"."price_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "saas_whatsapp_rate" ADD CONSTRAINT "saas_whatsapp_rate_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_whatsapp_rate_country_category_uidx" ON "saas_whatsapp_rate" USING btree ("country_code","category");--> statement-breakpoint
-- Global: la clínica la lee para su estimación; solo la administración la escribe.
REVOKE INSERT, UPDATE, DELETE ON "saas_whatsapp_rate" FROM dentalagent_app;
--> statement-breakpoint
-- La prueba del alta dura lo que dice el plan por defecto (ADR 0030: 30 días);
-- sin plan por defecto, 30. Antes eran 14 fijos.
CREATE OR REPLACE FUNCTION saas_trial_on_org_create() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  days integer := coalesce((SELECT "trial_days" FROM "saas_plan" WHERE "is_default" AND "is_active" LIMIT 1), 30);
BEGIN
  INSERT INTO "saas_subscription"
    ("organization_id", "status", "is_demo", "trial_started_at", "trial_ends_at",
     "current_period_start", "current_period_end", "proof_extension_count")
  VALUES
    (NEW.id, 'prueba', false, now(), now() + make_interval(days => days),
     now(), now() + make_interval(days => days), 0)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
