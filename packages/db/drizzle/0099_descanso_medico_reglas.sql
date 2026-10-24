-- Descanso médico (issue 229, decisión 8): de la clínica, con su RLS; el rol de la
-- aplicación lee, emite y anula, nunca borra (como la receta y la orden).
ALTER TABLE public.medical_leave ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.medical_leave FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.medical_leave USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.medical_leave FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.medical_leave TO dentalagent_app;
