ALTER TABLE "message" ADD COLUMN "send_attempted_at" timestamp with time zone;--> statement-breakpoint
-- Los estados de un mensaje (auditoría de estados del 11 nov): el que llega
-- (`received`), el que sale (`queued` en cola, `held` por entregar, `sent`,
-- `delivered`, `read`), el que no salió (`failed`) y el que no se sabe si salió
-- (`unknown`). NOT VALID: rige para todo lo que se escribe desde ahora sin
-- frenar el despliegue por una fila antigua; ninguna escritura conocida usa otro valor.
ALTER TABLE "message" ADD CONSTRAINT "message_status_check" CHECK ("status" in ('received', 'queued', 'held', 'sent', 'delivered', 'read', 'failed', 'unknown')) NOT VALID;
