-- Fundadores (issue 165): la política de alta y la lista de espera son de la
-- plataforma. Solo las toca ownerDb (rutas de administración y la ruta pública
-- de la web); la aplicación de una clínica no las lee ni las escribe.
REVOKE ALL ON TABLE public.saas_signup_policy FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_waitlist_request FROM dentalagent_app;--> statement-breakpoint
-- Mientras dure el programa Fundadores, se abren clínicas solo con invitación.
INSERT INTO public.saas_signup_policy (id, mode) VALUES (1, 'invitacion') ON CONFLICT (id) DO NOTHING;
