ALTER TABLE "consent_template" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_template" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;