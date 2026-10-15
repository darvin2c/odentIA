-- Un pendiente, un lugar: la campana es para enterarse. Un aviso con asunto
-- (`subject`) se retira solo cuando el asunto se resuelve (`resolved_at`; la
-- aplicación no borra avisos). Lo que pide trabajo vive en «Te espera», así que
-- se retiran los avisos que lo repetían: tarea vencida, conversación pendiente,
-- caso del agente nuevo o vencido, el agente no respondió y la conversación que
-- sigue abierta; y el aviso a quien generó su propio consentimiento.
ALTER TABLE "workspace_notification" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "workspace_notification" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_notification_subject_idx" ON "workspace_notification" USING btree ("organization_id","subject");--> statement-breakpoint
DELETE FROM "workspace_notification" WHERE "dedupe_key" LIKE 'task-due:%' OR "dedupe_key" LIKE 'conversation:%'
  OR "dedupe_key" LIKE 'agent-handoff:%' OR "dedupe_key" LIKE 'agent-handoff-overdue:%' OR "dedupe_key" LIKE 'agent-no-reply:%'
  OR "dedupe_key" LIKE 'conversation-open:%' OR "dedupe_key" LIKE 'consent-%-pendiente:%';
