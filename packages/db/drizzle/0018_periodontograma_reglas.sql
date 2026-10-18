-- Periodontograma (issue 49, ADR 0054): cada clínica ve solo lo suyo; se
-- escribe solo mientras su atención está en borrador y, al firmarla, queda fijo
-- como el resto de la atención. La aplicación no borra: limpiar una pieza es
-- guardarla sin medidas.
CREATE FUNCTION public.guard_periodontal_draft() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  encounter_status text;
BEGIN
  IF TG_TABLE_NAME = 'periodontal_chart' THEN
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.patient_id, NEW.encounter_id, NEW.expected_teeth, NEW.implant_teeth, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.patient_id, OLD.encounter_id, OLD.expected_teeth, OLD.implant_teeth, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Las piezas de un periodontograma se fijan al empezarlo' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
    END IF;
    SELECT e.status INTO encounter_status FROM encounter e
      WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id;
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.chart_id, NEW.tooth_number, NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.chart_id, OLD.tooth_number, OLD.created_at) THEN
      RAISE EXCEPTION 'Una pieza del periodontograma no cambia de periodontograma ni de número' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
    END IF;
    SELECT e.status INTO encounter_status FROM periodontal_chart c
      JOIN encounter e ON e.organization_id = c.organization_id AND e.id = c.encounter_id
      WHERE c.id = NEW.chart_id AND c.organization_id = NEW.organization_id;
  END IF;
  IF encounter_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'El periodontograma de una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER periodontal_chart_draft_only BEFORE INSERT OR UPDATE ON public.periodontal_chart FOR EACH ROW EXECUTE FUNCTION public.guard_periodontal_draft();--> statement-breakpoint
CREATE TRIGGER periodontal_tooth_draft_only BEFORE INSERT OR UPDATE ON public.periodontal_tooth FOR EACH ROW EXECUTE FUNCTION public.guard_periodontal_draft();--> statement-breakpoint
ALTER TABLE public.periodontal_chart ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.periodontal_chart FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.periodontal_chart USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.periodontal_chart FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.periodontal_chart TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.periodontal_tooth ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.periodontal_tooth FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.periodontal_tooth USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.periodontal_tooth FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.periodontal_tooth TO dentalagent_app;
