ALTER TABLE "encounter" ADD COLUMN "registration_skip_reason" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_registration_skip_reason_check" CHECK ("encounter"."registration_skip_reason" IS NULL OR char_length("encounter"."registration_skip_reason") BETWEEN 1 AND 2000);
--> statement-breakpoint
-- Sin colegiatura en el perfil, la atención se cierra con el motivo escrito (17 nov, ADR 0200):
-- la firma exige el nombre y, además, la colegiatura o el motivo. El motivo también es historia.
CREATE OR REPLACE FUNCTION public.guard_finalized_encounter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('finalizada', 'anulada') AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.professional_user_id, NEW.branch_id,
      NEW.appointment_id, NEW.reason, NEW.present_illness, NEW.illness_duration, NEW.vitals, NEW.evolution, NEW.indications, NEW.prognosis, NEW.examination,
      NEW.started_at, NEW.ended_at, NEW.finalized_at, NEW.finalized_by, NEW.signer_name, NEW.signer_title, NEW.signer_registration,
      NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.consent_skip_reason, NEW.registration_skip_reason, NEW.health_at_signing, NEW.anesthesia_at_signing)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.professional_user_id, OLD.branch_id,
      OLD.appointment_id, OLD.reason, OLD.present_illness, OLD.illness_duration, OLD.vitals, OLD.evolution, OLD.indications, OLD.prognosis, OLD.examination,
      OLD.started_at, OLD.ended_at, OLD.finalized_at, OLD.finalized_by, OLD.signer_name, OLD.signer_title, OLD.signer_registration,
      OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.consent_skip_reason, OLD.registration_skip_reason, OLD.health_at_signing, OLD.anesthesia_at_signing) THEN
    RAISE EXCEPTION 'Una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'encounter_finalized_immutable';
  END IF;
  IF OLD.status = 'borrador' AND NEW.status = 'finalizada'
      AND (NEW.signer_name IS NULL OR (NEW.signer_registration IS NULL AND NEW.registration_skip_reason IS NULL)) THEN
    RAISE EXCEPTION 'Cerrar una atención exige la firma del profesional con su colegiatura o el motivo para firmar sin ella' USING ERRCODE = '23514', CONSTRAINT = 'encounter_signature_required';
  END IF;
  RETURN NEW;
END;
$$;
