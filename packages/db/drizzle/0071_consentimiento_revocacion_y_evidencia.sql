ALTER TABLE "consent_document" ADD COLUMN "revoke_pdf_document_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "revoke_pdf_sha256" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "declaration_snapshot" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "person_signed_ip" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "person_signed_user_agent" text;--> statement-breakpoint
ALTER TABLE ONLY public.consent_document ADD CONSTRAINT consent_document_revoke_pdf_document_fk FOREIGN KEY (revoke_pdf_document_id) REFERENCES public.patient_document(id);--> statement-breakpoint
-- Consentimiento (#47): la revocación guarda su propio PDF una sola vez; el
-- firmado no se toca. Lo demás sigue como en la 0001: firmado solo pasa a
-- revocado (con quien revoca) o recibe su PDF una vez; revocado y anulado son
-- definitivos salvo adjuntar el PDF que faltaba.
CREATE OR REPLACE FUNCTION public.clinical_forms_consent_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  revoke_cols text[] := ARRAY['status','revoked_at','revoke_reason','revoker_name','revoker_contact_id','revoke_signature','updated_at'];
  pdf_cols text[] := ARRAY['pdf_document_id','pdf_sha256','updated_at'];
  revoke_pdf_cols text[] := ARRAY['revoke_pdf_document_id','revoke_pdf_sha256','updated_at'];
BEGIN
  IF OLD.status IN ('firmado','revocado','anulado') THEN
    -- Adjuntar el PDF una sola vez.
    IF OLD.pdf_document_id IS NULL AND NEW.pdf_document_id IS NOT NULL AND NEW.pdf_sha256 IS NOT NULL
      AND (to_jsonb(NEW) - pdf_cols) = (to_jsonb(OLD) - pdf_cols)
      AND OLD.status <> 'anulado'
    THEN
      RETURN NEW;
    END IF;
    -- Adjuntar el PDF de la revocación una sola vez.
    IF OLD.status = 'revocado' AND OLD.revoke_pdf_document_id IS NULL
      AND NEW.revoke_pdf_document_id IS NOT NULL AND NEW.revoke_pdf_sha256 IS NOT NULL
      AND (to_jsonb(NEW) - revoke_pdf_cols) = (to_jsonb(OLD) - revoke_pdf_cols)
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
