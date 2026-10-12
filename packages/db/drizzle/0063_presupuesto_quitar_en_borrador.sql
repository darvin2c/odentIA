-- Un borrador no lo ha recibido nadie: mientras el presupuesto está en
-- borrador se le puede quitar un tratamiento. Entregado, sus líneas siguen
-- siendo evidencia y no se borran (ni cambian, salvo la decisión).
CREATE OR REPLACE FUNCTION treatment_budget_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO budget_status FROM treatment_budget WHERE id = OLD.budget_id AND organization_id = OLD.organization_id;
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'Las líneas de un presupuesto entregado no se borran';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan líneas a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.plan_id,NEW.budget_id,NEW.plan_item_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.plan_id,OLD.budget_id,OLD.plan_item_id) THEN
      RAISE EXCEPTION 'La identidad de la línea de presupuesto es inmutable';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (to_jsonb(NEW)-'decision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'decision'-'updated_at') THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite cambios de decisión';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
GRANT DELETE ON "treatment_budget_item" TO "dentalagent_app";
