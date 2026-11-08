ALTER TABLE "treatment_budget" ADD COLUMN "decision_signature" jsonb;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "decision_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_decision_signature_check" CHECK (("treatment_budget"."decision_signature" IS NULL) = ("treatment_budget"."decision_signed_at" IS NULL));--> statement-breakpoint
-- La firma de quien decide no se reescribe ni se quita: es lo que firmó.
CREATE OR REPLACE FUNCTION public.treatment_budget_delivered_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status <> 'borrador' AND (NEW.valid_until, NEW.findings, NEW.proposal, NEW.delivered_snapshot) IS DISTINCT FROM (OLD.valid_until, OLD.findings, OLD.proposal, OLD.delivered_snapshot) THEN
    RAISE EXCEPTION 'Lo entregado en el presupuesto no cambia';
  END IF;
  IF OLD.decision_signature IS NOT NULL AND (NEW.decision_signature, NEW.decision_signed_at) IS DISTINCT FROM (OLD.decision_signature, OLD.decision_signed_at) THEN
    RAISE EXCEPTION 'La firma del presupuesto no cambia';
  END IF;
  RETURN NEW;
END;
$$;
