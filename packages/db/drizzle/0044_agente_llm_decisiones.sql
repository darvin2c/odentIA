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
ALTER TABLE "agent_run_ledger" DROP CONSTRAINT "agent_run_ledger_status_check";--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD COLUMN "llm_calls" integer;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "llm_base_url" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "llm_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "daily_run_limit" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "decision_provider" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_decision_log" ADD CONSTRAINT "agent_decision_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decision_log_org_idx" ON "agent_decision_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_decision_log_conversation_idx" ON "agent_decision_log" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD CONSTRAINT "agent_run_ledger_status_check" CHECK ("agent_run_ledger"."status" in ('ok','handoff','error','omitida','sin_respuesta'));--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_llm_pair_check" CHECK (("agent_config"."llm_base_url" is null) = ("agent_config"."llm_api_key_encrypted" is null));--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_daily_run_limit_check" CHECK ("agent_config"."daily_run_limit" between 1 and 100000);--> statement-breakpoint
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
