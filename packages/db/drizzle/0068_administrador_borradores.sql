ALTER TABLE "automation_rule" ADD COLUMN "draft" jsonb;--> statement-breakpoint
-- Una línea creada por la clínica se puede eliminar, y descartar el borrador de
-- una que nunca se prendió la quita. Sus casos conservan su tipo (rule_id queda nulo).
GRANT DELETE ON "automation_rule" TO "dentalagent_app";
