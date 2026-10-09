ALTER TABLE "agent_config" ADD COLUMN "llm_base_url" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "llm_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "daily_run_limit" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_llm_pair_check" CHECK (("agent_config"."llm_base_url" is null) = ("agent_config"."llm_api_key_encrypted" is null));--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_daily_run_limit_check" CHECK ("agent_config"."daily_run_limit" between 1 and 100000);