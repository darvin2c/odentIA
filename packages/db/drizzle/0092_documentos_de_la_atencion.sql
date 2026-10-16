-- Documentos de la atención en un solo lugar (ADR 0033; fase 3, paso 2B).
--
-- 1. La plantilla de consentimiento dice para qué servicios se pide: al
--    registrar o indicar uno de ellos, la atención propone prepararlo. El
--    vínculo es por la clave de la plantilla, no por una versión: publicar una
--    versión nueva no lo pierde.
CREATE TABLE "consent_template_service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"template_key" text NOT NULL,
	"service_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_template_service_key_check" CHECK (char_length("consent_template_service"."template_key") BETWEEN 2 AND 40)
);
--> statement-breakpoint
ALTER TABLE "consent_template_service" ADD CONSTRAINT "consent_template_service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template_service" ADD CONSTRAINT "consent_template_service_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."service_catalog"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template_service" ADD CONSTRAINT "consent_template_service_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_template_service_uidx" ON "consent_template_service" USING btree ("organization_id","template_key","service_id");--> statement-breakpoint
CREATE INDEX "consent_template_service_service_idx" ON "consent_template_service" USING btree ("organization_id","service_id");--> statement-breakpoint
ALTER TABLE "consent_template_service" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_template_service" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "consent_template_service"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Un documento del paciente se referencia con su organización (firma en papel,
-- resultado de una orden).
CREATE UNIQUE INDEX IF NOT EXISTS "patient_document_org_id_uidx" ON "patient_document" USING btree ("organization_id","id");--> statement-breakpoint
-- 2. Cómo se firmó el consentimiento y con qué nivel, siempre a la vista: en la
--    clínica (trazo en la pantalla), en papel (con la foto de la hoja) o por
--    enlace (paso 6). El nivel es «simple» mientras no exista la firma
--    avanzada con certificado (issue 47). Los firmados antes de esta versión
--    quedan sin método: se leen como firmados en la clínica.
ALTER TABLE "consent_document" ADD COLUMN "signature_method" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "signature_level" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "paper_document_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_signature_method_check" CHECK ("signature_method" IS NULL OR "signature_method" IN ('clinica','papel','enlace'));--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_signature_level_check" CHECK ("signature_level" IS NULL OR "signature_level" IN ('simple'));--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_paper_check" CHECK (CASE WHEN "signature_method" = 'papel' THEN "paper_document_id" IS NOT NULL ELSE "paper_document_id" IS NULL END);--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_paper_document_fk" FOREIGN KEY ("organization_id","paper_document_id") REFERENCES "public"."patient_document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 3. La orden: también de imagen; el diagnóstico de la atención que la motiva;
--    el resultado subido a la propia orden; la derivación a un colega de la
--    clínica; y la cancelación con motivo (las canceladas antes quedan sin él).
ALTER TABLE "clinical_order" DROP CONSTRAINT "clinical_order_kind_check";--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_kind_check" CHECK ("clinical_order"."kind" in ('imagen','laboratorio','interconsulta'));--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "diagnosis_code" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "result_document_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "recipient_user_id" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_diagnosis_code_fk" FOREIGN KEY ("diagnosis_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_result_document_fk" FOREIGN KEY ("organization_id","result_document_id") REFERENCES "public"."patient_document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_cancel_check" CHECK (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL) AND ("cancelled_at" IS NULL OR "status" = 'cancelado') AND ("cancel_reason" IS NULL OR char_length("cancel_reason") BETWEEN 1 AND 2000));--> statement-breakpoint
-- 4. Cerrar la atención con un consentimiento sin firmar se avisa sin bloquear:
--    queda el motivo que dio quien la cerró, y es historia como el resto.
ALTER TABLE "encounter" ADD COLUMN "consent_skip_reason" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_consent_skip_reason_check" CHECK ("consent_skip_reason" IS NULL OR char_length("consent_skip_reason") BETWEEN 1 AND 2000);--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_finalized_encounter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('finalizada', 'anulada') AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.dentist_user_id, NEW.branch_id,
      NEW.appointment_id, NEW.reason, NEW.evolution, NEW.indications, NEW.next_step, NEW.examination, NEW.next_appointment_at,
      NEW.started_at, NEW.ended_at, NEW.finalized_at, NEW.finalized_by, NEW.signer_name, NEW.signer_title, NEW.signer_registration,
      NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.consent_skip_reason)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.dentist_user_id, OLD.branch_id,
      OLD.appointment_id, OLD.reason, OLD.evolution, OLD.indications, OLD.next_step, OLD.examination, OLD.next_appointment_at,
      OLD.started_at, OLD.ended_at, OLD.finalized_at, OLD.finalized_by, OLD.signer_name, OLD.signer_title, OLD.signer_registration,
      OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.consent_skip_reason) THEN
    RAISE EXCEPTION 'Una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'encounter_finalized_immutable';
  END IF;
  IF OLD.status = 'borrador' AND NEW.status = 'finalizada' AND (NEW.signer_name IS NULL OR NEW.signer_registration IS NULL) THEN
    RAISE EXCEPTION 'Cerrar una atención exige la firma del profesional con su colegiatura' USING ERRCODE = '23514', CONSTRAINT = 'encounter_signature_required';
  END IF;
  RETURN NEW;
END;
$$;
