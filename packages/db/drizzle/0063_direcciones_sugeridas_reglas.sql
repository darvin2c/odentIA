-- La cuenta diaria de búsquedas de direcciones (issue 36): de cada clínica.
-- La aplicación la lee y la suma; no la borra.
GRANT SELECT,INSERT,UPDATE ON TABLE public.address_lookup_day TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.address_lookup_day ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.address_lookup_day FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.address_lookup_day USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));
