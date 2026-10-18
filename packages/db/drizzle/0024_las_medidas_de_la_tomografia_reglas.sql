-- imaging_measurement (ADR 0056): cada clínica ve solo lo suyo; la aplicación
-- no borra ni reescribe una medida: solo la retira, y lo retirado no vuelve.
ALTER TABLE public.imaging_measurement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.imaging_measurement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.imaging_measurement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.imaging_measurement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.imaging_measurement TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_at) ON TABLE public.imaging_measurement TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_by) ON TABLE public.imaging_measurement TO dentalagent_app;--> statement-breakpoint
CREATE FUNCTION public.imaging_measurement_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'La medida ya se quitó'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER imaging_measurement_guard_update BEFORE UPDATE ON public.imaging_measurement FOR EACH ROW EXECUTE FUNCTION public.imaging_measurement_guard_update();
