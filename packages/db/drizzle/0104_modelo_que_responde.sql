-- Recepción solo se enciende con un modelo que responde (fase 4, tablero 3).
-- 1) La comprobación «El modelo responde» es una llamada pagada: se anota en
--    el libro de uso de IA con su propio origen (ADR 0031).
ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_origin_check";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_origin_check" CHECK ("ai_usage"."origin" in ('recepcion','probar','simulacion','vista_previa','dictado','practica_dictado','administrador','ya_aviso','vectores','transcripcion','comprobacion'));--> statement-breakpoint
-- 2) «Modelo sin responder» es un caso automático de odentIA: no lo abre una
--    persona ni es de una clínica (un mismo motivo junta a varias). Sin autor,
--    el caso tampoco puede tener organización: ninguna clínica lo ve.
ALTER TABLE "support_case" ALTER COLUMN "opened_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_opener_check" CHECK ("support_case"."opened_by" is not null or "support_case"."organization_id" is null);
