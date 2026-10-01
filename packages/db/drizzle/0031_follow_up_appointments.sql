ALTER TABLE clinical_follow_up RENAME COLUMN scheduled_at TO legacy_scheduled_at;
ALTER TABLE clinical_follow_up ADD COLUMN appointment_id uuid;
UPDATE clinical_follow_up SET status = 'pendiente' WHERE status = 'programado';
CREATE UNIQUE INDEX appointment_org_patient_id_uidx ON appointment (organization_id, patient_id, id);
ALTER TABLE clinical_follow_up ADD CONSTRAINT clinical_follow_up_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id) REFERENCES appointment (organization_id, patient_id, id);
CREATE INDEX clinical_follow_up_appointment_idx ON clinical_follow_up (organization_id, appointment_id);
ALTER TABLE clinical_follow_up ADD CONSTRAINT clinical_follow_up_reservation_check CHECK (status <> 'programado' OR appointment_id IS NOT NULL);
--> statement-breakpoint
-- El bloqueo de cita precede al del control en los servicios. La guarda protege
-- también las escrituras directas sin inferir vínculos históricos.
CREATE FUNCTION guard_follow_up_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appointment_status text;
BEGIN
  IF NEW.appointment_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR (NEW.status = 'programado' AND OLD.status <> 'programado')) THEN
    SELECT status INTO appointment_status FROM appointment
      WHERE id = NEW.appointment_id AND organization_id = NEW.organization_id AND patient_id = NEW.patient_id FOR UPDATE;
    IF appointment_status IS NULL OR appointment_status NOT IN ('programada', 'confirmada') THEN
      RAISE EXCEPTION 'La cita no admite programar el control' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinical_follow_up_appointment_guard BEFORE INSERT OR UPDATE ON clinical_follow_up FOR EACH ROW EXECUTE FUNCTION guard_follow_up_appointment();
--> statement-breakpoint
-- Todas las entradas de agenda (personal, portal y agente) quedan cubiertas.
CREATE FUNCTION sync_follow_up_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('cancelada', 'no_asistio', 'atendida') THEN
    UPDATE clinical_follow_up SET status = 'pendiente', updated_at = now()
      WHERE organization_id = NEW.organization_id AND appointment_id = NEW.id AND status = 'programado';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_follow_up_sync AFTER UPDATE OF status ON appointment FOR EACH ROW EXECUTE FUNCTION sync_follow_up_appointment();
