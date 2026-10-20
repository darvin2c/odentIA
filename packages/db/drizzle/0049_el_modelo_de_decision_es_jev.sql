-- OpenAI Decisions se retira (ADR 0047, issue 154): Jev es el modelo de
-- decisión de toda clínica y odentIA no tiene cuenta de OpenAI Decisions, así
-- que una fila con ese proveedor fallaba con «sin credenciales». Pasa a Jev
-- antes de cerrar la restricción; no hay clínicas reales que conservar.
UPDATE "agent_config" SET "decision_provider" = 'jev', "updated_at" = now() WHERE "decision_provider" = 'openai_decisions';--> statement-breakpoint
ALTER TABLE "agent_config" DROP CONSTRAINT "agent_config_decision_provider_check";--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_decision_provider_check" CHECK ("agent_config"."decision_provider" in ('none','baseline','jev'));
