-- Argos en Reportes, metas y el resumen del lunes: reglas (ADR 0070 y 0071).

-- 1. Cada tabla nace cerrada al rol de la app (ADR 0063) y aislada por clínica.
-- Las preguntas solo se anotan: no se cambian ni se borran.
GRANT SELECT,INSERT ON TABLE public.report_question TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.report_question ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_question FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_question USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Una respuesta fijada se pone y se quita; no se edita.
GRANT SELECT,INSERT,DELETE ON TABLE public.report_pin TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.report_pin ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_pin FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_pin USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Una meta se cambia dentro de su mes; las de meses pasados quedan como estaban.
GRANT SELECT,INSERT,UPDATE ON TABLE public.report_goal TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.report_goal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_goal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_goal USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

GRANT SELECT,INSERT,UPDATE ON TABLE public.report_digest TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.report_digest ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_digest FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_digest USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

GRANT SELECT,INSERT,UPDATE ON TABLE public.report_digest_send TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.report_digest_send ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_digest_send FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_digest_send USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- 2. Hasta cuatro respuestas fijadas por clínica (decisión 8), también con dos
-- personas fijando a la vez: el candado de la clínica ordena las inserciones.
CREATE FUNCTION public.report_pin_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('report_pin:' || NEW.organization_id));
  IF (SELECT count(*) FROM public.report_pin WHERE organization_id = NEW.organization_id) >= 4 THEN
    RAISE EXCEPTION 'Ya hay cuatro respuestas fijadas en el Resumen' USING ERRCODE = 'check_violation', CONSTRAINT = 'report_pin_limit';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER report_pin_limit BEFORE INSERT ON public.report_pin FOR EACH ROW EXECUTE FUNCTION public.report_pin_limit();
