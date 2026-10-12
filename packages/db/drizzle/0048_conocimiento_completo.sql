CREATE TABLE "agent_knowledge_gap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"question" text NOT NULL,
	"query" text NOT NULL,
	"status" text DEFAULT 'abierta' NOT NULL,
	"resolved_entry_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_gap_status_check" CHECK ("agent_knowledge_gap"."status" in ('abierta','resuelta','descartada'))
);
--> statement-breakpoint
ALTER TABLE "agent_decision_log" DROP CONSTRAINT "agent_decision_log_mode_check";--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD COLUMN "ask_forms" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD COLUMN "basic_key" text;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_resolved_entry_id_agent_knowledge_entry_id_fk" FOREIGN KEY ("resolved_entry_id") REFERENCES "public"."agent_knowledge_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_knowledge_gap_org_idx" ON "agent_knowledge_gap" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_knowledge_gap_conversation_idx" ON "agent_knowledge_gap" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "agent_decision_log" ADD CONSTRAINT "agent_decision_log_mode_check" CHECK ("agent_decision_log"."mode" in ('shadow','retrieval'));--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD CONSTRAINT "agent_knowledge_entry_validity_check" CHECK ("agent_knowledge_entry"."valid_from" is null or "agent_knowledge_entry"."valid_until" is null or "agent_knowledge_entry"."valid_until" >= "agent_knowledge_entry"."valid_from");--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_knowledge_gap"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Se registra y se resuelve; nunca se borra: es la historia de lo que faltaba.
GRANT SELECT, INSERT, UPDATE ON "agent_knowledge_gap" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_knowledge_gap" FROM dentalagent_app;
