ALTER TABLE "clinical_form_response" DROP CONSTRAINT "clinical_form_response_status_check";--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "template_title" text;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "respondent_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "discarded_by" text;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD COLUMN "discard_reason" text;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD COLUMN "respondent" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_discarded_by_user_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_source_check" CHECK ("clinical_form_response"."source" in ('staff','portal'));--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_status_check" CHECK ("clinical_form_response"."status" in ('borrador','finalizado','descartado'));--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_respondent_check" CHECK ("clinical_form_template"."respondent" in ('staff','portal'));--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_respondent_contact_fk" FOREIGN KEY ("organization_id", "respondent_contact_id") REFERENCES "contact" ("organization_id", "id");--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_discard_check" CHECK (("status" = 'descartado') = ("discarded_at" IS NOT NULL) AND ("status" <> 'descartado' OR char_length(coalesce("discard_reason", '')) BETWEEN 1 AND 2000));--> statement-breakpoint
-- Título congelado en las respuestas existentes (antes solo se guardaba el esquema).
UPDATE "clinical_form_response" r SET "template_title" = t."title"
  FROM "clinical_form_template" t WHERE t."id" = r."template_id" AND r."template_title" IS NULL;--> statement-breakpoint
-- La plantilla publicada congela también a quién va dirigida.
CREATE OR REPLACE FUNCTION clinical_forms_template_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND (to_jsonb(NEW) - ARRAY['status','updated_at']) = (to_jsonb(OLD) - ARRAY['status','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Plantilla publicada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Plantilla archivada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Finalizado y descartado son definitivos: las correcciones son adendas.
CREATE OR REPLACE FUNCTION clinical_forms_response_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('finalizado','descartado') THEN
    RAISE EXCEPTION 'Formulario % inmutable (usar adenda) (%)', OLD.status, OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
