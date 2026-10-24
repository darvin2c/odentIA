-- La conversación que sube de Informa a Gestiona guarda cuándo subió y lo que valía antes (ADR 0085):
-- el rol de la aplicación las escribe junto con el tipo, como en 0093.
GRANT UPDATE(tier_changed_at,previous_price_micros) ON TABLE public.saas_action TO dentalagent_app;
