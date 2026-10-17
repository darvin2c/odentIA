-- Lo repetido: personas, citas y dinero (fase 4, paso 7b-2). Sin datos reales:
-- lo que se quita no necesita plan de conservación.
-- 1) Un solo nombre visible (decisión 19): el nombre comercial, obligatorio.
--    Los datos viejos sin él toman la razón social; vacío al crear, el nombre
--    de la cuenta. La base lo copia en `organization.name`, que leen las pantallas de la cuenta: así no
--    hay dos nombres. La razón social queda para el comprobante y lo legal.
UPDATE "org_profile" SET "trade_name" = "legal_name" WHERE "trade_name" IS NULL OR btrim("trade_name") = '';--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "trade_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "trade_name" SET NOT NULL;--> statement-breakpoint
-- Al crear el perfil sin nombre comercial vale el nombre que se escribió al
-- crear la cuenta; después, vaciarlo deja la razón social.
CREATE OR REPLACE FUNCTION org_profile_trade_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.trade_name := coalesce(btrim(NEW.trade_name), '');
  IF NEW.trade_name = '' AND TG_OP = 'INSERT' THEN
    NEW.trade_name := coalesce(nullif(btrim((SELECT o."name" FROM "organization" o WHERE o."id" = NEW.organization_id)), ''), NEW.legal_name);
  ELSIF NEW.trade_name = '' THEN
    NEW.trade_name := NEW.legal_name;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "org_profile_trade_name" BEFORE INSERT OR UPDATE OF "trade_name", "legal_name" ON "org_profile" FOR EACH ROW EXECUTE FUNCTION org_profile_trade_name();--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_profile_sync_organization_name() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE "organization" SET "name" = NEW.trade_name WHERE "id" = NEW.organization_id AND "name" IS DISTINCT FROM NEW.trade_name;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "org_profile_sync_organization_name" AFTER INSERT OR UPDATE OF "trade_name" ON "org_profile" FOR EACH ROW EXECUTE FUNCTION org_profile_sync_organization_name();--> statement-breakpoint
UPDATE "organization" o SET "name" = p."trade_name" FROM "org_profile" p WHERE p."organization_id" = o."id" AND o."name" IS DISTINCT FROM p."trade_name";--> statement-breakpoint
-- 2) El contacto de emergencia es una marca sobre una persona vinculada
--    (decisión 25), como `Patient.contact` de FHIR con su parentesco HL7.
ALTER TABLE "patient_contact" ADD COLUMN "is_emergency" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_emergency_check" CHECK (NOT ("patient_contact"."is_emergency" AND "patient_contact"."relationship" = 'self'));--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "emergency_contact_name";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "emergency_contact_phone";--> statement-breakpoint
ALTER TABLE "patient" DROP COLUMN "emergency_contact_relationship";--> statement-breakpoint
-- 3) Un teléfono que no es WhatsApp (decisión 23, caso 1): WhatsApp rechazó el
--    mensaje porque el número no tiene WhatsApp.
ALTER TABLE "contact_identity" ADD COLUMN "no_whatsapp_at" timestamp with time zone;--> statement-breakpoint
-- 4) Restos que se guardaban dos veces o que nadie usaba.
--    Las notas de la persona son `crm_note`: la conciliación persona ↔ ficha
--    deja ahí lo que no conserva («Teléfono anterior…»), sin autor.
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
    updated_at = now()
  WHERE organization_id = p_org AND id = p_contact;
  IF btrim(kept, E'\n') <> '' THEN
    INSERT INTO crm_note (organization_id, contact_id, body) VALUES (p_org, p_contact, btrim(kept, E'\n'));
  END IF;
END;
$$;--> statement-breakpoint
INSERT INTO "crm_note" ("organization_id", "contact_id", "body", "created_at")
SELECT "organization_id", "id", btrim("notes"), "updated_at" FROM "contact" WHERE "notes" IS NOT NULL AND btrim("notes") <> '';--> statement-breakpoint
ALTER TABLE "contact" DROP COLUMN "notes";--> statement-breakpoint
--    El responsable de una persona es el de su conversación u oportunidad.
ALTER TABLE "contact" DROP COLUMN "assigned_user_id";--> statement-breakpoint
--    El nombre del medio de pago se guardaba dos veces.
UPDATE "patient_payment" SET "method_name" = "method" WHERE "method_name" IS NULL;--> statement-breakpoint
ALTER TABLE "patient_payment" ALTER COLUMN "method_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment" DROP COLUMN "method";--> statement-breakpoint
--    Dos correos de facturación que nada usaba: los avisos de odentIA van al
--    propietario y al administrador de la clínica.
ALTER TABLE "org_profile" DROP COLUMN "billing_email";--> statement-breakpoint
ALTER TABLE "saas_subscription" DROP COLUMN "billing_email";--> statement-breakpoint
--    El diagnóstico es de la atención (`encounter_diagnosis`): la nota ya no lo guarda.
ALTER TABLE "clinical_note" DROP CONSTRAINT IF EXISTS "clinical_note_diagnosis_type_check";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP CONSTRAINT IF EXISTS "clinical_note_diagnosis_pair_check";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP CONSTRAINT IF EXISTS "clinical_note_diagnosis_fk";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP COLUMN "diagnosis_type";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP COLUMN "diagnosis_code";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP COLUMN "diagnosis_system";--> statement-breakpoint
-- 5) Listas: la base dice lo mismo que la constante. Ninguna pantalla ni
--    servicio escribe presupuestos, recetas ni comprobantes como documentos
--    subidos (salen de sus propias tablas).
ALTER TABLE "patient_document" DISABLE TRIGGER "patient_document_guard_update";--> statement-breakpoint
UPDATE "patient_document" SET "category" = 'otro' WHERE "category" IN ('presupuesto','receta','comprobante_pago');--> statement-breakpoint
ALTER TABLE "patient_document" ENABLE TRIGGER "patient_document_guard_update";--> statement-breakpoint
ALTER TABLE "patient_document" DROP CONSTRAINT "patient_document_category_check";--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_category_check" CHECK ("patient_document"."category" IN ('consentimiento','radiografia','foto_clinica','informe','otro'));
