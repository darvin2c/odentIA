--> 0019 biblioteca oficial CPMS 1:1 + ediciones importadas.
--> procedure_catalog_release: una fila por sistema y versión; is_current marca la
--> edición vigente (única por sistema). treatment_template_code pasa de N:M ambiguo
--> a proyección 1:1 (únicos por plantilla y por código).
--> Migración limpia: las ofertas ligadas a plantillas internas pasan a custom con
--> template_id NULL (conservan nombre, código, precio, moneda y demás valores);
--> los snapshots históricos en planes/presupuestos/atenciones (JSONB codings) no
--> se tocan. Las plantillas previas quedan retiradas y los mappings limpiados; los
--> códigos históricos se conservan (el seed desactiva fuera de ámbito sin borrar).
CREATE TABLE "procedure_catalog_release" (
	"system_key" text NOT NULL,
	"version" text NOT NULL,
	"scope" text NOT NULL,
	"source_url" text NOT NULL,
	"source_sha256" text NOT NULL,
	"expected_count" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	CONSTRAINT "procedure_catalog_release_system_key_version_pk" PRIMARY KEY("system_key","version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_catalog_release_current_uidx" ON "procedure_catalog_release" USING btree ("system_key") WHERE "is_current";--> statement-breakpoint
ALTER TABLE "procedure_catalog_release" ADD CONSTRAINT "procedure_catalog_release_system_key_procedure_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "public"."procedure_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "service_catalog" SET "template_id" = NULL, "source" = 'custom' WHERE "template_id" IS NOT NULL;--> statement-breakpoint
UPDATE "treatment_template" SET "is_active" = false;--> statement-breakpoint
DELETE FROM "treatment_template_code";--> statement-breakpoint
DROP INDEX "treatment_template_code_primary_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_code_template_uidx" ON "treatment_template_code" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_code_code_uidx" ON "treatment_template_code" USING btree ("system_key","code","version");--> statement-breakpoint
ALTER TABLE "treatment_template_code" ALTER COLUMN "is_primary" SET DEFAULT true;--> statement-breakpoint
--> Catálogo de ediciones: lectura para el rol app (el seed usa rol owner),
--> como procedure_code y treatment_template.
REVOKE INSERT, UPDATE, DELETE ON "procedure_catalog_release" FROM "dentalagent_app";
