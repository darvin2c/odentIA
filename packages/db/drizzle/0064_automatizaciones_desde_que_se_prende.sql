ALTER TABLE "automation_job" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD COLUMN "enabled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "automation_job_org_message_idx" ON "automation_job" USING btree ("organization_id","sent_message_id");
--> statement-breakpoint
-- Las reglas que ya estaban prendidas cuentan desde ahora: no escriben por nada anterior.
UPDATE "automation_rule" SET "enabled_at" = now() WHERE "enabled";
