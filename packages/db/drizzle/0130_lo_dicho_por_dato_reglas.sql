-- Lo que dijo el paciente, por dato y donde se decide (auditor, 15 nov, A2): lo que TS no declara.
-- La columna `encounter.health_at_signing` la generó 0129.

-- Lo que se dijo de su salud y seguía sin revisar al firmar es historia como el resto de la atención
-- firmada: la guarda que ya protege su contenido también la protege (NTS 139-MINSA/2018/DGAIN, 5.3.3:
-- lo registrado no se modifica; se corrige con una adenda).
CREATE OR REPLACE FUNCTION public.guard_finalized_encounter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('finalizada', 'anulada') AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.professional_user_id, NEW.branch_id,
      NEW.appointment_id, NEW.reason, NEW.present_illness, NEW.illness_duration, NEW.vitals, NEW.evolution, NEW.indications, NEW.prognosis, NEW.examination,
      NEW.started_at, NEW.ended_at, NEW.finalized_at, NEW.finalized_by, NEW.signer_name, NEW.signer_title, NEW.signer_registration,
      NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.consent_skip_reason, NEW.health_at_signing)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.professional_user_id, OLD.branch_id,
      OLD.appointment_id, OLD.reason, OLD.present_illness, OLD.illness_duration, OLD.vitals, OLD.evolution, OLD.indications, OLD.prognosis, OLD.examination,
      OLD.started_at, OLD.ended_at, OLD.finalized_at, OLD.finalized_by, OLD.signer_name, OLD.signer_title, OLD.signer_registration,
      OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.consent_skip_reason, OLD.health_at_signing) THEN
    RAISE EXCEPTION 'Una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'encounter_finalized_immutable';
  END IF;
  IF OLD.status = 'borrador' AND NEW.status = 'finalizada' AND (NEW.signer_name IS NULL OR NEW.signer_registration IS NULL) THEN
    RAISE EXCEPTION 'Cerrar una atención exige la firma del profesional con su colegiatura' USING ERRCODE = '23514', CONSTRAINT = 'encounter_signature_required';
  END IF;
  RETURN NEW;
END;
$$;
