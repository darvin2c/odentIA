DROP INDEX "catalog"."treatment_template_code_template_uidx";--> statement-breakpoint
DROP INDEX "catalog"."treatment_template_code_code_uidx";--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "procedure_system" text;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "procedure_code" text;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "procedure_version" text;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "leaves_finding" jsonb;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "is_common" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "coded_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_procedure_fk" FOREIGN KEY ("procedure_system","procedure_code","procedure_version") REFERENCES "catalog"."procedure_code"("system_key","code","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_code_list_uidx" ON "catalog"."treatment_template_code" USING btree ("template_id","system_key","version");--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template_code" DROP COLUMN "is_primary";--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_procedure_check" CHECK (("service_catalog"."procedure_system" IS NULL) = ("service_catalog"."procedure_code" IS NULL) AND ("service_catalog"."procedure_code" IS NULL) = ("service_catalog"."procedure_version" IS NULL) AND ("service_catalog"."procedure_code" IS NULL OR "service_catalog"."template_id" IS NULL));