ALTER TABLE "agent_config" DROP CONSTRAINT "agent_config_llm_pair_check";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "llm_base_url";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "llm_api_key_encrypted";--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "llm" text DEFAULT 'chatgpt_6' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_llm_check" CHECK ("agent_config"."llm" in ('chatgpt_6','claude_5_5'));