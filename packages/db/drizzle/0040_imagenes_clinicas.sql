ALTER TABLE "patient_document" ADD COLUMN "image_type" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "report_status" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "retired_by" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "retire_reason" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_image_type_check" CHECK ("patient_document"."image_type" IS NULL OR ("patient_document"."category" = 'radiografia' AND "patient_document"."image_type" IN ('periapical','bitewing','oclusal','panoramica','cefalometrica','tomografia')) OR ("patient_document"."category" = 'foto_clinica' AND "patient_document"."image_type" IN ('foto_intraoral','foto_extraoral')));--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_report_status_check" CHECK ("patient_document"."report_status" IS NULL OR "patient_document"."report_status" IN ('pendiente','informado','no_requiere'));--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_source_check" CHECK ("patient_document"."source" IS NULL OR char_length("patient_document"."source") BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_retired_check" CHECK (("patient_document"."retired_at" IS NULL) = ("patient_document"."retire_reason" IS NULL) AND ("patient_document"."retire_reason" IS NULL OR char_length("patient_document"."retire_reason") BETWEEN 1 AND 2000));--> statement-breakpoint
-- El archivo y su clasificación siguen inmutables para la aplicación: el
-- UPDATE de tabla sigue revocado (0005) y solo se conceden las columnas del
-- informe y del retiro. El trigger impide deshacer o modificar un retiro.
GRANT UPDATE ("report_status", "retired_at", "retired_by", "retire_reason") ON "patient_document" TO "dentalagent_app";--> statement-breakpoint
CREATE OR REPLACE FUNCTION patient_document_guard_update() RETURNS trigger AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'El archivo está retirado y no admite cambios'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.retired_at IS NOT NULL AND NEW.retired_by IS NULL THEN
    RAISE EXCEPTION 'El retiro exige registrar quién lo hace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER patient_document_guard_update BEFORE UPDATE ON "patient_document"
  FOR EACH ROW EXECUTE FUNCTION patient_document_guard_update();--> statement-breakpoint
CREATE INDEX "patient_document_active_idx" ON "patient_document" ("organization_id","patient_id","created_at") WHERE "retired_at" IS NULL;--> statement-breakpoint
-- Las radiografías existentes quedan pendientes de informe; el subtipo no se
-- infiere del título para no inventar una clasificación.
UPDATE "patient_document" SET "report_status" = 'pendiente' WHERE "category" = 'radiografia';
