-- «Retomar una oportunidad» funciona como las demás líneas del Administrador
-- (ADR 0023): el Administrador detecta, Recepción escribe con el mensaje del
-- catálogo y el equipo atiende lo que no se resuelve solo. Se retira el camino
-- viejo: la coordinación comercial y las propuestas sin hilo que esperaban que
-- el equipo las aprobara. Ninguna propuesta espera al equipo, así que nadie la
-- rechaza: la que nadie confirma, expira. odentIA no está en producción: lo que
-- quedaba de ese camino (solo desarrollo) no se conserva.
ALTER TABLE "commercial_follow_up_coordination" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "commercial_follow_up_coordination" CASCADE;--> statement-breakpoint
DELETE FROM "agent_proposal" WHERE "conversation_id" IS NULL;--> statement-breakpoint
UPDATE "agent_proposal" SET "status" = 'expirada', "updated_at" = now() WHERE "status" = 'rechazada';--> statement-breakpoint
DELETE FROM "workspace_notification" WHERE "dedupe_key" LIKE 'agent-approval:%' OR "dedupe_key" LIKE 'commercial-coordination%';--> statement-breakpoint
ALTER TABLE "agent_proposal" DROP CONSTRAINT "agent_proposal_status_check";--> statement-breakpoint
ALTER TABLE "agent_proposal" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_status_check" CHECK ("agent_proposal"."status" in ('propuesta','aprobada','ejecutada','fallida','expirada'));
