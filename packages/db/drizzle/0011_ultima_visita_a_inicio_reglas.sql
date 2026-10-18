-- home_visit: cada clínica ve solo lo suyo; la aplicación no borra visitas.
ALTER TABLE public.home_visit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.home_visit FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.home_visit USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.home_visit FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.home_visit TO dentalagent_app;
