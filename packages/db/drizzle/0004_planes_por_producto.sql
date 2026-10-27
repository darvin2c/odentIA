DROP INDEX "admin"."saas_plan_default_uidx";--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "product" text DEFAULT 'dental' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_signup_policy" ADD COLUMN "medical_mode" text DEFAULT 'invitacion' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_plan_default_uidx" ON "admin"."saas_plan" USING btree ("product") WHERE "admin"."saas_plan"."is_default";--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD CONSTRAINT "saas_plan_product_check" CHECK ("admin"."saas_plan"."product" IN ('dental','medical'));--> statement-breakpoint
ALTER TABLE "admin"."saas_signup_policy" ADD CONSTRAINT "saas_signup_policy_medical_mode_check" CHECK ("admin"."saas_signup_policy"."medical_mode" IN ('invitacion','abierta'));--> statement-breakpoint
-- latidIA empieza como odentIA: cómo se abren sus clínicas, lo mismo que hoy (ADR 0092).
UPDATE admin.saas_signup_policy SET medical_mode = mode;--> statement-breakpoint
-- La prueba que abre el disparador usa el plan de lista de odentIA: al crear la
-- clínica aún no se sabe su producto. Para otro producto la corrige
-- `startSaasTrial` con su propio plan de lista (ADR 0092).
CREATE OR REPLACE FUNCTION public.saas_trial_on_org_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'catalog', 'auth', 'admin', 'dental'
    AS $$
DECLARE
  days integer := coalesce(
    (SELECT "trial_days" FROM "saas_plan" WHERE "is_default" AND "is_active" AND "product" = 'dental' LIMIT 1),
    (SELECT "trial_days" FROM "saas_commercial_terms" WHERE "effective_from" <= now() ORDER BY "effective_from" DESC LIMIT 1),
    30);
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
