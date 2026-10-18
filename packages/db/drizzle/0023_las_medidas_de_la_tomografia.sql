CREATE TABLE "imaging_measurement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"view" text NOT NULL,
	"points" jsonb NOT NULL,
	"value" real NOT NULL,
	"tooth_number" smallint,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	CONSTRAINT "imaging_measurement_kind_check" CHECK ("imaging_measurement"."kind" IN ('distancia','angulo')),
	CONSTRAINT "imaging_measurement_view_check" CHECK ("imaging_measurement"."view" IN ('panoramica','transversal','axial','coronal','sagital')),
	CONSTRAINT "imaging_measurement_value_check" CHECK ("imaging_measurement"."value" >= 0 AND ("imaging_measurement"."kind" <> 'angulo' OR "imaging_measurement"."value" <= 180)),
	CONSTRAINT "imaging_measurement_retired_check" CHECK (("imaging_measurement"."retired_at" IS NULL) = ("imaging_measurement"."retired_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_study_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."imaging_study"("organization_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_measurement_org_document_idx" ON "imaging_measurement" USING btree ("organization_id","document_id");