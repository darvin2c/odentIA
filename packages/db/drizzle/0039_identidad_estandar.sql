CREATE TABLE "patient_data_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"notice_version" integer NOT NULL,
	"notice_text" text NOT NULL,
	"purposes" text[] NOT NULL,
	"granted_by_contact_id" uuid,
	"granted_by_name" text NOT NULL,
	"channel" text NOT NULL,
	"recorded_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	CONSTRAINT "patient_data_consent_channel_check" CHECK ("patient_data_consent"."channel" IN ('presencial','formulario_publico','portal')),
	CONSTRAINT "patient_data_consent_revoke_check" CHECK (("patient_data_consent"."revoked_at" IS NULL) = ("patient_data_consent"."revoke_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "patient_family_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"condition" text NOT NULL,
	"cie10_code" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_family_history_relationship_check" CHECK ("patient_family_history"."relationship" IN ('madre','padre','hijo','conyuge','hermano','abuelo','tio','otro_familiar'))
);
--> statement-breakpoint
CREATE TABLE "ubigeo" (
	"code" char(6) PRIMARY KEY NOT NULL,
	"department" text NOT NULL,
	"province" text,
	"district" text,
	CONSTRAINT "ubigeo_code_check" CHECK ("ubigeo"."code" ~ '^[0-9]{6}$')
);
--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT "patient_doc_type_check";--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT "patient_sex_check";--> statement-breakpoint
ALTER TABLE "contact" DROP CONSTRAINT "contact_doc_type_check";--> statement-breakpoint
ALTER TABLE "contact" DROP CONSTRAINT "contact_sex_check";--> statement-breakpoint
ALTER TABLE "patient_allergy" ALTER COLUMN "severity" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "given_names" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "paternal_surname" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "maternal_surname" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "identity_needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "identity_legacy" jsonb;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "doc_country" char(2);--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "nationality" char(2);--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "birth_place_ubigeo" char(6);--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "address_ubigeo" char(6);--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "address_reference" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "insurer_name" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "affiliation_number" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "emergency_contact_relationship" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "asa_class" text;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "kind" text DEFAULT 'alergia' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "criticality" text;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD COLUMN "verification" text DEFAULT 'no_confirmada' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "given_names" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "paternal_surname" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "maternal_surname" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "doc_country" char(2);--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_granted_by_contact_id_contact_id_fk" FOREIGN KEY ("granted_by_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_cie10_code_cie10_code_code_fk" FOREIGN KEY ("cie10_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_data_consent_org_patient_idx" ON "patient_data_consent" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_family_history_org_patient_idx" ON "patient_family_history" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "ubigeo_department_idx" ON "ubigeo" USING btree ("department");--> statement-breakpoint
-- Catálogos de filiación (ADR 0004). Lo que no encaja en el catálogo no se
-- descarta: se guarda en identity_legacy y la ficha queda por revisar.
UPDATE "patient" SET "identity_legacy" = COALESCE("identity_legacy", '{}'::jsonb) || jsonb_build_object('maritalStatus', "marital_status")
  WHERE "marital_status" IS NOT NULL AND translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') !~ '^(solter|casad|convivien|viud|divorciad|separad)';--> statement-breakpoint
UPDATE "patient" SET "marital_status" = CASE
    WHEN translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') ~ '^solter' THEN 'soltero'
    WHEN translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') ~ '^casad' THEN 'casado'
    WHEN translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') ~ '^convivien' THEN 'conviviente'
    WHEN translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') ~ '^viud' THEN 'viudo'
    WHEN translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') ~ '^divorciad' THEN 'divorciado'
    WHEN translate(lower(btrim("marital_status")), 'áéíóú', 'aeiou') ~ '^separad' THEN 'separado'
    ELSE NULL
  END
  WHERE "marital_status" IS NOT NULL;--> statement-breakpoint
UPDATE "patient" SET "identity_legacy" = COALESCE("identity_legacy", '{}'::jsonb) || jsonb_build_object('educationLevel', "education_level")
  WHERE "education_level" IS NOT NULL AND translate(lower(btrim("education_level")), 'áéíóú', 'aeiou') !~ '^(sin nivel|ninguno|inicial|primaria (in)?completa|secundaria (in)?completa|superior (tecnica|no universitaria) (in)?completa|superior universitaria (in)?completa|universitaria (in)?completa|posgrado|postgrado|maestria|doctorado)$';--> statement-breakpoint
UPDATE "patient" SET "education_level" = CASE translate(lower(btrim("education_level")), 'áéíóú', 'aeiou')
    WHEN 'sin nivel' THEN 'sin_nivel' WHEN 'ninguno' THEN 'sin_nivel' WHEN 'inicial' THEN 'inicial'
    WHEN 'primaria incompleta' THEN 'primaria_incompleta' WHEN 'primaria completa' THEN 'primaria_completa'
    WHEN 'secundaria incompleta' THEN 'secundaria_incompleta' WHEN 'secundaria completa' THEN 'secundaria_completa'
    WHEN 'superior tecnica incompleta' THEN 'superior_no_universitaria_incompleta'
    WHEN 'superior tecnica completa' THEN 'superior_no_universitaria_completa'
    WHEN 'superior no universitaria incompleta' THEN 'superior_no_universitaria_incompleta'
    WHEN 'superior no universitaria completa' THEN 'superior_no_universitaria_completa'
    WHEN 'superior universitaria incompleta' THEN 'superior_universitaria_incompleta'
    WHEN 'superior universitaria completa' THEN 'superior_universitaria_completa'
    WHEN 'universitaria incompleta' THEN 'superior_universitaria_incompleta'
    WHEN 'universitaria completa' THEN 'superior_universitaria_completa'
    WHEN 'posgrado' THEN 'posgrado' WHEN 'postgrado' THEN 'posgrado'
    WHEN 'maestria' THEN 'posgrado' WHEN 'doctorado' THEN 'posgrado'
    ELSE NULL
  END
  WHERE "education_level" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_marital_status_check" CHECK ("patient"."marital_status" IS NULL OR "patient"."marital_status" IN ('soltero','casado','conviviente','viudo','divorciado','separado'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_education_level_check" CHECK ("patient"."education_level" IS NULL OR "patient"."education_level" IN ('sin_nivel','inicial','primaria_incompleta','primaria_completa','secundaria_incompleta','secundaria_completa','superior_no_universitaria_incompleta','superior_no_universitaria_completa','superior_universitaria_incompleta','superior_universitaria_completa','posgrado'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_asa_class_check" CHECK ("patient"."asa_class" IS NULL OR "patient"."asa_class" IN ('I','II','III','IV','V','VI'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_doc_type_check" CHECK ("patient"."doc_type" IS NULL OR "patient"."doc_type" IN ('DNI','CE','PASAPORTE','CNV','DIE','OTRO'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_sex_check" CHECK ("patient"."sex" IS NULL OR "patient"."sex" IN ('M','F','I','D'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_kind_check" CHECK ("patient_allergy"."kind" IN ('alergia','intolerancia'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_criticality_check" CHECK ("patient_allergy"."criticality" IS NULL OR "patient_allergy"."criticality" IN ('baja','alta','no_evaluable'));--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_verification_check" CHECK ("patient_allergy"."verification" IN ('no_confirmada','confirmada','descartada'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_doc_type_check" CHECK ("contact"."doc_type" IS NULL OR "contact"."doc_type" IN ('DNI','CE','PASAPORTE','CNV','DIE','OTRO'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_sex_check" CHECK ("contact"."sex" IS NULL OR "contact"."sex" IN ('M','F','I','D'));
--> statement-breakpoint
-- Aislamiento por organización de las tablas nuevas; el ubigeo es un catálogo
-- global de solo lectura para la aplicación, como CIE-10.
ALTER TABLE "patient_data_consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_data_consent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "patient_data_consent"
  USING (organization_id = nullif(current_setting('app.org_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "patient_family_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_family_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "patient_family_history"
  USING (organization_id = nullif(current_setting('app.org_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- El consentimiento se otorga y se revoca; nunca se borra.
REVOKE DELETE, TRUNCATE ON "patient_data_consent" FROM dentalagent_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "ubigeo" FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON "ubigeo" TO dentalagent_app;--> statement-breakpoint
-- El consentimiento único anterior pasa al registro por versión (versión 0).
INSERT INTO "patient_data_consent" ("organization_id", "patient_id", "notice_version", "notice_text", "purposes", "granted_by_name", "channel", "recorded_by", "granted_at")
  SELECT "organization_id", "id", 0, 'Consentimiento registrado antes del registro por versión del aviso.', ARRAY['atencion'], "display_name", 'presencial', "data_consent_by", "data_consent_at"
  FROM "patient" WHERE "data_consent_at" IS NOT NULL;--> statement-breakpoint
-- Nombre separado: se parte por heurística (nombres + apellido paterno +
-- apellido materno) y la ficha queda «identidad por revisar» hasta que
-- recepción lo confirme. La persona recibe lo mismo por la sincronía.
UPDATE "patient" SET
  "given_names" = CASE WHEN array_length(t.parts, 1) >= 3 THEN array_to_string(t.parts[1:array_length(t.parts, 1) - 2], ' ') ELSE t.parts[1] END,
  "paternal_surname" = CASE WHEN array_length(t.parts, 1) >= 3 THEN t.parts[array_length(t.parts, 1) - 1] WHEN array_length(t.parts, 1) = 2 THEN t.parts[2] END,
  "maternal_surname" = CASE WHEN array_length(t.parts, 1) >= 3 THEN t.parts[array_length(t.parts, 1)] END,
  "identity_needs_review" = true
FROM (SELECT "id", regexp_split_to_array(btrim("display_name"), '\s+') AS parts FROM "patient") AS t
WHERE t."id" = "patient"."id" AND "patient"."given_names" IS NULL AND btrim("patient"."display_name") <> '';--> statement-breakpoint
-- El nombre visible se deriva del nombre separado cuando este cambia. Si solo
-- cambia el nombre visible (p. ej. una edición antigua), se conserva y la
-- ficha queda por revisar.
CREATE FUNCTION derive_person_display_name() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE composed text;
BEGIN
  composed := NULLIF(btrim(regexp_replace(concat_ws(' ', NEW.given_names, NEW.paternal_surname, NEW.maternal_surname), '\s+', ' ', 'g')), '');
  IF TG_OP = 'INSERT' THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF (NEW.given_names, NEW.paternal_surname, NEW.maternal_surname) IS DISTINCT FROM (OLD.given_names, OLD.paternal_surname, OLD.maternal_surname) THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name AND composed IS NOT NULL AND TG_TABLE_NAME = 'patient' THEN
    NEW.identity_needs_review := true;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER patient_display_name_derive BEFORE INSERT OR UPDATE ON "patient" FOR EACH ROW EXECUTE FUNCTION derive_person_display_name();--> statement-breakpoint
CREATE TRIGGER contact_display_name_derive BEFORE INSERT OR UPDATE ON "contact" FOR EACH ROW EXECUTE FUNCTION derive_person_display_name();--> statement-breakpoint
-- La sincronía persona ↔ ficha (0034) incluye el nombre separado y el país
-- emisor del documento.
DROP TRIGGER "contact_person_identity_sync" ON "contact";--> statement-breakpoint
DROP TRIGGER "patient_person_identity_sync" ON "patient";--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_patient_from_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE patient p SET
    display_name = NEW.display_name, given_names = NEW.given_names, paternal_surname = NEW.paternal_surname,
    maternal_surname = NEW.maternal_surname, doc_type = NEW.doc_type, doc_number = NEW.doc_number,
    doc_country = NEW.doc_country, birth_date = NEW.birth_date, sex = NEW.sex, phone = NEW.phone,
    email = NEW.email, updated_at = now()
  FROM patient_contact pc
  WHERE pc.organization_id = NEW.organization_id AND pc.contact_id = NEW.id AND pc.relationship = 'self'
    AND p.organization_id = pc.organization_id AND p.id = pc.patient_id
    AND (p.display_name, p.given_names, p.paternal_surname, p.maternal_surname, p.doc_type, p.doc_number, p.doc_country, p.birth_date, p.sex, p.phone, p.email)
      IS DISTINCT FROM (NEW.display_name, NEW.given_names, NEW.paternal_surname, NEW.maternal_surname, NEW.doc_type, NEW.doc_number, NEW.doc_country, NEW.birth_date, NEW.sex, NEW.phone, NEW.email);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_person_from_patient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contact c SET
    display_name = NEW.display_name, given_names = NEW.given_names, paternal_surname = NEW.paternal_surname,
    maternal_surname = NEW.maternal_surname, doc_type = NEW.doc_type, doc_number = NEW.doc_number,
    doc_country = NEW.doc_country, birth_date = NEW.birth_date, sex = NEW.sex, phone = NEW.phone,
    email = NEW.email, updated_at = now()
  FROM patient_contact pc
  WHERE pc.organization_id = NEW.organization_id AND pc.patient_id = NEW.id AND pc.relationship = 'self'
    AND c.organization_id = pc.organization_id AND c.id = pc.contact_id
    AND (c.display_name, c.given_names, c.paternal_surname, c.maternal_surname, c.doc_type, c.doc_number, c.doc_country, c.birth_date, c.sex, c.phone, c.email)
      IS DISTINCT FROM (NEW.display_name, NEW.given_names, NEW.paternal_surname, NEW.maternal_surname, NEW.doc_type, NEW.doc_number, NEW.doc_country, NEW.birth_date, NEW.sex, NEW.phone, NEW.email);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER contact_person_identity_sync AFTER UPDATE OF display_name, given_names, paternal_surname, maternal_surname, doc_type, doc_number, doc_country, birth_date, sex, phone, email ON contact FOR EACH ROW EXECUTE FUNCTION sync_patient_from_person();--> statement-breakpoint
CREATE TRIGGER patient_person_identity_sync AFTER UPDATE OF display_name, given_names, paternal_surname, maternal_surname, doc_type, doc_number, doc_country, birth_date, sex, phone, email ON patient FOR EACH ROW EXECUTE FUNCTION sync_person_from_patient();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reconcile_patient_person(p_org text, p_patient uuid, p_contact uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c contact%ROWTYPE;
  p patient%ROWTYPE;
  kept text := '';
BEGIN
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
    given_names = COALESCE(p.given_names, c.given_names),
    paternal_surname = COALESCE(p.paternal_surname, c.paternal_surname),
    maternal_surname = COALESCE(p.maternal_surname, c.maternal_surname),
    doc_type = CASE WHEN p.doc_number IS NOT NULL THEN p.doc_type ELSE c.doc_type END,
    doc_number = COALESCE(p.doc_number, c.doc_number),
    doc_country = CASE WHEN p.doc_number IS NOT NULL THEN p.doc_country ELSE c.doc_country END,
    birth_date = COALESCE(p.birth_date, c.birth_date),
    sex = COALESCE(p.sex, c.sex),
    phone = COALESCE(p.phone, c.phone),
    email = COALESCE(p.email, c.email),
    notes = NULLIF(btrim(COALESCE(c.notes, '') || kept, E'\n'), ''),
    updated_at = now()
  WHERE organization_id = p_org AND id = p_contact;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_patient_person(p_org text, p_patient uuid) RETURNS void LANGUAGE plpgsql AS $$
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
    INSERT INTO contact (organization_id, display_name, given_names, paternal_surname, maternal_surname, phone, email, doc_type, doc_number, doc_country, birth_date, sex)
      VALUES (p_org, p.display_name, p.given_names, p.paternal_surname, p.maternal_surname, p.phone, p.email, p.doc_type, p.doc_number, p.doc_country, p.birth_date, p.sex)
      RETURNING id INTO person;
  END IF;
  INSERT INTO patient_contact (organization_id, patient_id, contact_id, relationship, is_preferred)
    VALUES (p_org, p_patient, person, 'self',
      NOT EXISTS (SELECT 1 FROM patient_contact WHERE organization_id = p_org AND patient_id = p_patient AND is_preferred))
    ON CONFLICT (organization_id, patient_id, contact_id) DO UPDATE SET relationship = 'self', updated_at = now();
END;
$$;--> statement-breakpoint
-- La persona recibe el nombre separado ya calculado en su ficha.
UPDATE "contact" c SET "given_names" = p."given_names", "paternal_surname" = p."paternal_surname", "maternal_surname" = p."maternal_surname"
FROM "patient_contact" pc JOIN "patient" p ON p."organization_id" = pc."organization_id" AND p."id" = pc."patient_id"
WHERE pc."relationship" = 'self' AND c."organization_id" = pc."organization_id" AND c."id" = pc."contact_id" AND c."given_names" IS NULL;
