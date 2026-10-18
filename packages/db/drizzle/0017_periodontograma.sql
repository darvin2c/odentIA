CREATE TABLE "periodontal_chart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"expected_teeth" smallint[] NOT NULL,
	"implant_teeth" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"diagnosis" text,
	"stage" smallint,
	"grade" text,
	"extent" text,
	"bone_loss_percent" smallint,
	"teeth_lost_to_periodontitis" smallint,
	"cigarettes_per_day" smallint,
	"diabetes" boolean,
	"hba1c" numeric(3, 1),
	"periodontitis_status" text,
	"classified_by" text,
	"classified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periodontal_chart_diagnosis_check" CHECK ("periodontal_chart"."diagnosis" IS NULL OR "periodontal_chart"."diagnosis" IN ('health','gingivitis','periodontitis')),
	CONSTRAINT "periodontal_chart_stage_check" CHECK (("periodontal_chart"."diagnosis" = 'periodontitis') = ("periodontal_chart"."stage" IS NOT NULL AND "periodontal_chart"."grade" IS NOT NULL) AND ("periodontal_chart"."stage" IS NULL OR "periodontal_chart"."stage" BETWEEN 1 AND 4) AND ("periodontal_chart"."grade" IS NULL OR "periodontal_chart"."grade" IN ('A','B','C'))),
	CONSTRAINT "periodontal_chart_extent_check" CHECK (("periodontal_chart"."diagnosis" IS NULL OR "periodontal_chart"."diagnosis" = 'health') = ("periodontal_chart"."extent" IS NULL) AND ("periodontal_chart"."extent" IS NULL OR "periodontal_chart"."extent" IN ('localized','generalized') OR ("periodontal_chart"."diagnosis" = 'periodontitis' AND "periodontal_chart"."extent" = 'molar_incisor'))),
	CONSTRAINT "periodontal_chart_status_check" CHECK ("periodontal_chart"."periodontitis_status" IS NULL OR ("periodontal_chart"."diagnosis" = 'periodontitis' AND "periodontal_chart"."periodontitis_status" IN ('stable','remission','unstable'))),
	CONSTRAINT "periodontal_chart_classified_check" CHECK (("periodontal_chart"."diagnosis" IS NULL) = ("periodontal_chart"."classified_at" IS NULL) AND ("periodontal_chart"."classified_at" IS NULL) = ("periodontal_chart"."classified_by" IS NULL)),
	CONSTRAINT "periodontal_chart_inputs_check" CHECK (("periodontal_chart"."bone_loss_percent" IS NULL OR "periodontal_chart"."bone_loss_percent" BETWEEN 0 AND 100) AND ("periodontal_chart"."teeth_lost_to_periodontitis" IS NULL OR "periodontal_chart"."teeth_lost_to_periodontitis" BETWEEN 0 AND 32) AND ("periodontal_chart"."cigarettes_per_day" IS NULL OR "periodontal_chart"."cigarettes_per_day" BETWEEN 0 AND 200) AND ("periodontal_chart"."hba1c" IS NULL OR ("periodontal_chart"."diabetes" AND "periodontal_chart"."hba1c" BETWEEN 3 AND 20)))
);
--> statement-breakpoint
CREATE TABLE "periodontal_tooth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"chart_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"probing_depth" smallint[] NOT NULL,
	"recession" smallint[] NOT NULL,
	"bleeding" boolean[] NOT NULL,
	"suppuration" boolean[] NOT NULL,
	"mobility" smallint,
	"furcation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plaque" boolean[],
	"peri_implant" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periodontal_tooth_fdi_check" CHECK ("periodontal_tooth"."tooth_number" IN (11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48)),
	CONSTRAINT "periodontal_tooth_sites_check" CHECK (cardinality("periodontal_tooth"."probing_depth") = 6 AND cardinality("periodontal_tooth"."recession") = 6 AND cardinality("periodontal_tooth"."bleeding") = 6 AND cardinality("periodontal_tooth"."suppuration") = 6),
	CONSTRAINT "periodontal_tooth_ranges_check" CHECK (0 <= ALL("periodontal_tooth"."probing_depth") AND 15 >= ALL("periodontal_tooth"."probing_depth") AND -10 <= ALL("periodontal_tooth"."recession") AND 15 >= ALL("periodontal_tooth"."recession")),
	CONSTRAINT "periodontal_tooth_mobility_check" CHECK ("periodontal_tooth"."mobility" IS NULL OR "periodontal_tooth"."mobility" BETWEEN 0 AND 3),
	CONSTRAINT "periodontal_tooth_furcation_check" CHECK (jsonb_typeof("periodontal_tooth"."furcation") = 'object'),
	CONSTRAINT "periodontal_tooth_plaque_check" CHECK ("periodontal_tooth"."plaque" IS NULL OR cardinality("periodontal_tooth"."plaque") = 4),
	CONSTRAINT "periodontal_tooth_peri_implant_check" CHECK ("periodontal_tooth"."peri_implant" IS NULL OR "periodontal_tooth"."peri_implant" IN ('health','mucositis','peri_implantitis'))
);
--> statement-breakpoint
ALTER TABLE "periodontal_chart" ADD CONSTRAINT "periodontal_chart_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodontal_chart" ADD CONSTRAINT "periodontal_chart_classified_by_user_id_fk" FOREIGN KEY ("classified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodontal_chart" ADD CONSTRAINT "periodontal_chart_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodontal_chart" ADD CONSTRAINT "periodontal_chart_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodontal_tooth" ADD CONSTRAINT "periodontal_tooth_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodontal_tooth" ADD CONSTRAINT "periodontal_tooth_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- La clave compuesta de la pieza necesita antes el índice único (organización, id).
CREATE UNIQUE INDEX "periodontal_chart_org_id_uidx" ON "periodontal_chart" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "periodontal_tooth" ADD CONSTRAINT "periodontal_tooth_chart_fk" FOREIGN KEY ("organization_id","chart_id") REFERENCES "public"."periodontal_chart"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "periodontal_chart_encounter_uidx" ON "periodontal_chart" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "periodontal_chart_org_patient_idx" ON "periodontal_chart" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "periodontal_tooth_chart_tooth_uidx" ON "periodontal_tooth" USING btree ("chart_id","tooth_number");