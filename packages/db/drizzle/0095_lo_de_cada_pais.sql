-- Lo de cada país (fase 3, paso 5; ADR 0036). La base de odentIA es igual en
-- todos los países y lo que solo vale en Perú lo decide el país de la clínica
-- en `@odentia/clinical` (`clinicalProfileFor`), no la base. No hay datos
-- reales: lo que sale se borra sin plan de conservación.
--
-- 1. Sale el ubigeo del INEI: la dirección es la internacional. En Perú el
--    departamento se elige de una lista (ISO 3166-2:PE) y fuera se escribe.
ALTER TABLE "patient" DROP COLUMN IF EXISTS "birth_place_ubigeo";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN IF EXISTS "address_ubigeo";--> statement-breakpoint
ALTER TABLE "branch" DROP COLUMN IF EXISTS "ubigeo";--> statement-breakpoint
DROP TABLE IF EXISTS "ubigeo";--> statement-breakpoint
-- 2. Dirección internacional (HL7 FHIR Address) y lugar de nacimiento.
--    `address` sigue siendo la calle y el número; la región guarda el código
--    ISO 3166-2 cuando el país tiene lista y, si no, lo que se escribe.
ALTER TABLE "patient" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "address_district" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "address_region" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "address_country" char(2);--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "birth_country" char(2);--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "birth_place" text;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_address_lengths_check" CHECK (
  ("address_city" IS NULL OR char_length("address_city") BETWEEN 1 AND 100)
  AND ("address_district" IS NULL OR char_length("address_district") BETWEEN 1 AND 100)
  AND ("address_region" IS NULL OR char_length("address_region") BETWEEN 1 AND 100)
  AND ("address_postal_code" IS NULL OR char_length("address_postal_code") BETWEEN 1 AND 20)
  AND ("birth_place" IS NULL OR char_length("birth_place") BETWEEN 1 AND 200)
);--> statement-breakpoint
-- 3. Documento: la lista de tipos depende del país y la valida el servicio
--    (salen los checks con la lista peruana). Siempre con su país emisor, que
--    entra en la unicidad: el mismo número puede existir en dos países.
--    Los documentos ya guardados toman su país: los peruanos (DNI, CE, CNV),
--    el Perú; los demás, el país de su clínica.
ALTER TABLE "patient" DROP CONSTRAINT IF EXISTS "patient_doc_type_check";--> statement-breakpoint
ALTER TABLE "contact" DROP CONSTRAINT IF EXISTS "contact_doc_type_check";--> statement-breakpoint
UPDATE "patient" SET "doc_country" = 'PE'
  WHERE "doc_number" IS NOT NULL AND "doc_type" IN ('DNI', 'CE', 'CNV') AND "doc_country" IS DISTINCT FROM 'PE';--> statement-breakpoint
UPDATE "contact" SET "doc_country" = 'PE'
  WHERE "doc_number" IS NOT NULL AND "doc_type" IN ('DNI', 'CE', 'CNV') AND "doc_country" IS DISTINCT FROM 'PE';--> statement-breakpoint
UPDATE "patient" p SET "doc_country" = op."country_code"
  FROM "org_profile" op
  WHERE op."organization_id" = p."organization_id" AND p."doc_number" IS NOT NULL AND p."doc_country" IS NULL;--> statement-breakpoint
UPDATE "contact" c SET "doc_country" = op."country_code"
  FROM "org_profile" op
  WHERE op."organization_id" = c."organization_id" AND c."doc_number" IS NOT NULL AND c."doc_country" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "patient_org_doc_uidx";--> statement-breakpoint
DROP INDEX IF EXISTS "contact_org_doc_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "patient_org_doc_uidx" ON "patient" ("organization_id", "doc_country", "doc_type", "doc_number")
  NULLS NOT DISTINCT WHERE "doc_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_org_doc_uidx" ON "contact" ("organization_id", "doc_country", "doc_type", "doc_number")
  NULLS NOT DISTINCT WHERE "doc_number" IS NOT NULL;--> statement-breakpoint
-- La persona propia de una ficha se busca por su documento con su país.
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
        AND c.doc_country IS NOT DISTINCT FROM p.doc_country
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
$$;
--> statement-breakpoint
-- 4. Seguro con un tipo general, igual en todos los países; SIS, EsSalud y
--    EPS quedan como régimen con nombre propio en Perú. Salen el detalle libre
--    del seguro y lo que no encajó en un catálogo al migrar la identidad.
ALTER TABLE "patient" ADD COLUMN "insurance_scheme" text;--> statement-breakpoint
UPDATE "patient" SET "insurance_scheme" = "insurance_type", "insurance_type" = 'PUBLICO'
  WHERE "insurance_type" IN ('SIS', 'ESSALUD');--> statement-breakpoint
UPDATE "patient" SET "insurance_scheme" = 'EPS', "insurance_type" = 'PRIVADO' WHERE "insurance_type" = 'EPS';--> statement-breakpoint
UPDATE "patient" SET "insurance_type" = NULL
  WHERE "insurance_type" IS NOT NULL AND "insurance_type" NOT IN ('PUBLICO', 'PRIVADO', 'PARTICULAR', 'OTRO');--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_insurance_type_check"
  CHECK ("insurance_type" IS NULL OR "insurance_type" IN ('PUBLICO', 'PRIVADO', 'PARTICULAR', 'OTRO'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_insurance_scheme_check"
  CHECK ("insurance_scheme" IS NULL OR ("insurance_type" IS NOT NULL AND char_length("insurance_scheme") BETWEEN 1 AND 20));--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN IF EXISTS "insurance_detail";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN IF EXISTS "identity_legacy";--> statement-breakpoint
-- 5. «Registro de pacientes»: nombre, nacimiento y un teléfono o correo se
--    piden siempre; los datos censales solo pueden ser opcionales o no pedirse;
--    sale el detalle del seguro.
UPDATE "patient_registration_config" SET "fields" = ("fields" - 'insuranceDetail')
  || jsonb_build_object('displayName', 'required', 'birthDate', 'required', 'phone', 'required')
  || COALESCE((
    SELECT jsonb_object_agg(f.key, 'optional')
    FROM jsonb_each_text("patient_registration_config"."fields") f
    WHERE f.key IN ('maritalStatus', 'educationLevel', 'occupation', 'origin', 'referralSource') AND f.value = 'required'
  ), '{}'::jsonb);--> statement-breakpoint
-- 6. Odontograma: una sola firma, la del perfil profesional, sin trazo. El
--    odontograma firmado de Perú guarda el título de quien firma, su norma
--    (sin valor por defecto: la pone el servicio por el país) y la atención
--    cuyo cierre lo firmó (uno por atención).
ALTER TABLE "professional_profile" ALTER COLUMN "professional_title" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "professional_profile" ALTER COLUMN "registration_body" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ALTER COLUMN "standard" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD COLUMN "examiner_title" text;--> statement-breakpoint
UPDATE "odontogram_assessment" a SET "examiner_title" = COALESCE((
  SELECT pp."professional_title" FROM "professional_profile" pp
  WHERE pp."organization_id" = a."organization_id" AND pp."user_id" = a."author_user_id"
), 'Cirujano dentista');--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ALTER COLUMN "examiner_title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" DROP COLUMN IF EXISTS "signature";--> statement-breakpoint
ALTER TABLE "odontogram_assessment" DROP COLUMN IF EXISTS "signature_kind";--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "odontogram_assessment_encounter_uidx" ON "odontogram_assessment" ("encounter_id") WHERE "encounter_id" IS NOT NULL;--> statement-breakpoint
-- 7. Lo tratado queda dibujado: cada servicio dice qué deja en la pieza y el
--    hallazgo nuevo recuerda qué tratamiento lo dejó (se escribe al insertar;
--    el rol de la aplicación sigue sin poder reescribir el hallazgo).
ALTER TABLE "service_catalog" ADD COLUMN "leaves_finding" jsonb;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_leaves_finding_check"
  CHECK ("leaves_finding" IS NULL OR (jsonb_typeof("leaves_finding") = 'object' AND jsonb_typeof("leaves_finding" -> 'condition') = 'string'));--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "left_by_plan_item_id" uuid;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_left_by_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("left_by_plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;
