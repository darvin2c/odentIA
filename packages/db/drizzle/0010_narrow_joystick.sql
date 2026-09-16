CREATE TABLE "service_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'medical' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"duration_min" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_catalog_org_code_uidx" ON "service_catalog" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "service_catalog_org_active_idx" ON "service_catalog" USING btree ("organization_id","is_active");--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_service_idx" ON "treatment_plan_item" USING btree ("organization_id","service_id");--> statement-breakpoint
ALTER TABLE "service_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_catalog" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "service_catalog"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
REVOKE DELETE ON "service_catalog" FROM "dentalagent_app";