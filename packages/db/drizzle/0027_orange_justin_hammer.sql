ALTER TABLE "portal_link" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "portal_link" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;