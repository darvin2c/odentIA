-- La ficha en cuatro secciones (fase 3, decisión 2). Salen cuatro piezas que
-- repetían lo que ya está en otro sitio. No hay datos reales: se borran las
-- columnas y las filas sin plan de conservación.
--
-- 1. Sale el rol «acompañante»: no decide ni recibe información por sí. Quien
--    solo acompaña va en «Personas vinculadas»; los niños conservan
--    representante legal, autorizado para información y responsable económico.
DELETE FROM "patient_responsibility" WHERE "kind" = 'acompanante';--> statement-breakpoint
ALTER TABLE "patient_responsibility" DROP CONSTRAINT "patient_responsibility_kind_check";--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_kind_check" CHECK ("patient_responsibility"."kind" IN ('representante_legal','autorizado_informacion','responsable_economico'));--> statement-breakpoint
-- 2. La guarda de la atención cerrada deja de nombrar «paso siguiente» y
--    «revisión sugerida» antes de borrarlas: lo que sigue lo dice el plan y la
--    próxima cita, la agenda. El resto de la historia sigue sin reescribirse.
-- La guarda cubre también enfermedad actual, tiempo de enfermedad, funciones
-- vitales y pronóstico: hasta aquí una atención firmada podía reescribirlos.
CREATE OR REPLACE FUNCTION guard_finalized_encounter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('finalizada', 'anulada') AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.dentist_user_id, NEW.branch_id,
      NEW.appointment_id, NEW.reason, NEW.present_illness, NEW.illness_duration, NEW.vitals, NEW.evolution, NEW.indications, NEW.prognosis, NEW.examination,
      NEW.started_at, NEW.ended_at, NEW.finalized_at, NEW.finalized_by, NEW.signer_name, NEW.signer_title, NEW.signer_registration,
      NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.consent_skip_reason)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.dentist_user_id, OLD.branch_id,
      OLD.appointment_id, OLD.reason, OLD.present_illness, OLD.illness_duration, OLD.vitals, OLD.evolution, OLD.indications, OLD.prognosis, OLD.examination,
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
--> statement-breakpoint
-- 3. Salen de la atención «paso siguiente», «revisión sugerida» (sin reserva)
--    y «exámenes auxiliares»: los exámenes son órdenes con su resultado.
ALTER TABLE "encounter" DROP COLUMN IF EXISTS "next_step";--> statement-breakpoint
ALTER TABLE "encounter" DROP COLUMN IF EXISTS "next_appointment_at";--> statement-breakpoint
ALTER TABLE "encounter" DROP COLUMN IF EXISTS "auxiliary_exams";--> statement-breakpoint
-- 4. Sale la casilla de consentimiento de Antecedentes: el consentimiento de
--    datos es el de «Datos y consentimiento» (patient_data_consent), por
--    versión del aviso y finalidades, con su revocación.
ALTER TABLE "patient" DROP COLUMN IF EXISTS "data_consent_at";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN IF EXISTS "data_consent_by";
