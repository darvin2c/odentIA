-- Sofi responde siempre (ADR 0084): sin «A qué horas responde» ni «Canales».
-- El único horario es el de recontacto (`writing_hours`).
ALTER TABLE "agent_config" DROP CONSTRAINT "agent_config_active_hours_check";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "active_from_min";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "active_until_min";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "channels";