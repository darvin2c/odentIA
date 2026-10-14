-- Sin niveles (ADR 0021): la política de autonomía es fija para todas las
-- clínicas. Se olvida lo que cada una eligió como nivel; sin fila, rige la fija.
DELETE FROM "agent_policy";--> statement-breakpoint
-- Sin niveles ya no hay mensajes del Administrador que esperen aprobación: lo
-- que quedó en «por_aprobar» no sale y se cierra con su motivo.
UPDATE "automation_job" SET "status" = 'cancelado', "last_error" = 'El mensaje esperaba una aprobación que ya no existe', "updated_at" = now() WHERE "status" = 'por_aprobar';
