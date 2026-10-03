-- Reentrega del mismo trigger del agente (webhook duplicado): la tarea se
-- crea una sola vez por clave de idempotencia. Nula en tareas de usuarios.
ALTER TABLE "task" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_idempotency_uidx" ON "task" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
