-- saas_action_review (ADR 0054): la clínica pide y lee sus revisiones; decidir
-- y anotar el cargo que la devolvió es del personal de odentIA, con owner.
ALTER TABLE public.saas_action_review ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_action_review FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_action_review USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_action_review FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.saas_action_review TO dentalagent_app;
