CREATE TABLE "legal_notice" (
	"user_id" text NOT NULL,
	"version" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_agreement_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"version" text NOT NULL,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "processing_agreement_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "processing_agreement_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "legal_notice" ADD CONSTRAINT "legal_notice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_agreement_acceptance" ADD CONSTRAINT "processing_agreement_acceptance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_agreement_acceptance" ADD CONSTRAINT "processing_agreement_acceptance_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_notice_user_version_uidx" ON "legal_notice" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_agreement_acceptance_version_uidx" ON "processing_agreement_acceptance" USING btree ("organization_id","version");