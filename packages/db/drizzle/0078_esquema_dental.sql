-- Lo dental, en su esquema (ADR 0079, entrega 4). Mover una tabla conserva sus
-- filas, índices, llaves, disparadores, RLS y permisos; las llaves entre
-- esquemas siguen valiendo.
CREATE SCHEMA "dental";
--> statement-breakpoint
ALTER TABLE "public"."odontogram_entry" SET SCHEMA "dental";--> statement-breakpoint
ALTER TABLE "public"."odontogram_assessment" SET SCHEMA "dental";--> statement-breakpoint
ALTER TABLE "public"."periodontal_chart" SET SCHEMA "dental";--> statement-breakpoint
ALTER TABLE "public"."periodontal_tooth" SET SCHEMA "dental";--> statement-breakpoint

-- El SQL a mano sigue nombrando las tablas sin esquema: dental entra al
-- search_path de cada conexión nueva y de esta misma.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, catalog, auth, admin, dental', current_database());
END
$$;--> statement-breakpoint
SELECT set_config('search_path', 'public, catalog, auth, admin, dental', false);--> statement-breakpoint

-- Las funciones que fijan el camino completo (los disparadores de la atención
-- cerrada y del periodontograma, entre otras) también ven dental.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%admin%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, catalog, auth, admin, dental', f);
  END LOOP;
END
$$;--> statement-breakpoint

-- Para que un enlace no cruce de paciente ni de clínica.
CREATE UNIQUE INDEX "odontogram_entry_org_patient_id_uidx" ON "dental"."odontogram_entry" USING btree ("organization_id","patient_id","id");--> statement-breakpoint

-- Enlaces de lo común con el odontograma.
CREATE TABLE "dental"."plan_item_finding" (
	"plan_item_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"odontogram_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dental"."service_finding" (
	"service_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"condition" text NOT NULL,
	"variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."dental_template_rule" (
	"template_id" uuid PRIMARY KEY NOT NULL,
	"surface_count_min" integer,
	"surface_count_max" integer,
	"leaves_condition" text,
	"leaves_variant" text,
	CONSTRAINT "dental_template_rule_leaves_check" CHECK ("catalog"."dental_template_rule"."leaves_variant" IS NULL OR "catalog"."dental_template_rule"."leaves_condition" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "dental"."plan_item_finding" ADD CONSTRAINT "plan_item_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."plan_item_finding" ADD CONSTRAINT "plan_item_finding_plan_item_fk" FOREIGN KEY ("organization_id","patient_id","plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."plan_item_finding" ADD CONSTRAINT "plan_item_finding_entry_fk" FOREIGN KEY ("organization_id","patient_id","odontogram_entry_id") REFERENCES "dental"."odontogram_entry"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_item_finding_entry_idx" ON "dental"."plan_item_finding" USING btree ("odontogram_entry_id");--> statement-breakpoint
ALTER TABLE "dental"."service_finding" ADD CONSTRAINT "service_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."service_finding" ADD CONSTRAINT "service_finding_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."service_catalog"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."dental_template_rule" ADD CONSTRAINT "dental_template_rule_template_id_treatment_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "catalog"."treatment_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Los datos pasan tal cual a sus tablas nuevas.
INSERT INTO "dental"."plan_item_finding" ("plan_item_id", "organization_id", "patient_id", "odontogram_entry_id", "created_at")
  SELECT "id", "organization_id", "patient_id", "odontogram_entry_id", "created_at"
  FROM "public"."treatment_plan_item" WHERE "odontogram_entry_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "dental"."service_finding" ("service_id", "organization_id", "condition", "variant", "created_at", "updated_at")
  SELECT "id", "organization_id", "leaves_finding" ->> 'condition', "leaves_finding" ->> 'variant', "created_at", "updated_at"
  FROM "public"."service_catalog" WHERE "leaves_finding" IS NOT NULL;--> statement-breakpoint
INSERT INTO "catalog"."dental_template_rule" ("template_id", "surface_count_min", "surface_count_max", "leaves_condition", "leaves_variant")
  SELECT "id", "surface_count_min", "surface_count_max", "leaves_finding" ->> 'condition', "leaves_finding" ->> 'variant'
  FROM "catalog"."treatment_template"
  WHERE "surface_count_min" IS NOT NULL OR "surface_count_max" IS NOT NULL OR "leaves_finding" IS NOT NULL;--> statement-breakpoint

-- La biblioteca dice su producto; las de hoy son todas dentales.
ALTER TABLE "catalog"."treatment_template" ADD COLUMN "product" text DEFAULT 'dental' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD CONSTRAINT "treatment_template_product_check" CHECK ("catalog"."treatment_template"."product" IN ('dental','medical'));--> statement-breakpoint

-- Lo dental sale de las tablas comunes.
ALTER TABLE "treatment_plan_item" DROP CONSTRAINT "treatment_plan_item_odontogram_entry_id_odontogram_entry_id_fk";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "odontogram_entry_id";--> statement-breakpoint
ALTER TABLE "service_catalog" DROP CONSTRAINT "service_catalog_leaves_finding_check";--> statement-breakpoint
ALTER TABLE "service_catalog" DROP COLUMN "leaves_finding";--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" DROP CONSTRAINT IF EXISTS "treatment_template_leaves_finding_check";--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" DROP COLUMN "surface_count_min";--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" DROP COLUMN "surface_count_max";--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" DROP COLUMN "leaves_finding";--> statement-breakpoint
ALTER TABLE "catalog"."diagnosis_code" DROP COLUMN "is_dental";--> statement-breakpoint

-- Tipos de imagen y fases del plan: sus valores los dice el producto. La base
-- solo pide que el tipo de imagen vaya con una imagen.
ALTER TABLE "treatment_plan_item" DROP CONSTRAINT "treatment_plan_item_phase_check";--> statement-breakpoint
ALTER TABLE "patient_document" DROP CONSTRAINT "patient_document_image_type_check";--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_image_type_check" CHECK ("patient_document"."image_type" IS NULL OR "patient_document"."category" IN ('radiografia','foto_clinica'));
