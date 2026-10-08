-- Estructura clínica: valores de catálogo garantizados en la base, diagnóstico
-- con tipo y pieza, antecedentes con categoría y código, firmante vinculado,
-- atención finalizada inmutable y bitácora de consultas a la historia.
CREATE TABLE "clinical_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"resource" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "signer_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "diagnosis_type" text;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "tooth_number" smallint;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "patient_condition" ADD COLUMN "cie10_code" text;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD COLUMN "generic_name" text;--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_access_log_bucket_uidx" ON "clinical_access_log" USING btree ("organization_id","patient_id","user_id","resource","bucket");--> statement-breakpoint
CREATE INDEX "clinical_access_log_org_patient_idx" ON "clinical_access_log" USING btree ("organization_id","patient_id","last_at");--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_cie10_code_cie10_code_code_fk" FOREIGN KEY ("cie10_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Valores heredados fuera de catálogo antes de exigirlo. Se elige el valor que
-- no oculta información clínica: severidad desconocida, condición vigente.
UPDATE "patient_allergy" SET "severity" = 'desconocida' WHERE "severity" NOT IN ('leve','moderada','severa','desconocida');
UPDATE "patient_condition" SET "status" = 'activa' WHERE "status" NOT IN ('activa','resuelta','inactiva');
UPDATE "clinical_note" SET "kind" = 'evolucion' WHERE "kind" NOT IN ('evolucion','adenda');
UPDATE "patient_document" SET "category" = 'otro' WHERE "category" NOT IN ('consentimiento','radiografia','foto_clinica','informe','presupuesto','receta','comprobante_pago','otro');--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_kind_check" CHECK ("clinical_note"."kind" IN ('evolucion','adenda'));--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_diagnosis_type_check" CHECK ("clinical_note"."diagnosis_type" IS NULL OR ("clinical_note"."diagnosis_code" IS NOT NULL AND "clinical_note"."diagnosis_type" IN ('presuntivo','definitivo','repetido')));--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_status_check" CHECK ("encounter"."status" IN ('borrador','finalizada'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_severity_check" CHECK ("patient_allergy"."severity" IN ('leve','moderada','severa','desconocida'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_category_check" CHECK ("patient_allergy"."category" IS NULL OR "patient_allergy"."category" IN ('medicamento','anestesico','material','alimento','ambiental','otro'));--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_status_check" CHECK ("patient_condition"."status" IN ('activa','resuelta','inactiva'));--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_category_check" CHECK ("patient_document"."category" IN ('consentimiento','radiografia','foto_clinica','informe','presupuesto','receta','comprobante_pago','otro'));--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_signer_contact_fk" FOREIGN KEY ("organization_id", "signer_contact_id") REFERENCES "contact" ("organization_id", "id");--> statement-breakpoint
-- La atención finalizada es parte de la historia: no se reescribe. Las
-- correcciones posteriores son adendas (notas propias), como exige el servicio.
CREATE FUNCTION guard_finalized_encounter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finalizada' AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.dentist_user_id, NEW.branch_id,
      NEW.reason, NEW.evolution, NEW.indications, NEW.next_step, NEW.examination, NEW.next_appointment_at,
      NEW.finalized_at, NEW.finalized_by)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.dentist_user_id, OLD.branch_id,
      OLD.reason, OLD.evolution, OLD.indications, OLD.next_step, OLD.examination, OLD.next_appointment_at,
      OLD.finalized_at, OLD.finalized_by) THEN
    RAISE EXCEPTION 'Una atención finalizada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'encounter_finalized_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER encounter_finalized_immutable BEFORE UPDATE ON encounter FOR EACH ROW EXECUTE FUNCTION guard_finalized_encounter();--> statement-breakpoint
ALTER TABLE "clinical_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_access_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "clinical_access_log"
  USING (organization_id = nullif(current_setting('app.org_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- Traza de solo anexado: la aplicación inserta y solo actualiza el contador y la
-- última hora de la misma franja; nunca borra ni cambia quién, a quién o qué.
-- Los privilegios por defecto del rol incluyen UPDATE y DELETE: se retiran antes
-- de conceder solo las dos columnas de conteo.
REVOKE UPDATE, DELETE, TRUNCATE ON "clinical_access_log" FROM dentalagent_app;
GRANT SELECT, INSERT ON "clinical_access_log" TO dentalagent_app;
GRANT UPDATE ("last_at", "hits") ON "clinical_access_log" TO dentalagent_app;
