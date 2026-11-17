-- «Conectar con Instagram» vuelve por OAuth como Gmail y el botón de páginas: su
-- state de un solo uso se guarda en la misma tabla, con su proveedor.
ALTER TABLE public.mailbox_oauth_state DROP CONSTRAINT mailbox_oauth_state_provider_check;--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_provider_check CHECK ((provider = ANY (ARRAY['gmail'::text, 'microsoft365'::text, 'meta_pages'::text, 'instagram_login'::text])));--> statement-breakpoint
-- Las páginas que marcó en Facebook, cifradas, mientras elige una (10 minutos, un solo uso).
ALTER TABLE public.mailbox_oauth_state ADD COLUMN payload_encrypted text;