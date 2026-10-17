-- La identidad vive en la persona (fase 4, paso 7c, decisión 29; ADR 0044, que
-- cierra lo pendiente del 0001). La ficha de paciente deja de repetir nombre,
-- documento, nacimiento, sexo, teléfono, correo y si está archivada: apunta a
-- su persona con `person_id` y todo se lee desde ella. Salen los disparadores
-- que copiaban cada cambio de un lado al otro y la conciliación. Sin datos
-- reales: antes de quitar las columnas se completa en la persona lo que solo
-- tenía la ficha.
--
-- 1) Lo que se retira primero: la copia en los dos sentidos y la conciliación
--    al vincular. Desde aquí nada escribe la identidad en la ficha.
DROP TRIGGER IF EXISTS "contact_person_identity_sync" ON "contact";--> statement-breakpoint
DROP TRIGGER IF EXISTS "patient_person_identity_sync" ON "patient";--> statement-breakpoint
DROP TRIGGER IF EXISTS "patient_contact_person_link" ON "patient_contact";--> statement-breakpoint
DROP TRIGGER IF EXISTS "patient_contact_person_adopt" ON "patient_contact";--> statement-breakpoint
DROP TRIGGER IF EXISTS "patient_display_name_derive" ON "patient";--> statement-breakpoint
-- 2) El nombre separado por heurística se revisa en la persona.
ALTER TABLE "contact" ADD COLUMN "identity_needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION derive_person_display_name() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE composed text;
BEGIN
  composed := NULLIF(btrim(regexp_replace(concat_ws(' ', NEW.given_names, NEW.paternal_surname, NEW.maternal_surname), '\s+', ' ', 'g')), '');
  IF TG_OP = 'INSERT' THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF (NEW.given_names, NEW.paternal_surname, NEW.maternal_surname) IS DISTINCT FROM (OLD.given_names, OLD.paternal_surname, OLD.maternal_surname) THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name AND composed IS NOT NULL THEN
    -- Solo cambió el nombre visible (una edición antigua): se conserva y queda por revisar.
    NEW.identity_needs_review := true;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- 3) Toda ficha tiene su persona (lo garantizaba `patient_person_required`):
--    por si alguna quedó sin ella, se le da con la función de siempre.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.organization_id, p.id FROM patient p
    WHERE NOT EXISTS (SELECT 1 FROM patient_contact s WHERE s.organization_id = p.organization_id AND s.patient_id = p.id AND s.relationship = 'self')
    ORDER BY p.created_at, p.id
  LOOP
    PERFORM ensure_patient_person(r.organization_id, r.id);
  END LOOP;
END;
$$;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "person_id" uuid;--> statement-breakpoint
UPDATE "patient" p SET "person_id" = s."contact_id"
  FROM "patient_contact" s
  WHERE s."organization_id" = p."organization_id" AND s."patient_id" = p."id" AND s."relationship" = 'self';--> statement-breakpoint
-- 4) La persona completa lo que solo tenía su ficha. El nombre visible lo
--    deriva la base del nombre separado; el documento pasa entero (tipo,
--    número y país) y solo si no es ya de otra persona. Archivada si lo estaba
--    cualquiera de las dos.
UPDATE "contact" c SET
  "given_names" = COALESCE(c."given_names", p."given_names"),
  "paternal_surname" = COALESCE(c."paternal_surname", p."paternal_surname"),
  "maternal_surname" = COALESCE(c."maternal_surname", p."maternal_surname"),
  "display_name" = COALESCE(NULLIF(btrim(c."display_name"), ''), p."display_name"),
  "birth_date" = COALESCE(c."birth_date", p."birth_date"),
  "sex" = COALESCE(c."sex", p."sex"),
  "phone" = COALESCE(c."phone", p."phone"),
  "email" = COALESCE(c."email", p."email"),
  "identity_needs_review" = c."identity_needs_review" OR p."identity_needs_review",
  "is_active" = c."is_active" AND p."is_active",
  "updated_at" = now()
FROM "patient" p
WHERE p."organization_id" = c."organization_id" AND p."person_id" = c."id";--> statement-breakpoint
UPDATE "contact" c SET "doc_type" = p."doc_type", "doc_number" = p."doc_number", "doc_country" = p."doc_country"
FROM "patient" p
WHERE p."organization_id" = c."organization_id" AND p."person_id" = c."id"
  AND c."doc_number" IS NULL AND p."doc_number" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "contact" o
    WHERE o."organization_id" = p."organization_id" AND o."id" <> c."id" AND o."doc_number" = p."doc_number"
      AND o."doc_type" IS NOT DISTINCT FROM p."doc_type" AND o."doc_country" IS NOT DISTINCT FROM p."doc_country"
  );--> statement-breakpoint
-- 5) La ficha apunta a su persona: una por persona y de la misma organización.
ALTER TABLE "patient" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_org_person_uidx" ON "patient" USING btree ("organization_id", "person_id");--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_person_fk" FOREIGN KEY ("organization_id", "person_id") REFERENCES "contact" ("organization_id", "id");--> statement-breakpoint
-- 6) Sale lo que mantenía la identidad repetida y la creaba desde la ficha.
DROP TRIGGER IF EXISTS "patient_person_required" ON "patient";--> statement-breakpoint
DROP TRIGGER IF EXISTS "patient_contact_person_guard" ON "patient_contact";--> statement-breakpoint
DROP FUNCTION IF EXISTS sync_patient_from_person();--> statement-breakpoint
DROP FUNCTION IF EXISTS sync_person_from_patient();--> statement-breakpoint
DROP FUNCTION IF EXISTS link_patient_person();--> statement-breakpoint
DROP FUNCTION IF EXISTS adopt_patient_person();--> statement-breakpoint
DROP FUNCTION IF EXISTS patient_requires_person();--> statement-breakpoint
DROP FUNCTION IF EXISTS guard_patient_person_link();--> statement-breakpoint
DROP FUNCTION IF EXISTS reconcile_patient_person(text, uuid, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS ensure_patient_person(text, uuid);--> statement-breakpoint
-- 7) Las columnas repetidas y el segundo índice de documento: el documento es
--    único solo en la persona (`contact_org_doc_uidx`).
DROP INDEX IF EXISTS "patient_org_doc_uidx";--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT IF EXISTS "patient_sex_check";--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT IF EXISTS "patient_doc_type_check";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "display_name";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "given_names";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "paternal_surname";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "maternal_surname";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "identity_needs_review";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "doc_type";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "doc_number";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "doc_country";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "birth_date";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "sex";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "is_active";--> statement-breakpoint
-- 8) El vínculo `self` sigue en `patient_contact` (la lista de personas de la
--    ficha lo incluye), pero sale de `person_id`: la base lo crea al insertar
--    la ficha y lo cambia cuando cambia su persona. Nadie lo escribe aparte.
CREATE FUNCTION patient_self_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.person_id = OLD.person_id THEN RETURN NULL; END IF;
    DELETE FROM patient_contact
      WHERE organization_id = NEW.organization_id AND patient_id = NEW.id AND relationship = 'self';
  END IF;
  INSERT INTO patient_contact (organization_id, patient_id, contact_id, relationship, is_preferred)
    VALUES (NEW.organization_id, NEW.id, NEW.person_id, 'self',
      NOT EXISTS (SELECT 1 FROM patient_contact WHERE organization_id = NEW.organization_id AND patient_id = NEW.id AND is_preferred))
    ON CONFLICT (organization_id, patient_id, contact_id) DO UPDATE SET
      relationship = 'self', relationship_detail = NULL, kinship = NULL, is_emergency = false, updated_at = now();
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "patient_self_link" AFTER INSERT OR UPDATE OF "person_id" ON "patient" FOR EACH ROW EXECUTE FUNCTION patient_self_link();--> statement-breakpoint
-- Al confirmar, el único vínculo `self` de una ficha es el de su persona: no
-- se retira, no se degrada y no apunta a otra.
CREATE FUNCTION guard_patient_self_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  org text;
  pid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; pid := OLD.patient_id;
  ELSE org := NEW.organization_id; pid := NEW.patient_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM patient p WHERE p.organization_id = org AND p.id = pid
      AND NOT EXISTS (SELECT 1 FROM patient_contact s WHERE s.organization_id = org AND s.patient_id = pid AND s.relationship = 'self' AND s.contact_id = p.person_id)
  ) THEN
    RAISE EXCEPTION 'El vínculo propio del paciente es su persona' USING ERRCODE = '23514', CONSTRAINT = 'patient_self_link';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "patient_self_link_guard" AFTER INSERT OR DELETE OR UPDATE OF "relationship", "contact_id" ON "patient_contact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_patient_self_link();--> statement-breakpoint
-- 9) La persona provisional (creada solo para la ficha) se reconoce igual: la
--    ficha que la tiene como persona no cuenta como uso.
CREATE OR REPLACE FUNCTION is_placeholder_person(p_org text, p_contact uuid, p_patient uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
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
    ELSIF ref.tbl = 'patient'::regclass THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1 AND id <> $2)', ref.tbl, ref.col)
        INTO used USING p_contact, p_patient;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', ref.tbl, ref.col)
        INTO used USING p_contact;
    END IF;
    IF used THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
