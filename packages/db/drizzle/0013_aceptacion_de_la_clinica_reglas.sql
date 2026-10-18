-- processing_agreement_acceptance: cada clínica ve solo lo suyo; la aceptación no se reescribe ni se borra.
ALTER TABLE public.processing_agreement_acceptance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.processing_agreement_acceptance FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.processing_agreement_acceptance USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.processing_agreement_acceptance FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.processing_agreement_acceptance TO dentalagent_app;--> statement-breakpoint
-- legal_notice: solo el envío de la plataforma (owner) la escribe.
REVOKE ALL ON TABLE public.legal_notice FROM dentalagent_app;
