-- Jev, modelo de decisión de toda clínica (ADR 0047). 0007 cambia el valor
-- por defecto de la columna para las filas nuevas; aquí pasan a Jev las
-- clínicas que ya tenían fila con «none». Las que no tienen fila toman el
-- valor por defecto del código (DEFAULTS de agentConfig.ts).
--
-- No hay clínicas reales todavía: no se conserva el valor anterior. Las filas
-- con otro proveedor («baseline», «openai_decisions») las eligió alguien a
-- propósito y no se tocan.
UPDATE "agent_config" SET "decision_provider" = 'jev', "updated_at" = now() WHERE "decision_provider" = 'none';
