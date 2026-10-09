-- Persona única: el contacto es la persona (quien escribe, paga, representa o
-- se atiende) y el paciente es su historia clínica. Todo paciente es exactamente
-- una persona —su vínculo `self`— y la identidad se mantiene igual en ambos
-- registros. Ver docs/decisions/0001-persona-unica.md.
ALTER TABLE "agent_proposal" ADD COLUMN "patient_id" uuid;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "doc_type" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "doc_number" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "sex" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "patient_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_proposal_org_patient_idx" ON "agent_proposal" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_org_doc_uidx" ON "contact" USING btree ("organization_id","doc_type","doc_number") WHERE "doc_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_org_patient_idx" ON "task" USING btree ("organization_id","patient_id");--> statement-breakpoint
-- Valores heredados fuera de catálogo: el tipo de documento desconocido pasa a
-- OTRO (conserva el número) y el sexo no reconocido queda sin registrar.
UPDATE "patient" SET "doc_type" = 'OTRO' WHERE "doc_type" IS NOT NULL AND "doc_type" NOT IN ('DNI','CE','PASAPORTE','OTRO');
UPDATE "patient" SET "sex" = upper("sex") WHERE "sex" IS NOT NULL AND "sex" NOT IN ('M','F') AND upper("sex") IN ('M','F');
UPDATE "patient" SET "sex" = NULL WHERE "sex" IS NOT NULL AND "sex" NOT IN ('M','F');--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_doc_type_check" CHECK ("patient"."doc_type" IS NULL OR "patient"."doc_type" IN ('DNI','CE','PASAPORTE','OTRO'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_sex_check" CHECK ("patient"."sex" IS NULL OR "patient"."sex" IN ('M','F'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_doc_type_check" CHECK ("contact"."doc_type" IS NULL OR "contact"."doc_type" IN ('DNI','CE','PASAPORTE','OTRO'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_sex_check" CHECK ("contact"."sex" IS NULL OR "contact"."sex" IN ('M','F'));--> statement-breakpoint
-- Propuestas del agente y tareas referidas a un paciente: FK compuesta por
-- organización (sin FK en el esquema TS para evitar el ciclo crm ↔ clinical).
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_patient_fk" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patient" ("organization_id", "id");
ALTER TABLE "task" ADD CONSTRAINT "task_patient_fk" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patient" ("organization_id", "id");
UPDATE "agent_proposal" ap SET "patient_id" = p."id" FROM "patient" p
  WHERE ap."patient_id" IS NULL AND p."organization_id" = ap."organization_id" AND p."id"::text = ap."payload"->>'patientId';--> statement-breakpoint
-- Al vincular a la propia persona se concilia la identidad: manda lo registrado
-- en la ficha (nombre y documento verificados por el equipo) y se completa con
-- lo que solo el contacto conocía. Un teléfono o correo distinto del contacto
-- no se pierde: queda anotado en sus notas.
CREATE FUNCTION reconcile_patient_person(p_org text, p_patient uuid, p_contact uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c contact%ROWTYPE;
  p patient%ROWTYPE;
  kept text := '';
BEGIN
  -- Mismo orden de bloqueo que los servicios: contacto y después paciente.
  SELECT * INTO c FROM contact WHERE organization_id = p_org AND id = p_contact FOR UPDATE;
  SELECT * INTO p FROM patient WHERE organization_id = p_org AND id = p_patient FOR UPDATE;
  IF c.id IS NULL OR p.id IS NULL THEN RETURN; END IF;
  IF p.phone IS NOT NULL AND c.phone IS NOT NULL AND p.phone <> c.phone THEN
    kept := kept || E'\nTeléfono anterior del contacto: ' || c.phone;
  END IF;
  IF p.email IS NOT NULL AND c.email IS NOT NULL AND lower(p.email) <> lower(c.email) THEN
    kept := kept || E'\nCorreo anterior del contacto: ' || c.email;
  END IF;
  UPDATE contact SET
    display_name = p.display_name,
    doc_type = CASE WHEN p.doc_number IS NOT NULL THEN p.doc_type ELSE c.doc_type END,
    doc_number = COALESCE(p.doc_number, c.doc_number),
    birth_date = COALESCE(p.birth_date, c.birth_date),
    sex = COALESCE(p.sex, c.sex),
    phone = COALESCE(p.phone, c.phone),
    email = COALESCE(p.email, c.email),
    notes = NULLIF(btrim(COALESCE(c.notes, '') || kept, E'\n'), ''),
    updated_at = now()
  WHERE organization_id = p_org AND id = p_contact;
END;
$$;--> statement-breakpoint
-- La identidad se edita desde cualquiera de los dos registros y el otro la
-- recibe en la misma transacción. Cada sentido solo escribe si hay diferencia,
-- así el rebote termina en el primer paso.
CREATE FUNCTION sync_patient_from_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE patient p SET
    display_name = NEW.display_name, doc_type = NEW.doc_type, doc_number = NEW.doc_number,
    birth_date = NEW.birth_date, sex = NEW.sex, phone = NEW.phone, email = NEW.email, updated_at = now()
  FROM patient_contact pc
  WHERE pc.organization_id = NEW.organization_id AND pc.contact_id = NEW.id AND pc.relationship = 'self'
    AND p.organization_id = pc.organization_id AND p.id = pc.patient_id
    AND (p.display_name, p.doc_type, p.doc_number, p.birth_date, p.sex, p.phone, p.email)
      IS DISTINCT FROM (NEW.display_name, NEW.doc_type, NEW.doc_number, NEW.birth_date, NEW.sex, NEW.phone, NEW.email);
  RETURN NULL;
END;
$$;
CREATE TRIGGER contact_person_identity_sync AFTER UPDATE OF display_name, doc_type, doc_number, birth_date, sex, phone, email ON contact FOR EACH ROW EXECUTE FUNCTION sync_patient_from_person();--> statement-breakpoint
CREATE FUNCTION sync_person_from_patient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contact c SET
    display_name = NEW.display_name, doc_type = NEW.doc_type, doc_number = NEW.doc_number,
    birth_date = NEW.birth_date, sex = NEW.sex, phone = NEW.phone, email = NEW.email, updated_at = now()
  FROM patient_contact pc
  WHERE pc.organization_id = NEW.organization_id AND pc.patient_id = NEW.id AND pc.relationship = 'self'
    AND c.organization_id = pc.organization_id AND c.id = pc.contact_id
    AND (c.display_name, c.doc_type, c.doc_number, c.birth_date, c.sex, c.phone, c.email)
      IS DISTINCT FROM (NEW.display_name, NEW.doc_type, NEW.doc_number, NEW.birth_date, NEW.sex, NEW.phone, NEW.email);
  RETURN NULL;
END;
$$;
CREATE TRIGGER patient_person_identity_sync AFTER UPDATE OF display_name, doc_type, doc_number, birth_date, sex, phone, email ON patient FOR EACH ROW EXECUTE FUNCTION sync_person_from_patient();--> statement-breakpoint
CREATE FUNCTION link_patient_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reconcile_patient_person(NEW.organization_id, NEW.patient_id, NEW.contact_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER patient_contact_person_link AFTER INSERT OR UPDATE OF relationship ON patient_contact FOR EACH ROW WHEN (NEW.relationship = 'self') EXECUTE FUNCTION link_patient_person();--> statement-breakpoint
-- Una persona creada solo para dar identidad a la ficha —sin canales ni nada que
-- la referencie fuera de esa ficha— es provisional. Se detecta por las claves
-- foráneas hacia contact, así una tabla nueva que la referencie cuenta sola.
CREATE FUNCTION is_placeholder_person(p_org text, p_contact uuid, p_patient uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  ref record;
  used boolean;
BEGIN
  FOR ref IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'contact'::regclass AND a.attname <> 'organization_id'
  LOOP
    IF ref.tbl = 'patient_contact'::regclass THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1 AND patient_id <> $2)', ref.tbl, ref.col)
        INTO used USING p_contact, p_patient;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', ref.tbl, ref.col)
        INTO used USING p_contact;
    END IF;
    IF used THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;--> statement-breakpoint
-- Identificar al paciente con otra persona sustituye a la provisional: se
-- desvincula y se elimina (nada más la referencia), para no dejar dos
-- identidades. Si la persona actual ya tiene actividad, el índice único rechaza
-- el segundo vínculo.
CREATE FUNCTION adopt_patient_person() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous uuid;
BEGIN
  SELECT contact_id INTO previous FROM patient_contact
    WHERE organization_id = NEW.organization_id AND patient_id = NEW.patient_id
      AND relationship = 'self' AND contact_id <> NEW.contact_id;
  IF previous IS NOT NULL AND is_placeholder_person(NEW.organization_id, previous, NEW.patient_id) THEN
    DELETE FROM patient_contact
      WHERE organization_id = NEW.organization_id AND patient_id = NEW.patient_id AND contact_id = previous;
    DELETE FROM contact WHERE organization_id = NEW.organization_id AND id = previous;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_contact_person_adopt BEFORE INSERT OR UPDATE OF relationship ON patient_contact FOR EACH ROW WHEN (NEW.relationship = 'self') EXECUTE FUNCTION adopt_patient_person();--> statement-breakpoint
-- Todo paciente es una persona. Si al confirmar la transacción nadie vinculó a
-- la propia persona, se adopta la que ya tiene su mismo documento (identificador
-- fuerte; nunca el teléfono) o se crea desde la filiación.
CREATE FUNCTION ensure_patient_person(p_org text, p_patient uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p patient%ROWTYPE;
  person uuid;
BEGIN
  SELECT * INTO p FROM patient WHERE organization_id = p_org AND id = p_patient;
  IF p.id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM patient_contact WHERE organization_id = p_org AND patient_id = p_patient AND relationship = 'self') THEN
    RETURN;
  END IF;
  IF p.doc_number IS NOT NULL THEN
    SELECT c.id INTO person FROM contact c
      WHERE c.organization_id = p_org AND c.doc_type IS NOT DISTINCT FROM p.doc_type AND c.doc_number = p.doc_number
        AND NOT EXISTS (SELECT 1 FROM patient_contact pc WHERE pc.organization_id = p_org AND pc.contact_id = c.id AND pc.relationship = 'self')
      LIMIT 1;
  END IF;
  IF person IS NULL THEN
    INSERT INTO contact (organization_id, display_name, phone, email, doc_type, doc_number, birth_date, sex)
      VALUES (p_org, p.display_name, p.phone, p.email, p.doc_type, p.doc_number, p.birth_date, p.sex)
      RETURNING id INTO person;
  END IF;
  INSERT INTO patient_contact (organization_id, patient_id, contact_id, relationship, is_preferred)
    VALUES (p_org, p_patient, person, 'self',
      NOT EXISTS (SELECT 1 FROM patient_contact WHERE organization_id = p_org AND patient_id = p_patient AND is_preferred))
    ON CONFLICT (organization_id, patient_id, contact_id) DO UPDATE SET relationship = 'self', updated_at = now();
END;
$$;--> statement-breakpoint
CREATE FUNCTION patient_requires_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_patient_person(NEW.organization_id, NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER patient_person_required AFTER INSERT ON patient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION patient_requires_person();--> statement-breakpoint
-- El vínculo con la propia persona no se retira ni se degrada: se sustituye.
CREATE FUNCTION guard_patient_person_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM patient WHERE organization_id = OLD.organization_id AND id = OLD.patient_id)
    AND NOT EXISTS (SELECT 1 FROM patient_contact WHERE organization_id = OLD.organization_id AND patient_id = OLD.patient_id AND relationship = 'self') THEN
    RAISE EXCEPTION 'El paciente debe conservar su propia persona' USING ERRCODE = '23514', CONSTRAINT = 'patient_person_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER patient_contact_person_guard AFTER DELETE OR UPDATE OF relationship ON patient_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.relationship = 'self') EXECUTE FUNCTION guard_patient_person_link();--> statement-breakpoint
-- Datos existentes: primero se concilian las personas ya vinculadas y después
-- se da persona a los pacientes que aún no la tienen.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT organization_id, patient_id, contact_id FROM patient_contact WHERE relationship = 'self' LOOP
    PERFORM reconcile_patient_person(r.organization_id, r.patient_id, r.contact_id);
  END LOOP;
  FOR r IN SELECT organization_id, id FROM patient ORDER BY created_at, id LOOP
    PERFORM ensure_patient_person(r.organization_id, r.id);
  END LOOP;
END;
$$;
