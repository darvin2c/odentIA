ALTER TABLE "saas_action" ADD COLUMN "tier_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_action" ADD COLUMN "previous_price_micros" bigint;