CREATE TABLE "commission_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"professional_user_id" text NOT NULL,
	"service_id" uuid,
	"effective_from" timestamp with time zone NOT NULL,
	"rate_bps" integer,
	"fixed_cents" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rate_rate_check" CHECK ("commission_rate"."rate_bps" IS NULL OR "commission_rate"."rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "commission_rate_fixed_check" CHECK ("commission_rate"."fixed_cents" IS NULL OR "commission_rate"."fixed_cents" > 0),
	CONSTRAINT "commission_rate_one_check" CHECK ("commission_rate"."rate_bps" IS NULL OR "commission_rate"."fixed_cents" IS NULL),
	CONSTRAINT "commission_rate_general_check" CHECK ("commission_rate"."service_id" IS NOT NULL OR ("commission_rate"."rate_bps" IS NOT NULL AND "commission_rate"."fixed_cents" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "commission_sessions" smallint;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "slice" smallint;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "sessions" smallint;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "fixed_cents" integer;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "for_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rate_general_uidx" ON "commission_rate" USING btree ("organization_id","professional_user_id","effective_from") WHERE "commission_rate"."service_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rate_service_uidx" ON "commission_rate" USING btree ("organization_id","professional_user_id","service_id","effective_from") WHERE "commission_rate"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rate_org_id_uidx" ON "commission_rate" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "commission_line_org_application_idx" ON "commission_settlement_line" USING btree ("organization_id","application_id");--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_commission_sessions_check" CHECK ("patient_charge"."commission_sessions" IS NULL OR "patient_charge"."commission_sessions" BETWEEN 2 AND 60);