ALTER TABLE "agent_config" ADD COLUMN "persona_name" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "treatment" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "tone" text DEFAULT 'cercano' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "about" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "disabled_functions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "function_notes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "active_from_min" integer;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "active_until_min" integer;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "channels" text[];--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "sandbox_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_treatment_check" CHECK ("agent_config"."treatment" is null or "agent_config"."treatment" in ('tu','usted'));--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_tone_check" CHECK ("agent_config"."tone" in ('cercano','neutro','formal'));--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_active_hours_check" CHECK (("agent_config"."active_from_min" is null) = ("agent_config"."active_until_min" is null) and ("agent_config"."active_from_min" is null or ("agent_config"."active_from_min" between 0 and 1439 and "agent_config"."active_until_min" between 1 and 1440 and "agent_config"."active_from_min" <> "agent_config"."active_until_min")));