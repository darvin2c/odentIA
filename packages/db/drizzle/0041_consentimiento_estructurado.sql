ALTER TABLE "consent_document" DROP CONSTRAINT "consent_document_status_check";--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "sections_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "diagnosis_code" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "informed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "informed_by" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "informer_name" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "informer_title" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "informer_registration" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "professional_signature" jsonb;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "comprehension_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "witness_name" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "witness_doc" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "revoker_name" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "revoker_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "revoke_signature" jsonb;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "pdf_document_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "pdf_sha256" text;--> statement-breakpoint
ALTER TABLE "consent_template" ADD COLUMN "sections" jsonb;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_informed_by_user_id_fk" FOREIGN KEY ("informed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_status_check" CHECK ("consent_document"."status" in ('pendiente','firmado','revocado','anulado'));--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_revoker_contact_fk" FOREIGN KEY ("organization_id", "revoker_contact_id") REFERENCES "contact" ("organization_id", "id");--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_pdf_document_fk" FOREIGN KEY ("pdf_document_id") REFERENCES "patient_document" ("id");--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_pdf_sha256_check" CHECK ("pdf_sha256" IS NULL OR "pdf_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_cancel_check" CHECK (("status" = 'anulado') = ("cancelled_at" IS NOT NULL) AND ("status" <> 'anulado' OR char_length(coalesce("cancel_reason", '')) BETWEEN 1 AND 2000));--> statement-breakpoint
-- Plantilla publicada: las secciones también quedan congeladas.
CREATE OR REPLACE FUNCTION clinical_forms_consent_template_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND (to_jsonb(NEW) - ARRAY['status','updated_at']) = (to_jsonb(OLD) - ARRAY['status','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento publicado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Consentimiento archivado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Consentimiento: firmado solo pasa a revocado (con quien revoca) o recibe su
-- PDF una vez; revocado y anulado son definitivos salvo adjuntar el PDF que
-- faltaba. Ningún cambio toca contenido, firmantes (incluida la persona
-- vinculada que firmó), profesional que informa ni testigo.
CREATE OR REPLACE FUNCTION clinical_forms_consent_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revoke_cols text[] := ARRAY['status','revoked_at','revoke_reason','revoker_name','revoker_contact_id','revoke_signature','updated_at'];
  pdf_cols text[] := ARRAY['pdf_document_id','pdf_sha256','updated_at'];
BEGIN
  IF OLD.status IN ('firmado','revocado','anulado') THEN
    -- Adjuntar el PDF una sola vez.
    IF OLD.pdf_document_id IS NULL AND NEW.pdf_document_id IS NOT NULL AND NEW.pdf_sha256 IS NOT NULL
      AND (to_jsonb(NEW) - pdf_cols) = (to_jsonb(OLD) - pdf_cols)
      AND OLD.status <> 'anulado'
    THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'firmado' AND NEW.status = 'revocado'
      AND NEW.revoked_at IS NOT NULL AND NEW.revoke_reason IS NOT NULL
      AND (to_jsonb(NEW) - revoke_cols) = (to_jsonb(OLD) - revoke_cols)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento % inmutable (%)', OLD.status, OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
