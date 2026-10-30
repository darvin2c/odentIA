-- Registro de solo anexado (como la traza de respuestas): el rol app anota y lee, nunca corrige ni borra.
ALTER TABLE public.agent_action_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_action_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_action_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_action_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_action_log TO dentalagent_app;
