-- El sitio común (ADR 0079): las tablas comunes guardan dónde como sistema,
-- código y calificadores (bodySite de FHIR); odontología usa ISO 3950: la pieza
-- es su número FDI, el cuadrante «10» a «80», la arcada «01» o «02» y las caras
-- van como calificadores. Estado final generado con drizzle-kit; los datos se
-- convierten antes de quitar las columnas viejas, con las guardas apagadas
-- solo durante la conversión (lo firmado no cambia: es el mismo sitio escrito
-- de otra forma).

-- Atención, plan, presupuesto: pieza, caras, cuadrante y arcada.
ALTER TABLE "encounter_procedure" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "site_qualifiers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "site_qualifiers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "site_qualifiers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD COLUMN "site_qualifiers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "site_qualifiers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD COLUMN "site_qualifiers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "site_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint

ALTER TABLE "encounter_procedure" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "encounter_procedure" SET
  "site_system" = CASE WHEN "tooth_number" IS NOT NULL OR "quadrant" IS NOT NULL OR "arch" IN ('upper','lower') THEN 'ISO-3950' END,
  "site_code" = CASE WHEN "tooth_number" IS NOT NULL THEN "tooth_number"::text WHEN "quadrant" IS NOT NULL THEN "quadrant"::text || '0'
    WHEN "arch" = 'upper' THEN '01' WHEN "arch" = 'lower' THEN '02' END,
  "site_qualifiers" = "surfaces";--> statement-breakpoint
ALTER TABLE "encounter_procedure" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "treatment_plan_item" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "treatment_plan_item" SET
  "site_system" = CASE WHEN "tooth_number" IS NOT NULL OR "quadrant" IS NOT NULL OR "arch" IN ('upper','lower') THEN 'ISO-3950' END,
  "site_code" = CASE WHEN "tooth_number" IS NOT NULL THEN "tooth_number"::text WHEN "quadrant" IS NOT NULL THEN "quadrant"::text || '0'
    WHEN "arch" = 'upper' THEN '01' WHEN "arch" = 'lower' THEN '02' END,
  "site_qualifiers" = "surfaces";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "treatment_budget_item" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "treatment_budget_item" SET
  "site_system" = CASE WHEN "tooth_number" IS NOT NULL OR "quadrant" IS NOT NULL OR "arch" IN ('upper','lower') THEN 'ISO-3950' END,
  "site_code" = CASE WHEN "tooth_number" IS NOT NULL THEN "tooth_number"::text WHEN "quadrant" IS NOT NULL THEN "quadrant"::text || '0'
    WHEN "arch" = 'upper' THEN '01' WHEN "arch" = 'lower' THEN '02' END,
  "site_qualifiers" = "surfaces";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "encounter_diagnosis" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "encounter_diagnosis" SET
  "site_system" = CASE WHEN "tooth_number" IS NOT NULL THEN 'ISO-3950' END,
  "site_code" = "tooth_number"::text,
  "site_qualifiers" = "surfaces";--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "clinical_note" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "clinical_note" SET "site_system" = 'ISO-3950', "site_code" = "tooth_number"::text WHERE "tooth_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_note" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "imaging_measurement" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "imaging_measurement" SET "site_system" = 'ISO-3950', "site_code" = "tooth_number"::text WHERE "tooth_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "patient_document_context" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "patient_document_context" SET "site_system" = 'ISO-3950', "site_codes" = "tooth_numbers"::text[]
  WHERE cardinality("tooth_numbers") > 0;--> statement-breakpoint
ALTER TABLE "patient_document_context" ENABLE TRIGGER USER;--> statement-breakpoint

ALTER TABLE "encounter_procedure" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "encounter_procedure" DROP COLUMN "surfaces";--> statement-breakpoint
ALTER TABLE "encounter_procedure" DROP COLUMN "quadrant";--> statement-breakpoint
ALTER TABLE "encounter_procedure" DROP COLUMN "arch";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "surfaces";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "quadrant";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN "arch";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" DROP COLUMN "surfaces";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" DROP COLUMN "quadrant";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" DROP COLUMN "arch";--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" DROP COLUMN "surfaces";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "imaging_measurement" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "patient_document_context" DROP COLUMN "tooth_numbers";--> statement-breakpoint

-- Piezas vistas en la atención → sitios vistos en la atención.
ALTER TABLE "encounter_tooth" RENAME TO "encounter_site";--> statement-breakpoint
ALTER TABLE "encounter_site" ADD COLUMN "site_system" text;--> statement-breakpoint
ALTER TABLE "encounter_site" ADD COLUMN "site_code" text;--> statement-breakpoint
ALTER TABLE "encounter_site" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "encounter_site" SET "site_system" = 'ISO-3950', "site_code" = "tooth_number"::text;--> statement-breakpoint
ALTER TABLE "encounter_site" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "encounter_site" ALTER COLUMN "site_system" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_site" ALTER COLUMN "site_code" SET NOT NULL;--> statement-breakpoint
DROP INDEX "encounter_tooth_encounter_tooth_uidx";--> statement-breakpoint
ALTER TABLE "encounter_site" DROP COLUMN "tooth_number";--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_site_encounter_site_uidx" ON "encounter_site" USING btree ("encounter_id","site_system","site_code");--> statement-breakpoint
ALTER TABLE "encounter_site" RENAME CONSTRAINT "encounter_tooth_organization_id_organization_id_fk" TO "encounter_site_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "encounter_site" RENAME CONSTRAINT "encounter_tooth_encounter_id_encounter_id_fk" TO "encounter_site_encounter_id_encounter_id_fk";
