CREATE TABLE "procedure_code" (
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"version" text NOT NULL,
	"display" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"replaced_by" text,
	CONSTRAINT "procedure_code_system_key_code_version_pk" PRIMARY KEY("system_key","code","version")
);
--> statement-breakpoint
CREATE TABLE "procedure_code_system" (
	"key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"country" char(2),
	"license" text NOT NULL,
	"source_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_template_code" (
	"template_id" uuid NOT NULL,
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"version" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "treatment_template_code_template_id_system_key_code_version_pk" PRIMARY KEY("template_id","system_key","code","version")
);
--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "codings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "codings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "codings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_code" ADD CONSTRAINT "procedure_code_system_key_procedure_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "public"."procedure_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_template_code" ADD CONSTRAINT "treatment_template_code_template_id_treatment_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."treatment_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_template_code" ADD CONSTRAINT "treatment_template_code_system_key_code_version_procedure_code_system_key_code_version_fk" FOREIGN KEY ("system_key","code","version") REFERENCES "public"."procedure_code"("system_key","code","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "procedure_code_system_code_idx" ON "procedure_code" USING btree ("system_key","code");--> statement-breakpoint
CREATE INDEX "treatment_template_code_reverse_idx" ON "treatment_template_code" USING btree ("system_key","code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_code_primary_uidx" ON "treatment_template_code" USING btree ("template_id","system_key") WHERE "is_primary";--> statement-breakpoint
ALTER TABLE "treatment_template" DROP COLUMN "external_codings";
--> statement-breakpoint
--> Catálogos globales de codificación: lectura para el rol app (el seed usa rol owner), como cie10_code y treatment_template.
REVOKE INSERT, UPDATE, DELETE ON "procedure_code_system", "procedure_code", "treatment_template_code" FROM "dentalagent_app";