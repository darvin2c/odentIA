--> 0012 biblioteca global de prestaciones + oferta organizacional con tarifa nullable.
--> treatment_template: catálogo global sin org y sin RLS (como cie10_code);
--> service_catalog pasa a ser la oferta de cada organización: template/source,
--> código interno nullable, especialidad/ámbito y precio nullable (Sin tarifa).
CREATE TABLE "treatment_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"specialty" text NOT NULL,
	"scope" text NOT NULL,
	"surface_count_min" integer,
	"surface_count_max" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"external_codings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_key_uidx" ON "treatment_template" USING btree ("key");--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "source" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "specialty" text;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "service_catalog" ALTER COLUMN "code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service_catalog" ALTER COLUMN "price_cents" DROP NOT NULL;--> statement-breakpoint
--> Auditoría de la migración: conserva la categoría original por organización
--> antes de retirarla como clasificación válida (sin trasladarla al modelo nuevo).
INSERT INTO "audit_event" ("organization_id", "action", "entity", "metadata")
SELECT "organization_id", 'catalog.legacy_migrated', 'service_catalog',
  jsonb_build_object('categories', array_agg(DISTINCT "category"), 'count', count(*))
FROM "service_catalog" GROUP BY "organization_id";--> statement-breakpoint
--> Filas existentes: legado inactivo pendiente de revisión (conservan ID,
--> nombre, código y precio; sin equivalencias deducidas por nombre).
UPDATE "service_catalog" SET "source" = 'legacy', "is_active" = false;--> statement-breakpoint
ALTER TABLE "service_catalog" DROP COLUMN "category";--> statement-breakpoint
DROP INDEX "service_catalog_org_code_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "service_catalog_org_code_uidx" ON "service_catalog" USING btree ("organization_id","code") WHERE "code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "service_catalog_org_specialty_idx" ON "service_catalog" USING btree ("organization_id","specialty");--> statement-breakpoint
CREATE INDEX "service_catalog_template_idx" ON "service_catalog" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_template_id_treatment_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."treatment_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> Biblioteca global solo lectura para el rol app (el seed usa rol owner).
REVOKE INSERT, UPDATE, DELETE ON "treatment_template" FROM "dentalagent_app";--> statement-breakpoint
--> Blindaje de dominio a nivel DB (el servicio valida primero, fail closed).
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_source_check" CHECK ("source" IN ('template','custom','legacy'));
