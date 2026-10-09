CREATE TABLE "agent_decision_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"trigger_message_id" uuid,
	"point" text NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"state_hash" text NOT NULL,
	"state_chars" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"outcome" jsonb,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_decision_log_mode_check" CHECK ("agent_decision_log"."mode" in ('shadow'))
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "decision_provider" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_decision_log" ADD CONSTRAINT "agent_decision_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decision_log_org_idx" ON "agent_decision_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_decision_log_conversation_idx" ON "agent_decision_log" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_decision_provider_check" CHECK ("agent_config"."decision_provider" in ('none','baseline','jev','openai_decisions'));--> statement-breakpoint
ALTER TABLE "agent_decision_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_decision_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_decision_log"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Libro append-only: el rol app registra y lee, nunca corrige ni borra.
GRANT SELECT, INSERT ON "agent_decision_log" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "agent_decision_log" FROM dentalagent_app;
