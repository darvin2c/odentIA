--> 0013 plan clínico independiente del presupuesto + líneas económicas snapshot.
--> treatment_plan: cabecera longitudinal (legado marcado, origen solo legado);
--> treatment_plan_item: planId obligatorio, sitio clínico, budgetId vigente
--> nullable, sin columna decision (se deriva de la línea vigente) y
--> source_encounter_id en lugar de encounter_id; treatment_budget_item:
--> snapshot de lo cotizado por documento; encounter_procedure conserva sitio.
CREATE TABLE "treatment_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"title" text NOT NULL,
	"origin_encounter_id" uuid,
	"is_legacy" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "treatment_plan_org_patient_idx" ON "treatment_plan" USING btree ("organization_id","patient_id");--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "source_encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "surfaces" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "quadrant" smallint;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "arch" text;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
CREATE TABLE "treatment_budget_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"service_id" uuid,
	"title" text NOT NULL,
	"scope" text,
	"tooth_number" smallint,
	"surfaces" text[] DEFAULT '{}' NOT NULL,
	"quadrant" smallint,
	"arch" text,
	"price_cents" integer,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"decision" text DEFAULT 'pendiente' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_item_budget_plan_uidx" ON "treatment_budget_item" USING btree ("budget_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_patient_idx" ON "treatment_budget_item" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_budget_idx" ON "treatment_budget_item" USING btree ("organization_id","budget_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_plan_idx" ON "treatment_budget_item" USING btree ("organization_id","plan_id");--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "surfaces" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "quadrant" smallint;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "arch" text;--> statement-breakpoint
--> Backfill histórico: un plan por presupuesto previo (mismo título y
--> paciente, legado, origen null; no se adivina la consulta de origen).
--> Columna temporal de enlace, retirada al final de la migración.
ALTER TABLE "treatment_plan" ADD COLUMN "migration_budget_id" uuid;--> statement-breakpoint
INSERT INTO "treatment_plan" ("organization_id", "patient_id", "title", "is_legacy", "migration_budget_id")
SELECT "organization_id", "patient_id", "title", true, "id" FROM "treatment_budget";--> statement-breakpoint
UPDATE "treatment_budget" "b" SET "plan_id" = "p"."id"
FROM "treatment_plan" "p" WHERE "p"."migration_budget_id" = "b"."id";--> statement-breakpoint
UPDATE "treatment_plan_item" "i" SET
  "plan_id" = "b"."plan_id",
  "source_encounter_id" = "i"."encounter_id",
  "scope" = CASE WHEN "i"."tooth_number" IS NULL THEN 'general' ELSE 'tooth' END
FROM "treatment_budget" "b" WHERE "b"."id" = "i"."budget_id";--> statement-breakpoint
--> Líneas snapshot con la decisión existente (sin inferir aceptaciones nuevas).
INSERT INTO "treatment_budget_item"
  ("organization_id", "patient_id", "plan_id", "budget_id", "plan_item_id", "service_id", "title",
   "scope", "tooth_number", "surfaces", "price_cents", "currency", "decision", "created_by")
SELECT "i"."organization_id", "i"."patient_id", "i"."plan_id", "i"."budget_id", "i"."id", "i"."service_id",
  "i"."title", "i"."scope", "i"."tooth_number", '{}', "i"."price_cents", "i"."currency", "i"."decision", "i"."created_by"
FROM "treatment_plan_item" "i" WHERE "i"."budget_id" IS NOT NULL;--> statement-breakpoint
UPDATE "encounter_procedure" SET "scope" = CASE WHEN "tooth_number" IS NULL THEN 'general' ELSE 'tooth' END;--> statement-breakpoint
ALTER TABLE "treatment_plan" DROP COLUMN "migration_budget_id";--> statement-breakpoint
--> Columnas y constraints obsoletos: decisión física del ítem, presupuesto
--> obligatorio para indicar y encounter_id como origen mutable.
ALTER TABLE "treatment_plan_item" ALTER COLUMN "plan_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ALTER COLUMN "budget_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP CONSTRAINT IF EXISTS "treatment_plan_item_encounter_id_encounter_id_fk";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "encounter_id";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "decision";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_source_encounter_id_encounter_id_fk" FOREIGN KEY ("source_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_origin_encounter_id_encounter_id_fk" FOREIGN KEY ("origin_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_plan_idx" ON "treatment_plan_item" USING btree ("organization_id","plan_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_org_plan_idx" ON "treatment_budget" USING btree ("organization_id","plan_id");--> statement-breakpoint
--> RLS: aislamiento por tenant en las tablas nuevas.
ALTER TABLE "treatment_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_plan" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "treatment_plan"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "treatment_budget_item"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
--> Los planes y las líneas no se borran por API (la baja de ítems la regula
--> su propia policy); los documentos económicos se cancelan por estado.
REVOKE DELETE ON "treatment_plan" FROM "dentalagent_app";--> statement-breakpoint
REVOKE DELETE ON "treatment_budget_item" FROM "dentalagent_app";--> statement-breakpoint
--> La policy 0011 dependía de presupuesto obligatorio: se reemplaza por una
--> regla sin presupuesto requerido (ítem pendiente, sin líneas económicas,
--> sin procedimientos ni vínculos de ejecución).
DROP POLICY IF EXISTS "draft_plan_item_delete" ON "treatment_plan_item";--> statement-breakpoint
CREATE POLICY "plan_item_delete_guard" ON "treatment_plan_item" AS RESTRICTIVE FOR DELETE
  USING ("status" = 'pendiente'
    AND NOT EXISTS (SELECT 1 FROM "treatment_budget_item" WHERE "treatment_budget_item"."plan_item_id" = "treatment_plan_item"."id")
    AND NOT EXISTS (SELECT 1 FROM "encounter_procedure" WHERE "encounter_procedure"."plan_item_id" = "treatment_plan_item"."id")
    AND NOT EXISTS (SELECT 1 FROM "encounter_plan_item" WHERE "encounter_plan_item"."plan_item_id" = "treatment_plan_item"."id")
    AND ("treatment_plan_item"."budget_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "treatment_budget"
      WHERE "treatment_budget"."id" = "treatment_plan_item"."budget_id"
        AND "treatment_budget"."status" <> 'borrador'
    ))
  );
--> statement-breakpoint
--> Guardia de líneas económicas: alta solo sobre presupuesto borrador; el
--> snapshot solo cambia en borrador; tras presentar solo `decision` puede
--> cambiar (decideBudget la escribe antes del estado de cabecera, en la misma
--> transacción). Sin DELETE físico en ningún estado.
CREATE OR REPLACE FUNCTION "treatment_budget_item_guard"() RETURNS trigger AS $$
DECLARE
  budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'treatment_budget_item sin DELETE: cancele el presupuesto (%)', OLD.budget_id;
  END IF;
  SELECT "status" INTO budget_status FROM "treatment_budget" WHERE "id" = COALESCE(NEW.budget_id, OLD.budget_id);
  IF TG_OP = 'INSERT' THEN
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'treatment_budget_item solo admite altas en borrador (%)', NEW.budget_id;
    END IF;
    RETURN NEW;
  END IF;
  IF budget_status IS DISTINCT FROM 'borrador' THEN
    IF (NEW.organization_id, NEW.patient_id, NEW.plan_id, NEW.budget_id, NEW.plan_item_id,
        NEW.service_id, NEW.title, NEW.scope, NEW.tooth_number, NEW.surfaces,
        NEW.quadrant, NEW.arch, NEW.price_cents, NEW.currency)
       IS DISTINCT FROM
       (OLD.organization_id, OLD.patient_id, OLD.plan_id, OLD.budget_id, OLD.plan_item_id,
        OLD.service_id, OLD.title, OLD.scope, OLD.tooth_number, OLD.surfaces,
        OLD.quadrant, OLD.arch, OLD.price_cents, OLD.currency) THEN
      RAISE EXCEPTION 'snapshot del presupuesto (%) cerrado: solo decision puede cambiar', OLD.budget_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "treatment_budget_item_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "treatment_budget_item"
  FOR EACH ROW EXECUTE FUNCTION "treatment_budget_item_guard"();
