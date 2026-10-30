ALTER TABLE "service_catalog" ADD COLUMN "patient_guide" jsonb;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "patient_guide_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "patient_guide_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "findings" text;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "proposal" text;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "delivered_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "decided_via" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "patient_guide" jsonb;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD COLUMN "pros" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD COLUMN "cons" text;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "patient_guide" jsonb;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "budget_valid_days" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "budget_payment_terms" text DEFAULT 'Cada tratamiento se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.';--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "budget_change_terms" text DEFAULT 'Solo por algo que no se podía ver antes de empezar. Se le explica y le entregamos un presupuesto nuevo para que decida; nada se cobra sin su aceptación.';--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_patient_guide_reviewed_by_user_id_fk" FOREIGN KEY ("patient_guide_reviewed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_decided_via_check" CHECK ("treatment_budget"."decided_via" IS NULL OR "treatment_budget"."decided_via" IN ('enlace','portal','conversacion','clinica'));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_budget_valid_days_check" CHECK ("org_profile"."budget_valid_days" BETWEEN 1 AND 365);--> statement-breakpoint
-- latidIA habla de atenciones: sus clínicas de hoy y las nuevas parten de esa
-- misma frase. El texto de cada clínica se edita en su perfil.
UPDATE "org_profile" SET "budget_payment_terms" = 'Cada atención se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.' WHERE "product" = 'medical';--> statement-breakpoint
CREATE FUNCTION public.org_profile_budget_terms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.product = 'medical' AND NEW.budget_payment_terms = 'Cada tratamiento se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.' THEN
    NEW.budget_payment_terms := 'Cada atención se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER org_profile_budget_terms BEFORE INSERT ON public.org_profile FOR EACH ROW EXECUTE FUNCTION public.org_profile_budget_terms();--> statement-breakpoint
-- Lo entregado no cambia: la opción conserva su nombre y lo que se le dijo al
-- elegir, y el presupuesto, lo encontrado, lo propuesto y su vigencia.
CREATE OR REPLACE FUNCTION public.treatment_budget_option_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO budget_status FROM treatment_budget WHERE id = OLD.budget_id AND organization_id = OLD.organization_id;
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'Las opciones de un presupuesto entregado no se quitan';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan opciones a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.budget_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.budget_id) THEN
      RAISE EXCEPTION 'La opción no cambia de presupuesto';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (NEW.position, NEW.is_recommended, NEW.name, NEW.pros, NEW.cons) IS DISTINCT FROM (OLD.position, OLD.is_recommended, OLD.name, OLD.pros, OLD.cons) THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite elegir una opción';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.treatment_budget_delivered_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status <> 'borrador' AND (NEW.valid_until, NEW.findings, NEW.proposal, NEW.delivered_snapshot) IS DISTINCT FROM (OLD.valid_until, OLD.findings, OLD.proposal, OLD.delivered_snapshot) THEN
    RAISE EXCEPTION 'Lo entregado en el presupuesto no cambia';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER treatment_budget_delivered_guard_trigger BEFORE UPDATE ON public.treatment_budget FOR EACH ROW EXECUTE FUNCTION public.treatment_budget_delivered_guard();
