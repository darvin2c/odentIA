-- Pedidos sobre sus datos (issue 50, ADR 0080): de cada clínica. La aplicación
-- los registra, los comprueba y los responde; nunca los borra.
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_data_request TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.patient_data_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_data_request FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_data_request USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));
