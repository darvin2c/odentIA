ALTER TABLE "automation_rule" DROP COLUMN "channel";--> statement-breakpoint
ALTER TABLE "automation_rule" DROP COLUMN "template_name";--> statement-breakpoint
ALTER TABLE "automation_rule" DROP COLUMN "template_language";--> statement-breakpoint
-- El agente «Asesor» pasa a llamarse «Administrador»: lo aprendido sigue siendo suyo.
UPDATE "agent_lesson" SET "scope" = 'administrador' WHERE "scope" = 'asesor';
