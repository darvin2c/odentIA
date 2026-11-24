CREATE TABLE "admin"."saas_web_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"product" text NOT NULL,
	"source_page" text NOT NULL,
	"sheets" text[] DEFAULT '{}'::text[] NOT NULL,
	"client_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_web_contact_email_check" CHECK ("admin"."saas_web_contact"."email" = lower("admin"."saas_web_contact"."email") AND length("admin"."saas_web_contact"."email") BETWEEN 3 AND 254),
	CONSTRAINT "saas_web_contact_product_check" CHECK ("admin"."saas_web_contact"."product" IN ('dental','medical','optical')),
	CONSTRAINT "saas_web_contact_page_check" CHECK ("admin"."saas_web_contact"."source_page" ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$' AND length("admin"."saas_web_contact"."source_page") <= 160),
	CONSTRAINT "saas_web_contact_sheets_check" CHECK ("admin"."saas_web_contact"."sheets" <@ ARRAY['odontograma','odontograma-ninos','presupuesto']::text[])
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD COLUMN "source_page" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_web_contact" ADD CONSTRAINT "saas_web_contact_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_web_contact_email_idx" ON "admin"."saas_web_contact" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "saas_web_contact_client_idx" ON "admin"."saas_web_contact" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_source_page_check" CHECK ("admin"."saas_waitlist_request"."source_page" IS NULL OR "admin"."saas_waitlist_request"."source_page" ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$' AND length("admin"."saas_waitlist_request"."source_page") <= 160);