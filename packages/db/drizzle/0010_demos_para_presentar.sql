CREATE TABLE "admin"."saas_demo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"product" text NOT NULL,
	"kind" text NOT NULL,
	"size" text NOT NULL,
	"months" integer NOT NULL,
	"country_code" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"presenter_user_id" text NOT NULL,
	"created_by" text NOT NULL,
	"seed" integer NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"progress" jsonb,
	"error" text,
	"history_through" date,
	"advanced_on" date,
	"opened_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_demo_product_check" CHECK ("admin"."saas_demo"."product" IN ('dental','medical')),
	CONSTRAINT "saas_demo_size_check" CHECK ("admin"."saas_demo"."size" IN ('pequeno','mediano','grande')),
	CONSTRAINT "saas_demo_months_check" CHECK ("admin"."saas_demo"."months" IN (6, 12, 24)),
	CONSTRAINT "saas_demo_status_check" CHECK ("admin"."saas_demo"."status" IN ('pendiente','creando','lista','fallida'))
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_demo" ADD CONSTRAINT "saas_demo_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_demo" ADD CONSTRAINT "saas_demo_presenter_user_id_fkey" FOREIGN KEY ("presenter_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_demo" ADD CONSTRAINT "saas_demo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_demo_organization_uidx" ON "admin"."saas_demo" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_demo_slug_uidx" ON "admin"."saas_demo" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "saas_demo_status_idx" ON "admin"."saas_demo" USING btree ("status");