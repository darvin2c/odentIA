-- «Conectar con Facebook» de Messenger e Instagram vuelve por OAuth como Gmail: su
-- state de un solo uso se guarda en la misma tabla, con su proveedor.
ALTER TABLE public.mailbox_oauth_state DROP CONSTRAINT mailbox_oauth_state_provider_check;--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_provider_check CHECK ((provider = ANY (ARRAY['gmail'::text, 'microsoft365'::text, 'meta_pages'::text])));
