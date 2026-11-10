CREATE TABLE "clinical_follow_up_item" (
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"follow_up_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_follow_up_item_follow_up_id_plan_item_id_pk" PRIMARY KEY("follow_up_id","plan_item_id")
);
--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD COLUMN "finish_after_days" smallint;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "session_gap_days" smallint;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "finish_controls" jsonb;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "session_gap_days" smallint;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "finish_controls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_follow_up_org_patient_id_uidx" ON "clinical_follow_up" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
ALTER TABLE "clinical_follow_up_item" ADD CONSTRAINT "clinical_follow_up_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up_item" ADD CONSTRAINT "clinical_follow_up_item_follow_up_fk" FOREIGN KEY ("organization_id","patient_id","follow_up_id") REFERENCES "public"."clinical_follow_up"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up_item" ADD CONSTRAINT "clinical_follow_up_item_plan_item_fk" FOREIGN KEY ("organization_id","patient_id","plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_follow_up_item_plan_item_idx" ON "clinical_follow_up_item" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_session_gap_check" CHECK ("service_catalog"."session_gap_days" IS NULL OR "service_catalog"."session_gap_days" BETWEEN 0 AND 120);--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_finish_controls_check" CHECK ("service_catalog"."finish_controls" IS NULL OR jsonb_typeof("service_catalog"."finish_controls") = 'array');--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD CONSTRAINT "treatment_template_session_gap_check" CHECK ("catalog"."treatment_template"."session_gap_days" IS NULL OR "catalog"."treatment_template"."session_gap_days" BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD CONSTRAINT "treatment_template_finish_controls_check" CHECK (jsonb_typeof("catalog"."treatment_template"."finish_controls") = 'array');