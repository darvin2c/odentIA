-- «Mi calendario» (issue 46, ADR 0082). El enlace se crea, se cambia y se
-- apaga, nunca se borra: revocarlo deja su historia. Su registro de uso suma
-- una fila por día y programa y se borra a los 90 días, por eso tiene DELETE.
GRANT SELECT,INSERT ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(status,known_clients,revoked_at,revoked_by,revoke_reason,updated_at) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.calendar_feed ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.calendar_feed FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.calendar_feed USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.calendar_feed_use TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(hits,last_at) ON TABLE public.calendar_feed_use TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.calendar_feed_use ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.calendar_feed_use FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.calendar_feed_use USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));
