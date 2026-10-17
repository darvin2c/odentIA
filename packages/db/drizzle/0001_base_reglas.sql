-- Base del 2026-10-16, segunda parte: lo que el esquema TypeScript no declara.
-- 0000_base.sql crea las tablas desde packages/db/src/schema/*.ts; este archivo
-- agrega, tabla por tabla, la seguridad y las reglas que viven en la base:
-- RLS y FORCE, políticas, permisos del rol de la aplicación, funciones,
-- disparadores, CHECK, EXCLUDE, índices y claves compuestas sin declarar en TS,
-- las colas de pgmq, el trabajo de pg_cron y las listas de diagnóstico.
--
-- Los comentarios explican el porqué y vienen de las 108 migraciones que esta
-- base reemplaza (0000 a 0107, en git hasta el commit 405b732); «(de la NNNN)»
-- dice de cuál. El estado exacto se comprobó contra una base con las 108
-- aplicadas (ADR 0045).
--
-- Permisos: el init de la imagen (infra/dev/postgres/init/01-role.sh) da al
-- rol dentalagent_app lectura y escritura completas sobre cada tabla nueva.
-- Por eso, donde la aplicación no debe borrar o reescribir, se retira todo y
-- se concede solo lo necesario: un GRANT parcial no restringe nada.

-- ═════════════════════════════════════════════════════════════════════════
-- Funciones (los disparadores y las políticas de abajo las usan)
-- ═════════════════════════════════════════════════════════════════════════

-- La evidencia congelada de una propuesta incluye el estado esperado: sin esta
-- guarda, el rol de la aplicación podría reescribir la precondición aprobada.
--   (de la 0030)
CREATE FUNCTION public.agent_proposal_evidence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.before_summary IS DISTINCT FROM OLD.before_summary
    OR NEW.after_summary IS DISTINCT FROM OLD.after_summary
    OR NEW.expected_state IS DISTINCT FROM OLD.expected_state THEN
    RAISE EXCEPTION 'La evidencia de una propuesta no se modifica después de crearla' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Consentimiento firmado inmutable salvo revocación: solo permite
-- firmado → revocado con motivo, sin alterar snapshot, contenido ni firma.
--   (de la 0026)
-- Consentimiento: firmado solo pasa a revocado (con quien revoca) o recibe su
-- PDF una vez; revocado y anulado son definitivos salvo adjuntar el PDF que
-- faltaba. Ningún cambio toca contenido, firmantes (incluida la persona
-- vinculada que firmó), profesional que informa ni testigo.
--   (de la 0041)
CREATE FUNCTION public.clinical_forms_consent_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  revoke_cols text[] := ARRAY['status','revoked_at','revoke_reason','revoker_name','revoker_contact_id','revoke_signature','updated_at'];
  pdf_cols text[] := ARRAY['pdf_document_id','pdf_sha256','updated_at'];
BEGIN
  IF OLD.status IN ('firmado','revocado','anulado') THEN
    -- Adjuntar el PDF una sola vez.
    IF OLD.pdf_document_id IS NULL AND NEW.pdf_document_id IS NOT NULL AND NEW.pdf_sha256 IS NOT NULL
      AND (to_jsonb(NEW) - pdf_cols) = (to_jsonb(OLD) - pdf_cols)
      AND OLD.status <> 'anulado'
    THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'firmado' AND NEW.status = 'revocado'
      AND NEW.revoked_at IS NOT NULL AND NEW.revoke_reason IS NOT NULL
      AND (to_jsonb(NEW) - revoke_cols) = (to_jsonb(OLD) - revoke_cols)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento % inmutable (%)', OLD.status, OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- consent_template.body ocupa el lugar de clinical_form_template.schema.
--   (de la 0026)
-- Plantilla publicada: las secciones también quedan congeladas.
--   (de la 0041)
CREATE FUNCTION public.clinical_forms_consent_template_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND (to_jsonb(NEW) - ARRAY['status','updated_at']) = (to_jsonb(OLD) - ARRAY['status','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento publicado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Consentimiento archivado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Respuesta finalizada inmutable: las correcciones son adendas (INSERT en
-- clinical_form_addendum), nunca UPDATE.
--   (de la 0026)
-- Finalizado y descartado son definitivos: las correcciones son adendas.
--   (de la 0042)
CREATE FUNCTION public.clinical_forms_response_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('finalizado','descartado') THEN
    RAISE EXCEPTION 'Formulario % inmutable (usar adenda) (%)', OLD.status, OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Inmutabilidad de versiones publicadas: una fila publicada/archivada nunca
-- se edita (las versiones nuevas son INSERT). Solo se permite el retiro
-- publicado → archivado sin tocar el contenido congelado.
--   (de la 0026)
-- La plantilla publicada congela también a quién va dirigida.
--   (de la 0042)
CREATE FUNCTION public.clinical_forms_template_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND (to_jsonb(NEW) - ARRAY['status','updated_at']) = (to_jsonb(OLD) - ARRAY['status','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Plantilla publicada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Plantilla archivada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION public.crm_contact_links_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation c WHERE c.id = NEW.conversation_id
      AND c.organization_id = NEW.organization_id AND c.contact_id = NEW.contact_id
  ) THEN
    RAISE EXCEPTION 'La conversación no pertenece al contacto de la organización' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('crm_note', 'task') THEN
    IF NEW.opportunity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity o WHERE o.id = NEW.opportunity_id
        AND o.organization_id = NEW.organization_id AND o.contact_id = NEW.contact_id
    ) THEN
      RAISE EXCEPTION 'La oportunidad no pertenece al contacto de la organización' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- El nombre visible se deriva del nombre separado cuando este cambia. Si solo
-- cambia el nombre visible (p. ej. una edición antigua), se conserva y la
-- ficha queda por revisar.
--   (de la 0039)
CREATE FUNCTION public.derive_person_display_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- Solo las columnas de TG_ARGV pueden cambiar; el resto es inmutable.
--   (de la 0026)
CREATE FUNCTION public.finance_allow_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  allowed text[] := TG_ARGV;
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finance: % no admite borrado, solo anulación', TG_TABLE_NAME;
  END IF;
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = TG_TABLE_NAME
  LOOP
    IF NOT (col = ANY (allowed)) THEN
      IF (row_to_json(OLD)->>col) IS DISTINCT FROM (row_to_json(NEW)->>col) THEN
        RAISE EXCEPTION 'finance: % es inmutable (%)', TG_TABLE_NAME, col;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Cierre una sola vez y turno cerrado inmutable (además del lock de servicio).
--   (de la 0026)
CREATE FUNCTION public.finance_cash_shift_close() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'cerrada' THEN
    RAISE EXCEPTION 'finance: turno cerrado inmutable';
  END IF;
  IF NEW.status <> 'cerrada' THEN
    RAISE EXCEPTION 'finance: el turno solo pasa a cerrada';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- El runtime no borra; el rol owner conserva el mantenimiento de datos semilla.
--   (de la 0026)
CREATE FUNCTION public.finance_no_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'finance: % no admite borrado, solo anulación', TG_TABLE_NAME;
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Procedimientos y diagnósticos se registran o se anulan solo mientras su
-- atención está en borrador; el estado clínico del diagnóstico (activo o
-- resuelto) sigue la evolución del paciente y puede cambiar después.
--   (de la 0036)
CREATE FUNCTION public.guard_draft_encounter_child() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS NOT DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason) THEN
    IF TG_TABLE_NAME = 'encounter_procedure' THEN
      RAISE EXCEPTION 'Un procedimiento registrado no se modifica: anúlalo en el borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'resolved_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'resolved_at' - 'updated_at') THEN
      RAISE EXCEPTION 'Un diagnóstico registrado no se modifica: anúlalo en el borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'La anulación es definitiva' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  IF NEW.encounter_id IS NULL THEN
    RAISE EXCEPTION 'Los diagnósticos nuevos se registran en una atención' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  SELECT status INTO current_status FROM encounter WHERE id = NEW.encounter_id AND organization_id = NEW.organization_id;
  IF current_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'La atención no está en borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- La atención finalizada es parte de la historia: no se reescribe. Las
-- correcciones posteriores son adendas (notas propias), como exige el servicio.
--   (de la 0035)
-- Finalizada y anulada son historia: no se reescriben. Las correcciones de una
-- atención finalizada son adendas.
--   (de la 0036)
-- 2. La guarda de la atención cerrada deja de nombrar «paso siguiente» y
--    «revisión sugerida» antes de borrarlas: lo que sigue lo dice el plan y la
--    próxima cita, la agenda. El resto de la historia sigue sin reescribirse.
-- La guarda cubre también enfermedad actual, tiempo de enfermedad, funciones
-- vitales y pronóstico: hasta aquí una atención firmada podía reescribirlos.
--   (de la 0094)
CREATE FUNCTION public.guard_finalized_encounter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;--> statement-breakpoint

-- El bloqueo de cita precede al del control en los servicios. La guarda protege
-- también las escrituras directas sin inferir vínculos históricos.
--   (de la 0031)
CREATE FUNCTION public.guard_follow_up_appointment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;--> statement-breakpoint

-- Al confirmar, el único vínculo `self` de una ficha es el de su persona: no
-- se retira, no se degrada y no apunta a otra.
--   (de la 0107)
CREATE FUNCTION public.guard_patient_self_link() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- Una persona creada solo para dar identidad a la ficha —sin canales ni nada que
-- la referencie fuera de esa ficha— es provisional. Se detecta por las claves
-- foráneas hacia contact, así una tabla nueva que la referencie cuenta sola.
--   (de la 0034)
-- 9) La persona provisional (creada solo para la ficha) se reconoce igual: la
--    ficha que la tiene como persona no cuenta como uso.
--   (de la 0107)
CREATE FUNCTION public.is_placeholder_person(p_org text, p_contact uuid, p_patient uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $_$
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
$_$;--> statement-breakpoint

CREATE FUNCTION public.org_profile_sync_organization_name() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE "organization" SET "name" = NEW.trade_name WHERE "id" = NEW.organization_id AND "name" IS DISTINCT FROM NEW.trade_name;
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Al crear el perfil sin nombre comercial vale el nombre que se escribió al
-- crear la cuenta; después, vaciarlo deja la razón social.
--   (de la 0106)
CREATE FUNCTION public.org_profile_trade_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.patient_document_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'El archivo está retirado y no admite cambios'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.retired_at IS NOT NULL AND NEW.retired_by IS NULL THEN
    RAISE EXCEPTION 'El retiro exige registrar quién lo hace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- 8) El vínculo `self` sigue en `patient_contact` (la lista de personas de la
--    ficha lo incluye), pero sale de `person_id`: la base lo crea al insertar
--    la ficha y lo cambia cuando cambia su persona. Nadie lo escribe aparte.
--   (de la 0107)
CREATE FUNCTION public.patient_self_link() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- Tope de sedes reforzado en DB (race + otros caminos; app.ts intacto): cuenta
-- solo sedes ACTIVAS (desactivar libera cupo, no borra). Fail-open sin
-- suscripción (legado exento), en demo o sin tope. Sin grants nuevos: el rol
-- app ya lee suscripción/planes y escribe su propia tabla.
--   (de la 0082)
CREATE FUNCTION public.saas_branch_cap_check() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  sub_row RECORD;
  plan_cap integer;
  used_count integer;
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('saas-branch:' || NEW.organization_id));
  SELECT * INTO sub_row FROM "saas_subscription" WHERE "organization_id" = NEW.organization_id;
  IF NOT FOUND OR sub_row.is_demo THEN
    RETURN NEW;
  END IF;
  IF sub_row.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "max_branches" INTO plan_cap FROM "saas_plan" WHERE "id" = sub_row.plan_id;
  IF plan_cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO used_count FROM "branch"
    WHERE "organization_id" = NEW.organization_id AND "is_active";
  IF used_count >= plan_cap THEN
    RAISE EXCEPTION 'Plan sin cupo para más sedes (%)', NEW.organization_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION public.saas_charge_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.plan_code IS DISTINCT FROM NEW.plan_code
    OR OLD.period_start IS DISTINCT FROM NEW.period_start
    OR OLD.period_end IS DISTINCT FROM NEW.period_end THEN
    RAISE EXCEPTION 'Cargo SaaS inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION public.saas_payment_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.charge_id IS DISTINCT FROM NEW.charge_id
    OR OLD.receipt_object_key IS DISTINCT FROM NEW.receipt_object_key THEN
    RAISE EXCEPTION 'Pago SaaS inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Tope de personas reforzado en DB (el chequeo pre-auth tiene race con dos
-- invitaciones concurrentes): serializa por organización y cuenta la UNIÓN
-- por correo de miembros e invitaciones pendientes, excluyendo el correo que
-- se suma. Aceptar al límite exacto pasa porque el asiento ya lo reserva su
-- invitación; invitar un correo nuevo suma uno. Sin doble conteo en ningún
-- orden. Fail-open sin suscripción (legado exento), en demo o sin tope.
--   (de la 0082)
CREATE FUNCTION public.saas_seat_cap_check() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  sub_row RECORD;
  plan_cap integer;
  used_count integer;
  newcomer text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('saas-seats:' || NEW.organization_id));
  SELECT * INTO sub_row FROM "saas_subscription" WHERE "organization_id" = NEW.organization_id;
  IF NOT FOUND OR sub_row.is_demo THEN
    RETURN NEW;
  END IF;
  IF sub_row.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "max_seats" INTO plan_cap FROM "saas_plan" WHERE "id" = sub_row.plan_id;
  IF plan_cap IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'member' THEN
    SELECT lower("email") INTO newcomer FROM "user" WHERE "id" = NEW.user_id;
  ELSE
    newcomer := lower(trim(NEW.email));
  END IF;
  SELECT count(*) INTO used_count FROM (
    SELECT lower("u"."email") AS "email" FROM "member" AS "m"
      JOIN "user" AS "u" ON "u"."id" = "m"."user_id"
      WHERE "m"."organization_id" = NEW.organization_id
    UNION
    SELECT lower(trim("email")) AS "email" FROM "invitation"
      WHERE "organization_id" = NEW.organization_id AND "status" = 'pending'
  ) AS "seats" WHERE "email" IS DISTINCT FROM newcomer;
  IF used_count >= plan_cap THEN
    RAISE EXCEPTION 'Plan sin cupo para más personas (%)', NEW.organization_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Garantía transaccional del alta: cada organización nace con su prueba de
-- 14 días en la misma transacción (databaseHooks de Better Auth no cubre el
-- modelo organization). El servicio `startSaasTrial` solo rellena plan y
-- datos en esa fila. Las organizaciones previas conservan su acceso sin
-- facturación ni restricción hasta asignación explícita de suscripción.
--   (de la 0082)
-- La prueba del alta dura lo que dice el plan por defecto (ADR 0030: 30 días);
-- sin plan por defecto, 30. Antes eran 14 fijos.
--   (de la 0089)
CREATE FUNCTION public.saas_trial_on_org_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  days integer := coalesce((SELECT "trial_days" FROM "saas_plan" WHERE "is_default" AND "is_active" LIMIT 1), 30);
BEGIN
  INSERT INTO "saas_subscription"
    ("organization_id", "status", "is_demo", "trial_started_at", "trial_ends_at",
     "current_period_start", "current_period_end", "proof_extension_count")
  VALUES
    (NEW.id, 'prueba', false, now(), now() + make_interval(days => days),
     now(), now() + make_interval(days => days), 0)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION public.support_case_org_match() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "support_case" c WHERE c."id" = NEW."case_id"
      AND c."organization_id" IS NOT DISTINCT FROM NEW."organization_id"
  ) THEN
    RAISE EXCEPTION 'support % must match organization of case %', TG_TABLE_NAME, NEW."case_id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Todas las entradas de agenda (personal, portal y agente) quedan cubiertas.
--   (de la 0031)
CREATE FUNCTION public.sync_follow_up_appointment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('cancelada', 'no_asistio', 'atendida') THEN
    UPDATE clinical_follow_up SET status = 'pendiente', updated_at = now()
      WHERE organization_id = NEW.organization_id AND appointment_id = NEW.id AND status = 'programado';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Un borrador no lo ha recibido nadie: mientras el presupuesto está en
-- borrador se le puede quitar un tratamiento. Entregado, sus líneas siguen
-- siendo evidencia y no se borran (ni cambian, salvo la decisión).
--   (de la 0063)
-- La guarda de líneas: la opción es parte de la identidad de la línea.
--   (de la 0093)
CREATE FUNCTION public.treatment_budget_item_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO budget_status FROM treatment_budget WHERE id = OLD.budget_id AND organization_id = OLD.organization_id;
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'Las líneas de un presupuesto entregado no se borran';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan líneas a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.plan_id,NEW.budget_id,NEW.option_id,NEW.plan_item_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.plan_id,OLD.budget_id,OLD.option_id,OLD.plan_item_id) THEN
      RAISE EXCEPTION 'La identidad de la línea de presupuesto es inmutable';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (to_jsonb(NEW)-'decision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'decision'-'updated_at') THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite cambios de decisión';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- La guarda de opciones: se agregan, se quitan, se reordenan y se recomienda
-- solo en borrador; entregado, cada opción solo cambia su decisión.
--   (de la 0093)
CREATE FUNCTION public.treatment_budget_option_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO budget_status FROM treatment_budget WHERE id = OLD.budget_id AND organization_id = OLD.organization_id;
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'Las opciones de un presupuesto entregado no se quitan';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan opciones a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.budget_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.budget_id) THEN
      RAISE EXCEPTION 'La opción no cambia de presupuesto';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (NEW.position, NEW.is_recommended) IS DISTINCT FROM (OLD.position, OLD.is_recommended) THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite elegir una opción';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- account_lifecycle_notice
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.account_lifecycle_notice ADD CONSTRAINT account_lifecycle_notice_status_check CHECK ((status = ANY (ARRAY['claimed'::text, 'sent'::text, 'uncertain'::text])));--> statement-breakpoint
REVOKE ALL ON TABLE public.account_lifecycle_notice FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- account_recovery_case
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.account_recovery_case ADD CONSTRAINT account_recovery_case_kind_check CHECK ((kind = ANY (ARRAY['acceso'::text, 'propiedad'::text])));--> statement-breakpoint
ALTER TABLE public.account_recovery_case ADD CONSTRAINT account_recovery_case_status_check CHECK ((status = ANY (ARRAY['pendiente'::text, 'aprobada'::text, 'rechazada'::text, 'ejecutada'::text])));--> statement-breakpoint
REVOKE ALL ON TABLE public.account_recovery_case FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin_audit
-- ═════════════════════════════════════════════════════════════════════════
-- Tablas globales internas: el rol app no las toca (el servicio admin usa
-- owner tras el guard). two_factor la opera Better Auth con rol app.
--   (de la 0081)
ALTER TABLE public.admin_audit ADD CONSTRAINT admin_audit_actor_role_check CHECK (((actor_role IS NULL) OR (actor_role = ANY (ARRAY['admin'::text, 'support'::text, 'system'::text]))));--> statement-breakpoint
REVOKE ALL ON TABLE public.admin_audit FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin_invitation
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.admin_invitation ADD CONSTRAINT admin_invitation_delivery_check CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'uncertain'::text])));--> statement-breakpoint
ALTER TABLE public.admin_invitation ADD CONSTRAINT admin_invitation_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'support'::text])));--> statement-breakpoint
ALTER TABLE public.admin_invitation ADD CONSTRAINT admin_invitation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])));--> statement-breakpoint
REVOKE ALL ON TABLE public.admin_invitation FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin_session_verification
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.admin_session_verification ADD CONSTRAINT admin_session_verification_method_check CHECK ((method = ANY (ARRAY['totp'::text, 'recovery'::text])));--> statement-breakpoint
REVOKE ALL ON TABLE public.admin_session_verification FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin_staff
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.admin_staff ADD CONSTRAINT admin_staff_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'support'::text])));--> statement-breakpoint
REVOKE ALL ON TABLE public.admin_staff FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_answer_trace
-- ═════════════════════════════════════════════════════════════════════════
-- Traza de solo anexado: el rol app registra y lee, nunca corrige ni borra.
--   (de la 0047)
ALTER TABLE public.agent_answer_trace ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_answer_trace FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_answer_trace USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_answer_trace FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_answer_trace TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_case_memory
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_case_memory ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_case_memory FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_case_memory USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_config
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_config USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_decision_log
-- ═════════════════════════════════════════════════════════════════════════
-- Libro append-only: el rol app registra y lee, nunca corrige ni borra.
--   (de la 0044)
ALTER TABLE public.agent_decision_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_decision_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_decision_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_decision_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_decision_log TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_handoff
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_handoff ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_handoff FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_handoff USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_handoff FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_handoff TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_knowledge_entry
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_knowledge_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_knowledge_entry FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_knowledge_entry USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_knowledge_entry FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_knowledge_entry TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_knowledge_gap
-- ═════════════════════════════════════════════════════════════════════════
-- Se registra y se resuelve; nunca se borra: es la historia de lo que faltaba.
--   (de la 0048)
ALTER TABLE public.agent_knowledge_gap ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_knowledge_gap FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_knowledge_gap USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_knowledge_gap FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_knowledge_gap TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_knowledge_revision
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_knowledge_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_knowledge_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_knowledge_revision USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_knowledge_revision FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_knowledge_revision TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_lesson
-- ═════════════════════════════════════════════════════════════════════════
-- Lo revisado, lo aprendido y sus casos se retiran, nunca se borran: son la historia de lo que cambió al agente.
--   (de la 0050)
ALTER TABLE public.agent_lesson ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_lesson FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_lesson USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_lesson FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_lesson TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_person_fact
-- ═════════════════════════════════════════════════════════════════════════
-- Un dato se reemplaza o se quita; la fila queda como historia de lo que el agente supo y cuándo.
--   (de la 0051)
ALTER TABLE public.agent_person_fact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_person_fact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_person_fact USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_person_fact FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_person_fact TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_proposal
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_proposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_proposal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_proposal USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_proposal FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_proposal TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER agent_proposal_evidence_immutable BEFORE UPDATE ON public.agent_proposal FOR EACH ROW EXECUTE FUNCTION public.agent_proposal_evidence_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_review_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_review_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_review_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_review_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_review_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_review_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_run_ledger
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_run_ledger ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_run_ledger FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_run_ledger USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_run_ledger FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_run_ledger TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_search_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_search_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_search_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_search_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- agent_test_case
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_test_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_test_case FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_test_case USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_test_case FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_test_case TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ai_usage
-- ═════════════════════════════════════════════════════════════════════════
-- Libro append-only: el rol app registra y lee, nunca corrige ni borra.
--   (de la 0087)
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.ai_usage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.ai_usage USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.ai_usage FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.ai_usage TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- appointment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE ONLY public.appointment ADD CONSTRAINT appointment_no_overlap_chair EXCLUDE USING gist (organization_id WITH =, chair_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])));--> statement-breakpoint
ALTER TABLE ONLY public.appointment ADD CONSTRAINT appointment_no_overlap_dentist EXCLUDE USING gist (organization_id WITH =, dentist_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])));--> statement-breakpoint
ALTER TABLE public.appointment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.appointment TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER appointment_follow_up_sync AFTER UPDATE OF status ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.sync_follow_up_appointment();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- appointment_booking_link
-- ═════════════════════════════════════════════════════════════════════════
-- Los enlaces se crean, se usan y se revocan; no se borran: son la constancia de quién reservó y por dónde.
--   (de la 0056)
ALTER TABLE public.appointment_booking_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment_booking_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment_booking_link USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment_booking_link FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.appointment_booking_link TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- appointment_plan_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.appointment_plan_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment_plan_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment_plan_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment_plan_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.appointment_plan_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- audit_event
-- ═════════════════════════════════════════════════════════════════════════
CREATE INDEX audit_event_org_entity_created_idx ON public.audit_event USING btree (organization_id, entity, created_at DESC);--> statement-breakpoint
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.audit_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.audit_event USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- automation_consent
-- ═════════════════════════════════════════════════════════════════════════
-- 4) Tipos de mensaje (ADR 0040): «avisos» es la fila de lo que pasó con su
--    cita y sus papeles; solo se apaga con «No quiero ningún mensaje de la
--    clínica». Los demás tipos siguen siendo los de siempre.
--   (de la 0101)
ALTER TABLE public.automation_consent ADD CONSTRAINT automation_consent_purpose_check CHECK ((purpose = ANY (ARRAY['recordatorio'::text, 'seguimiento'::text, 'novedades'::text, 'avisos'::text])));--> statement-breakpoint
ALTER TABLE public.automation_consent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_consent FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_consent USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.automation_consent FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.automation_consent TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- automation_job
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.automation_job ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_job FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_job USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.automation_job FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.automation_job TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- automation_link_token
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.automation_link_token ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_link_token FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_link_token USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.automation_link_token FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.automation_link_token TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- automation_rule
-- ═════════════════════════════════════════════════════════════════════════
-- Automatizaciones: RLS por organización y permisos del rol de la aplicación.
--   (de la 0026)
ALTER TABLE public.automation_rule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_rule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_rule USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- branch
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX branch_org_id_finance_uidx ON public.branch USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.branch ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.branch FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.branch USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER saas_branch_cap_activate BEFORE UPDATE OF is_active ON public.branch FOR EACH ROW EXECUTE FUNCTION public.saas_branch_cap_check();--> statement-breakpoint
CREATE TRIGGER saas_branch_cap_insert BEFORE INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.saas_branch_cap_check();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- cash_closure
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.cash_closure ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.cash_closure FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.cash_closure USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.cash_closure FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_closure TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER cash_closure_immutable BEFORE UPDATE ON public.cash_closure FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only();--> statement-breakpoint
CREATE TRIGGER cash_closure_no_delete BEFORE DELETE ON public.cash_closure FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- cash_movement
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.cash_movement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.cash_movement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.cash_movement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.cash_movement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_movement TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER cash_movement_immutable BEFORE UPDATE ON public.cash_movement FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER cash_movement_no_delete BEFORE DELETE ON public.cash_movement FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- cash_shift
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX cash_shift_org_id_finance_uidx ON public.cash_shift USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.cash_shift ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.cash_shift FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.cash_shift USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.cash_shift FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_shift TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER cash_shift_close_once BEFORE UPDATE ON public.cash_shift FOR EACH ROW EXECUTE FUNCTION public.finance_cash_shift_close();--> statement-breakpoint
CREATE TRIGGER cash_shift_immutable BEFORE UPDATE ON public.cash_shift FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('status', 'closed_by', 'closed_at', 'expected_cents', 'electronic_cents', 'counted_cents', 'difference_cents', 'close_notes', 'retained_cents', 'delivered_cents');--> statement-breakpoint
CREATE TRIGGER cash_shift_no_delete BEFORE DELETE ON public.cash_shift FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- channel_connection
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Coherencia proveedor/canal del chat propio.
--   (de la 0026)
ALTER TABLE public.channel_connection ADD CONSTRAINT channel_connection_webchat_channel_chk CHECK (((provider <> 'web_chat'::text) OR (channel = 'webchat'::text)));--> statement-breakpoint
ALTER TABLE public.channel_connection ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.channel_connection FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.channel_connection USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- channel_template
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.channel_template ADD CONSTRAINT channel_template_unsupported_check CHECK (((unsupported IS NULL) OR (unsupported = ANY (ARRAY['encabezado'::text, 'datos_por_nombre'::text]))));--> statement-breakpoint
ALTER TABLE public.channel_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.channel_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.channel_template USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinic_message
-- ═════════════════════════════════════════════════════════════════════════
-- Un mensaje se archiva y un texto nuevo es otra versión: la aplicación no
-- borra ninguno ni reescribe un texto ya guardado.
--   (de la 0069)
ALTER TABLE public.clinic_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinic_message FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinic_message USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinic_message FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinic_message TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinic_message_version
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinic_message_version ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinic_message_version FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinic_message_version USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinic_message_version FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinic_message_version TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_access_log
-- ═════════════════════════════════════════════════════════════════════════
-- Traza de solo anexado: la aplicación inserta y solo actualiza el contador y la
-- última hora de la misma franja; nunca borra ni cambia quién, a quién o qué.
-- Los privilegios por defecto del rol incluyen UPDATE y DELETE: se retiran antes
-- de conceder solo las dos columnas de conteo.
--   (de la 0035)
-- Hueco en cada página para que la reescritura de `last_at` y `hits` quepa en
-- la misma página, condición de la actualización HOT. Rige para las páginas
-- que se escriban desde ahora.
--   (de la 0103)
-- Los permisos no cambian: el rol de la aplicación consulta, inserta y solo
-- actualiza `last_at` y `hits`; no borra, no vacía ni reescribe quién, a quién
-- o qué (0035). Se reafirman por si un despliegue los hubiera ampliado.
--   (de la 0103)
ALTER TABLE public.clinical_access_log SET (fillfactor=90);--> statement-breakpoint
ALTER TABLE public.clinical_access_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_access_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_access_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_access_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinical_access_log TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(last_at) ON TABLE public.clinical_access_log TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(hits) ON TABLE public.clinical_access_log TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_follow_up
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_follow_up ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_follow_up FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_follow_up USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_follow_up FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_follow_up TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER clinical_follow_up_appointment_guard BEFORE INSERT OR UPDATE ON public.clinical_follow_up FOR EACH ROW EXECUTE FUNCTION public.guard_follow_up_appointment();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_form_addendum
-- ═════════════════════════════════════════════════════════════════════════
-- Append-only reforzado: la historia y las adendas no se mutan.
--   (de la 0026)
ALTER TABLE public.clinical_form_addendum ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_form_addendum FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_form_addendum USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_form_addendum FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinical_form_addendum TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_form_response
-- ═════════════════════════════════════════════════════════════════════════
-- Grants del rol app: CRUD de configuración y captura; SIN DELETE salvo
-- vínculos de asignación (professional_specialty, service_specialty), que el
-- servicio reescribe por completo al reasignar.
--   (de la 0026)
ALTER TABLE public.clinical_form_response ADD CONSTRAINT clinical_form_response_discard_check CHECK ((((status = 'descartado'::text) = (discarded_at IS NOT NULL)) AND ((status <> 'descartado'::text) OR ((char_length(COALESCE(discard_reason, ''::text)) >= 1) AND (char_length(COALESCE(discard_reason, ''::text)) <= 2000)))));--> statement-breakpoint
ALTER TABLE public.clinical_form_response ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_form_response FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_form_response USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_form_response FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_form_response TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER clinical_form_response_immutable BEFORE UPDATE ON public.clinical_form_response FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_response_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_form_template
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_form_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_form_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_form_template USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_form_template FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_form_template TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER clinical_form_template_immutable BEFORE UPDATE ON public.clinical_form_template FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_template_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_note
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_note FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_note USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_note FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinical_note TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- clinical_order
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_order FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_order USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_order FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_order TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- commission_rule
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_rule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_rule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_rule USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_rule FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.commission_rule TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER commission_rule_immutable BEFORE UPDATE ON public.commission_rule FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('rate_bps', 'updated_at');--> statement-breakpoint
CREATE TRIGGER commission_rule_no_delete BEFORE DELETE ON public.commission_rule FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- commission_settlement
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_settlement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_settlement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_settlement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_settlement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.commission_settlement TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER commission_settlement_immutable BEFORE UPDATE ON public.commission_settlement FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('status', 'voided_at', 'voided_by', 'void_reason', 'updated_at', 'expense_id');--> statement-breakpoint
CREATE TRIGGER commission_settlement_no_delete BEFORE DELETE ON public.commission_settlement FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- commission_settlement_line
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_settlement_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_settlement_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_settlement_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_settlement_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.commission_settlement_line TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_immutable BEFORE UPDATE ON public.commission_settlement_line FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_no_delete BEFORE DELETE ON public.commission_settlement_line FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- consent_document
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_document ADD CONSTRAINT consent_document_cancel_check CHECK ((((status = 'anulado'::text) = (cancelled_at IS NOT NULL)) AND ((status <> 'anulado'::text) OR ((char_length(COALESCE(cancel_reason, ''::text)) >= 1) AND (char_length(COALESCE(cancel_reason, ''::text)) <= 2000)))));--> statement-breakpoint
ALTER TABLE public.consent_document ADD CONSTRAINT consent_document_link_signed_check CHECK (((signature_method IS DISTINCT FROM 'enlace'::text) OR (person_signed_at IS NOT NULL)));--> statement-breakpoint
ALTER TABLE public.consent_document ADD CONSTRAINT consent_document_pdf_sha256_check CHECK (((pdf_sha256 IS NULL) OR (pdf_sha256 ~ '^[0-9a-f]{64}$'::text)));--> statement-breakpoint
ALTER TABLE public.consent_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_document FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_document USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.consent_document FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.consent_document TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER consent_document_immutable BEFORE UPDATE ON public.consent_document FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_consent_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- consent_event
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_event USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.consent_event FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.consent_event TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- consent_template
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_template USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.consent_template FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.consent_template TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER consent_template_immutable BEFORE UPDATE ON public.consent_template FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_consent_template_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- consent_template_service
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_template_service ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_template_service FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_template_service USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- contact
-- ═════════════════════════════════════════════════════════════════════════
DROP INDEX public.contact_org_doc_uidx;--> statement-breakpoint
CREATE UNIQUE INDEX contact_org_doc_uidx ON public.contact USING btree (organization_id, doc_country, doc_type, doc_number) NULLS NOT DISTINCT WHERE (doc_number IS NOT NULL);--> statement-breakpoint
ALTER TABLE public.contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.contact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.contact USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER contact_display_name_derive BEFORE INSERT OR UPDATE ON public.contact FOR EACH ROW EXECUTE FUNCTION public.derive_person_display_name();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- contact_identity
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.contact_identity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.contact_identity FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.contact_identity USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- conversation
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.conversation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.conversation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.conversation USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- crm_note
-- ═════════════════════════════════════════════════════════════════════════
-- Notas operativas inmutables y vínculos nuevos aislados por organización.
--   (de la 0029)
ALTER TABLE public.crm_note ADD CONSTRAINT crm_note_body_check CHECK (((length(TRIM(BOTH FROM body)) >= 1) AND (length(TRIM(BOTH FROM body)) <= 2000)));--> statement-breakpoint
ALTER TABLE public.crm_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.crm_note FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY crm_note_insert ON public.crm_note FOR INSERT TO dentalagent_app WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE POLICY crm_note_select ON public.crm_note FOR SELECT TO dentalagent_app USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.crm_note FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.crm_note TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER crm_note_links_guard BEFORE INSERT ON public.crm_note FOR EACH ROW EXECUTE FUNCTION public.crm_contact_links_guard();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- custom_field_def
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.custom_field_def ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.custom_field_def FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.custom_field_def USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- diagnosis_code
-- ═════════════════════════════════════════════════════════════════════════
-- El buscador ignora tildes y mayúsculas: busca en el texto normalizado.
--   (de la 0102)
CREATE INDEX diagnosis_code_search_idx ON public.diagnosis_code USING gin (search_text public.gin_trgm_ops);--> statement-breakpoint
REVOKE ALL ON TABLE public.diagnosis_code FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.diagnosis_code TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- diagnosis_code_release
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.diagnosis_code_release FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.diagnosis_code_release TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- diagnosis_code_system
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.diagnosis_code_system FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.diagnosis_code_system TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- encounter
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER encounter_finalized_immutable BEFORE UPDATE ON public.encounter FOR EACH ROW EXECUTE FUNCTION public.guard_finalized_encounter();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- encounter_diagnosis
-- ═════════════════════════════════════════════════════════════════════════
-- El diagnóstico es historia clínica: se anula, nunca se borra.
--   (de la 0036)
ALTER TABLE public.encounter_diagnosis ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_diagnosis FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_diagnosis USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_diagnosis FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter_diagnosis TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER encounter_diagnosis_draft_only BEFORE INSERT OR UPDATE ON public.encounter_diagnosis FOR EACH ROW EXECUTE FUNCTION public.guard_draft_encounter_child();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- encounter_dictation_suggestion
-- ═════════════════════════════════════════════════════════════════════════
-- Una sugerencia se confirma o se descarta; no se borra mientras exista la atención.
--   (de la 0054)
ALTER TABLE public.encounter_dictation_suggestion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_dictation_suggestion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_dictation_suggestion USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_dictation_suggestion FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter_dictation_suggestion TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- encounter_plan_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter_plan_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_plan_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_plan_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_plan_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.encounter_plan_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- encounter_procedure
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter_procedure ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_procedure FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_procedure USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_procedure FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter_procedure TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER encounter_procedure_draft_only BEFORE INSERT OR UPDATE ON public.encounter_procedure FOR EACH ROW EXECUTE FUNCTION public.guard_draft_encounter_child();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- encounter_tooth
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter_tooth ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_tooth FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY draft_teeth_delete ON public.encounter_tooth AS RESTRICTIVE FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.encounter
  WHERE ((encounter.id = encounter_tooth.encounter_id) AND (encounter.organization_id = encounter_tooth.organization_id) AND (encounter.status = 'borrador'::text)))));--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_tooth USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- expense
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.expense ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.expense FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.expense TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER expense_immutable BEFORE UPDATE ON public.expense FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason', 'updated_at');--> statement-breakpoint
CREATE TRIGGER expense_no_delete BEFORE DELETE ON public.expense FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- help_ask
-- ═════════════════════════════════════════════════════════════════════════
-- La clínica crea y lee lo suyo; la respuesta la escribe el equipo de odentIA con el rol propietario.
--   (de la 0055)
ALTER TABLE public.help_ask ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.help_ask FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.help_ask USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.help_ask FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.help_ask TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- invitation
-- ═════════════════════════════════════════════════════════════════════════
CREATE TRIGGER saas_seat_cap_invitation BEFORE INSERT ON public.invitation FOR EACH ROW WHEN ((new.status = 'pending'::text)) EXECUTE FUNCTION public.saas_seat_cap_check();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- mailbox_oauth_state
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Checks de frontera (state OAuth de un solo uso y corta duración).
--   (de la 0026)
-- 2. RLS: aislamiento por organización. El callback OAuth lee/consume el
-- nonce con rol owner (sin GUC); el rol app solo inserta su propio inicio.
--   (de la 0026)
-- Rol app: insertar su inicio y leer su fila; el consumo (DELETE) y la
-- limpieza de caducados corren con rol owner. Sin UPDATE jamás.
--   (de la 0026)
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_expiry_check CHECK ((expires_at > created_at));--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_provider_check CHECK ((provider = ANY (ARRAY['gmail'::text, 'microsoft365'::text])));--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_verifier_check CHECK (((char_length(code_verifier) >= 43) AND (char_length(code_verifier) <= 128)));--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.mailbox_oauth_state FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY mailbox_oauth_state_org_isolation ON public.mailbox_oauth_state USING ((organization_id = current_setting('app.org_id'::text, true))) WITH CHECK ((organization_id = current_setting('app.org_id'::text, true)));--> statement-breakpoint
REVOKE ALL ON TABLE public.mailbox_oauth_state FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.mailbox_oauth_state TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- member
-- ═════════════════════════════════════════════════════════════════════════
CREATE TRIGGER saas_seat_cap_member BEFORE INSERT ON public.member FOR EACH ROW EXECUTE FUNCTION public.saas_seat_cap_check();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- message
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.message FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.message USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- odontogram_assessment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.odontogram_assessment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.odontogram_assessment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.odontogram_assessment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.odontogram_assessment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.odontogram_assessment TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- odontogram_entry
-- ═════════════════════════════════════════════════════════════════════════
-- El rol de aplicación conserva el hallazgo original; solo puede registrar su corrección.
--   (de la 0009)
-- El hallazgo original sigue intacto; además de anularse, ahora puede quedar tratado.
--   (de la 0036)
ALTER TABLE public.odontogram_entry ADD CONSTRAINT odontogram_entry_details_object_check CHECK ((jsonb_typeof(details) = 'object'::text));--> statement-breakpoint
ALTER TABLE public.odontogram_entry ADD CONSTRAINT odontogram_entry_status_check CHECK ((status = ANY (ARRAY['recorded'::text, 'voided'::text])));--> statement-breakpoint
ALTER TABLE public.odontogram_entry ADD CONSTRAINT odontogram_entry_surface_check CHECK (((surface IS NULL) OR (surface = ANY (ARRAY['mesial'::text, 'distal'::text, 'buccal'::text, 'facial'::text, 'lingual'::text, 'palatal'::text, 'occlusal'::text, 'incisal'::text]))));--> statement-breakpoint
ALTER TABLE public.odontogram_entry ADD CONSTRAINT odontogram_entry_tooth_fdi_check CHECK ((tooth_number = ANY (ARRAY[11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84, 85])));--> statement-breakpoint
ALTER TABLE public.odontogram_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.odontogram_entry FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.odontogram_entry USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.odontogram_entry FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(status) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(updated_at) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(voided_at) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(voided_by) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(void_reason) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(resolved_at) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(resolved_by) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(resolved_by_plan_item_id) ON TABLE public.odontogram_entry TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- opportunity
-- ═════════════════════════════════════════════════════════════════════════
-- Rol app: oportunidades lectura/escritura parcial; eventos solo anexar/leer.
--   (de la 0026)
ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_amount_check CHECK (((amount_cents IS NULL) OR (amount_cents >= 0)));--> statement-breakpoint
ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_close_check CHECK ((((status = 'open'::text) AND (closed_at IS NULL) AND (close_reason IS NULL)) OR ((status = ANY (ARRAY['won'::text, 'lost'::text])) AND (closed_at IS NOT NULL) AND (close_reason IS NOT NULL))));--> statement-breakpoint
ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_status_check CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])));--> statement-breakpoint
ALTER TABLE public.opportunity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.opportunity FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opportunity_org_isolation ON public.opportunity USING ((organization_id = current_setting('app.org_id'::text, true))) WITH CHECK ((organization_id = current_setting('app.org_id'::text, true)));--> statement-breakpoint
REVOKE ALL ON TABLE public.opportunity FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.opportunity TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER opportunity_conversation_guard BEFORE INSERT OR UPDATE OF organization_id, contact_id, conversation_id ON public.opportunity FOR EACH ROW EXECUTE FUNCTION public.crm_contact_links_guard();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- opportunity_event
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.opportunity_event ADD CONSTRAINT opportunity_event_action_check CHECK ((action = ANY (ARRAY['opportunity.created'::text, 'opportunity.updated'::text, 'opportunity.moved'::text, 'opportunity.won'::text, 'opportunity.lost'::text, 'opportunity.reopened'::text])));--> statement-breakpoint
ALTER TABLE public.opportunity_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.opportunity_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opportunity_event_org_isolation ON public.opportunity_event USING ((organization_id = current_setting('app.org_id'::text, true))) WITH CHECK ((organization_id = current_setting('app.org_id'::text, true)));--> statement-breakpoint
REVOKE ALL ON TABLE public.opportunity_event FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.opportunity_event TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- org_counter
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.org_counter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.org_counter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.org_counter USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.org_counter FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.org_counter TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- org_profile
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.org_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.org_profile FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.org_profile USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER org_profile_sync_organization_name AFTER INSERT OR UPDATE OF trade_name ON public.org_profile FOR EACH ROW EXECUTE FUNCTION public.org_profile_sync_organization_name();--> statement-breakpoint
CREATE TRIGGER org_profile_trade_name BEFORE INSERT OR UPDATE OF trade_name, legal_name ON public.org_profile FOR EACH ROW EXECUTE FUNCTION public.org_profile_trade_name();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- org_specialty
-- ═════════════════════════════════════════════════════════════════════════
-- Especialidades, formularios, consentimientos y órdenes: inmutabilidad en la
-- base con disparadores condicionados, como el resto de lo clínico (el servicio
-- ya lo garantiza y la base lo blinda).
--
-- RLS por tenant en las 10 tablas (todas llevan organization_id).
--   (de la 0026)
ALTER TABLE public.org_specialty ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.org_specialty FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.org_specialty USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.org_specialty FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.org_specialty TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- organization
-- ═════════════════════════════════════════════════════════════════════════
CREATE TRIGGER saas_trial_on_org_create AFTER INSERT ON public.organization FOR EACH ROW EXECUTE FUNCTION public.saas_trial_on_org_create();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- organization_payment_method
-- ═════════════════════════════════════════════════════════════════════════
-- Aislamiento y privilegios de las nuevas tablas económicas.
--   (de la 0059)
ALTER TABLE public.organization_payment_method ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.organization_payment_method FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.organization_payment_method USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.organization_payment_method FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.organization_payment_method TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER organization_payment_method_no_delete BEFORE DELETE ON public.organization_payment_method FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER patient_self_link AFTER INSERT OR UPDATE OF person_id ON public.patient FOR EACH ROW EXECUTE FUNCTION public.patient_self_link();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_allergy
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_allergy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_allergy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_allergy USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_allergy FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_allergy TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_anamnesis
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_anamnesis ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_anamnesis FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_anamnesis USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_anamnesis FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_anamnesis TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_charge
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_charge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_charge FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_charge USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_charge FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_charge TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_condition
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_condition ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_condition FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_condition USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_condition FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_condition TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_contact
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_contact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_contact USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE CONSTRAINT TRIGGER patient_self_link_guard AFTER INSERT OR DELETE OR UPDATE OF relationship, contact_id ON public.patient_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_patient_self_link();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_data_consent
-- ═════════════════════════════════════════════════════════════════════════
-- Aislamiento por organización de las tablas nuevas; el ubigeo es un catálogo
-- global de solo lectura para la aplicación, como CIE-10.
--   (de la 0039)
-- El consentimiento se otorga y se revoca; nunca se borra.
--   (de la 0039)
ALTER TABLE public.patient_data_consent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_data_consent FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_data_consent USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_data_consent FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_data_consent TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_document
-- ═════════════════════════════════════════════════════════════════════════
-- El archivo y su clasificación siguen inmutables para la aplicación: el
-- UPDATE de tabla sigue revocado (0005) y solo se conceden las columnas del
-- informe y del retiro. El trigger impide deshacer o modificar un retiro.
--   (de la 0040)
-- Un documento del paciente se referencia con su organización (firma en papel,
-- resultado de una orden).
--   (de la 0092)
CREATE INDEX patient_document_active_idx ON public.patient_document USING btree (organization_id, patient_id, created_at) WHERE (retired_at IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX patient_document_org_id_uidx ON public.patient_document USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.patient_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_document FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_document USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_document FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(report_status) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_at) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_by) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retire_reason) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER patient_document_guard_update BEFORE UPDATE ON public.patient_document FOR EACH ROW EXECUTE FUNCTION public.patient_document_guard_update();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_document_context
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_document_context ADD CONSTRAINT patient_document_context_version_check CHECK ((version >= 1));--> statement-breakpoint
ALTER TABLE public.patient_document_context ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_document_context FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_document_context USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_document_context FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_document_context TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_family_history
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_family_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_family_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_family_history USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_medication
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_medication ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_medication FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_medication USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_medication FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_medication TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_payment
-- ═════════════════════════════════════════════════════════════════════════
-- El medio y el importe de un pago quedan congelados en la base: solo admite anularse.
--   (de la 0061)
ALTER TABLE public.patient_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_payment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_payment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_payment TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER patient_payment_immutable BEFORE UPDATE ON public.patient_payment FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason', 'updated_at');--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_payment_application
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_payment_application ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_application FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_payment_application USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_payment_application FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_payment_application TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_payment_refund
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_payment_refund ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_refund FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_payment_refund USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_payment_refund FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_payment_refund TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_registration
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_registration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_registration FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_registration USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_registration FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_registration TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_registration_config
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_registration_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_registration_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_registration_config USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_registration_link
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_registration_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_registration_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_registration_link USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- patient_responsibility
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_responsibility ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_responsibility FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_responsibility USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_responsibility FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_responsibility TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- payment_ticket
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX payment_ticket_org_id_finance_uidx ON public.payment_ticket USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.payment_ticket ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.payment_ticket FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.payment_ticket USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.payment_ticket FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.payment_ticket TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER payment_ticket_immutable BEFORE UPDATE ON public.payment_ticket FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER payment_ticket_no_delete BEFORE DELETE ON public.payment_ticket FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- pipeline
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.pipeline ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.pipeline FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.pipeline USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- pipeline_stage
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.pipeline_stage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.pipeline_stage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.pipeline_stage USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_access_log
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_access_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_access_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_access_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_access_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.portal_access_log TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_challenge
-- ═════════════════════════════════════════════════════════════════════════
-- 4. Grants mínimos para dentalagent_app: lectura/escritura operativa sin
-- borrado en caliente; verificación y challenges son append-only con UPDATE
-- solo para liquidar (task de solicitud, challenge usado).
--   (de la 0028)
ALTER TABLE public.portal_challenge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_challenge FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_challenge USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_challenge FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_challenge TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_grant
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_grant ADD CONSTRAINT portal_grant_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'appointments'::text) AND (scope ? 'budgets'::text) AND (scope ? 'account'::text) AND (scope ? 'documents'::text)));--> statement-breakpoint
ALTER TABLE public.portal_grant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_grant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_grant USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_grant FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_grant TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_link
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Forma del alcance: drizzle no valida jsonb; el servicio sí, esto lo blinda en DB.
--   (de la 0026)
-- 2. Coherencia de estados: usado implica used_at; pendiente implica sin uso;
-- revocado conserva evidencia (puede tener used_at si se revocó tras canje).
--   (de la 0026)
-- 3. RLS por tenant (FORCE como el resto del dominio).
--   (de la 0026)
-- 4. Grants: la bitácora es append-only (sin UPDATE ni DELETE); enlaces y
-- sesiones se revocan por UPDATE, nunca se borran en caliente.
--   (de la 0026)
ALTER TABLE public.portal_link ADD CONSTRAINT portal_link_revoked_check CHECK (((status <> 'revocado'::text) = (revoked_at IS NULL)));--> statement-breakpoint
ALTER TABLE public.portal_link ADD CONSTRAINT portal_link_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'appointments'::text) AND (scope ? 'budgets'::text) AND (scope ? 'account'::text) AND (scope ? 'documents'::text) AND (jsonb_typeof((scope -> 'documents'::text)) = 'array'::text)));--> statement-breakpoint
ALTER TABLE public.portal_link ADD CONSTRAINT portal_link_used_check CHECK ((((status = 'usado'::text) AND (used_at IS NOT NULL)) OR ((status = 'pendiente'::text) AND (used_at IS NULL)) OR (status = 'revocado'::text)));--> statement-breakpoint
ALTER TABLE public.portal_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_link USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_link FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_link TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_passkey
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_passkey ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_passkey FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_passkey USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_passkey FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_passkey TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_policy
-- ═════════════════════════════════════════════════════════════════════════
-- 3. RLS por tenant (FORCE como el resto del dominio).
--   (de la 0028)
ALTER TABLE public.portal_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_policy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_policy USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_policy FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_policy TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_session
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_session ADD CONSTRAINT portal_session_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'appointments'::text) AND (scope ? 'budgets'::text) AND (scope ? 'account'::text) AND (scope ? 'documents'::text) AND (jsonb_typeof((scope -> 'documents'::text)) = 'array'::text)));--> statement-breakpoint
ALTER TABLE public.portal_session ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_session FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_session USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_session FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_session TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- portal_verification
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_verification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_verification FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_verification USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_verification FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.portal_verification TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- prescription
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.prescription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.prescription FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.prescription USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.prescription FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.prescription TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- prescription_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.prescription_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.prescription_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.prescription_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.prescription_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.prescription_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- procedure_catalog_release
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.procedure_catalog_release FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.procedure_catalog_release TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- procedure_code
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.procedure_code FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.procedure_code TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- procedure_code_system
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.procedure_code_system FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.procedure_code_system TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- product
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.product ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.product FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.product USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- product_lot
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.product_lot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.product_lot FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.product_lot USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- professional_profile
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.professional_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_profile FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_profile USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- professional_schedule
-- ═════════════════════════════════════════════════════════════════════════
-- Agenda y disponibilidad: RLS por organización y permisos del rol de la
-- aplicación.
--   (de la 0026)
ALTER TABLE public.professional_schedule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_schedule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_schedule USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- professional_specialty
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.professional_specialty ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_specialty FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_specialty USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- promotion
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX promotion_org_id_finance_uidx ON public.promotion USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.promotion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.promotion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.promotion USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.promotion FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.promotion TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER promotion_no_delete BEFORE DELETE ON public.promotion FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- promotion_service_price
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.promotion_service_price ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.promotion_service_price FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.promotion_service_price USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.promotion_service_price FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.promotion_service_price TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER promotion_service_price_no_delete BEFORE DELETE ON public.promotion_service_price FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- purchase_order
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.purchase_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.purchase_order USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- purchase_order_line
-- ═════════════════════════════════════════════════════════════════════════
-- 3. Sin recepciones por encima de lo pedido.
--   (de la 0026)
ALTER TABLE public.purchase_order_line ADD CONSTRAINT purchase_order_line_received_cap_check CHECK ((received_quantity <= quantity));--> statement-breakpoint
ALTER TABLE public.purchase_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.purchase_order_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_action
-- ═════════════════════════════════════════════════════════════════════════
-- Libro: la aplicación registra y lee; el cobro anota el cargo con owner.
--   (de la 0088)
ALTER TABLE public.saas_action ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_action FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_action USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_action FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_charge
-- ═════════════════════════════════════════════════════════════════════════
-- Rol app: CRUD de tenant salvo borrado; globales de sólo lectura segura.
--   (de la 0082)
ALTER TABLE public.saas_charge ADD CONSTRAINT saas_charge_tax_check CHECK (((tax_cents >= 0) AND ((subtotal_cents IS NULL) OR ((subtotal_cents + tax_cents) = amount_cents))));--> statement-breakpoint
ALTER TABLE public.saas_charge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_charge FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_charge USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_charge FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_charge TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER saas_charge_immutable BEFORE UPDATE ON public.saas_charge FOR EACH ROW EXECUTE FUNCTION public.saas_charge_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_charge_line
-- ═════════════════════════════════════════════════════════════════════════
-- Histórico inmutable como el cargo: la clínica lo lee; lo emite el ciclo con owner.
--   (de la 0090)
ALTER TABLE public.saas_charge_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_charge_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_charge_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_charge_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_charge_line TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_commission_adjustment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.saas_commission_adjustment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_commission_adjustment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_commission_adjustment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_commission_adjustment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_commission_adjustment TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_commission_settlement
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.saas_commission_settlement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_commission_settlement TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_commission_settlement_line
-- ═════════════════════════════════════════════════════════════════════════
-- Históricos inmutables: cargos, pagos y comisiones no se reescriben ni borran por app.
--   (de la 0082)
REVOKE ALL ON TABLE public.saas_commission_settlement_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_commission_settlement_line TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_negotiation
-- ═════════════════════════════════════════════════════════════════════════
-- La decide la administración de odentIA (owner); la clínica no la ve ni la escribe.
--   (de la 0089)
ALTER TABLE public.saas_negotiation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_negotiation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_negotiation USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_negotiation FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_notice
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.saas_notice ADD CONSTRAINT saas_notice_email_state_check CHECK ((email_state = ANY (ARRAY['pendiente'::text, 'reclamado'::text, 'enviado'::text, 'incierto'::text])));--> statement-breakpoint
ALTER TABLE public.saas_notice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_notice FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_notice USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_notice FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_notice TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_payment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.saas_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_payment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_payment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_payment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_payment TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER saas_payment_immutable BEFORE UPDATE ON public.saas_payment FOR EACH ROW EXECUTE FUNCTION public.saas_payment_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_payment_method
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.saas_payment_method FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_payment_method TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_plan
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.saas_plan FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_plan TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_seller
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.saas_seller FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_seller TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_seller_commission
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.saas_seller_commission ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_seller_commission FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_seller_commission USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_seller_commission FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.saas_seller_commission TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_subscription
-- ═════════════════════════════════════════════════════════════════════════
-- RLS por tenant: las tablas con organization_id solo ven la org del GUC.
--   (de la 0082)
ALTER TABLE public.saas_subscription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_subscription FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_subscription USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_subscription FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_subscription TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- saas_whatsapp_rate
-- ═════════════════════════════════════════════════════════════════════════
-- Global: la clínica la lee para su estimación; solo la administración la escribe.
--   (de la 0089)
REVOKE ALL ON TABLE public.saas_whatsapp_rate FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_whatsapp_rate TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- schedule_block
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.schedule_block ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.schedule_block FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.schedule_block USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- schedule_chair
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.schedule_chair ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.schedule_chair FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.schedule_chair USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.schedule_chair FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.schedule_chair TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- service_catalog
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.service_catalog ADD CONSTRAINT service_catalog_source_check CHECK ((source = ANY (ARRAY['template'::text, 'custom'::text, 'legacy'::text])));--> statement-breakpoint
CREATE UNIQUE INDEX service_catalog_org_id_finance_uidx ON public.service_catalog USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.service_catalog ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.service_catalog FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.service_catalog USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.service_catalog FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.service_catalog TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- stock_movement
-- ═════════════════════════════════════════════════════════════════════════
-- 2. El consumo clínico siempre queda vinculado a un paciente.
--   (de la 0026)
-- Reglas de dominio que el servicio ya valida (defensa en profundidad):
-- 1. El traslado exige almacén destino distinto del origen.
--   (de la 0026)
-- Ledger inmutable: el rol app inserta y lee, NUNCA edita ni borra.
-- Las correcciones son movimientos inversos de ajuste con su motivo.
--   (de la 0026)
ALTER TABLE public.stock_movement ADD CONSTRAINT stock_movement_consume_patient_check CHECK (((kind <> 'consumo'::text) OR (patient_id IS NOT NULL)));--> statement-breakpoint
ALTER TABLE public.stock_movement ADD CONSTRAINT stock_movement_transfer_dest_check CHECK ((((kind <> 'traslado'::text) AND (dest_warehouse_id IS NULL)) OR ((kind = 'traslado'::text) AND (dest_warehouse_id IS NOT NULL) AND (dest_warehouse_id <> warehouse_id))));--> statement-breakpoint
ALTER TABLE public.stock_movement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.stock_movement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.stock_movement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.stock_movement TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- supplier
-- ═════════════════════════════════════════════════════════════════════════
-- Inventario: aislamiento por organización, movimientos inmutables y saldos no
-- negativos.
--   (de la 0026)
ALTER TABLE public.supplier ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.supplier FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.supplier USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- support_access_audit
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_access_audit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_access_audit USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_access_audit FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_access_audit TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER support_access_audit_org_match BEFORE INSERT OR UPDATE ON public.support_access_audit FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- support_access_grant
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_access_grant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_access_grant USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_access_grant FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.support_access_grant TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER support_access_grant_org_match BEFORE INSERT OR UPDATE ON public.support_access_grant FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- support_attachment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_attachment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_attachment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_attachment TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER support_attachment_org_match BEFORE INSERT OR UPDATE ON public.support_attachment FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- support_case
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_case USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_case FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.support_case TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- support_message
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_message USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_message FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_message TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER support_message_org_match BEFORE INSERT OR UPDATE ON public.support_message FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- support_notice
-- ═════════════════════════════════════════════════════════════════════════
-- La FK compuesta no mira filas con organización nula: el trigger iguala la del caso.
--   (de la 0100)
-- La aplicación crea y lee avisos de su clínica; reclamarlos y cerrarlos es del worker (owner).
--   (de la 0100)
ALTER TABLE public.support_notice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_notice USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_notice FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_notice TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER support_notice_org_match BEFORE INSERT OR UPDATE ON public.support_notice FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- task
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.task ADD CONSTRAINT task_kind_check CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['ficha_repetida'::text, 'volver_al_portal'::text]))));--> statement-breakpoint
ALTER TABLE public.task ADD CONSTRAINT task_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])));--> statement-breakpoint
ALTER TABLE public.task ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.task FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.task USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER task_links_guard BEFORE INSERT OR UPDATE OF organization_id, contact_id, conversation_id, opportunity_id ON public.task FOR EACH ROW EXECUTE FUNCTION public.crm_contact_links_guard();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ticket_counter
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.ticket_counter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.ticket_counter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.ticket_counter USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.ticket_counter FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.ticket_counter TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER ticket_counter_immutable BEFORE UPDATE ON public.ticket_counter FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('next_number');--> statement-breakpoint
CREATE TRIGGER ticket_counter_no_delete BEFORE DELETE ON public.ticket_counter FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_budget
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_budget ADD CONSTRAINT treatment_budget_number_check CHECK ((budget_number > 0));--> statement-breakpoint
ALTER TABLE public.treatment_budget ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_budget FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_budget USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_budget FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.treatment_budget TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_budget_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_budget_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_budget_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_budget_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER treatment_budget_item_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.treatment_budget_item FOR EACH ROW EXECUTE FUNCTION public.treatment_budget_item_guard();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_budget_option
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_budget_option ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_budget_option FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_budget_option USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER treatment_budget_option_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.treatment_budget_option FOR EACH ROW EXECUTE FUNCTION public.treatment_budget_option_guard();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_plan
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_plan ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_plan FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_plan USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_plan FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.treatment_plan TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_plan_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_plan_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_plan_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_plan_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE POLICY plan_item_delete_guard ON public.treatment_plan_item AS RESTRICTIVE FOR DELETE USING (((status = 'pendiente'::text) AND (NOT (EXISTS ( SELECT 1
   FROM public.treatment_budget_item
  WHERE (treatment_budget_item.plan_item_id = treatment_plan_item.id)))) AND (NOT (EXISTS ( SELECT 1
   FROM public.encounter_procedure
  WHERE (encounter_procedure.plan_item_id = treatment_plan_item.id)))) AND (NOT (EXISTS ( SELECT 1
   FROM public.encounter_plan_item
  WHERE (encounter_plan_item.plan_item_id = treatment_plan_item.id)))) AND ((budget_id IS NULL) OR (NOT (EXISTS ( SELECT 1
   FROM public.treatment_budget
  WHERE ((treatment_budget.id = treatment_plan_item.budget_id) AND (treatment_budget.status <> 'borrador'::text))))))));--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_plan_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.treatment_plan_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_template
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.treatment_template FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.treatment_template TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- treatment_template_code
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.treatment_template_code FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.treatment_template_code TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- user_global_block
-- ═════════════════════════════════════════════════════════════════════════
-- Solo owner: la aplicación no toca estas tablas (ni siquiera lectura).
--   (de la 0084)
ALTER TABLE public.user_global_block ADD CONSTRAINT user_global_block_reason_check CHECK (((length(TRIM(BOTH FROM reason)) >= 10) AND (length(TRIM(BOTH FROM reason)) <= 500)));--> statement-breakpoint
REVOKE ALL ON TABLE public.user_global_block FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- warehouse
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.warehouse ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.warehouse FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.warehouse USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- webchat_rate_limit
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.webchat_rate_limit FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- workspace_notification
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.workspace_notification ADD CONSTRAINT workspace_notification_href_check CHECK ((href ~ '^/[^/]'::text));--> statement-breakpoint
ALTER TABLE public.workspace_notification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.workspace_notification FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.workspace_notification USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.workspace_notification FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.workspace_notification TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Vínculos compuestos que el esquema TS no declara (ciclos entre archivos o
-- formas que Drizzle no expresa). Van al final: apuntan a índices únicos de
-- otras tablas creados arriba.
-- ═════════════════════════════════════════════════════════════════════════

-- agent_proposal
-- Propuestas del agente y tareas referidas a un paciente: FK compuesta por
-- organización (sin FK en el esquema TS para evitar el ciclo crm ↔ clinical).
--   (de la 0034)
ALTER TABLE ONLY public.agent_proposal ADD CONSTRAINT agent_proposal_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id);--> statement-breakpoint

-- cash_closure
ALTER TABLE ONLY public.cash_closure ADD CONSTRAINT cash_closure_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.cash_closure ADD CONSTRAINT cash_closure_shift_id_org_fk FOREIGN KEY (organization_id, shift_id) REFERENCES public.cash_shift(organization_id, id);--> statement-breakpoint

-- cash_movement
-- Finanzas: los disparadores blindan, fila por fila, que las actualizaciones
-- sean solo las acotadas (cierre, anulación, recálculo) y que nada se borre ni
-- se reabra.
--
-- FK diferida: cash_movement.expense_id → expense.id (expense se declara
-- después de cash_movement en el esquema y se evita el ciclo en código).
--   (de la 0026)
ALTER TABLE ONLY public.cash_movement ADD CONSTRAINT cash_movement_expense_fk FOREIGN KEY (expense_id) REFERENCES public.expense(id);--> statement-breakpoint

-- clinical_form_response
ALTER TABLE ONLY public.clinical_form_response ADD CONSTRAINT clinical_form_response_respondent_contact_fk FOREIGN KEY (organization_id, respondent_contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint

-- clinical_order
ALTER TABLE ONLY public.clinical_order ADD CONSTRAINT clinical_order_result_document_fk FOREIGN KEY (organization_id, result_document_id) REFERENCES public.patient_document(organization_id, id);--> statement-breakpoint

-- consent_document
ALTER TABLE ONLY public.consent_document ADD CONSTRAINT consent_document_paper_document_fk FOREIGN KEY (organization_id, paper_document_id) REFERENCES public.patient_document(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document ADD CONSTRAINT consent_document_pdf_document_fk FOREIGN KEY (pdf_document_id) REFERENCES public.patient_document(id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document ADD CONSTRAINT consent_document_revoker_contact_fk FOREIGN KEY (organization_id, revoker_contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document ADD CONSTRAINT consent_document_signer_contact_fk FOREIGN KEY (organization_id, signer_contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint

-- consent_template_service
ALTER TABLE ONLY public.consent_template_service ADD CONSTRAINT consent_template_service_service_fk FOREIGN KEY (organization_id, service_id) REFERENCES public.service_catalog(organization_id, id) ON DELETE CASCADE;--> statement-breakpoint

-- crm_note
ALTER TABLE ONLY public.crm_note ADD CONSTRAINT crm_note_contact_org_fk FOREIGN KEY (organization_id, contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.crm_note ADD CONSTRAINT crm_note_conversation_org_fk FOREIGN KEY (organization_id, conversation_id) REFERENCES public.conversation(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.crm_note ADD CONSTRAINT crm_note_opportunity_org_fk FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunity(organization_id, id);--> statement-breakpoint

-- odontogram_entry
ALTER TABLE ONLY public.odontogram_entry ADD CONSTRAINT odontogram_entry_left_by_plan_item_fk FOREIGN KEY (organization_id, patient_id, left_by_plan_item_id) REFERENCES public.treatment_plan_item(organization_id, patient_id, id);--> statement-breakpoint

-- opportunity
ALTER TABLE ONLY public.opportunity ADD CONSTRAINT opportunity_conversation_org_fk FOREIGN KEY (organization_id, conversation_id) REFERENCES public.conversation(organization_id, id);--> statement-breakpoint

-- patient_charge
ALTER TABLE ONLY public.patient_charge ADD CONSTRAINT patient_charge_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint

-- patient_payment
ALTER TABLE ONLY public.patient_payment ADD CONSTRAINT patient_payment_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment ADD CONSTRAINT patient_payment_payment_method_id_org_fk FOREIGN KEY (organization_id, payment_method_id) REFERENCES public.organization_payment_method(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment ADD CONSTRAINT patient_payment_ticket_id_org_fk FOREIGN KEY (organization_id, ticket_id) REFERENCES public.payment_ticket(organization_id, id);--> statement-breakpoint

-- patient_payment_application
ALTER TABLE ONLY public.patient_payment_application ADD CONSTRAINT patient_payment_application_ticket_id_org_fk FOREIGN KEY (organization_id, ticket_id) REFERENCES public.payment_ticket(organization_id, id);--> statement-breakpoint

-- payment_ticket
ALTER TABLE ONLY public.payment_ticket ADD CONSTRAINT payment_ticket_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.payment_ticket ADD CONSTRAINT payment_ticket_patient_id_org_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id);--> statement-breakpoint

-- promotion_service_price
ALTER TABLE ONLY public.promotion_service_price ADD CONSTRAINT promotion_service_price_promotion_id_org_fk FOREIGN KEY (organization_id, promotion_id) REFERENCES public.promotion(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.promotion_service_price ADD CONSTRAINT promotion_service_price_service_id_org_fk FOREIGN KEY (organization_id, service_id) REFERENCES public.service_catalog(organization_id, id);--> statement-breakpoint

-- task
ALTER TABLE ONLY public.task ADD CONSTRAINT task_opportunity_org_fk FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunity(organization_id, id) ON DELETE SET NULL (opportunity_id);--> statement-breakpoint
ALTER TABLE ONLY public.task ADD CONSTRAINT task_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id);--> statement-breakpoint

-- treatment_budget_item
ALTER TABLE ONLY public.treatment_budget_item ADD CONSTRAINT treatment_budget_item_promotion_id_org_fk FOREIGN KEY (organization_id, promotion_id) REFERENCES public.promotion(organization_id, id);--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Colas de pgmq y despertador de pg_cron
-- ═════════════════════════════════════════════════════════════════════════
-- Las extensiones pgmq y pg_cron las crea el init de la imagen
-- (02-extensions.sql) con los mismos permisos; se repiten aquí para que la
-- base no dependa de ese orden. Las colas q_* que se crean después heredan
-- los permisos por defecto del esquema pgmq.
--   (de la 0001)
GRANT USAGE ON SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE dentalagent IN SCHEMA pgmq GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalagent_app;--> statement-breakpoint
-- Colas del worker: mensajes que llegan y salen, turnos del agente y el
-- despertador de automatizaciones. `demo_tasks` la sigue usando el worker
-- (apps/worker/src/index.ts). pgmq.create no es idempotente: se tolera que la
-- cola ya exista.
--   (de la 0000, 0002 y 0026)
DO $$ BEGIN PERFORM pgmq.create('demo_tasks'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('inbound_messages'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('outbound_messages'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('agent_runs'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('automation_ticks'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- Despertador durable del tick: un único job por minuto que encola un aviso
-- sin datos personales en 'automation_ticks'. El worker drena (junta los
-- avisos) y ejecuta un solo tick con la hora de la base. No se programa cada
-- envío en cron: los trabajos viven en automation_job.
--   (de la 0026)
DO $$ BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'automation-tick';
  PERFORM cron.schedule('automation-tick', '* * * * *', $job$SELECT pgmq.send('automation_ticks', '{}'::jsonb)$job$);
END $$;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Datos de catálogo
-- ═════════════════════════════════════════════════════════════════════════
-- Las dos listas de la OMS y, preparadas sin cargar, las nacionales. Sus
-- códigos los carga `seed:diagnoses` con el archivo oficial (ADR 0041).
--   (de la 0102)
INSERT INTO "diagnosis_code_system" ("key", "title", "publisher", "country", "uri") VALUES
	('ICD-10', 'CIE-10 (OMS)', 'Organización Mundial de la Salud', NULL, 'http://hl7.org/fhir/sid/icd-10'),
	('ICD-11', 'CIE-11 (OMS)', 'Organización Mundial de la Salud', NULL, 'http://id.who.int/icd/release/11/mms'),
	('ICD-10-PE', 'CIE-10 MINSA', 'Ministerio de Salud del Perú', 'PE', 'urn:odentia:diagnosis:icd-10-pe'),
	('ICD-10-ES', 'CIE-10-ES', 'Ministerio de Sanidad de España', 'ES', 'urn:odentia:diagnosis:icd-10-es');
