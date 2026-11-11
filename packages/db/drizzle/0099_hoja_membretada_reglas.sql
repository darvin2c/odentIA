-- La hoja membretada de la clínica (ADR 0180): lo que TS no declara. Cada versión solo se
-- agrega; la aplicación solo puede marcarla como quitada (quién y cuándo), nunca borrarla
-- ni cambiar su archivo o sus márgenes: un papel ya emitido la sigue leyendo.
ALTER TABLE public.clinic_letterhead ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinic_letterhead FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinic_letterhead USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinic_letterhead TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by) ON TABLE public.clinic_letterhead TO dentalagent_app;--> statement-breakpoint
-- Quitada no vuelve: «Deshacer» agrega otra versión con el mismo archivo.
CREATE FUNCTION public.clinic_letterhead_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'La hoja membretada ya fue quitada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clinic_letterhead_guard_update BEFORE UPDATE ON public.clinic_letterhead FOR EACH ROW EXECUTE FUNCTION public.clinic_letterhead_guard();
