-- Reglas de la 0072 (ADR 0079): lo que drizzle no declara y nombraba al
-- dentista o a la unidad dental.

-- 1. La guarda de la atención cerrada nombra la columna dentro de su código, y
--    PostgreSQL no lo reescribe al renombrarla. Misma regla, columna nueva.
CREATE OR REPLACE FUNCTION public.guard_finalized_encounter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('finalizada', 'anulada') AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.professional_user_id, NEW.branch_id,
      NEW.appointment_id, NEW.reason, NEW.present_illness, NEW.illness_duration, NEW.vitals, NEW.evolution, NEW.indications, NEW.prognosis, NEW.examination,
      NEW.started_at, NEW.ended_at, NEW.finalized_at, NEW.finalized_by, NEW.signer_name, NEW.signer_title, NEW.signer_registration,
      NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.consent_skip_reason)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.professional_user_id, OLD.branch_id,
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
$$;--> statement-breakpoint

-- 2. Las exclusiones de la agenda y los nombres que PostgreSQL puso solo
--    (llave primaria y no nulos) siguen a la columna o tabla nueva.
ALTER TABLE appointment RENAME CONSTRAINT appointment_no_overlap_chair TO appointment_no_overlap_room;--> statement-breakpoint
ALTER TABLE appointment RENAME CONSTRAINT appointment_no_overlap_dentist TO appointment_no_overlap_professional;--> statement-breakpoint
ALTER TABLE appointment RENAME CONSTRAINT appointment_dentist_user_id_not_null TO appointment_professional_user_id_not_null;--> statement-breakpoint
ALTER TABLE appointment RENAME CONSTRAINT appointment_chair_id_not_null TO appointment_room_id_not_null;--> statement-breakpoint
ALTER TABLE professional_schedule RENAME CONSTRAINT professional_schedule_dentist_user_id_not_null TO professional_schedule_professional_user_id_not_null;--> statement-breakpoint
ALTER TABLE encounter RENAME CONSTRAINT encounter_dentist_user_id_not_null TO encounter_professional_user_id_not_null;--> statement-breakpoint
ALTER TABLE encounter_dictation_suggestion RENAME CONSTRAINT encounter_dictation_suggestion_dentist_user_id_not_null TO encounter_dictation_suggestion_professional_user_id_not_null;--> statement-breakpoint
ALTER TABLE admin.saas_waitlist_request RENAME CONSTRAINT saas_waitlist_request_dentists_not_null TO saas_waitlist_request_professionals_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_pkey TO schedule_room_pkey;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_id_not_null TO schedule_room_id_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_organization_id_not_null TO schedule_room_organization_id_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_branch_id_not_null TO schedule_room_branch_id_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_name_not_null TO schedule_room_name_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_is_active_not_null TO schedule_room_is_active_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_created_at_not_null TO schedule_room_created_at_not_null;--> statement-breakpoint
ALTER TABLE schedule_room RENAME CONSTRAINT schedule_chair_updated_at_not_null TO schedule_room_updated_at_not_null;--> statement-breakpoint

-- 3. El rol clínico pasa de dentist a clinician. Un miembro puede tener varios
--    roles separados por coma: se cambia solo ese, en su lugar.
UPDATE member SET role = (
  SELECT string_agg(CASE WHEN trim(r) = 'dentist' THEN 'clinician' ELSE trim(r) END, ',' ORDER BY n)
  FROM unnest(string_to_array(role, ',')) WITH ORDINALITY AS x(r, n)
) WHERE role ~ '(^|,)\s*dentist\s*(,|$)';--> statement-breakpoint
UPDATE invitation SET role = (
  SELECT string_agg(CASE WHEN trim(r) = 'dentist' THEN 'clinician' ELSE trim(r) END, ',' ORDER BY n)
  FROM unnest(string_to_array(role, ',')) WITH ORDINALITY AS x(r, n)
) WHERE role ~ '(^|,)\s*dentist\s*(,|$)';--> statement-breakpoint

-- 4. Argos: la agenda expone al profesional con el nombre nuevo y el equipo
--    traduce el rol nuevo. Lo demás de las vistas sigue a las columnas solo.
ALTER VIEW argos.agenda_base RENAME COLUMN dentist_user_id TO professional_user_id;--> statement-breakpoint
CREATE OR REPLACE VIEW argos.equipo AS
SELECT u.name AS profesional,
  array_to_string(ARRAY(SELECT CASE trim(r) WHEN 'owner' THEN 'propietario' WHEN 'admin' THEN 'administración' WHEN 'clinician' THEN 'odontología'
    WHEN 'reception' THEN 'recepción' WHEN 'cashier' THEN 'caja' ELSE 'otro' END FROM unnest(string_to_array(m.role, ',')) r), ', ') AS rol,
  (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM public.professional_specialty ps
    JOIN public.org_specialty s ON s.organization_id = ps.organization_id AND s.id = ps.specialty_id
    WHERE ps.organization_id = m.organization_id AND ps.user_id = m.user_id) AS especialidades,
  (EXISTS (SELECT 1 FROM public.professional_schedule s WHERE s.organization_id = m.organization_id AND s.professional_user_id = m.user_id)
    OR EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = m.organization_id AND a.professional_user_id = m.user_id)) AS atiende
FROM public.member m
JOIN auth."user" u ON u.id = m.user_id
WHERE m.organization_id = NULLIF(current_setting('app.org_id', true), '');
