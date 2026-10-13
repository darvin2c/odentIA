DROP INDEX "automation_rule_org_kind_idx";--> statement-breakpoint
ALTER TABLE "automation_job" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD COLUMN "agent_part" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD COLUMN "team_part" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD COLUMN "no_recommend" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD COLUMN "enabled_by" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "reason" text;--> statement-breakpoint
-- Salen las campañas, el seguimiento tras la atención y la recuperación de
-- inactivos: ya no son líneas del Administrador. Sus enlaces caen en cascada.
DELETE FROM "automation_job" WHERE "kind" IN ('campana', 'seguimiento_cita', 'recuperacion_inactivo');--> statement-breakpoint
DELETE FROM "automation_rule" WHERE "kind" IN ('campana', 'seguimiento_cita', 'recuperacion_inactivo');--> statement-breakpoint
DELETE FROM "automation_consent" WHERE "purpose" = 'marketing';--> statement-breakpoint
-- Una fila por organización y línea: queda la prendida y, entre iguales, la más antigua.
DELETE FROM "automation_rule" a USING "automation_rule" b
WHERE a.organization_id = b.organization_id AND a.kind = b.kind AND a.id <> b.id
  AND (b.enabled::int > a.enabled::int OR (b.enabled = a.enabled AND (b.created_at, b.id) < (a.created_at, a.id)));--> statement-breakpoint
-- Recepción ya retomaba por su cuenta las oportunidades con la próxima acción
-- vencida: donde estaba encendida, esa línea queda prendida.
INSERT INTO "automation_rule" ("organization_id", "name", "kind", "enabled", "enabled_at")
SELECT "organization_id", 'Retomar una oportunidad', 'seguimiento_comercial', true, now()
FROM "agent_config" WHERE "enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_org_kind_uidx" ON "automation_rule" USING btree ("organization_id","kind");
