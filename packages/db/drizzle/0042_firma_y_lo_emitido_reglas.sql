-- La firma que se ve solo se agrega: el rol app anota y lee, nunca corrige ni borra. Cada papel lee la que regía al emitirse.
ALTER TABLE public.professional_drawn_signature ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_drawn_signature FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_drawn_signature USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.professional_drawn_signature FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.professional_drawn_signature TO dentalagent_app;
--> statement-breakpoint

-- Lo emitido no cambia (ADR 0132). El PDF guardado solo se agrega y se lee: ni se corrige ni se borra.
ALTER TABLE public.issued_paper ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.issued_paper FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.issued_paper USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.issued_paper FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.issued_paper TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.issued_paper ADD CONSTRAINT issued_paper_patient_org_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id) ON DELETE CASCADE;--> statement-breakpoint

-- Las órdenes de antes copian quién las firmó: desde ahora, sin copia es que nadie firmó.
UPDATE public.clinical_order o
SET signer_name = COALESCE(pp.signature_name, u.name),
    signer_title = pp.professional_title,
    signer_registration = pp.registration_body || ' ' || pp.registration_number
FROM public.professional_profile pp
JOIN auth."user" u ON u.id = pp.user_id
WHERE pp.organization_id = o.organization_id AND pp.user_id = o.from_user_id AND pp.registration_number IS NOT NULL;--> statement-breakpoint

-- Lo que dice un papel emitido no cambia: solo cambian su estado y lo que anota la
-- operación que lo mueve (los demás argumentos). Anulado (el primero), ya nada cambia.
-- `specialty_id` no sale en el papel, y al borrar una especialidad la base la deja nula.
CREATE FUNCTION public.issued_document_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  written text[] := TG_ARGV[1:];
  unprinted text[] := ARRAY['updated_at','specialty_id'];
BEGIN
  IF (to_jsonb(NEW) - unprinted) IS NOT DISTINCT FROM (to_jsonb(OLD) - unprinted) THEN
    RETURN NEW;
  END IF;
  IF to_jsonb(OLD)->>'status' = TG_ARGV[0]
    OR (to_jsonb(NEW) - (written || unprinted)) IS DISTINCT FROM (to_jsonb(OLD) - (written || unprinted))
  THEN
    RAISE EXCEPTION 'Documento emitido: % % no cambia', TG_TABLE_NAME, OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER prescription_issued_immutable BEFORE UPDATE ON public.prescription FOR EACH ROW EXECUTE FUNCTION public.issued_document_immutable('anulada', 'status', 'cancelled_at', 'cancelled_by', 'cancel_reason');--> statement-breakpoint
CREATE TRIGGER medical_leave_issued_immutable BEFORE UPDATE ON public.medical_leave FOR EACH ROW EXECUTE FUNCTION public.issued_document_immutable('anulado', 'status', 'cancelled_at', 'cancelled_by', 'cancel_reason');--> statement-breakpoint
CREATE TRIGGER clinical_order_issued_immutable BEFORE UPDATE ON public.clinical_order FOR EACH ROW EXECUTE FUNCTION public.issued_document_immutable('cancelado', 'status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'result_text', 'result_at', 'completed_by', 'result_document_id');--> statement-breakpoint

-- El archivo que respalda un consentimiento firmado no se retira (revocado, sí): la foto de la hoja
-- es la prueba, y sin ella el consentimiento seguiría diciendo «firmado» sin respaldo.
CREATE OR REPLACE FUNCTION public.patient_document_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'El archivo está retirado y no admite cambios'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.retired_at IS NOT NULL AND NEW.retired_by IS NULL THEN
    RAISE EXCEPTION 'El retiro exige registrar quién lo hace'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.retired_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.consent_document c
    WHERE c.organization_id = NEW.organization_id AND c.status = 'firmado'
      AND NEW.id IN (c.paper_document_id, c.pdf_document_id, c.revoke_pdf_document_id)
  ) THEN
    RAISE EXCEPTION 'El archivo respalda un consentimiento firmado y no se retira'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
