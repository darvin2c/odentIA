-- La Ayuda elige su respuesta con Jev (ADR 0146). Lo que cuesta va con su propio origen, «ayuda», que paga
-- odentIA y no cuenta para la clínica; help_ask guarda qué respondió (la pregunta frecuente, como está en la
-- guía), cómo se decidió y con qué probabilidad, nunca lo que se preguntó. Las columnas nuevas quedan con el
-- GRANT de la tabla; lo de antes queda con via nula.
ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_origin_check";--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "faq" text;--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "probability" real;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_origin_check" CHECK ("ai_usage"."origin" in ('recepcion','probar','simulacion','vista_previa','dictado','practica_dictado','administrador','ya_aviso','vectores','transcripcion','comprobacion','reportes','ayuda'));--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_via_check" CHECK ("help_ask"."via" is null or "help_ask"."via" in ('exacta','jev','respaldo'));--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_verdict_check" CHECK ("help_ask"."verdict" is null or "help_ask"."verdict" in ('seguro','duda','ninguna','datos'));--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_probability_check" CHECK ("help_ask"."probability" is null or ("help_ask"."probability" >= 0 and "help_ask"."probability" <= 1));