-- Condiciones comerciales (issue 167, ADR 0074): reglas.

-- 1. La aplicación solo las lee: cuenta conversaciones y citas recuperadas con
-- la regla de su día dentro del contexto de la clínica. Escribe la
-- administración con owner.
GRANT SELECT ON TABLE admin.saas_commercial_terms TO dentalagent_app;--> statement-breakpoint

-- 2. Cada versión es historia: lo que ya se contó o se cobró se calculó con
-- ella. Nada se reescribe ni se borra; un cambio es una fila nueva.
CREATE FUNCTION admin.saas_commercial_terms_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Las condiciones comerciales no se reescriben: un cambio es una versión nueva'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_commercial_terms_append_only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER saas_commercial_terms_append_only BEFORE UPDATE OR DELETE ON admin.saas_commercial_terms
  FOR EACH ROW EXECUTE FUNCTION admin.saas_commercial_terms_append_only();--> statement-breakpoint

-- 3. La primera versión: los valores que estaban en el código, vigentes desde
-- siempre, para que nada cambie al desplegar.
INSERT INTO admin.saas_commercial_terms
  (effective_from, conversation_window_hours, recovery_window_days, review_auto_percent, review_answer_days,
   review_read_days, payment_days, grace_days, proof_extension_days, proof_extension_max, half_cycle_days,
   trial_days, warn_percent, alarm_percent, waitlist_answer_days, commission_months)
VALUES ('1970-01-01T00:00:00Z', 24, 7, 10, 2, 7, 7, 7, 3, 1, 15, 30, 75, 90, 2, 12);--> statement-breakpoint

-- 4. Sin plan por defecto, la prueba del alta dura lo que dicen las condiciones
-- vigentes (antes, 30 fijos).
CREATE OR REPLACE FUNCTION public.saas_trial_on_org_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'catalog', 'auth', 'admin'
    AS $$
DECLARE
  days integer := coalesce(
    (SELECT "trial_days" FROM "saas_plan" WHERE "is_default" AND "is_active" LIMIT 1),
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
