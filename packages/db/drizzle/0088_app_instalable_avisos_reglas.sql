-- Equipos que reciben los avisos (push web): lo que TS no declara. Nace cerrada al rol
-- de la aplicación (ADR 0063) y aislada por clínica; quién es la persona lo filtra el
-- servicio. Quien deja la clínica no recibe nada: el worker mira la membresía al enviar
-- y borra la suscripción.
ALTER TABLE public.push_subscription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.push_subscription FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.push_subscription USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.push_subscription TO dentalagent_app;
