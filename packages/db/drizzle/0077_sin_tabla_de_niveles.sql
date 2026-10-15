-- Sin tabla de niveles (ADR 0021): quién dice que sí a cada acción del agente es
-- fijo en el código (`DEFAULT_AUTONOMY_MODES`) y ninguna clínica lo cambia. La
-- tabla solo la usaban las pruebas; sin producción no hay datos que conservar.
DROP TABLE "agent_policy" CASCADE;
