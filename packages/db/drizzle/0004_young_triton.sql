ALTER TABLE "message" ADD COLUMN "template_name" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "template_language" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "template_params" jsonb;