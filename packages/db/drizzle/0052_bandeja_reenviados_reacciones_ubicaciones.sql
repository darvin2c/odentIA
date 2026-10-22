ALTER TABLE "message" ADD COLUMN "forwarded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "contact_reaction" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "contact_reaction_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "location" jsonb;