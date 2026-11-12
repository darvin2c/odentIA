-- La fecha del documento se corrige con una versión nueva de su contexto, con su motivo
-- (servicio `correctDocumentContext`). Cada versión lleva la fecha que valía entonces:
-- las de antes toman la que el archivo tiene hoy, que nunca se había cambiado.
UPDATE public.patient_document_context c
SET captured_at = d.captured_at
FROM public.patient_document d
WHERE d.id = c.document_id AND d.organization_id = c.organization_id AND d.captured_at IS NOT NULL;--> statement-breakpoint
-- La vigente se copia en el archivo, para que todo lo que la lee siga igual. Nada más de la fila.
GRANT UPDATE(captured_at) ON TABLE public.patient_document TO dentalagent_app;
--> statement-breakpoint
-- La fecha del archivo cambia solo junto con su versión de contexto: la vigente es siempre
-- la de la última versión, así el historial dice cada fecha que tuvo.
CREATE FUNCTION public.patient_document_date_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.captured_at IS DISTINCT FROM OLD.captured_at AND NEW.captured_at IS DISTINCT FROM (
    SELECT c.captured_at FROM public.patient_document_context c
    WHERE c.organization_id = NEW.organization_id AND c.document_id = NEW.id
    ORDER BY c.version DESC LIMIT 1
  ) THEN
    RAISE EXCEPTION 'La fecha del documento se corrige con una versión nueva de su contexto'
      USING ERRCODE = 'check_violation';
  END IF;
  -- El PDF que genera la firma o la revocación de un consentimiento lleva la fecha de ese hecho.
  IF NEW.captured_at IS DISTINCT FROM OLD.captured_at AND EXISTS (
    SELECT 1 FROM public.consent_document c
    WHERE c.organization_id = NEW.organization_id
      AND NEW.id IN (c.pdf_document_id, c.revoke_pdf_document_id)
  ) THEN
    RAISE EXCEPTION 'La fecha del papel que generó la firma no se cambia'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_document_date_guard BEFORE UPDATE OF captured_at ON public.patient_document FOR EACH ROW EXECUTE FUNCTION public.patient_document_date_guard();
--> statement-breakpoint
-- Una versión que cambia la fecha dice por qué: el motivo no depende solo del servicio.
CREATE FUNCTION public.patient_document_context_date_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.version > 1 AND NEW.date_reason IS NULL AND NEW.captured_at IS DISTINCT FROM (
    SELECT c.captured_at FROM public.patient_document_context c
    WHERE c.organization_id = NEW.organization_id AND c.document_id = NEW.document_id
      AND c.version = NEW.version - 1
  ) THEN
    RAISE EXCEPTION 'Cambiar la fecha del documento pide su motivo'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_document_context_date_guard BEFORE INSERT ON public.patient_document_context FOR EACH ROW EXECUTE FUNCTION public.patient_document_context_date_guard();
