-- imaging_study / imaging_study_file (ADR 0054): cada clínica ve solo lo suyo.
-- La aplicación no borra: una tomografía cancelada se retira desde su documento.
-- Lo que puede cambiar es lo que avanza con la subida: la miniatura, el fin de
-- la subida y, por archivo, cuándo se comprobó que llegó. Lo recibido no se deshace.
ALTER TABLE public.imaging_study ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.imaging_study FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.imaging_study USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.imaging_study FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.imaging_study TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(thumbnail_key) ON TABLE public.imaging_study TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(completed_at) ON TABLE public.imaging_study TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.imaging_study_file ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.imaging_study_file FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.imaging_study_file USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.imaging_study_file FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.imaging_study_file TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(uploaded_at) ON TABLE public.imaging_study_file TO dentalagent_app;--> statement-breakpoint
CREATE FUNCTION public.imaging_study_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'La tomografía ya terminó de subirse'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER imaging_study_guard_update BEFORE UPDATE ON public.imaging_study FOR EACH ROW EXECUTE FUNCTION public.imaging_study_guard_update();--> statement-breakpoint
CREATE FUNCTION public.imaging_study_file_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.uploaded_at IS NOT NULL AND NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'El archivo ya se recibió'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER imaging_study_file_guard_update BEFORE UPDATE ON public.imaging_study_file FOR EACH ROW EXECUTE FUNCTION public.imaging_study_file_guard_update();
