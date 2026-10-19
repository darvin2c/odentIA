-- Permisos del rol de la app (ADR 0063).

-- Una tabla nueva nace cerrada para el rol de las clínicas: cada migración que
-- crea una tabla le concede con GRANT lo que la aplicación necesita. Antes
-- nacía con lectura y escritura completas, y una tabla solo de odentIA que
-- olvidara su REVOKE quedaba abierta a cualquier clínica sin que nada fallara.
-- Sin FOR ROLE vale para quien migra, el mismo owner que el init de la imagen.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM dentalagent_app;--> statement-breakpoint

-- Vendedores y sus liquidaciones son de odentIA: solo el admin los lee y los
-- escribe, con owner. El rol de la app veía el porcentaje de cada vendedor y lo
-- que se le pagó, con las clínicas de cada línea, sin RLS.
REVOKE ALL ON TABLE public.saas_seller FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_commission_settlement FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_commission_settlement_line FROM dentalagent_app;
