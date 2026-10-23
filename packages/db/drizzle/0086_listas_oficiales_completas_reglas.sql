-- Listas oficiales completas (ADR 0079, entrega 7). Qué códigos usa cada
-- producto es un catálogo global: el rol app solo lo lee.
GRANT SELECT ON TABLE catalog.procedure_code_product TO dentalagent_app;
