-- Base del 2026-10-24, segunda parte: lo que el esquema TypeScript no declara.
-- 0000_base.sql crea las tablas desde packages/db/src/schema/*.ts; este archivo
-- agrega, tabla por tabla, la seguridad y las reglas que viven en la base:
-- RLS y FORCE, políticas, permisos del rol de la aplicación, funciones,
-- disparadores, CHECK, EXCLUDE, índices y claves compuestas sin declarar en TS,
-- las vistas de Argos, las colas de pgmq, el trabajo de pg_cron y los datos
-- iniciales.
--
-- Cada definición sale tal cual de una base con las 106 migraciones que esta
-- reemplaza (0000 a 0105, en git hasta el commit 5aa7b2cc), y se comprobó que
-- las dos bases son iguales (ADR 0088). Los comentarios explican el porqué y
-- vienen de la migración que creó cada objeto: «(de la NNNN del 24-oct)» es de
-- esas 106; «(de la NNNN del 16-oct)», de las 108 anteriores (ADR 0045, en git
-- hasta el commit 405b732).
--
-- Permisos: el init de la imagen (infra/dev/postgres/init/01-role.sh) da al
-- rol dentalagent_app lectura y escritura completas sobre cada tabla creada
-- antes de este archivo. Por eso, donde la aplicación no debe borrar o
-- reescribir, se retira todo y se concede solo lo necesario: un GRANT parcial
-- no restringe nada.
-- ═════════════════════════════════════════════════════════════════════════
-- Lo que vale para toda la base
-- ═════════════════════════════════════════════════════════════════════════--> statement-breakpoint

-- Una tabla nueva nace cerrada para el rol de las clínicas: cada migración que
-- crea una tabla le concede con GRANT lo que la aplicación necesita. Antes
-- nacía con lectura y escritura completas, y una tabla solo de odentIA que
-- olvidara su REVOKE quedaba abierta a cualquier clínica sin que nada fallara.
-- Sin FOR ROLE vale para quien migra, el mismo owner que el init de la imagen.
--   (de la 0033 del 24-oct, ADR 0063)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM dentalagent_app;--> statement-breakpoint

-- Los nombres no se repiten entre esquemas: el SQL a mano los sigue nombrando
-- sin esquema, con lo dental en el suyo (ADR 0064 y 0079). Vale para cada
-- conexión nueva; set_config cubre esta misma.
--   (de la 0034 y la 0078 del 24-oct)
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, catalog, auth, admin, dental', current_database());
END
$$;--> statement-breakpoint
SELECT set_config('search_path', 'public, catalog, auth, admin, dental', false);--> statement-breakpoint

-- Argos consulta las vistas del negocio con la llave de quien pregunta (ADR 0075):
-- el dueño de las vistas y una llave por rol de la aplicación.
--   (de la 0064 del 24-oct)
DO $$
DECLARE key text;
BEGIN
  FOREACH key IN ARRAY ARRAY['argos_dueno', 'argos_gestion', 'argos_recepcion', 'argos_clinico', 'argos_caja'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = key) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', key);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- La aplicación se pone la llave con SET LOCAL ROLE, sin heredar lo que ve.
GRANT argos_gestion, argos_recepcion, argos_clinico, argos_caja TO dentalagent_app WITH INHERIT FALSE, SET TRUE;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Funciones (los disparadores y las políticas de abajo las usan)
-- ═════════════════════════════════════════════════════════════════════════
-- 2. Cada versión es historia: lo que ya se contó o se cobró se calculó con
-- ella. Nada se reescribe ni se borra; un cambio es una fila nueva.
--   (de la 0051 del 24-oct)
CREATE FUNCTION admin.saas_commercial_terms_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Las condiciones comerciales no se reescriben: un cambio es una versión nueva'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_commercial_terms_append_only';
END;
$$;--> statement-breakpoint

-- La evidencia congelada de una propuesta incluye el estado esperado: sin esta
-- guarda, el rol de la aplicación podría reescribir la precondición aprobada.
--   (de la 0030 del 16-oct)
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

-- Una sede nueva nace con su almacén principal, venga de donde venga (la API,
-- el alta de la clínica o una semilla).
--   (de la 0038 del 24-oct)
CREATE FUNCTION public.branch_default_warehouse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "warehouse" (organization_id, branch_id, name, is_default)
    VALUES (NEW.organization_id, NEW.id, 'Almacén principal', true);
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Dos iguales en una clínica llevan -2, -3…: el primero libre, aunque otra
-- sede ya se llame así («Sede Norte» dos veces y «Norte 2»).
--   (de la 0061 del 24-oct)
CREATE FUNCTION public.branch_slug_free(org text, stem text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  candidate text := stem;
  n integer := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.branch WHERE organization_id = org AND slug = candidate) LOOP
    n := n + 1;
    candidate := stem || '-' || n;
  END LOOP;
  RETURN candidate;
END;
$$;--> statement-breakpoint

-- unaccent() no es IMMUTABLE porque depende del diccionario del search_path:
-- con el diccionario nombrado y el camino completo sí lo es, y puede indexarse.
--   (de la 0035 del 24-oct)
CREATE FUNCTION public.search_fold(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, value)) $$;--> statement-breakpoint

-- El enlace corto de cada sede para llegar (issue 36) nace de su nombre, sin
-- «Sede» delante y sin tildes: «Sede Miraflores» → «miraflores». Lo pone la
-- base al crearla (también las semillas y las pruebas que insertan directo) y
-- no cambia al renombrarla: los enlaces ya enviados siguen sirviendo.
--   (de la 0061 del 24-oct)
CREATE FUNCTION public.branch_slug_stem(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT coalesce(
  nullif(trim(both '-' from regexp_replace(public.search_fold(regexp_replace(coalesce(value, ''), '^\s*sede\s+', '', 'i')), '[^a-z0-9]+', '-', 'g')), ''),
  'sede'
) $$;--> statement-breakpoint
CREATE FUNCTION public.branch_slug_fill() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    RETURN NEW;
  END IF;
  -- Dos altas a la vez en la misma clínica no eligen el mismo hueco.
  PERFORM pg_advisory_xact_lock(hashtext('branch_slug:' || NEW.organization_id));
  NEW.slug := public.branch_slug_free(NEW.organization_id, public.branch_slug_stem(NEW.name));
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Consentimiento firmado inmutable salvo revocación: solo permite
-- firmado → revocado con motivo, sin alterar snapshot, contenido ni firma.
--   (de la 0026 del 16-oct)
-- Consentimiento: firmado solo pasa a revocado (con quien revoca) o recibe su
-- PDF una vez; revocado y anulado son definitivos salvo adjuntar el PDF que
-- faltaba. Ningún cambio toca contenido, firmantes (incluida la persona
-- vinculada que firmó), profesional que informa ni testigo.
--   (de la 0041 del 16-oct)
-- Consentimiento (#47): la revocación guarda su propio PDF una sola vez; el
-- firmado no se toca. Lo demás sigue como en la 0001: firmado solo pasa a
-- revocado (con quien revoca) o recibe su PDF una vez; revocado y anulado son
-- definitivos salvo adjuntar el PDF que faltaba.
--   (de la 0071 del 24-oct)
CREATE FUNCTION public.clinical_forms_consent_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  revoke_cols text[] := ARRAY['status','revoked_at','revoke_reason','revoker_name','revoker_contact_id','revoke_signature','updated_at'];
  pdf_cols text[] := ARRAY['pdf_document_id','pdf_sha256','updated_at'];
  revoke_pdf_cols text[] := ARRAY['revoke_pdf_document_id','revoke_pdf_sha256','updated_at'];
BEGIN
  IF OLD.status IN ('firmado','revocado','anulado') THEN
    -- Adjuntar el PDF una sola vez.
    IF OLD.pdf_document_id IS NULL AND NEW.pdf_document_id IS NOT NULL AND NEW.pdf_sha256 IS NOT NULL
      AND (to_jsonb(NEW) - pdf_cols) = (to_jsonb(OLD) - pdf_cols)
      AND OLD.status <> 'anulado'
    THEN
      RETURN NEW;
    END IF;
    -- Adjuntar el PDF de la revocación una sola vez.
    IF OLD.status = 'revocado' AND OLD.revoke_pdf_document_id IS NULL
      AND NEW.revoke_pdf_document_id IS NOT NULL AND NEW.revoke_pdf_sha256 IS NOT NULL
      AND (to_jsonb(NEW) - revoke_pdf_cols) = (to_jsonb(OLD) - revoke_pdf_cols)
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
--   (de la 0026 del 16-oct)
-- Plantilla publicada: las secciones también quedan congeladas.
--   (de la 0041 del 16-oct)
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
--   (de la 0026 del 16-oct)
-- Finalizado y descartado son definitivos: las correcciones son adendas.
--   (de la 0042 del 16-oct)
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
--   (de la 0026 del 16-oct)
-- La plantilla publicada congela también a quién va dirigida.
--   (de la 0042 del 16-oct)
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

-- Respuesta del Libro de Reclamaciones desde la administración de odentIA: las
-- reglas que el esquema TypeScript no declara. Las columnas las crea 0005.
--
-- Lo enviado es lo que dice el libro: una hoja respondida no cambia su
-- respuesta, su fecha ni vuelve a «recibido». El resto de columnas sí (marcar
-- el correo enviado, `updated_at`, quién respondió si su cuenta se borra).
--   (de la 0006 del 24-oct)
CREATE FUNCTION public.consumer_complaint_response_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."status" = 'respondido' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."provider_response" IS DISTINCT FROM OLD."provider_response"
    OR NEW."responded_at" IS DISTINCT FROM OLD."responded_at"
  ) THEN
    RAISE EXCEPTION 'La respuesta de una hoja de reclamación no se puede cambiar' USING ERRCODE = 'check_violation';
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

-- «Borrar esta prueba» y el borrado a los 7 días (fase 6 del pulido): una
-- conversación de prueba del chat web se borra con todo lo que dejó. Solo una
-- prueba (`is_test`) de la clínica en contexto (`app.org_id`): el rol de la app
-- no borra temas, corridas ni tareas por su cuenta. Lo aprendido en una
-- corrección queda, sin la conversación. Lo que una prueba no debería dejar
-- (una cita, un registro) tampoco se borra: se suelta de la conversación. La
-- persona de prueba se borra solo si no es nadie más: sin otras
-- conversaciones, sin ficha y sin más identidad que la de la prueba; si quedó
-- unida a algo real (un pago, un consentimiento), se queda.
--   (de la 0057 del 24-oct)
CREATE FUNCTION public.delete_webchat_test(p_conversation uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_org text := NULLIF(current_setting('app.org_id', true), '');
  v_contact uuid;
  v_tasks uuid[];
BEGIN
  SELECT "contact_id" INTO v_contact FROM "conversation"
    WHERE "id" = p_conversation AND "organization_id" = v_org AND "is_test";
  IF v_contact IS NULL THEN
    RETURN false;
  END IF;
  UPDATE "appointment" SET "conversation_id" = NULL WHERE "conversation_id" = p_conversation;
  UPDATE "patient_registration" SET "conversation_id" = NULL WHERE "conversation_id" = p_conversation;
  UPDATE "portal_link" SET "delivery_conversation_id" = NULL, "delivery_message_id" = NULL
    WHERE "delivery_conversation_id" = p_conversation;
  v_tasks := ARRAY(SELECT "task_id" FROM "agent_handoff" WHERE "conversation_id" = p_conversation AND "task_id" IS NOT NULL);
  DELETE FROM "agent_handoff" WHERE "conversation_id" = p_conversation;
  DELETE FROM "task" WHERE "id" = ANY(v_tasks) OR "conversation_id" = p_conversation;
  DELETE FROM "agent_proposal" WHERE "conversation_id" = p_conversation;
  -- Primero lo que apunta a las trazas: los casos por revisar y su lección.
  UPDATE "agent_lesson" SET "review_item_id" = NULL WHERE "review_item_id" IN (
    SELECT "id" FROM "agent_review_item" WHERE "conversation_id" = p_conversation
      OR "trace_id" IN (SELECT "id" FROM "agent_answer_trace" WHERE "conversation_id" = p_conversation));
  DELETE FROM "agent_review_item" WHERE "conversation_id" = p_conversation
    OR "trace_id" IN (SELECT "id" FROM "agent_answer_trace" WHERE "conversation_id" = p_conversation);
  DELETE FROM "agent_answer_trace" WHERE "conversation_id" = p_conversation;
  DELETE FROM "agent_knowledge_gap" WHERE "conversation_id" = p_conversation;
  DELETE FROM "agent_person_fact" WHERE "conversation_id" = p_conversation;
  DELETE FROM "agent_run_ledger" WHERE "conversation_id" = p_conversation;
  UPDATE "agent_lesson" SET "conversation_id" = NULL WHERE "conversation_id" = p_conversation;
  DELETE FROM "appointment_booking_link" WHERE "conversation_id" = p_conversation;
  UPDATE "patient_registration" SET "link_id" = NULL WHERE "link_id" IN (
    SELECT "id" FROM "patient_registration_link" WHERE "conversation_id" = p_conversation);
  DELETE FROM "patient_registration_link" WHERE "conversation_id" = p_conversation;
  UPDATE "crm_note" SET "conversation_id" = NULL WHERE "conversation_id" = p_conversation;
  UPDATE "opportunity" SET "conversation_id" = NULL WHERE "conversation_id" = p_conversation;
  DELETE FROM "conversation" WHERE "id" = p_conversation;
  IF NOT EXISTS (SELECT 1 FROM "conversation" WHERE "contact_id" = v_contact)
     AND NOT EXISTS (SELECT 1 FROM "patient" WHERE "person_id" = v_contact)
     AND NOT EXISTS (SELECT 1 FROM "patient_contact" WHERE "contact_id" = v_contact)
     AND NOT EXISTS (SELECT 1 FROM "contact_identity" WHERE "contact_id" = v_contact
       AND "external_user_id" NOT LIKE 'webchat:prueba:%') THEN
    DELETE FROM "task" WHERE "contact_id" = v_contact;
    DELETE FROM "agent_person_fact" WHERE "contact_id" = v_contact;
    DELETE FROM "agent_proposal" WHERE "contact_id" = v_contact;
    DELETE FROM "appointment_booking_link" WHERE "contact_id" = v_contact;
    UPDATE "patient_registration" SET "link_id" = NULL WHERE "link_id" IN (
      SELECT "id" FROM "patient_registration_link" WHERE "contact_id" = v_contact);
    DELETE FROM "patient_registration_link" WHERE "contact_id" = v_contact;
    BEGIN
      DELETE FROM "contact" WHERE "id" = v_contact;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END IF;
  RETURN true;
END;
$$;--> statement-breakpoint

-- El nombre visible se deriva del nombre separado cuando este cambia. Si solo
-- cambia el nombre visible (p. ej. una edición antigua), se conserva y la
-- ficha queda por revisar.
--   (de la 0039 del 16-oct)
CREATE FUNCTION public.derive_person_display_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE composed text;
BEGIN
  composed := NULLIF(btrim(regexp_replace(concat_ws(' ', NEW.given_names, NEW.family_name), '\s+', ' ', 'g')), '');
  IF TG_OP = 'INSERT' THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF (NEW.given_names, NEW.family_name) IS DISTINCT FROM (OLD.given_names, OLD.family_name) THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name AND composed IS NOT NULL THEN
    -- Solo cambió el nombre visible (una edición antigua): se conserva y queda por revisar.
    NEW.identity_needs_review := true;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Borrar lo no clínico de una persona a su pedido y bloquear su historia. La
-- aplicación no tiene DELETE en las tablas del agente, del CRM ni del portal,
-- así que el borrado es esta función, como `delete_webchat_test` (0057), en el
-- orden que piden las claves foráneas. Lo clínico, los cobros y los
-- comprobantes no se tocan: la ley pide guardarlos. Devuelve las claves de los
-- adjuntos de sus mensajes para borrarlos del almacenamiento después de
-- confirmar.
--   (de la 0082 del 24-oct)
CREATE FUNCTION public.erase_person_data(p_patient uuid, p_actor text) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_org text := NULLIF(current_setting('app.org_id', true), '');
  v_contact uuid;
  v_convs uuid[];
  v_opps uuid[];
  v_tasks uuid[];
  v_keys text[];
BEGIN
  SELECT "person_id" INTO v_contact FROM "patient" WHERE "id" = p_patient AND "organization_id" = v_org;
  IF v_contact IS NULL THEN
    RAISE EXCEPTION 'Paciente inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  v_convs := ARRAY(SELECT "id" FROM "conversation" WHERE "contact_id" = v_contact AND "organization_id" = v_org);
  v_opps := ARRAY(SELECT "id" FROM "opportunity" WHERE "contact_id" = v_contact AND "organization_id" = v_org);
  v_keys := ARRAY(
    SELECT a ->> 'objectKey' FROM "message" m, jsonb_array_elements(coalesce(m."attachments", '[]'::jsonb)) a
    WHERE m."conversation_id" = ANY(v_convs) AND jsonb_typeof(a) = 'object' AND a ? 'objectKey');
  -- Sus conversaciones y lo que el agente dejó en ellas.
  UPDATE "appointment" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  UPDATE "patient_registration" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  UPDATE "portal_link" SET "delivery_conversation_id" = NULL, "delivery_message_id" = NULL
    WHERE "delivery_conversation_id" = ANY(v_convs);
  v_tasks := ARRAY(SELECT "task_id" FROM "agent_handoff"
    WHERE ("conversation_id" = ANY(v_convs) OR "contact_id" = v_contact) AND "task_id" IS NOT NULL);
  DELETE FROM "agent_handoff" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact;
  DELETE FROM "agent_proposal" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact;
  UPDATE "agent_lesson" SET "review_item_id" = NULL WHERE "review_item_id" IN (
    SELECT "id" FROM "agent_review_item" WHERE "conversation_id" = ANY(v_convs)
      OR "trace_id" IN (SELECT "id" FROM "agent_answer_trace" WHERE "conversation_id" = ANY(v_convs)));
  DELETE FROM "agent_review_item" WHERE "conversation_id" = ANY(v_convs)
    OR "trace_id" IN (SELECT "id" FROM "agent_answer_trace" WHERE "conversation_id" = ANY(v_convs));
  DELETE FROM "agent_answer_trace" WHERE "conversation_id" = ANY(v_convs);
  DELETE FROM "agent_knowledge_gap" WHERE "conversation_id" = ANY(v_convs);
  DELETE FROM "agent_person_fact" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact;
  DELETE FROM "agent_run_ledger" WHERE "conversation_id" = ANY(v_convs);
  UPDATE "agent_lesson" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  -- Sus enlaces, tareas, notas y oportunidades.
  DELETE FROM "appointment_booking_link" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact;
  UPDATE "patient_registration" SET "link_id" = NULL WHERE "link_id" IN (
    SELECT "id" FROM "patient_registration_link" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact);
  DELETE FROM "patient_registration_link" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact;
  DELETE FROM "task" WHERE "id" = ANY(v_tasks) OR "contact_id" = v_contact OR "conversation_id" = ANY(v_convs);
  DELETE FROM "crm_note" WHERE "contact_id" = v_contact;
  UPDATE "crm_note" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  UPDATE "crm_note" SET "opportunity_id" = NULL WHERE "opportunity_id" = ANY(v_opps);
  DELETE FROM "opportunity" WHERE "id" = ANY(v_opps);
  UPDATE "opportunity" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  DELETE FROM "conversation" WHERE "id" = ANY(v_convs);
  DELETE FROM "contact_identity" WHERE "contact_id" = v_contact;
  -- Mensajes automáticos y su portal: sin conversación ni canal ya no sirven.
  DELETE FROM "automation_job" WHERE "organization_id" = v_org AND ("contact_id" = v_contact OR "patient_id" = p_patient);
  DELETE FROM "automation_link_token" WHERE "organization_id" = v_org AND "contact_id" = v_contact;
  DELETE FROM "portal_session" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  DELETE FROM "portal_verification" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  DELETE FROM "portal_link" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  DELETE FROM "portal_grant" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  -- Correo, redes, etiquetas y campos propios. Nombre, documento y teléfono
  -- quedan, solo dentro de la historia bloqueada.
  UPDATE "contact" SET
    "email" = NULL, "preferred_channel" = NULL, "tags" = '{}', "custom_fields" = '{}'::jsonb,
    "last_interaction_at" = NULL, "screen" = NULL, "screened_at" = NULL, "screened_by_user_id" = NULL,
    "screen_reason" = NULL, "screen_note" = NULL, "not_spam_at" = NULL, "not_spam_by_user_id" = NULL,
    "is_active" = false, "record_locked_at" = now(), "record_locked_by" = p_actor, "updated_at" = now()
  WHERE "id" = v_contact AND "organization_id" = v_org;
  RETURN coalesce(v_keys, '{}');
END;
$$;--> statement-breakpoint

-- Solo las columnas de TG_ARGV pueden cambiar; el resto es inmutable.
--   (de la 0026 del 16-oct)
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
--   (de la 0026 del 16-oct)
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
--   (de la 0026 del 16-oct)
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
--   (de la 0036 del 16-oct)
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
--   (de la 0035 del 16-oct)
-- Finalizada y anulada son historia: no se reescriben. Las correcciones de una
-- atención finalizada son adendas.
--   (de la 0036 del 16-oct)
-- 2. La guarda de la atención cerrada deja de nombrar «paso siguiente» y
--    «revisión sugerida» antes de borrarlas: lo que sigue lo dice el plan y la
--    próxima cita, la agenda. El resto de la historia sigue sin reescribirse.
-- La guarda cubre también enfermedad actual, tiempo de enfermedad, funciones
-- vitales y pronóstico: hasta aquí una atención firmada podía reescribirlos.
--   (de la 0094 del 16-oct)
-- Reglas de la 0072 (ADR 0079): lo que drizzle no declara y nombraba al
-- dentista o a la unidad dental.

-- 1. La guarda de la atención cerrada nombra la columna dentro de su código, y
--    PostgreSQL no lo reescribe al renombrarla. Misma regla, columna nueva.
--   (de la 0073 del 24-oct)
CREATE FUNCTION public.guard_finalized_encounter() RETURNS trigger
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

-- El bloqueo de cita precede al del control en los servicios. La guarda protege
-- también las escrituras directas sin inferir vínculos históricos.
--   (de la 0031 del 16-oct)
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
--   (de la 0107 del 16-oct)
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

-- Periodontograma (issue 49, ADR 0054): cada clínica ve solo lo suyo; se
-- escribe solo mientras su atención está en borrador y, al firmarla, queda fijo
-- como el resto de la atención. La aplicación no borra: limpiar una pieza es
-- guardarla sin medidas.
--   (de la 0018 del 24-oct)
CREATE FUNCTION public.guard_periodontal_draft() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  encounter_status text;
BEGIN
  IF TG_TABLE_NAME = 'periodontal_chart' THEN
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.patient_id, NEW.encounter_id, NEW.expected_teeth, NEW.implant_teeth, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.patient_id, OLD.encounter_id, OLD.expected_teeth, OLD.implant_teeth, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Las piezas de un periodontograma se fijan al empezarlo' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
    END IF;
    SELECT e.status INTO encounter_status FROM encounter e
      WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id;
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.chart_id, NEW.tooth_number, NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.chart_id, OLD.tooth_number, OLD.created_at) THEN
      RAISE EXCEPTION 'Una pieza del periodontograma no cambia de periodontograma ni de número' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
    END IF;
    SELECT e.status INTO encounter_status FROM periodontal_chart c
      JOIN encounter e ON e.organization_id = c.organization_id AND e.id = c.encounter_id
      WHERE c.id = NEW.chart_id AND c.organization_id = NEW.organization_id;
  END IF;
  IF encounter_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'El periodontograma de una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.imaging_measurement_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'La medida ya se quitó'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.imaging_study_file_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.uploaded_at IS NOT NULL AND NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'El archivo ya se recibió'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.imaging_study_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'La tomografía ya terminó de subirse'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Una persona creada solo para dar identidad a la ficha —sin canales ni nada que
-- la referencie fuera de esa ficha— es provisional. Se detecta por las claves
-- foráneas hacia contact, así una tabla nueva que la referencie cuenta sola.
--   (de la 0034 del 16-oct)
-- 9) La persona provisional (creada solo para la ficha) se reconoce igual: la
--    ficha que la tiene como persona no cuenta como uso.
--   (de la 0107 del 16-oct)
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
    SET search_path TO 'public', 'catalog', 'auth', 'admin', 'dental'
    AS $$
BEGIN
  UPDATE "organization" SET "name" = NEW.trade_name WHERE "id" = NEW.organization_id AND "name" IS DISTINCT FROM NEW.trade_name;
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Al crear el perfil sin nombre comercial vale el nombre que se escribió al
-- crear la cuenta; después, vaciarlo deja la razón social.
--   (de la 0106 del 16-oct)
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
--   (de la 0107 del 16-oct)
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
CREATE FUNCTION public.purchase_order_line_draft_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "purchase_order" o
    WHERE o.organization_id = OLD.organization_id AND o.id = OLD.order_id AND o.status = 'borrador'
  ) THEN
    RAISE EXCEPTION 'Solo se quitan productos de una compra en borrador' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

-- 2. Hasta cuatro respuestas fijadas por clínica (decisión 8), también con dos
-- personas fijando a la vez: el candado de la clínica ordena las inserciones.
--   (de la 0046 del 24-oct)
CREATE FUNCTION public.report_pin_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('report_pin:' || NEW.organization_id));
  IF (SELECT count(*) FROM public.report_pin WHERE organization_id = NEW.organization_id) >= 4 THEN
    RAISE EXCEPTION 'Ya hay cuatro respuestas fijadas en el Resumen' USING ERRCODE = 'check_violation', CONSTRAINT = 'report_pin_limit';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE FUNCTION public.saas_action_charged_is_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.charge_id IS NOT NULL AND (
    NEW.tier IS DISTINCT FROM OLD.tier
    OR NEW.base_price_micros IS DISTINCT FROM OLD.base_price_micros
    OR NEW.price_micros IS DISTINCT FROM OLD.price_micros
    OR NEW.discount_bps IS DISTINCT FROM OLD.discount_bps
    OR NEW.units IS DISTINCT FROM OLD.units
    OR NEW.kind IS DISTINCT FROM OLD.kind
  ) THEN
    RAISE EXCEPTION 'Una acción ya cobrada no cambia de tipo ni de precio' USING ERRCODE = 'check_violation';
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

-- Garantía transaccional del alta: cada organización nace con su prueba de
-- 14 días en la misma transacción (databaseHooks de Better Auth no cubre el
-- modelo organization). El servicio `startSaasTrial` solo rellena plan y
-- datos en esa fila. Las organizaciones previas conservan su acceso sin
-- facturación ni restricción hasta asignación explícita de suscripción.
--   (de la 0082 del 16-oct)
-- La prueba del alta dura lo que dice el plan por defecto (ADR 0030: 30 días);
-- sin plan por defecto, 30. Antes eran 14 fijos.
--   (de la 0089 del 16-oct)
-- 4. Sin plan por defecto, la prueba del alta dura lo que dicen las condiciones
-- vigentes (antes, 30 fijos).
--   (de la 0051 del 24-oct)
CREATE FUNCTION public.saas_trial_on_org_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'catalog', 'auth', 'admin', 'dental'
    AS $$
DECLARE
  days integer := coalesce(
    (SELECT "trial_days" FROM "saas_plan" WHERE "is_default" AND "is_active" LIMIT 1),
    (SELECT "trial_days" FROM "saas_commercial_terms" WHERE "effective_from" <= now() ORDER BY "effective_from" DESC LIMIT 1),
    30);
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
CREATE FUNCTION public.search_digits(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT regexp_replace(value, '[^0-9]', '', 'g') $$;--> statement-breakpoint
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
--   (de la 0031 del 16-oct)
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
--   (de la 0063 del 16-oct)
-- La guarda de líneas: la opción es parte de la identidad de la línea.
--   (de la 0093 del 16-oct)
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
--   (de la 0093 del 16-oct)
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
GRANT USAGE ON SCHEMA admin TO dentalagent_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO dentalagent_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO argos_dueno;--> statement-breakpoint
GRANT USAGE ON SCHEMA catalog TO dentalagent_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA catalog TO argos_dueno;--> statement-breakpoint
GRANT USAGE ON SCHEMA dental TO dentalagent_app;--> statement-breakpoint
REVOKE USAGE ON SCHEMA public FROM dentalagent_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO dentalagent_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO argos_dueno;--> statement-breakpoint
REVOKE ALL ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT ALL ON FUNCTION pg_catalog.set_config(text, text, boolean) TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.delete_webchat_test(p_conversation uuid) FROM PUBLIC;--> statement-breakpoint
GRANT ALL ON FUNCTION public.delete_webchat_test(p_conversation uuid) TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.erase_person_data(p_patient uuid, p_actor text) FROM PUBLIC;--> statement-breakpoint
GRANT ALL ON FUNCTION public.erase_person_data(p_patient uuid, p_actor text) TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.account_lifecycle_notice
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.account_lifecycle_notice ADD CONSTRAINT account_lifecycle_notice_status_check CHECK ((status = ANY (ARRAY['claimed'::text, 'sent'::text, 'uncertain'::text])));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.account_recovery_case
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.account_recovery_case ADD CONSTRAINT account_recovery_case_kind_check CHECK ((kind = ANY (ARRAY['acceso'::text, 'propiedad'::text])));--> statement-breakpoint
ALTER TABLE admin.account_recovery_case ADD CONSTRAINT account_recovery_case_status_check CHECK ((status = ANY (ARRAY['pendiente'::text, 'aprobada'::text, 'rechazada'::text, 'ejecutada'::text])));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.admin_audit
-- ═════════════════════════════════════════════════════════════════════════
-- Tablas globales internas: el rol app no las toca (el servicio admin usa
-- owner tras el guard). two_factor la opera Better Auth con rol app.
--   (de la 0081 del 16-oct)
ALTER TABLE admin.admin_audit ADD CONSTRAINT admin_audit_actor_role_check CHECK (((actor_role IS NULL) OR (actor_role = ANY (ARRAY['admin'::text, 'support'::text, 'system'::text]))));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.admin_invitation
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.admin_invitation ADD CONSTRAINT admin_invitation_delivery_check CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'uncertain'::text])));--> statement-breakpoint
ALTER TABLE admin.admin_invitation ADD CONSTRAINT admin_invitation_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'support'::text])));--> statement-breakpoint
ALTER TABLE admin.admin_invitation ADD CONSTRAINT admin_invitation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.admin_session_verification
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.admin_session_verification ADD CONSTRAINT admin_session_verification_method_check CHECK ((method = ANY (ARRAY['totp'::text, 'recovery'::text])));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.admin_staff
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.admin_staff ADD CONSTRAINT admin_staff_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'support'::text])));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.consumer_complaint
-- ═════════════════════════════════════════════════════════════════════════
-- Importe entero en céntimos de la moneda, como el resto de importes del sistema.
--   (de la 0004 del 24-oct)
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_amount CHECK (((amount_minor IS NULL) OR (amount_minor >= 0)));--> statement-breakpoint

-- El monto y su moneda van juntos o no van.
--   (de la 0004 del 24-oct)
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_amount_currency CHECK (((amount_minor IS NULL) = (amount_currency IS NULL)));--> statement-breakpoint
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_currency CHECK (((amount_currency IS NULL) OR (amount_currency = ANY (ARRAY['PEN'::text, 'USD'::text]))));--> statement-breakpoint
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_item_type CHECK ((item_type = ANY (ARRAY['producto'::text, 'servicio'::text])));--> statement-breakpoint
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_kind CHECK ((kind = ANY (ARRAY['reclamo'::text, 'queja'::text])));--> statement-breakpoint

-- Un menor de edad reclama con el nombre de su padre, madre o apoderado.
--   (de la 0004 del 24-oct)
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_minor_guardian CHECK (((NOT is_minor) OR (COALESCE(btrim(guardian_name), ''::text) <> ''::text)));--> statement-breakpoint
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_number_year CHECK ((number ~~ ((year)::text || '-%'::text)));--> statement-breakpoint

-- Respondida exige la respuesta y su fecha.
--   (de la 0004 del 24-oct)
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_response CHECK (((status <> 'respondido'::text) OR ((provider_response IS NOT NULL) AND (responded_at IS NOT NULL))));--> statement-breakpoint
ALTER TABLE admin.consumer_complaint ADD CONSTRAINT consumer_complaint_status CHECK ((status = ANY (ARRAY['recibido'::text, 'respondido'::text])));--> statement-breakpoint
CREATE TRIGGER consumer_complaint_response_immutable BEFORE UPDATE ON admin.consumer_complaint FOR EACH ROW EXECUTE FUNCTION public.consumer_complaint_response_immutable();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.consumer_complaint_counter
-- ═════════════════════════════════════════════════════════════════════════
-- Libro de Reclamaciones virtual de odentIA (Perú: Ley 29571 y D.S. 011-2011-PCM
-- con sus modificatorias): las reglas que el esquema TypeScript no declara. Las
-- tablas las crea 0003 desde packages/db/src/schema/consumer-complaints.ts.
--
-- Es de la plataforma, no de una clínica: quien reclama es un visitante o cliente
-- de odentIA, así que no lleva organization_id ni RLS. Solo el rol owner la toca
-- (la API pública escribe con ownerDb); el rol de la aplicación no la lee.
--
-- El número correlativo es por año («2026-000001») y sale de
-- `consumer_complaint_counter` con un upsert atómico en la misma transacción que
-- inserta la hoja: si la inserción falla, el contador vuelve atrás y no quedan
-- huecos. `submission_id` hace idempotente el envío.
--   (de la 0004 del 24-oct)
ALTER TABLE admin.consumer_complaint_counter ADD CONSTRAINT consumer_complaint_counter_value CHECK ((value >= 0));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.saas_commercial_terms
-- ═════════════════════════════════════════════════════════════════════════
CREATE TRIGGER saas_commercial_terms_append_only BEFORE DELETE OR UPDATE ON admin.saas_commercial_terms FOR EACH ROW EXECUTE FUNCTION admin.saas_commercial_terms_append_only();--> statement-breakpoint

-- Condiciones comerciales (issue 167, ADR 0074): reglas.

-- 1. La aplicación solo las lee: cuenta conversaciones y citas recuperadas con
-- la regla de su día dentro del contexto de la clínica. Escribe la
-- administración con owner.
--   (de la 0051 del 24-oct)
GRANT SELECT ON TABLE admin.saas_commercial_terms TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.saas_commission_adjustment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.saas_commission_adjustment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY admin.saas_commission_adjustment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON admin.saas_commission_adjustment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.saas_negotiation
-- ═════════════════════════════════════════════════════════════════════════
-- La decide la administración de odentIA (owner); la clínica no la ve ni la escribe.
--   (de la 0089 del 16-oct)
ALTER TABLE admin.saas_negotiation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY admin.saas_negotiation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON admin.saas_negotiation USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.saas_payment_method
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE admin.saas_payment_method TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.saas_plan
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE admin.saas_plan TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.saas_seller_commission
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin.saas_seller_commission ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY admin.saas_seller_commission FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON admin.saas_seller_commission USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- admin.user_global_block
-- ═════════════════════════════════════════════════════════════════════════
-- Solo owner: la aplicación no toca estas tablas (ni siquiera lectura).
--   (de la 0084 del 16-oct)
ALTER TABLE admin.user_global_block ADD CONSTRAINT user_global_block_reason_check CHECK (((length(TRIM(BOTH FROM reason)) >= 10) AND (length(TRIM(BOTH FROM reason)) <= 500)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- auth.account
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.account TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- auth.session
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.session TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- auth.two_factor
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.two_factor TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- auth.user
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."user" TO dentalagent_app;--> statement-breakpoint
GRANT SELECT(id) ON TABLE auth."user" TO argos_dueno;--> statement-breakpoint
GRANT SELECT(name) ON TABLE auth."user" TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- auth.verification
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.verification TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.dental_template_rule
-- ═════════════════════════════════════════════════════════════════════════
-- La biblioteca es de solo lectura para la aplicación, también su parte dental.
--   (de la 0079 del 24-oct)
GRANT SELECT ON TABLE catalog.dental_template_rule TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.diagnosis_code
-- ═════════════════════════════════════════════════════════════════════════
-- El buscador ignora tildes y mayúsculas: busca en el texto normalizado.
--   (de la 0102 del 16-oct)
CREATE INDEX diagnosis_code_search_idx ON catalog.diagnosis_code USING gin (search_text public.gin_trgm_ops);--> statement-breakpoint
GRANT SELECT ON TABLE catalog.diagnosis_code TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.diagnosis_code_release
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.diagnosis_code_release TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.diagnosis_code_system
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.diagnosis_code_system TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.procedure_catalog_release
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.procedure_catalog_release TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.procedure_code
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.procedure_code TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.procedure_code_product
-- ═════════════════════════════════════════════════════════════════════════
-- Listas oficiales completas (ADR 0079, entrega 7). Qué códigos usa cada
-- producto es un catálogo global: el rol app solo lo lee.
--   (de la 0086 del 24-oct)
GRANT SELECT ON TABLE catalog.procedure_code_product TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.procedure_code_system
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.procedure_code_system TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.treatment_template
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.treatment_template TO dentalagent_app;--> statement-breakpoint
GRANT SELECT(id) ON TABLE catalog.treatment_template TO argos_dueno;--> statement-breakpoint
GRANT SELECT(specialty) ON TABLE catalog.treatment_template TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- catalog.treatment_template_code
-- ═════════════════════════════════════════════════════════════════════════
GRANT SELECT ON TABLE catalog.treatment_template_code TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.odontogram_assessment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE dental.odontogram_assessment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.odontogram_assessment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.odontogram_assessment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE dental.odontogram_assessment TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.odontogram_entry
-- ═════════════════════════════════════════════════════════════════════════
-- El rol de aplicación conserva el hallazgo original; solo puede registrar su corrección.
--   (de la 0009 del 16-oct)
-- El hallazgo original sigue intacto; además de anularse, ahora puede quedar tratado.
--   (de la 0036 del 16-oct)
ALTER TABLE dental.odontogram_entry ADD CONSTRAINT odontogram_entry_details_object_check CHECK ((jsonb_typeof(details) = 'object'::text));--> statement-breakpoint
ALTER TABLE dental.odontogram_entry ADD CONSTRAINT odontogram_entry_status_check CHECK ((status = ANY (ARRAY['recorded'::text, 'voided'::text])));--> statement-breakpoint
ALTER TABLE dental.odontogram_entry ADD CONSTRAINT odontogram_entry_surface_check CHECK (((surface IS NULL) OR (surface = ANY (ARRAY['mesial'::text, 'distal'::text, 'buccal'::text, 'facial'::text, 'lingual'::text, 'palatal'::text, 'occlusal'::text, 'incisal'::text]))));--> statement-breakpoint
ALTER TABLE dental.odontogram_entry ADD CONSTRAINT odontogram_entry_tooth_fdi_check CHECK ((tooth_number = ANY (ARRAY[11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84, 85])));--> statement-breakpoint
ALTER TABLE dental.odontogram_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.odontogram_entry FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.odontogram_entry USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(status) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(voided_at) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(voided_by) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(void_reason) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(resolved_at) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(resolved_by) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(resolved_by_plan_item_id) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(updated_at) ON TABLE dental.odontogram_entry TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.periodontal_chart
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE dental.periodontal_chart ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.periodontal_chart FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.periodontal_chart USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER periodontal_chart_draft_only BEFORE INSERT OR UPDATE ON dental.periodontal_chart FOR EACH ROW EXECUTE FUNCTION public.guard_periodontal_draft();--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE dental.periodontal_chart TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.periodontal_tooth
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE dental.periodontal_tooth ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.periodontal_tooth FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.periodontal_tooth USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER periodontal_tooth_draft_only BEFORE INSERT OR UPDATE ON dental.periodontal_tooth FOR EACH ROW EXECUTE FUNCTION public.guard_periodontal_draft();--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE dental.periodontal_tooth TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.plan_item_finding
-- ═════════════════════════════════════════════════════════════════════════
-- El hallazgo que motivó un tratamiento se anota al crearlo y no se cambia.
--   (de la 0079 del 24-oct)
ALTER TABLE dental.plan_item_finding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.plan_item_finding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.plan_item_finding USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE dental.plan_item_finding TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.service_finding
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE dental.service_finding ADD CONSTRAINT service_finding_condition_check CHECK (char_length(condition) BETWEEN 1 AND 60 AND (variant IS NULL OR char_length(variant) BETWEEN 1 AND 60));--> statement-breakpoint

-- Lo que deja un servicio se elige al crearlo o editarlo, y se puede quitar.
--   (de la 0079 del 24-oct)
ALTER TABLE dental.service_finding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.service_finding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.service_finding USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dental.service_finding TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.address_lookup_day
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.address_lookup_day ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.address_lookup_day FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.address_lookup_day USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- La cuenta diaria de búsquedas de direcciones (issue 36): de cada clínica.
-- La aplicación la lee y la suma; no la borra.
--   (de la 0063 del 24-oct)
REVOKE ALL ON TABLE public.address_lookup_day FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.address_lookup_day TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_answer_trace
-- ═════════════════════════════════════════════════════════════════════════
-- Traza de solo anexado: el rol app registra y lee, nunca corrige ni borra.
--   (de la 0047 del 16-oct)
ALTER TABLE public.agent_answer_trace ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_answer_trace FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_answer_trace USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_answer_trace FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_answer_trace TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_case_memory
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_case_memory ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_case_memory FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_case_memory USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_config
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_config USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_decision_log
-- ═════════════════════════════════════════════════════════════════════════
-- Libro append-only: el rol app registra y lee, nunca corrige ni borra.
--   (de la 0044 del 16-oct)
ALTER TABLE public.agent_decision_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_decision_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_decision_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_decision_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_decision_log TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_handoff
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_handoff ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_handoff FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_handoff USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_handoff FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_handoff TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_knowledge_entry
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_knowledge_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_knowledge_entry FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_knowledge_entry USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_knowledge_entry FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_knowledge_entry TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_knowledge_gap
-- ═════════════════════════════════════════════════════════════════════════
-- Se registra y se resuelve; nunca se borra: es la historia de lo que faltaba.
--   (de la 0048 del 16-oct)
ALTER TABLE public.agent_knowledge_gap ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_knowledge_gap FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_knowledge_gap USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_knowledge_gap FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_knowledge_gap TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_knowledge_revision
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_knowledge_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_knowledge_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_knowledge_revision USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_knowledge_revision FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_knowledge_revision TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_lesson
-- ═════════════════════════════════════════════════════════════════════════
-- Lo revisado, lo aprendido y sus casos se retiran, nunca se borran: son la historia de lo que cambió al agente.
--   (de la 0050 del 16-oct)
ALTER TABLE public.agent_lesson ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_lesson FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_lesson USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_lesson FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_lesson TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_person_fact
-- ═════════════════════════════════════════════════════════════════════════
-- Un dato se reemplaza o se quita; la fila queda como historia de lo que el agente supo y cuándo.
--   (de la 0051 del 16-oct)
ALTER TABLE public.agent_person_fact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_person_fact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_person_fact USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_person_fact FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_person_fact TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_proposal
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_proposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_proposal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_proposal USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER agent_proposal_evidence_immutable BEFORE UPDATE ON public.agent_proposal FOR EACH ROW EXECUTE FUNCTION public.agent_proposal_evidence_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_proposal FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_proposal TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_review_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_review_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_review_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_review_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_review_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_review_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_run_ledger
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_run_ledger ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_run_ledger FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_run_ledger USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_run_ledger FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.agent_run_ledger TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_search_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_search_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_search_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_search_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.agent_test_case
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agent_test_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.agent_test_case FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.agent_test_case USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_test_case FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_test_case TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.ai_usage
-- ═════════════════════════════════════════════════════════════════════════
-- Libro append-only: el rol app registra y lee, nunca corrige ni borra.
--   (de la 0087 del 16-oct)
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.ai_usage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.ai_usage USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.ai_usage FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.ai_usage TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.appointment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_no_overlap_professional EXCLUDE USING gist (organization_id WITH =, professional_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])));--> statement-breakpoint
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_no_overlap_room EXCLUDE USING gist (organization_id WITH =, room_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])));--> statement-breakpoint
ALTER TABLE public.appointment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER appointment_follow_up_sync AFTER UPDATE OF status ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.sync_follow_up_appointment();--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.appointment TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.appointment TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.appointment_booking_link
-- ═════════════════════════════════════════════════════════════════════════
-- Los enlaces se crean, se usan y se revocan; no se borran: son la constancia de quién reservó y por dónde.
--   (de la 0056 del 16-oct)
ALTER TABLE public.appointment_booking_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment_booking_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment_booking_link USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment_booking_link FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.appointment_booking_link TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.appointment_plan_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.appointment_plan_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment_plan_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment_plan_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment_plan_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.appointment_plan_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.audit_event
-- ═════════════════════════════════════════════════════════════════════════
CREATE INDEX audit_event_org_entity_created_idx ON public.audit_event USING btree (organization_id, entity, created_at DESC);--> statement-breakpoint
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.audit_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.audit_event USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.automation_consent
-- ═════════════════════════════════════════════════════════════════════════
-- 4) Tipos de mensaje (ADR 0040): «avisos» es la fila de lo que pasó con su
--    cita y sus papeles; solo se apaga con «No quiero ningún mensaje de la
--    clínica». Los demás tipos siguen siendo los de siempre.
--   (de la 0101 del 16-oct)
ALTER TABLE public.automation_consent ADD CONSTRAINT automation_consent_purpose_check CHECK ((purpose = ANY (ARRAY['recordatorio'::text, 'seguimiento'::text, 'novedades'::text, 'avisos'::text])));--> statement-breakpoint
ALTER TABLE public.automation_consent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_consent FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_consent USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.automation_consent FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.automation_consent TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.automation_job
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.automation_job ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_job FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_job USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.automation_job FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.automation_job TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.automation_link_token
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.automation_link_token ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_link_token FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_link_token USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.automation_link_token FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.automation_link_token TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.automation_rule
-- ═════════════════════════════════════════════════════════════════════════
-- Automatizaciones: RLS por organización y permisos del rol de la aplicación.
--   (de la 0026 del 16-oct)
ALTER TABLE public.automation_rule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.automation_rule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.automation_rule USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.branch
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.branch ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.branch FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.branch USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER branch_default_warehouse AFTER INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.branch_default_warehouse();--> statement-breakpoint
CREATE TRIGGER branch_slug_fill BEFORE INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.branch_slug_fill();--> statement-breakpoint
REVOKE ALL ON TABLE public.branch FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.branch TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.branch TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.calendar_feed
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.calendar_feed ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.calendar_feed FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.calendar_feed USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- «Mi calendario» (issue 46, ADR 0082). El enlace se crea, se cambia y se
-- apaga, nunca se borra: revocarlo deja su historia. Su registro de uso suma
-- una fila por día y programa y se borra a los 90 días, por eso tiene DELETE.
--   (de la 0084 del 24-oct)
REVOKE ALL ON TABLE public.calendar_feed FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(status) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(known_clients) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(revoked_at) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(revoked_by) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(revoke_reason) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(updated_at) ON TABLE public.calendar_feed TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.calendar_feed_use
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.calendar_feed_use ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.calendar_feed_use FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.calendar_feed_use USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.calendar_feed_use FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.calendar_feed_use TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(hits) ON TABLE public.calendar_feed_use TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(last_at) ON TABLE public.calendar_feed_use TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.cash_closure
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.cash_closure ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.cash_closure FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.cash_closure USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER cash_closure_immutable BEFORE UPDATE ON public.cash_closure FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only();--> statement-breakpoint
CREATE TRIGGER cash_closure_no_delete BEFORE DELETE ON public.cash_closure FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.cash_closure FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_closure TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.cash_movement
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.cash_movement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.cash_movement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.cash_movement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER cash_movement_immutable BEFORE UPDATE ON public.cash_movement FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER cash_movement_no_delete BEFORE DELETE ON public.cash_movement FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.cash_movement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_movement TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.cash_shift
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX cash_shift_org_id_finance_uidx ON public.cash_shift USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.cash_shift ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.cash_shift FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.cash_shift USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER cash_shift_close_once BEFORE UPDATE ON public.cash_shift FOR EACH ROW EXECUTE FUNCTION public.finance_cash_shift_close();--> statement-breakpoint
CREATE TRIGGER cash_shift_immutable BEFORE UPDATE ON public.cash_shift FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('status', 'closed_by', 'closed_at', 'expected_cents', 'electronic_cents', 'counted_cents', 'difference_cents', 'close_notes', 'retained_cents', 'delivered_cents');--> statement-breakpoint
CREATE TRIGGER cash_shift_no_delete BEFORE DELETE ON public.cash_shift FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.cash_shift FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_shift TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.channel_connection
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Coherencia proveedor/canal del chat propio.
--   (de la 0026 del 16-oct)
ALTER TABLE public.channel_connection ADD CONSTRAINT channel_connection_webchat_channel_chk CHECK (((provider <> 'web_chat'::text) OR (channel = 'webchat'::text)));--> statement-breakpoint
ALTER TABLE public.channel_connection ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.channel_connection FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.channel_connection USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.channel_connection FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.channel_connection TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.channel_connection TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.channel_template
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.channel_template ADD CONSTRAINT channel_template_unsupported_check CHECK (((unsupported IS NULL) OR (unsupported = ANY (ARRAY['encabezado'::text, 'datos_por_nombre'::text]))));--> statement-breakpoint
ALTER TABLE public.channel_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.channel_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.channel_template USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinic_message
-- ═════════════════════════════════════════════════════════════════════════
-- Un mensaje se archiva y un texto nuevo es otra versión: la aplicación no
-- borra ninguno ni reescribe un texto ya guardado.
--   (de la 0069 del 16-oct)
ALTER TABLE public.clinic_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinic_message FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinic_message USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinic_message FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinic_message TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinic_message_version
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinic_message_version ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinic_message_version FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinic_message_version USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinic_message_version FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinic_message_version TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_access_log
-- ═════════════════════════════════════════════════════════════════════════
-- Traza de solo anexado: la aplicación inserta y solo actualiza el contador y la
-- última hora de la misma franja; nunca borra ni cambia quién, a quién o qué.
-- Los privilegios por defecto del rol incluyen UPDATE y DELETE: se retiran antes
-- de conceder solo las dos columnas de conteo.
--   (de la 0035 del 16-oct)
-- Hueco en cada página para que la reescritura de `last_at` y `hits` quepa en
-- la misma página, condición de la actualización HOT. Rige para las páginas
-- que se escriban desde ahora.
--   (de la 0103 del 16-oct)
-- Los permisos no cambian: el rol de la aplicación consulta, inserta y solo
-- actualiza `last_at` y `hits`; no borra, no vacía ni reescribe quién, a quién
-- o qué (0035). Se reafirman por si un despliegue los hubiera ampliado.
--   (de la 0103 del 16-oct)
ALTER TABLE public.clinical_access_log SET (fillfactor='90');--> statement-breakpoint
ALTER TABLE public.clinical_access_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_access_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_access_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_access_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinical_access_log TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(last_at) ON TABLE public.clinical_access_log TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(hits) ON TABLE public.clinical_access_log TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_follow_up
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_follow_up ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_follow_up FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_follow_up USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER clinical_follow_up_appointment_guard BEFORE INSERT OR UPDATE ON public.clinical_follow_up FOR EACH ROW EXECUTE FUNCTION public.guard_follow_up_appointment();--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_follow_up FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_follow_up TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.clinical_follow_up TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_form_addendum
-- ═════════════════════════════════════════════════════════════════════════
-- Append-only reforzado: la historia y las adendas no se mutan.
--   (de la 0026 del 16-oct)
ALTER TABLE public.clinical_form_addendum ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_form_addendum FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_form_addendum USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_form_addendum FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinical_form_addendum TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_form_response
-- ═════════════════════════════════════════════════════════════════════════
-- Grants del rol app: CRUD de configuración y captura; SIN DELETE salvo
-- vínculos de asignación (professional_specialty, service_specialty), que el
-- servicio reescribe por completo al reasignar.
--   (de la 0026 del 16-oct)
ALTER TABLE public.clinical_form_response ADD CONSTRAINT clinical_form_response_discard_check CHECK ((((status = 'descartado'::text) = (discarded_at IS NOT NULL)) AND ((status <> 'descartado'::text) OR ((char_length(COALESCE(discard_reason, ''::text)) >= 1) AND (char_length(COALESCE(discard_reason, ''::text)) <= 2000)))));--> statement-breakpoint
ALTER TABLE public.clinical_form_response ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_form_response FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_form_response USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER clinical_form_response_immutable BEFORE UPDATE ON public.clinical_form_response FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_response_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_form_response FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_form_response TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_form_template
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_form_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_form_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_form_template USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER clinical_form_template_immutable BEFORE UPDATE ON public.clinical_form_template FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_template_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_form_template FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_form_template TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_note
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_note ADD CONSTRAINT clinical_note_site_check CHECK (((site_system IS NULL) = (site_code IS NULL)));--> statement-breakpoint
CREATE INDEX clinical_note_search_idx ON public.clinical_note USING gin (public.search_fold(note) public.gin_trgm_ops);--> statement-breakpoint
ALTER TABLE public.clinical_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_note FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_note USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_note FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.clinical_note TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.clinical_order
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clinical_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_order FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_order USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.clinical_order FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.clinical_order TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.commission_rule
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_rule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_rule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_rule USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER commission_rule_immutable BEFORE UPDATE ON public.commission_rule FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('rate_bps', 'updated_at');--> statement-breakpoint
CREATE TRIGGER commission_rule_no_delete BEFORE DELETE ON public.commission_rule FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_rule FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.commission_rule TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.commission_rule TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.commission_settlement
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_settlement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_settlement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_settlement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER commission_settlement_immutable BEFORE UPDATE ON public.commission_settlement FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('status', 'voided_at', 'voided_by', 'void_reason', 'updated_at', 'expense_id');--> statement-breakpoint
CREATE TRIGGER commission_settlement_no_delete BEFORE DELETE ON public.commission_settlement FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_settlement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.commission_settlement TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.commission_settlement TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.commission_settlement_line
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_settlement_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_settlement_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_settlement_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_immutable BEFORE UPDATE ON public.commission_settlement_line FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_no_delete BEFORE DELETE ON public.commission_settlement_line FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_settlement_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.commission_settlement_line TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.commission_settlement_line TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.consent_document
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_document ADD CONSTRAINT consent_document_cancel_check CHECK ((((status = 'anulado'::text) = (cancelled_at IS NOT NULL)) AND ((status <> 'anulado'::text) OR ((char_length(COALESCE(cancel_reason, ''::text)) >= 1) AND (char_length(COALESCE(cancel_reason, ''::text)) <= 2000)))));--> statement-breakpoint
ALTER TABLE public.consent_document ADD CONSTRAINT consent_document_link_signed_check CHECK (((signature_method IS DISTINCT FROM 'enlace'::text) OR (person_signed_at IS NOT NULL)));--> statement-breakpoint
ALTER TABLE public.consent_document ADD CONSTRAINT consent_document_pdf_sha256_check CHECK (((pdf_sha256 IS NULL) OR (pdf_sha256 ~ '^[0-9a-f]{64}$'::text)));--> statement-breakpoint
ALTER TABLE public.consent_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_document FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_document USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER consent_document_immutable BEFORE UPDATE ON public.consent_document FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_consent_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.consent_document FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.consent_document TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.consent_event
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_event USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.consent_event FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.consent_event TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.consent_template
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_template USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER consent_template_immutable BEFORE UPDATE ON public.consent_template FOR EACH ROW EXECUTE FUNCTION public.clinical_forms_consent_template_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.consent_template FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.consent_template TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.consent_template_service
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.consent_template_service ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.consent_template_service FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.consent_template_service USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.contact
-- ═════════════════════════════════════════════════════════════════════════
DROP INDEX public.contact_org_doc_uidx;--> statement-breakpoint
CREATE UNIQUE INDEX contact_org_doc_uidx ON public.contact USING btree (organization_id, doc_country, doc_type, doc_number) NULLS NOT DISTINCT WHERE (doc_number IS NOT NULL);--> statement-breakpoint
CREATE INDEX contact_search_name_idx ON public.contact USING gin (public.search_fold(display_name) public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX contact_search_phone_idx ON public.contact USING gin (public.search_digits(phone) public.gin_trgm_ops);--> statement-breakpoint
ALTER TABLE public.contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.contact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.contact USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER contact_display_name_derive BEFORE INSERT OR UPDATE ON public.contact FOR EACH ROW EXECUTE FUNCTION public.derive_person_display_name();--> statement-breakpoint
REVOKE ALL ON TABLE public.contact FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.contact TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.contact_identity
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.contact_identity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.contact_identity FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.contact_identity USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.conversation
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.conversation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.conversation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.conversation USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.conversation FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.conversation TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.conversation TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.crm_note
-- ═════════════════════════════════════════════════════════════════════════
-- Notas operativas inmutables y vínculos nuevos aislados por organización.
--   (de la 0029 del 16-oct)
ALTER TABLE public.crm_note ADD CONSTRAINT crm_note_body_check CHECK (((length(TRIM(BOTH FROM body)) >= 1) AND (length(TRIM(BOTH FROM body)) <= 2000)));--> statement-breakpoint
ALTER TABLE public.crm_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.crm_note FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY crm_note_insert ON public.crm_note FOR INSERT TO dentalagent_app WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE POLICY crm_note_select ON public.crm_note FOR SELECT TO dentalagent_app USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER crm_note_links_guard BEFORE INSERT ON public.crm_note FOR EACH ROW EXECUTE FUNCTION public.crm_contact_links_guard();--> statement-breakpoint
REVOKE ALL ON TABLE public.crm_note FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.crm_note TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.custom_field_def
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.custom_field_def ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.custom_field_def FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.custom_field_def USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER encounter_finalized_immutable BEFORE UPDATE ON public.encounter FOR EACH ROW EXECUTE FUNCTION public.guard_finalized_encounter();--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.encounter TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter_diagnosis
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter_diagnosis ADD CONSTRAINT encounter_diagnosis_site_check CHECK (((site_system IS NULL) = (site_code IS NULL)));--> statement-breakpoint

-- El diagnóstico es historia clínica: se anula, nunca se borra.
--   (de la 0036 del 16-oct)
ALTER TABLE public.encounter_diagnosis ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_diagnosis FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_diagnosis USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER encounter_diagnosis_draft_only BEFORE INSERT OR UPDATE ON public.encounter_diagnosis FOR EACH ROW EXECUTE FUNCTION public.guard_draft_encounter_child();--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_diagnosis FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter_diagnosis TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter_dictation_suggestion
-- ═════════════════════════════════════════════════════════════════════════
-- Una sugerencia se confirma o se descarta; no se borra mientras exista la atención.
--   (de la 0054 del 16-oct)
ALTER TABLE public.encounter_dictation_suggestion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_dictation_suggestion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_dictation_suggestion USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_dictation_suggestion FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter_dictation_suggestion TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter_plan_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter_plan_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_plan_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_plan_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_plan_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.encounter_plan_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter_procedure
-- ═════════════════════════════════════════════════════════════════════════
-- Reglas del sitio común (0074, ADR 0079). Un sitio tiene sistema y código
-- juntos, o ninguno; qué códigos valen lo decide el producto en el servicio
-- (ADR 0036: lo que cambia no va en checks).
--   (de la 0077 del 24-oct)
ALTER TABLE public.encounter_procedure ADD CONSTRAINT encounter_procedure_site_check CHECK (((site_system IS NULL) = (site_code IS NULL)));--> statement-breakpoint
ALTER TABLE public.encounter_procedure ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_procedure FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_procedure USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER encounter_procedure_draft_only BEFORE INSERT OR UPDATE ON public.encounter_procedure FOR EACH ROW EXECUTE FUNCTION public.guard_draft_encounter_child();--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_procedure FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.encounter_procedure TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.encounter_procedure TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter_site
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.encounter_site ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_site FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY draft_sites_delete ON public.encounter_site AS RESTRICTIVE FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.encounter
  WHERE ((encounter.id = encounter_site.encounter_id) AND (encounter.organization_id = encounter_site.organization_id) AND (encounter.status = 'borrador'::text)))));--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_site USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.expense
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.expense ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER expense_immutable BEFORE UPDATE ON public.expense FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason', 'updated_at');--> statement-breakpoint
CREATE TRIGGER expense_no_delete BEFORE DELETE ON public.expense FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.expense FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.expense TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.expense TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.expense_gap_dismissal
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX expense_gap_dismissal_uidx ON public.expense_gap_dismissal USING btree (organization_id, category, month, branch_id) NULLS NOT DISTINCT;--> statement-breakpoint
ALTER TABLE public.expense_gap_dismissal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense_gap_dismissal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense_gap_dismissal USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.expense_gap_dismissal FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.expense_gap_dismissal TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.help_ask
-- ═════════════════════════════════════════════════════════════════════════
-- La clínica crea y lee lo suyo; la respuesta la escribe el equipo de odentIA con el rol propietario.
--   (de la 0055 del 16-oct)
ALTER TABLE public.help_ask ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.help_ask FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.help_ask USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.help_ask FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.help_ask TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.home_visit
-- ═════════════════════════════════════════════════════════════════════════
-- home_visit: cada clínica ve solo lo suyo; la aplicación no borra visitas.
--   (de la 0011 del 24-oct)
ALTER TABLE public.home_visit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.home_visit FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.home_visit USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.home_visit FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.home_visit TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.imaging_measurement
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.imaging_measurement ADD CONSTRAINT imaging_measurement_site_check CHECK (((site_system IS NULL) = (site_code IS NULL)));--> statement-breakpoint

-- imaging_measurement (ADR 0056): cada clínica ve solo lo suyo; la aplicación
-- no borra ni reescribe una medida: solo la retira, y lo retirado no vuelve.
--   (de la 0024 del 24-oct)
ALTER TABLE public.imaging_measurement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.imaging_measurement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.imaging_measurement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER imaging_measurement_guard_update BEFORE UPDATE ON public.imaging_measurement FOR EACH ROW EXECUTE FUNCTION public.imaging_measurement_guard_update();--> statement-breakpoint
REVOKE ALL ON TABLE public.imaging_measurement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.imaging_measurement TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_at) ON TABLE public.imaging_measurement TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_by) ON TABLE public.imaging_measurement TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.imaging_study
-- ═════════════════════════════════════════════════════════════════════════
-- imaging_study / imaging_study_file (ADR 0055): cada clínica ve solo lo suyo.
-- La aplicación no borra: una tomografía cancelada se retira desde su documento.
-- Lo que puede cambiar es lo que avanza con la subida: la miniatura, el fin de
-- la subida y, por archivo, cuándo se comprobó que llegó. Lo recibido no se deshace.
--   (de la 0022 del 24-oct)
ALTER TABLE public.imaging_study ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.imaging_study FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.imaging_study USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER imaging_study_guard_update BEFORE UPDATE ON public.imaging_study FOR EACH ROW EXECUTE FUNCTION public.imaging_study_guard_update();--> statement-breakpoint
REVOKE ALL ON TABLE public.imaging_study FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.imaging_study TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(thumbnail_key) ON TABLE public.imaging_study TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(completed_at) ON TABLE public.imaging_study TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.imaging_study_file
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.imaging_study_file ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.imaging_study_file FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.imaging_study_file USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER imaging_study_file_guard_update BEFORE UPDATE ON public.imaging_study_file FOR EACH ROW EXECUTE FUNCTION public.imaging_study_file_guard_update();--> statement-breakpoint
REVOKE ALL ON TABLE public.imaging_study_file FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.imaging_study_file TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(uploaded_at) ON TABLE public.imaging_study_file TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.mailbox_oauth_state
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Checks de frontera (state OAuth de un solo uso y corta duración).
--   (de la 0026 del 16-oct)
-- 2. RLS: aislamiento por organización. El callback OAuth lee/consume el
-- nonce con rol owner (sin GUC); el rol app solo inserta su propio inicio.
--   (de la 0026 del 16-oct)
-- Rol app: insertar su inicio y leer su fila; el consumo (DELETE) y la
-- limpieza de caducados corren con rol owner. Sin UPDATE jamás.
--   (de la 0026 del 16-oct)
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_expiry_check CHECK ((expires_at > created_at));--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_provider_check CHECK ((provider = ANY (ARRAY['gmail'::text, 'microsoft365'::text])));--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ADD CONSTRAINT mailbox_oauth_state_verifier_check CHECK (((char_length(code_verifier) >= 43) AND (char_length(code_verifier) <= 128)));--> statement-breakpoint
ALTER TABLE public.mailbox_oauth_state ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.mailbox_oauth_state FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY mailbox_oauth_state_org_isolation ON public.mailbox_oauth_state USING ((organization_id = current_setting('app.org_id'::text, true))) WITH CHECK ((organization_id = current_setting('app.org_id'::text, true)));--> statement-breakpoint
REVOKE ALL ON TABLE public.mailbox_oauth_state FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.mailbox_oauth_state TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.medical_leave
-- ═════════════════════════════════════════════════════════════════════════
-- Descanso médico (issue 229, decisión 8): de la clínica, con su RLS; el rol de la
-- aplicación lee, emite y anula, nunca borra (como la receta y la orden).
--   (de la 0099 del 24-oct)
ALTER TABLE public.medical_leave ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.medical_leave FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.medical_leave USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.medical_leave FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.medical_leave TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.member
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.member FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.member TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.member TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.message
-- ═════════════════════════════════════════════════════════════════════════
CREATE INDEX message_search_body_idx ON public.message USING gin (public.search_fold(body) public.gin_trgm_ops);--> statement-breakpoint
ALTER TABLE public.message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.message FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.message USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT(id) ON TABLE public.message TO argos_dueno;--> statement-breakpoint
GRANT SELECT(organization_id) ON TABLE public.message TO argos_dueno;--> statement-breakpoint
GRANT SELECT(conversation_id) ON TABLE public.message TO argos_dueno;--> statement-breakpoint
GRANT SELECT(direction) ON TABLE public.message TO argos_dueno;--> statement-breakpoint
GRANT SELECT(created_at) ON TABLE public.message TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.opportunity
-- ═════════════════════════════════════════════════════════════════════════
-- Rol app: oportunidades lectura/escritura parcial; eventos solo anexar/leer.
--   (de la 0026 del 16-oct)
ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_amount_check CHECK (((amount_cents IS NULL) OR (amount_cents >= 0)));--> statement-breakpoint
ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_close_check CHECK ((((status = 'open'::text) AND (closed_at IS NULL) AND (close_reason IS NULL)) OR ((status = ANY (ARRAY['won'::text, 'lost'::text])) AND (closed_at IS NOT NULL) AND (close_reason IS NOT NULL))));--> statement-breakpoint
ALTER TABLE public.opportunity ADD CONSTRAINT opportunity_status_check CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])));--> statement-breakpoint
ALTER TABLE public.opportunity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.opportunity FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opportunity_org_isolation ON public.opportunity USING ((organization_id = current_setting('app.org_id'::text, true))) WITH CHECK ((organization_id = current_setting('app.org_id'::text, true)));--> statement-breakpoint
CREATE TRIGGER opportunity_conversation_guard BEFORE INSERT OR UPDATE OF organization_id, contact_id, conversation_id ON public.opportunity FOR EACH ROW EXECUTE FUNCTION public.crm_contact_links_guard();--> statement-breakpoint
REVOKE ALL ON TABLE public.opportunity FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.opportunity TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.opportunity TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.opportunity_event
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.opportunity_event ADD CONSTRAINT opportunity_event_action_check CHECK ((action = ANY (ARRAY['opportunity.created'::text, 'opportunity.updated'::text, 'opportunity.moved'::text, 'opportunity.won'::text, 'opportunity.lost'::text, 'opportunity.reopened'::text])));--> statement-breakpoint
ALTER TABLE public.opportunity_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.opportunity_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opportunity_event_org_isolation ON public.opportunity_event USING ((organization_id = current_setting('app.org_id'::text, true))) WITH CHECK ((organization_id = current_setting('app.org_id'::text, true)));--> statement-breakpoint
REVOKE ALL ON TABLE public.opportunity_event FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.opportunity_event TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.org_counter
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.org_counter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.org_counter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.org_counter USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.org_counter FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.org_counter TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.org_profile
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.org_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.org_profile FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.org_profile USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER org_profile_sync_organization_name AFTER INSERT OR UPDATE OF trade_name ON public.org_profile FOR EACH ROW EXECUTE FUNCTION public.org_profile_sync_organization_name();--> statement-breakpoint
CREATE TRIGGER org_profile_trade_name BEFORE INSERT OR UPDATE OF trade_name, legal_name ON public.org_profile FOR EACH ROW EXECUTE FUNCTION public.org_profile_trade_name();--> statement-breakpoint
REVOKE ALL ON TABLE public.org_profile FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_profile TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.org_profile TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.org_specialty
-- ═════════════════════════════════════════════════════════════════════════
-- Especialidades, formularios, consentimientos y órdenes: inmutabilidad en la
-- base con disparadores condicionados, como el resto de lo clínico (el servicio
-- ya lo garantiza y la base lo blinda).
--
-- RLS por tenant en las 10 tablas (todas llevan organization_id).
--   (de la 0026 del 16-oct)
ALTER TABLE public.org_specialty ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.org_specialty FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.org_specialty USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.org_specialty FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.org_specialty TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.org_specialty TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.organization
-- ═════════════════════════════════════════════════════════════════════════
CREATE TRIGGER saas_trial_on_org_create AFTER INSERT ON public.organization FOR EACH ROW EXECUTE FUNCTION public.saas_trial_on_org_create();--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.organization_payment_method
-- ═════════════════════════════════════════════════════════════════════════
-- Aislamiento y privilegios de las nuevas tablas económicas.
--   (de la 0059 del 16-oct)
ALTER TABLE public.organization_payment_method ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.organization_payment_method FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.organization_payment_method USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER organization_payment_method_no_delete BEFORE DELETE ON public.organization_payment_method FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.organization_payment_method FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.organization_payment_method TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER patient_self_link AFTER INSERT OR UPDATE OF person_id ON public.patient FOR EACH ROW EXECUTE FUNCTION public.patient_self_link();--> statement-breakpoint
REVOKE ALL ON TABLE public.patient FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.patient TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_allergy
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_allergy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_allergy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_allergy USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_allergy FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_allergy TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_anamnesis
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_anamnesis ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_anamnesis FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_anamnesis USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_anamnesis FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_anamnesis TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_charge
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_charge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_charge FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_charge USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_charge FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_charge TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.patient_charge TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_condition
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_condition ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_condition FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_condition USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_condition FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_condition TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_contact
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_contact FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_contact USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE CONSTRAINT TRIGGER patient_self_link_guard AFTER INSERT OR DELETE OR UPDATE OF relationship, contact_id ON public.patient_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_patient_self_link();--> statement-breakpoint
GRANT SELECT(organization_id) ON TABLE public.patient_contact TO argos_dueno;--> statement-breakpoint
GRANT SELECT(contact_id) ON TABLE public.patient_contact TO argos_dueno;--> statement-breakpoint
GRANT SELECT(relationship) ON TABLE public.patient_contact TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_data_consent
-- ═════════════════════════════════════════════════════════════════════════
-- Aislamiento por organización de las tablas nuevas; el ubigeo es un catálogo
-- global de solo lectura para la aplicación, como CIE-10.
--   (de la 0039 del 16-oct)
-- El consentimiento se otorga y se revoca; nunca se borra.
--   (de la 0039 del 16-oct)
ALTER TABLE public.patient_data_consent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_data_consent FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_data_consent USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_data_consent FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_data_consent TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_data_request
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_data_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_data_request FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_data_request USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Pedidos sobre sus datos (issue 50, ADR 0080): de cada clínica. La aplicación
-- los registra, los comprueba y los responde; nunca los borra.
--   (de la 0075 del 24-oct)
REVOKE ALL ON TABLE public.patient_data_request FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_data_request TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_document
-- ═════════════════════════════════════════════════════════════════════════
-- El archivo y su clasificación siguen inmutables para la aplicación: el
-- UPDATE de tabla sigue revocado (0005) y solo se conceden las columnas del
-- informe y del retiro. El trigger impide deshacer o modificar un retiro.
--   (de la 0040 del 16-oct)
-- Un documento del paciente se referencia con su organización (firma en papel,
-- resultado de una orden).
--   (de la 0092 del 16-oct)
CREATE INDEX patient_document_active_idx ON public.patient_document USING btree (organization_id, patient_id, created_at) WHERE (retired_at IS NULL);--> statement-breakpoint
ALTER TABLE public.patient_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_document FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_document USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER patient_document_guard_update BEFORE UPDATE ON public.patient_document FOR EACH ROW EXECUTE FUNCTION public.patient_document_guard_update();--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_document FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(report_status) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_at) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retired_by) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(retire_reason) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_document_context
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_document_context ADD CONSTRAINT patient_document_context_site_check CHECK (((site_system IS NULL) = (cardinality(site_codes) = 0)));--> statement-breakpoint
ALTER TABLE public.patient_document_context ADD CONSTRAINT patient_document_context_version_check CHECK ((version >= 1));--> statement-breakpoint
ALTER TABLE public.patient_document_context ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_document_context FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_document_context USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_document_context FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_document_context TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_family_history
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_family_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_family_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_family_history USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_medication
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_medication ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_medication FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_medication USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_medication FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_medication TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_payment
-- ═════════════════════════════════════════════════════════════════════════
-- El medio y el importe de un pago quedan congelados en la base: solo admite anularse.
--   (de la 0061 del 16-oct)
ALTER TABLE public.patient_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_payment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER patient_payment_immutable BEFORE UPDATE ON public.patient_payment FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason', 'updated_at');--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_payment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_payment TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.patient_payment TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_payment_application
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_payment_application ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_application FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_payment_application USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_payment_application FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_payment_application TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.patient_payment_application TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_payment_refund
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_payment_refund ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_refund FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_payment_refund USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_payment_refund FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_payment_refund TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.patient_payment_refund TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_record_opening
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_record_opening ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_record_opening FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_record_opening USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Historia bloqueada (ADR 0080, fase 2). Las aperturas con motivo son de cada
-- clínica: la aplicación las anota y las lee; nunca las cambia ni las borra.
--   (de la 0082 del 24-oct)
REVOKE ALL ON TABLE public.patient_record_opening FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_record_opening TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_registration
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_registration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_registration FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_registration USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_registration FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_registration TO dentalagent_app;--> statement-breakpoint
GRANT SELECT(organization_id) ON TABLE public.patient_registration TO argos_dueno;--> statement-breakpoint
GRANT SELECT(patient_id) ON TABLE public.patient_registration TO argos_dueno;--> statement-breakpoint
GRANT SELECT(entry_point) ON TABLE public.patient_registration TO argos_dueno;--> statement-breakpoint
GRANT SELECT(actor_user_id) ON TABLE public.patient_registration TO argos_dueno;--> statement-breakpoint
GRANT SELECT(context_contact_id) ON TABLE public.patient_registration TO argos_dueno;--> statement-breakpoint
GRANT SELECT(conversation_id) ON TABLE public.patient_registration TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_registration_config
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_registration_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_registration_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_registration_config USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_registration_link
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_registration_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_registration_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_registration_link USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_responsibility
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.patient_responsibility ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_responsibility FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_responsibility USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_responsibility FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.patient_responsibility TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.payment_return
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.payment_return ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.payment_return FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.payment_return USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER payment_return_immutable BEFORE UPDATE ON public.payment_return FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only();--> statement-breakpoint
CREATE TRIGGER payment_return_no_delete BEFORE DELETE ON public.payment_return FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- Anular y devolver un cobro: reglas (ADR 0068).

-- 1. La devolución nace cerrada al rol de la app (ADR 0063): se lee y se crea,
-- nunca se cambia ni se borra.
--   (de la 0042 del 24-oct)
REVOKE ALL ON TABLE public.payment_return FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.payment_return TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.payment_ticket
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX payment_ticket_org_id_finance_uidx ON public.payment_ticket USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.payment_ticket ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.payment_ticket FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.payment_ticket USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER payment_ticket_immutable BEFORE UPDATE ON public.payment_ticket FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER payment_ticket_no_delete BEFORE DELETE ON public.payment_ticket FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.payment_ticket FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.payment_ticket TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.payment_ticket TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.pipeline
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.pipeline ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.pipeline FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.pipeline USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.pipeline_stage
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.pipeline_stage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.pipeline_stage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.pipeline_stage USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.pipeline_stage FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pipeline_stage TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.pipeline_stage TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_access_log
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_access_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_access_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_access_log USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_access_log FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.portal_access_log TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_challenge
-- ═════════════════════════════════════════════════════════════════════════
-- 4. Grants mínimos para dentalagent_app: lectura/escritura operativa sin
-- borrado en caliente; verificación y challenges son append-only con UPDATE
-- solo para liquidar (task de solicitud, challenge usado).
--   (de la 0028 del 16-oct)
ALTER TABLE public.portal_challenge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_challenge FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_challenge USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_challenge FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_challenge TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_grant
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_grant ADD CONSTRAINT portal_grant_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'appointments'::text) AND (scope ? 'budgets'::text) AND (scope ? 'account'::text) AND (scope ? 'documents'::text)));--> statement-breakpoint
ALTER TABLE public.portal_grant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_grant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_grant USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_grant FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_grant TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_link
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Forma del alcance: drizzle no valida jsonb; el servicio sí, esto lo blinda en DB.
--   (de la 0026 del 16-oct)
-- 2. Coherencia de estados: usado implica used_at; pendiente implica sin uso;
-- revocado conserva evidencia (puede tener used_at si se revocó tras canje).
--   (de la 0026 del 16-oct)
-- 3. RLS por tenant (FORCE como el resto del dominio).
--   (de la 0026 del 16-oct)
-- 4. Grants: la bitácora es append-only (sin UPDATE ni DELETE); enlaces y
-- sesiones se revocan por UPDATE, nunca se borran en caliente.
--   (de la 0026 del 16-oct)
ALTER TABLE public.portal_link ADD CONSTRAINT portal_link_revoked_check CHECK (((status <> 'revocado'::text) = (revoked_at IS NULL)));--> statement-breakpoint
ALTER TABLE public.portal_link ADD CONSTRAINT portal_link_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'appointments'::text) AND (scope ? 'budgets'::text) AND (scope ? 'account'::text) AND (scope ? 'documents'::text) AND (jsonb_typeof((scope -> 'documents'::text)) = 'array'::text)));--> statement-breakpoint
ALTER TABLE public.portal_link ADD CONSTRAINT portal_link_used_check CHECK ((((status = 'usado'::text) AND (used_at IS NOT NULL)) OR ((status = 'pendiente'::text) AND (used_at IS NULL)) OR (status = 'revocado'::text)));--> statement-breakpoint
ALTER TABLE public.portal_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_link USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_link FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_link TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_passkey
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_passkey ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_passkey FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_passkey USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_passkey FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_passkey TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_policy
-- ═════════════════════════════════════════════════════════════════════════
-- 3. RLS por tenant (FORCE como el resto del dominio).
--   (de la 0028 del 16-oct)
ALTER TABLE public.portal_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_policy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_policy USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_policy FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_policy TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_session
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_session ADD CONSTRAINT portal_session_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'appointments'::text) AND (scope ? 'budgets'::text) AND (scope ? 'account'::text) AND (scope ? 'documents'::text) AND (jsonb_typeof((scope -> 'documents'::text)) = 'array'::text)));--> statement-breakpoint
ALTER TABLE public.portal_session ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_session FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_session USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_session FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.portal_session TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.portal_verification
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_verification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.portal_verification FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.portal_verification USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.portal_verification FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.portal_verification TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.prescription
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.prescription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.prescription FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.prescription USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.prescription FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.prescription TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.prescription_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.prescription_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.prescription_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.prescription_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.prescription_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.prescription_item TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.processing_agreement_acceptance
-- ═════════════════════════════════════════════════════════════════════════
-- processing_agreement_acceptance: cada clínica ve solo lo suyo; la aceptación no se reescribe ni se borra.
--   (de la 0013 del 24-oct)
ALTER TABLE public.processing_agreement_acceptance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.processing_agreement_acceptance FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.processing_agreement_acceptance USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.processing_agreement_acceptance FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.processing_agreement_acceptance TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.product
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.product ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.product FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.product USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Inventario cuida su historia (cierre de Inventario, fase 1).

-- 1. Lo que el rol de la app hace con inventario. Estas tablas nacieron con
-- lectura y escritura completas (el init de la imagen, antes de la ADR 0063).
-- La aplicación no borra nada de inventario: un producto, un almacén o un
-- proveedor se desactivan, una orden se cancela y un lote se queda con su
-- historia. El ledger (`stock_movement`) ya era de solo inserción.
--   (de la 0036 del 24-oct)
REVOKE ALL ON TABLE public.product FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.product TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.product TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.product_lot
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.product_lot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.product_lot FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.product_lot USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.product_lot FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.product_lot TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.product_lot TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.product_minimum
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.product_minimum ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.product_minimum FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.product_minimum USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Inventario por sede, unidades, materiales y venta: reglas y datos (ADR 0067).
-- Va entre la 0037 (lo que se agrega) y la 0039 (lo que se quita): pasa los
-- datos de las columnas viejas antes de quitarlas.

-- 1. Las tablas nuevas nacen cerradas al rol de la app (ADR 0063): se concede
-- solo lo que usa, con su RLS. Nada de inventario se borra: el mínimo de una
-- sede y los materiales de un servicio se ponen en cero o se reemplazan, salvo
-- la fila de un material que se quita del servicio, que sí se borra.
--   (de la 0038 del 24-oct)
REVOKE ALL ON TABLE public.product_minimum FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.product_minimum TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.product_minimum TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.professional_profile
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.professional_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_profile FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_profile USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.professional_schedule
-- ═════════════════════════════════════════════════════════════════════════
-- La vigente es la activa y no tiene fin; la cerrada terminó después de empezar.
--   (de la 0028 del 24-oct)
ALTER TABLE public.professional_schedule ADD CONSTRAINT professional_schedule_validity_check CHECK ((((valid_until IS NULL) = is_active) AND ((valid_until IS NULL) OR (valid_until > valid_from))));--> statement-breakpoint

-- Agenda y disponibilidad: RLS por organización y permisos del rol de la
-- aplicación.
--   (de la 0026 del 16-oct)
ALTER TABLE public.professional_schedule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_schedule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_schedule USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.professional_schedule FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.professional_schedule TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.professional_schedule TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.professional_specialty
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.professional_specialty ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.professional_specialty FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.professional_specialty USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.professional_specialty FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.professional_specialty TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.professional_specialty TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.promotion
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX promotion_org_id_finance_uidx ON public.promotion USING btree (organization_id, id);--> statement-breakpoint
ALTER TABLE public.promotion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.promotion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.promotion USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER promotion_no_delete BEFORE DELETE ON public.promotion FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.promotion FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.promotion TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.promotion TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.promotion_service_price
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.promotion_service_price ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.promotion_service_price FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.promotion_service_price USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER promotion_service_price_no_delete BEFORE DELETE ON public.promotion_service_price FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.promotion_service_price FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.promotion_service_price TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.purchase_order
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.purchase_order ALTER COLUMN order_number SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.purchase_order ADD CONSTRAINT purchase_order_number_check CHECK ((order_number > 0));--> statement-breakpoint
ALTER TABLE public.purchase_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.purchase_order USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.purchase_order FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.purchase_order TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.purchase_order TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.purchase_order_line
-- ═════════════════════════════════════════════════════════════════════════
-- 3. Sin recepciones por encima de lo pedido.
--   (de la 0026 del 16-oct)
ALTER TABLE public.purchase_order_line ADD CONSTRAINT purchase_order_line_received_cap_check CHECK ((received_quantity <= quantity));--> statement-breakpoint
ALTER TABLE public.purchase_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.purchase_order_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER purchase_order_line_draft_delete BEFORE DELETE ON public.purchase_order_line FOR EACH ROW EXECUTE FUNCTION public.purchase_order_line_draft_delete();--> statement-breakpoint

-- 7. Una compra en borrador se edita: sus productos se reemplazan y el que se
-- quita se borra. La app no borra nada más de una compra: una línea de una
-- compra pedida, recibida, cerrada o cancelada es historia (la base lo exige).
-- El rol owner conserva el mantenimiento de datos semilla, como en finance_no_delete.
--   (de la 0038 del 24-oct)
REVOKE ALL ON TABLE public.purchase_order_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.purchase_order_line TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.purchase_order_line TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.registration_hold
-- ═════════════════════════════════════════════════════════════════════════
-- registration_hold: cada clínica ve solo lo suyo; lo borra la decisión de recepción.
--   (de la 0026 del 24-oct)
ALTER TABLE public.registration_hold ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.registration_hold FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.registration_hold USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Lo que escribió no se reescribe: se guarda una vez y se borra al decidir.
--   (de la 0026 del 24-oct)
REVOKE ALL ON TABLE public.registration_hold FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.registration_hold TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.report_digest
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.report_digest ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_digest FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_digest USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.report_digest FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.report_digest TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.report_digest_send
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.report_digest_send ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_digest_send FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_digest_send USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.report_digest_send FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.report_digest_send TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.report_goal
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.report_goal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_goal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_goal USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Una meta se cambia dentro de su mes; las de meses pasados quedan como estaban.
--   (de la 0046 del 24-oct)
REVOKE ALL ON TABLE public.report_goal FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.report_goal TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.report_pin
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.report_pin ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_pin FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_pin USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER report_pin_limit BEFORE INSERT ON public.report_pin FOR EACH ROW EXECUTE FUNCTION public.report_pin_limit();--> statement-breakpoint

-- Una respuesta fijada se pone y se quita; no se edita.
--   (de la 0046 del 24-oct)
REVOKE ALL ON TABLE public.report_pin FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.report_pin TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.report_question
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.report_question ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.report_question FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.report_question USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Argos en Reportes, metas y el resumen del lunes: reglas (ADR 0070 y 0071).

-- 1. Cada tabla nace cerrada al rol de la app (ADR 0063) y aislada por clínica.
-- Las preguntas solo se anotan: no se cambian ni se borran.
--   (de la 0046 del 24-oct)
REVOKE ALL ON TABLE public.report_question FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.report_question TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_action
-- ═════════════════════════════════════════════════════════════════════════
-- Libro: la aplicación registra y lee; el cobro anota el cargo con owner.
--   (de la 0088 del 16-oct)
ALTER TABLE public.saas_action ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_action FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_action USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER saas_action_charged_is_frozen BEFORE UPDATE ON public.saas_action FOR EACH ROW EXECUTE FUNCTION public.saas_action_charged_is_frozen();--> statement-breakpoint

-- Cobro por tipo (ADR 0085). La conversación de Sofi cambia de tipo mientras
-- dura su ventana (de «Informa» a «Gestiona» si después mueve o reserva una
-- cita): la aplicación puede reescribir su tipo y su precio, nunca los de una
-- acción ya cobrada. El GB del día lo mide el reloj SaaS con owner; la clínica
-- lo lee.
--   (de la 0093 del 24-oct)
-- La conversación que sube de Informa a Gestiona guarda cuándo subió y lo que valía antes (ADR 0085):
-- el rol de la aplicación las escribe junto con el tipo, como en 0093.
--   (de la 0105 del 24-oct)
REVOKE ALL ON TABLE public.saas_action FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(detail) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(base_price_micros) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(price_micros) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(discount_bps) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(tier) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(tier_changed_at) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(previous_price_micros) ON TABLE public.saas_action TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_action_review
-- ═════════════════════════════════════════════════════════════════════════
-- saas_action_review (ADR 0054): la clínica pide y lee sus revisiones; decidir
-- y anotar el cargo que la devolvió es del personal de odentIA, con owner.
--   (de la 0020 del 24-oct)
ALTER TABLE public.saas_action_review ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_action_review FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_action_review USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_action_review FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.saas_action_review TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_charge
-- ═════════════════════════════════════════════════════════════════════════
-- Rol app: CRUD de tenant salvo borrado; globales de sólo lectura segura.
--   (de la 0082 del 16-oct)
ALTER TABLE public.saas_charge ADD CONSTRAINT saas_charge_tax_check CHECK (((tax_cents >= 0) AND ((subtotal_cents IS NULL) OR ((subtotal_cents + tax_cents) = amount_cents))));--> statement-breakpoint
ALTER TABLE public.saas_charge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_charge FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_charge USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER saas_charge_immutable BEFORE UPDATE ON public.saas_charge FOR EACH ROW EXECUTE FUNCTION public.saas_charge_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_charge FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_charge TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_charge_line
-- ═════════════════════════════════════════════════════════════════════════
-- Histórico inmutable como el cargo: la clínica lo lee; lo emite el ciclo con owner.
--   (de la 0090 del 16-oct)
ALTER TABLE public.saas_charge_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_charge_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_charge_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_charge_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.saas_charge_line TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_notice
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.saas_notice ADD CONSTRAINT saas_notice_email_state_check CHECK ((email_state = ANY (ARRAY['pendiente'::text, 'reclamado'::text, 'enviado'::text, 'incierto'::text])));--> statement-breakpoint
ALTER TABLE public.saas_notice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_notice FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_notice USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_notice FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_notice TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_payment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.saas_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_payment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_payment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER saas_payment_immutable BEFORE UPDATE ON public.saas_payment FOR EACH ROW EXECUTE FUNCTION public.saas_payment_immutable();--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_payment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_payment TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.saas_subscription
-- ═════════════════════════════════════════════════════════════════════════
-- RLS por tenant: las tablas con organization_id solo ven la org del GUC.
--   (de la 0082 del 16-oct)
ALTER TABLE public.saas_subscription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.saas_subscription FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.saas_subscription USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.saas_subscription FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.saas_subscription TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.schedule_block
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.schedule_block ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.schedule_block FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.schedule_block USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.schedule_block FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.schedule_block TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.schedule_block TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.schedule_room
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.schedule_room ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.schedule_room FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.schedule_room USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.schedule_room FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.schedule_room TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.schedule_room TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.service_catalog
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.service_catalog ADD CONSTRAINT service_catalog_source_check CHECK (((source = ANY (ARRAY['template'::text, 'custom'::text])) AND ((source = 'template'::text) = (template_id IS NOT NULL))));--> statement-breakpoint
ALTER TABLE public.service_catalog ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.service_catalog FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.service_catalog USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.service_catalog FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.service_catalog TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.service_catalog TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.service_material
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.service_material ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.service_material FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.service_material USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.stock_movement
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.stock_movement ADD CONSTRAINT stock_movement_transfer_dest_check CHECK ((((kind <> 'traslado'::text) AND (dest_warehouse_id IS NULL)) OR ((kind = 'traslado'::text) AND (dest_warehouse_id IS NOT NULL) AND (dest_warehouse_id <> warehouse_id))));--> statement-breakpoint
ALTER TABLE public.stock_movement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.stock_movement USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.stock_movement FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.stock_movement TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.stock_movement TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.stock_shortage
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.stock_shortage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.stock_shortage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.stock_shortage USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.stock_shortage FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.stock_shortage TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.stock_shortage TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.storage_usage_day
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.storage_usage_day ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.storage_usage_day FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.storage_usage_day USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.storage_usage_day FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.storage_usage_day TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.supplier
-- ═════════════════════════════════════════════════════════════════════════
-- Inventario: aislamiento por organización, movimientos inmutables y saldos no
-- negativos.
--   (de la 0026 del 16-oct)
ALTER TABLE public.supplier ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.supplier FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.supplier USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.supplier FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.supplier TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.supplier TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.supplier_credit_use
-- ═════════════════════════════════════════════════════════════════════════
-- expense: el gasto que paga una compra va a la sede de su almacén y en su
-- moneda; `purchase_order_id` ya es inmutable (`expense_immutable` revisa todas
-- las columnas salvo la anulación).

-- supplier_credit_use: cada clínica ve lo suyo; se anula, no se borra ni se reescribe.
--   (de la 0028 del 24-oct)
ALTER TABLE public.supplier_credit_use ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.supplier_credit_use FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.supplier_credit_use USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER supplier_credit_use_immutable BEFORE UPDATE ON public.supplier_credit_use FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER supplier_credit_use_no_delete BEFORE DELETE ON public.supplier_credit_use FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.supplier_credit_use FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.supplier_credit_use TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.support_access_audit
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_access_audit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_access_audit USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER support_access_audit_org_match BEFORE INSERT OR UPDATE ON public.support_access_audit FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint
REVOKE ALL ON TABLE public.support_access_audit FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_access_audit TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.support_access_grant
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_access_grant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_access_grant USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER support_access_grant_org_match BEFORE INSERT OR UPDATE ON public.support_access_grant FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint
REVOKE ALL ON TABLE public.support_access_grant FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.support_access_grant TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.support_attachment
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_attachment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER support_attachment_org_match BEFORE INSERT OR UPDATE ON public.support_attachment FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint
REVOKE ALL ON TABLE public.support_attachment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_attachment TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.support_case
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_case USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.support_case FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.support_case TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.support_message
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.support_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_message USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER support_message_org_match BEFORE INSERT OR UPDATE ON public.support_message FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint
REVOKE ALL ON TABLE public.support_message FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_message TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.support_notice
-- ═════════════════════════════════════════════════════════════════════════
-- La FK compuesta no mira filas con organización nula: el trigger iguala la del caso.
--   (de la 0100 del 16-oct)
-- La aplicación crea y lee avisos de su clínica; reclamarlos y cerrarlos es del worker (owner).
--   (de la 0100 del 16-oct)
ALTER TABLE public.support_notice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.support_notice USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER support_notice_org_match BEFORE INSERT OR UPDATE ON public.support_notice FOR EACH ROW EXECUTE FUNCTION public.support_case_org_match();--> statement-breakpoint
REVOKE ALL ON TABLE public.support_notice FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.support_notice TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.task
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.task ADD CONSTRAINT task_kind_check CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['ficha_repetida'::text, 'volver_al_portal'::text, 'registro_con_documento'::text, 'confirmar_representante'::text]))));--> statement-breakpoint
ALTER TABLE public.task ADD CONSTRAINT task_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])));--> statement-breakpoint
ALTER TABLE public.task ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.task FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.task USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER task_links_guard BEFORE INSERT OR UPDATE OF organization_id, contact_id, conversation_id, opportunity_id ON public.task FOR EACH ROW EXECUTE FUNCTION public.crm_contact_links_guard();--> statement-breakpoint
REVOKE ALL ON TABLE public.task FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.task TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.task TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.ticket_counter
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.ticket_counter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.ticket_counter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.ticket_counter USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER ticket_counter_immutable BEFORE UPDATE ON public.ticket_counter FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('next_number', 'next_return_number');--> statement-breakpoint
CREATE TRIGGER ticket_counter_no_delete BEFORE DELETE ON public.ticket_counter FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.ticket_counter FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.ticket_counter TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.treatment_budget
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_budget ADD CONSTRAINT treatment_budget_number_check CHECK ((budget_number > 0));--> statement-breakpoint
ALTER TABLE public.treatment_budget ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_budget FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_budget USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_budget FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.treatment_budget TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.treatment_budget TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.treatment_budget_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_budget_item ADD CONSTRAINT treatment_budget_item_site_check CHECK (((site_system IS NULL) = (site_code IS NULL)));--> statement-breakpoint
ALTER TABLE public.treatment_budget_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_budget_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_budget_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER treatment_budget_item_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.treatment_budget_item FOR EACH ROW EXECUTE FUNCTION public.treatment_budget_item_guard();--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_budget_item FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.treatment_budget_item TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.treatment_budget_item TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.treatment_budget_option
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_budget_option ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_budget_option FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_budget_option USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER treatment_budget_option_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.treatment_budget_option FOR EACH ROW EXECUTE FUNCTION public.treatment_budget_option_guard();--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_budget_option FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.treatment_budget_option TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.treatment_budget_option TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.treatment_plan
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_plan ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.treatment_plan FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.treatment_plan USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.treatment_plan FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.treatment_plan TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.treatment_plan_item
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.treatment_plan_item ADD CONSTRAINT treatment_plan_item_site_check CHECK (((site_system IS NULL) = (site_code IS NULL)));--> statement-breakpoint
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
GRANT SELECT ON TABLE public.treatment_plan_item TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.warehouse
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.warehouse ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.warehouse FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.warehouse USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.warehouse FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.warehouse TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.warehouse TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.webchat_rate_limit
-- ═════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.webchat_rate_limit FROM dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.webchat_site
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.webchat_site ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.webchat_site FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.webchat_site USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Sitios del chat web (decisión 8 del pulido de la Bandeja): de cada clínica.
--   (de la 0057 del 24-oct)
REVOKE ALL ON TABLE public.webchat_site FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.webchat_site TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.workspace_notification
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
-- odontogram_entry
ALTER TABLE ONLY dental.odontogram_entry
    ADD CONSTRAINT odontogram_entry_left_by_plan_item_fk FOREIGN KEY (organization_id, patient_id, left_by_plan_item_id) REFERENCES public.treatment_plan_item(organization_id, patient_id, id);--> statement-breakpoint

-- agent_proposal
-- Propuestas del agente y tareas referidas a un paciente: FK compuesta por
-- organización (sin FK en el esquema TS para evitar el ciclo crm ↔ clinical).
--   (de la 0034 del 16-oct)
ALTER TABLE ONLY public.agent_proposal
    ADD CONSTRAINT agent_proposal_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id);--> statement-breakpoint

-- cash_closure
ALTER TABLE ONLY public.cash_closure
    ADD CONSTRAINT cash_closure_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.cash_closure
    ADD CONSTRAINT cash_closure_shift_id_org_fk FOREIGN KEY (organization_id, shift_id) REFERENCES public.cash_shift(organization_id, id);--> statement-breakpoint

-- cash_movement
-- Finanzas: los disparadores blindan, fila por fila, que las actualizaciones
-- sean solo las acotadas (cierre, anulación, recálculo) y que nada se borre ni
-- se reabra.
--
-- FK diferida: cash_movement.expense_id → expense.id (expense se declara
-- después de cash_movement en el esquema y se evita el ciclo en código).
--   (de la 0026 del 16-oct)
ALTER TABLE ONLY public.cash_movement
    ADD CONSTRAINT cash_movement_expense_fk FOREIGN KEY (expense_id) REFERENCES public.expense(id);--> statement-breakpoint

-- clinical_form_response
ALTER TABLE ONLY public.clinical_form_response
    ADD CONSTRAINT clinical_form_response_respondent_contact_fk FOREIGN KEY (organization_id, respondent_contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint

-- clinical_order
ALTER TABLE ONLY public.clinical_order
    ADD CONSTRAINT clinical_order_result_document_fk FOREIGN KEY (organization_id, result_document_id) REFERENCES public.patient_document(organization_id, id);--> statement-breakpoint

-- consent_document
ALTER TABLE ONLY public.consent_document
    ADD CONSTRAINT consent_document_paper_document_fk FOREIGN KEY (organization_id, paper_document_id) REFERENCES public.patient_document(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document
    ADD CONSTRAINT consent_document_pdf_document_fk FOREIGN KEY (pdf_document_id) REFERENCES public.patient_document(id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document
    ADD CONSTRAINT consent_document_revoke_pdf_document_fk FOREIGN KEY (revoke_pdf_document_id) REFERENCES public.patient_document(id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document
    ADD CONSTRAINT consent_document_revoker_contact_fk FOREIGN KEY (organization_id, revoker_contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.consent_document
    ADD CONSTRAINT consent_document_signer_contact_fk FOREIGN KEY (organization_id, signer_contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint

-- consent_template_service
ALTER TABLE ONLY public.consent_template_service
    ADD CONSTRAINT consent_template_service_service_fk FOREIGN KEY (organization_id, service_id) REFERENCES public.service_catalog(organization_id, id) ON DELETE CASCADE;--> statement-breakpoint

-- crm_note
ALTER TABLE ONLY public.crm_note
    ADD CONSTRAINT crm_note_contact_org_fk FOREIGN KEY (organization_id, contact_id) REFERENCES public.contact(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.crm_note
    ADD CONSTRAINT crm_note_conversation_org_fk FOREIGN KEY (organization_id, conversation_id) REFERENCES public.conversation(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.crm_note
    ADD CONSTRAINT crm_note_opportunity_org_fk FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunity(organization_id, id);--> statement-breakpoint

-- expense_gap_dismissal: cada clínica ve lo suyo; uno por tipo, mes y sede
-- (sin sede cuenta como una más); la aplicación lo anota y no lo reescribe.
--   (de la 0028 del 24-oct)
ALTER TABLE ONLY public.expense_gap_dismissal
    ADD CONSTRAINT expense_gap_dismissal_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint

-- opportunity
ALTER TABLE ONLY public.opportunity
    ADD CONSTRAINT opportunity_conversation_org_fk FOREIGN KEY (organization_id, conversation_id) REFERENCES public.conversation(organization_id, id);--> statement-breakpoint

-- patient_charge
ALTER TABLE ONLY public.patient_charge
    ADD CONSTRAINT patient_charge_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_charge
    ADD CONSTRAINT patient_charge_original_fk FOREIGN KEY (organization_id, original_charge_id) REFERENCES public.patient_charge(organization_id, id);--> statement-breakpoint

-- 2. El producto vendido en «Cobrar» es de la misma clínica (`patient` no
-- importa `product` en el esquema: el vínculo compuesto vive aquí).
--   (de la 0038 del 24-oct)
ALTER TABLE ONLY public.patient_charge
    ADD CONSTRAINT patient_charge_product_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_application
    ADD CONSTRAINT patient_payment_application_replaces_fk FOREIGN KEY (organization_id, replaces_application_id) REFERENCES public.patient_payment_application(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_application
    ADD CONSTRAINT patient_payment_application_return_fk FOREIGN KEY (organization_id, return_id) REFERENCES public.payment_return(organization_id, id);--> statement-breakpoint

-- patient_payment_application
ALTER TABLE ONLY public.patient_payment_application
    ADD CONSTRAINT patient_payment_application_ticket_id_org_fk FOREIGN KEY (organization_id, ticket_id) REFERENCES public.payment_ticket(organization_id, id);--> statement-breakpoint

-- patient_payment
ALTER TABLE ONLY public.patient_payment
    ADD CONSTRAINT patient_payment_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment
    ADD CONSTRAINT patient_payment_payment_method_id_org_fk FOREIGN KEY (organization_id, payment_method_id) REFERENCES public.organization_payment_method(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_refund
    ADD CONSTRAINT patient_payment_refund_return_fk FOREIGN KEY (organization_id, return_id) REFERENCES public.payment_return(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment
    ADD CONSTRAINT patient_payment_ticket_id_org_fk FOREIGN KEY (organization_id, ticket_id) REFERENCES public.payment_ticket(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.payment_return
    ADD CONSTRAINT payment_return_branch_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint

-- 2. Todo vínculo queda dentro de la misma clínica.
--   (de la 0042 del 24-oct)
ALTER TABLE ONLY public.payment_return
    ADD CONSTRAINT payment_return_ticket_fk FOREIGN KEY (organization_id, ticket_id) REFERENCES public.payment_ticket(organization_id, id);--> statement-breakpoint

-- payment_ticket
ALTER TABLE ONLY public.payment_ticket
    ADD CONSTRAINT payment_ticket_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.payment_ticket
    ADD CONSTRAINT payment_ticket_patient_id_org_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot
    ADD CONSTRAINT product_lot_product_id_org_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot
    ADD CONSTRAINT product_lot_purchase_order_id_org_fk FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_order(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot
    ADD CONSTRAINT product_lot_supplier_id_org_fk FOREIGN KEY (organization_id, supplier_id) REFERENCES public.supplier(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot
    ADD CONSTRAINT product_lot_warehouse_id_org_fk FOREIGN KEY (organization_id, warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint

-- promotion_service_price
ALTER TABLE ONLY public.promotion_service_price
    ADD CONSTRAINT promotion_service_price_promotion_id_org_fk FOREIGN KEY (organization_id, promotion_id) REFERENCES public.promotion(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.promotion_service_price
    ADD CONSTRAINT promotion_service_price_service_id_org_fk FOREIGN KEY (organization_id, service_id) REFERENCES public.service_catalog(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order_line
    ADD CONSTRAINT purchase_order_line_order_id_org_fk FOREIGN KEY (organization_id, order_id) REFERENCES public.purchase_order(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order_line
    ADD CONSTRAINT purchase_order_line_product_id_org_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order
    ADD CONSTRAINT purchase_order_supplier_id_org_fk FOREIGN KEY (organization_id, supplier_id) REFERENCES public.supplier(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order
    ADD CONSTRAINT purchase_order_warehouse_id_org_fk FOREIGN KEY (organization_id, warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement
    ADD CONSTRAINT stock_movement_dest_warehouse_id_org_fk FOREIGN KEY (organization_id, dest_warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement
    ADD CONSTRAINT stock_movement_lot_id_org_fk FOREIGN KEY (organization_id, lot_id) REFERENCES public.product_lot(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement
    ADD CONSTRAINT stock_movement_product_id_org_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement
    ADD CONSTRAINT stock_movement_purchase_order_id_org_fk FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_order(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement
    ADD CONSTRAINT stock_movement_warehouse_id_org_fk FOREIGN KEY (organization_id, warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint

-- task
ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_opportunity_org_fk FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunity(organization_id, id) ON DELETE SET NULL (opportunity_id);--> statement-breakpoint
ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES public.patient(organization_id, id);--> statement-breakpoint

-- treatment_budget_item
ALTER TABLE ONLY public.treatment_budget_item
    ADD CONSTRAINT treatment_budget_item_promotion_id_org_fk FOREIGN KEY (organization_id, promotion_id) REFERENCES public.promotion(organization_id, id);--> statement-breakpoint

-- 3. Vínculos compuestos (organización, id): ninguna fila de inventario apunta
-- a la sede, el proveedor, el almacén, el producto, el lote o la orden de otra
-- clínica, aunque el servicio lo pase por alto. Los vínculos simples de
-- `0000_base` siguen; estos los acotan a la misma organización.
--   (de la 0036 del 24-oct)
ALTER TABLE ONLY public.warehouse
    ADD CONSTRAINT warehouse_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Argos: las vistas del negocio (ADR 0075). Son de argos_dueno, sin
-- BYPASSRLS: ve solo la clínica de app.org_id, y lo que lee de cada tabla
-- está arriba, en sus permisos. Las llaves argos_* no leen tablas, solo las
-- vistas de su rol. Nada de texto libre (mensajes, notas, motivos escritos)
-- ni de historia clínica.
--   (de la 0064 del 24-oct)
-- ═════════════════════════════════════════════════════════════════════════
CREATE SCHEMA argos;--> statement-breakpoint
ALTER SCHEMA argos OWNER TO argos_dueno;--> statement-breakpoint

-- La base de las horas libres (sin llave: la leen las dos vistas de abajo). Como Reportes › Agenda:
-- el horario que valía cada día (o el de hoy antes del primero guardado), menos los bloqueos, y lo
-- que de eso ocuparon citas no canceladas. De 400 días atrás a 60 días adelante.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.agenda_base AS
 WITH pair AS (
         SELECT s.organization_id,
            s.branch_id,
            s.professional_user_id AS dentist_user_id,
            min(s.valid_from) AS first_day
           FROM public.professional_schedule s
          GROUP BY s.organization_id, s.branch_id, s.professional_user_id
        ), day AS (
         SELECT pr.organization_id,
            pr.branch_id,
            pr.dentist_user_id,
            pr.first_day,
            COALESCE(b.timezone, op.timezone, 'UTC'::text) AS tz,
            (d.d)::date AS dia
           FROM (((pair pr
             JOIN public.branch b ON (((b.organization_id = pr.organization_id) AND (b.id = pr.branch_id))))
             LEFT JOIN public.org_profile op ON ((op.organization_id = pr.organization_id)))
             CROSS JOIN LATERAL generate_series(((((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date - 400))::timestamp with time zone, ((((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date + 60))::timestamp with time zone, '1 day'::interval) d(d))
        ), sched AS (
         SELECT d.organization_id,
            d.branch_id,
            d.dentist_user_id,
            d.first_day,
            d.tz,
            d.dia,
            (d.dia < d.first_day) AS supuesto,
            ( SELECT range_agg(tstzrange(((d.dia + make_interval(mins => (s.start_min)::integer)) AT TIME ZONE d.tz), ((d.dia + make_interval(mins => (s.end_min)::integer)) AT TIME ZONE d.tz))) AS range_agg
                   FROM public.professional_schedule s
                  WHERE ((s.organization_id = d.organization_id) AND (s.branch_id = d.branch_id) AND (s.professional_user_id = d.dentist_user_id) AND (s.weekday = (EXTRACT(dow FROM d.dia))::integer) AND
                        CASE
                            WHEN (d.dia < d.first_day) THEN s.is_active
                            ELSE ((s.valid_from <= d.dia) AND ((s.valid_until IS NULL) OR (s.valid_until > d.dia)))
                        END)) AS programado
           FROM day d
        ), free AS (
         SELECT s.organization_id,
            s.branch_id,
            s.dentist_user_id,
            s.first_day,
            s.tz,
            s.dia,
            s.supuesto,
            s.programado,
            (s.programado - COALESCE(( SELECT range_agg(tstzrange(k.starts_at, k.ends_at)) AS range_agg
                   FROM public.schedule_block k
                  WHERE ((k.organization_id = s.organization_id) AND (k.branch_id = s.branch_id) AND ((k.professional_user_id = s.dentist_user_id) OR ((k.professional_user_id IS NULL) AND (k.room_id IS NULL))) AND (k.starts_at < upper(s.programado)) AND (k.ends_at > lower(s.programado)))), '{}'::tstzmultirange)) AS libre
           FROM sched s
          WHERE (s.programado IS NOT NULL)
        )
 SELECT organization_id,
    branch_id,
    dentist_user_id AS professional_user_id,
    tz,
    dia,
    supuesto,
    programado,
    libre,
    (libre * COALESCE(( SELECT range_agg(tstzrange(a.starts_at, a.ends_at)) AS range_agg
           FROM public.appointment a
          WHERE ((a.organization_id = f.organization_id) AND (a.branch_id = f.branch_id) AND (a.professional_user_id = f.dentist_user_id) AND (a.status <> 'cancelada'::text) AND (a.starts_at < upper(f.programado)) AND (a.ends_at > lower(f.programado)))), '{}'::tstzmultirange)) AS ocupado
   FROM free f;--> statement-breakpoint
ALTER VIEW argos.agenda_base OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.agenda_por_dia AS
 SELECT g.dia,
    (ARRAY['domingo'::text, 'lunes'::text, 'martes'::text, 'miércoles'::text, 'jueves'::text, 'viernes'::text, 'sábado'::text])[((EXTRACT(dow FROM g.dia))::integer + 1)] AS dia_semana,
    b.name AS sede,
    u.name AS profesional,
    round((COALESCE(( SELECT sum(EXTRACT(epoch FROM (upper(r.r) - lower(r.r)))) AS sum
           FROM unnest(g.programado) r(r)), (0)::numeric) / (60)::numeric)) AS minutos_horario,
    round((COALESCE(( SELECT sum(EXTRACT(epoch FROM (upper(r.r) - lower(r.r)))) AS sum
           FROM unnest(g.libre) r(r)), (0)::numeric) / (60)::numeric)) AS minutos_disponibles,
    round((COALESCE(( SELECT sum(EXTRACT(epoch FROM (upper(r.r) - lower(r.r)))) AS sum
           FROM unnest(g.ocupado) r(r)), (0)::numeric) / (60)::numeric)) AS minutos_ocupados,
    g.supuesto AS horario_supuesto
   FROM ((argos.agenda_base g
     JOIN public.branch b ON (((b.organization_id = g.organization_id) AND (b.id = g.branch_id))))
     LEFT JOIN auth."user" u ON ((u.id = g.professional_user_id)));--> statement-breakpoint
ALTER VIEW argos.agenda_por_dia OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.agenda_por_hora AS
 SELECT dia,
    dia_semana,
    hora,
    sede,
    profesional,
    minutos_disponibles,
    minutos_ocupados
   FROM ( SELECT g.dia,
            (ARRAY['domingo'::text, 'lunes'::text, 'martes'::text, 'miércoles'::text, 'jueves'::text, 'viernes'::text, 'sábado'::text])[((EXTRACT(dow FROM g.dia))::integer + 1)] AS dia_semana,
            h.h AS hora,
            b.name AS sede,
            u.name AS profesional,
            round((COALESCE(( SELECT sum(EXTRACT(epoch FROM (upper(r.r) - lower(r.r)))) AS sum
                   FROM unnest((g.libre * tstzmultirange(tstzrange(((g.dia + make_interval(hours => h.h)) AT TIME ZONE g.tz), ((g.dia + make_interval(hours => (h.h + 1))) AT TIME ZONE g.tz))))) r(r)), (0)::numeric) / (60)::numeric)) AS minutos_disponibles,
            round((COALESCE(( SELECT sum(EXTRACT(epoch FROM (upper(r.r) - lower(r.r)))) AS sum
                   FROM unnest((g.ocupado * tstzmultirange(tstzrange(((g.dia + make_interval(hours => h.h)) AT TIME ZONE g.tz), ((g.dia + make_interval(hours => (h.h + 1))) AT TIME ZONE g.tz))))) r(r)), (0)::numeric) / (60)::numeric)) AS minutos_ocupados
           FROM (((argos.agenda_base g
             JOIN public.branch b ON (((b.organization_id = g.organization_id) AND (b.id = g.branch_id))))
             LEFT JOIN auth."user" u ON ((u.id = g.professional_user_id)))
             CROSS JOIN generate_series(0, 23) h(h))) x
  WHERE (minutos_disponibles > (0)::numeric);--> statement-breakpoint
ALTER VIEW argos.agenda_por_hora OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.ausencias AS
 SELECT u.name AS profesional,
    b.name AS sede,
    k.starts_at AS desde,
    k.ends_at AS hasta,
    ((k.starts_at AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date AS primer_dia,
    (((k.ends_at - '00:00:01'::interval) AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date AS ultimo_dia
   FROM (((public.schedule_block k
     JOIN public.branch b ON (((b.organization_id = k.organization_id) AND (b.id = k.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = k.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = k.professional_user_id)))
  WHERE (k.kind = 'ausencia'::text);--> statement-breakpoint
ALTER VIEW argos.ausencias OWNER TO argos_dueno;--> statement-breakpoint

-- 4. Agenda.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.citas AS
 SELECT a.id AS cita_id,
    a.starts_at AS inicio,
    ((a.starts_at AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date AS dia,
    (ARRAY['domingo'::text, 'lunes'::text, 'martes'::text, 'miércoles'::text, 'jueves'::text, 'viernes'::text, 'sábado'::text])[((EXTRACT(dow FROM (a.starts_at AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text))))::integer + 1)] AS dia_semana,
    (EXTRACT(hour FROM (a.starts_at AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text))))::integer AS hora,
    b.name AS sede,
    u.name AS profesional,
    a.patient_id AS paciente_id,
    pp.display_name AS paciente,
    a.service_name AS servicio,
        CASE a.status
            WHEN 'no_asistio'::text THEN 'no_vino'::text
            ELSE a.status
        END AS estado,
    (a.ends_at < now()) AS ya_paso,
    a.duration_min AS duracion_min,
    a.arrived_at AS llego_en,
    e.started_at AS atencion_inicio,
        CASE
            WHEN ((a.arrived_at IS NOT NULL) AND (e.started_at >= a.arrived_at)) THEN round((EXTRACT(epoch FROM (e.started_at - a.arrived_at)) / (60)::numeric))
            ELSE NULL::numeric
        END AS espera_min,
    a.source AS origen,
    ch.name AS unidad_dental
   FROM (((((((public.appointment a
     JOIN public.patient p ON (((p.organization_id = a.organization_id) AND (p.id = a.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     JOIN public.branch b ON (((b.organization_id = a.organization_id) AND (b.id = a.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = a.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = a.professional_user_id)))
     LEFT JOIN public.schedule_room ch ON (((ch.organization_id = a.organization_id) AND (ch.id = a.room_id))))
     LEFT JOIN LATERAL ( SELECT x.started_at
           FROM public.encounter x
          WHERE ((x.organization_id = a.organization_id) AND (x.appointment_id = a.id) AND (x.status <> 'anulada'::text))
          ORDER BY x.started_at
         LIMIT 1) e ON (true));--> statement-breakpoint
ALTER VIEW argos.citas OWNER TO argos_dueno;--> statement-breakpoint

-- Cada movimiento de lo cobrado: sumar «importe» en un periodo da lo cobrado (pagos menos anulaciones y devoluciones del periodo).
--   (de la 0064 del 24-oct)
-- Impuestos de lo cobrado (ADR 0083) en las vistas de Argos, para que «lo que deja» cuadre con Reportes.
-- argos.cobros suma al final «impuesto»: la parte del importe que es impuesto (el IGV de un pago, su
-- anulación y la parte de una devolución). argos.gastos marca el pago de ese impuesto con su propio tipo:
-- no resta de lo que deja, porque ya salió de lo cobrado. Las columnas de antes no cambian.
--   (de la 0090 del 24-oct)
CREATE VIEW argos.cobros AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.tipo, round(x.cents / 100.0, 2) AS importe,
  x.medio, b.name AS sede, pp.display_name AS paciente, x.patient_id AS paciente_id, round(x.tax_cents / 100.0, 2) AS impuesto
FROM (
  SELECT pay.organization_id, pay.paid_at AS momento, 'pago' AS tipo, pay.amount_cents AS cents, pay.method_name AS medio, pay.branch_id, pay.patient_id,
    pay.tax_cents
  FROM public.patient_payment pay
  UNION ALL
  SELECT pay.organization_id, pay.voided_at, 'anulacion', -pay.amount_cents, pay.method_name, pay.branch_id, pay.patient_id, -pay.tax_cents
  FROM public.patient_payment pay WHERE pay.voided_at IS NOT NULL
  UNION ALL
  SELECT r.organization_id, r.refunded_at, 'devolucion', -r.amount_cents, pay.method_name, pay.branch_id, r.patient_id, -r.tax_cents
  FROM public.patient_payment_refund r JOIN public.patient_payment pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
) x
JOIN public.patient p ON p.organization_id = x.organization_id AND p.id = x.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;--> statement-breakpoint
ALTER VIEW argos.cobros OWNER TO argos_dueno;--> statement-breakpoint

-- Comisiones, como Finanzas › Comisiones: cada cobro de lo que atendió un profesional con su porcentaje; lo pagado, como se pagó.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.comisiones AS
 WITH live_app AS (
         SELECT a.id,
            a.organization_id,
            (a.amount_cents)::bigint AS cents,
            a.created_at AS at,
            e.professional_user_id AS user_id,
            p.branch_id
           FROM ((((public.patient_payment_application a
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id))))
             JOIN public.encounter_procedure ep ON (((ep.organization_id = a.organization_id) AND (ep.id = c.encounter_procedure_id))))
             JOIN public.encounter e ON (((e.organization_id = a.organization_id) AND (e.id = ep.encounter_id))))
          WHERE ((a.voided_at IS NULL) AND (p.voided_at IS NULL) AND (c.voided_at IS NULL) AND (ep.voided_at IS NULL) AND (e.status = 'finalizada'::text) AND (e.voided_at IS NULL))
        ), frozen AS (
         SELECT l_1.application_id,
            l_1.organization_id,
            (l_1.base_cents)::bigint AS base,
            (l_1.commission_cents)::bigint AS commission,
            l_1.occurred_at AS at,
            s.professional_user_id AS user_id,
            ((a.voided_at IS NULL) AND (p.voided_at IS NULL) AND (c.voided_at IS NULL)) AS live,
            p.branch_id
           FROM ((((public.commission_settlement_line l_1
             JOIN public.commission_settlement s ON (((s.organization_id = l_1.organization_id) AND (s.id = l_1.settlement_id) AND (s.voided_at IS NULL))))
             JOIN public.patient_payment_application a ON (((a.organization_id = l_1.organization_id) AND (a.id = l_1.application_id))))
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id))))
          WHERE ((l_1.kind = 'cobro'::text) AND (l_1.voided_at IS NULL))
        ), line AS (
         SELECT f.organization_id,
            f.user_id,
            f.at,
                CASE
                    WHEN f.live THEN f.base
                    ELSE (0)::bigint
                END AS base,
                CASE
                    WHEN f.live THEN f.commission
                    ELSE (0)::bigint
                END AS commission,
            f.commission AS paid,
            (0)::bigint AS fresh,
            f.branch_id
           FROM frozen f
        UNION ALL
         SELECT la.organization_id,
            la.user_id,
            la.at,
            la.cents,
            ((la.cents * COALESCE(r.rate_bps, 0)) / 10000),
            0,
            ((la.cents * COALESCE(r.rate_bps, 0)) / 10000),
            la.branch_id
           FROM (live_app la
             LEFT JOIN public.commission_rule r ON (((r.organization_id = la.organization_id) AND (r.professional_user_id = la.user_id))))
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM frozen f
                  WHERE ((f.organization_id = la.organization_id) AND (f.application_id = la.id)))))
        )
 SELECT l.at AS momento,
    ((l.at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    u.name AS profesional,
    b.name AS sede,
    round(((l.base)::numeric / 100.0), 2) AS base,
    round(((l.commission)::numeric / 100.0), 2) AS comision,
    round(((l.paid)::numeric / 100.0), 2) AS pagado,
    round(((l.fresh)::numeric / 100.0), 2) AS sin_pagar
   FROM (((line l
     JOIN auth."user" u ON ((u.id = l.user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = l.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = l.organization_id) AND (b.id = l.branch_id))))
  WHERE (EXISTS ( SELECT 1
           FROM public.member m
          WHERE ((m.organization_id = l.organization_id) AND (m.user_id = l.user_id))));--> statement-breakpoint
ALTER VIEW argos.comisiones OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.compras AS
 SELECT po.order_number AS numero,
    s.name AS proveedor,
    b.name AS sede,
    po.status AS estado,
    po.created_at AS creada_en,
    ((po.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    round(((COALESCE(( SELECT sum((l.quantity * l.unit_cost_cents)) AS sum
           FROM public.purchase_order_line l
          WHERE ((l.organization_id = po.organization_id) AND (l.order_id = po.id))), (0)::bigint))::numeric / 100.0), 2) AS total,
    round(((COALESCE(( SELECT sum((l.received_quantity * l.unit_cost_cents)) AS sum
           FROM public.purchase_order_line l
          WHERE ((l.organization_id = po.organization_id) AND (l.order_id = po.id))), (0)::bigint))::numeric / 100.0), 2) AS recibido,
    round(((COALESCE(( SELECT sum(e.amount_cents) AS sum
           FROM public.expense e
          WHERE ((e.organization_id = po.organization_id) AND (e.purchase_order_id = po.id) AND (e.voided_at IS NULL))), (0)::bigint))::numeric / 100.0), 2) AS pagado
   FROM ((((public.purchase_order po
     JOIN public.supplier s ON (((s.organization_id = po.organization_id) AND (s.id = po.supplier_id))))
     JOIN public.warehouse w ON (((w.organization_id = po.organization_id) AND (w.id = po.warehouse_id))))
     JOIN public.branch b ON (((b.organization_id = w.organization_id) AND (b.id = w.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = po.organization_id)));--> statement-breakpoint
ALTER VIEW argos.compras OWNER TO argos_dueno;--> statement-breakpoint

-- Argos (ADR 0075 y 0078): dos datos que ya están en odentIA y las vistas no mostraban.
-- El detalle de cada orden de compra (qué producto, cuánto, a qué precio y a qué proveedor): solo quien dirige la clínica,
-- como las compras; recepción ve el inventario sin precios.
-- Si una conversación espera respuesta de la clínica: su último mensaje es de la persona. Solo la dirección del mensaje,
-- nunca su texto.
-- Las columnas nuevas van al final: una vista se reemplaza sin cambiar sus columnas de antes.
--   (de la 0070 del 24-oct)
CREATE VIEW argos.compras_detalle AS
 SELECT po.order_number AS numero,
    s.name AS proveedor,
    b.name AS sede,
    po.status AS estado,
    po.created_at AS creada_en,
    ((po.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    pr.name AS producto,
    pr.unit AS unidad,
    l.quantity AS cantidad,
    l.received_quantity AS recibida,
    round(((l.unit_cost_cents)::numeric / 100.0), 2) AS precio,
    round((((l.quantity * l.unit_cost_cents))::numeric / 100.0), 2) AS total
   FROM ((((((public.purchase_order_line l
     JOIN public.purchase_order po ON (((po.organization_id = l.organization_id) AND (po.id = l.order_id))))
     JOIN public.product pr ON (((pr.organization_id = l.organization_id) AND (pr.id = l.product_id))))
     JOIN public.supplier s ON (((s.organization_id = po.organization_id) AND (s.id = po.supplier_id))))
     JOIN public.warehouse w ON (((w.organization_id = po.organization_id) AND (w.id = po.warehouse_id))))
     JOIN public.branch b ON (((b.organization_id = w.organization_id) AND (b.id = w.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = po.organization_id)));--> statement-breakpoint
ALTER VIEW argos.compras_detalle OWNER TO argos_dueno;--> statement-breakpoint

-- Controles: cuándo vencen y si ya tienen cita (sin el texto de las indicaciones).
--   (de la 0064 del 24-oct)
CREATE VIEW argos.controles AS
 SELECT pp.display_name AS paciente,
    f.patient_id AS paciente_id,
    f.kind AS tipo,
    f.due_at AS vence_en,
    ((f.due_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS vence_dia,
    f.status AS estado,
    (f.appointment_id IS NOT NULL) AS tiene_cita,
    f.completed_at AS hecho_en
   FROM (((public.clinical_follow_up f
     JOIN public.patient p ON (((p.organization_id = f.organization_id) AND (p.id = f.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = f.organization_id)));--> statement-breakpoint
ALTER VIEW argos.controles OWNER TO argos_dueno;--> statement-breakpoint

-- 8. Relación con las personas: conversaciones, oportunidades y tareas (sin mensajes ni notas).
--   (de la 0064 del 24-oct)
CREATE VIEW argos.conversaciones AS
 SELECT c.created_at AS inicio,
    ((c.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    cc.channel AS canal,
    c.status AS estado,
    c.close_reason AS motivo_cierre,
    c.closed_at AS cerrada_en,
    c.last_message_at AS ultimo_mensaje_en,
    pp.display_name AS persona,
    c.contact_id AS persona_id,
    ( SELECT p.id
           FROM public.patient p
          WHERE ((p.organization_id = c.organization_id) AND (p.person_id = c.contact_id))
         LIMIT 1) AS paciente_id,
    (EXISTS ( SELECT 1
           FROM public.patient p
          WHERE ((p.organization_id = c.organization_id) AND (p.person_id = c.contact_id)))) AS es_paciente,
    c.agent_status AS agente,
    u.name AS asignada_a,
    COALESCE(( SELECT (m.direction = 'in'::text)
           FROM public.message m
          WHERE ((m.organization_id = c.organization_id) AND (m.conversation_id = c.id))
          ORDER BY m.created_at DESC
         LIMIT 1), false) AS espera_respuesta
   FROM ((((public.conversation c
     JOIN public.contact pp ON (((pp.organization_id = c.organization_id) AND (pp.id = c.contact_id))))
     LEFT JOIN public.channel_connection cc ON (((cc.organization_id = c.organization_id) AND (cc.id = c.channel_connection_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = c.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = c.assigned_user_id)))
  WHERE (pp.screen IS NULL);--> statement-breakpoint
ALTER VIEW argos.conversaciones OWNER TO argos_dueno;--> statement-breakpoint

-- Lo que debe cada paciente, a hoy: lo cargado sin pagar menos lo que tiene a favor. Su deuda está
-- vencida si su concepto más antiguo sin pagar tiene más de 30 días (la regla de «Te deben hace más de 30 días»).
--   (de la 0064 del 24-oct)
CREATE VIEW argos.deudas AS
 WITH charge AS (
         SELECT c.organization_id,
            c.patient_id,
            c.created_at,
            (c.amount_cents - COALESCE(( SELECT sum(a.amount_cents) AS sum
                   FROM (public.patient_payment_application a
                     JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
                  WHERE ((a.organization_id = c.organization_id) AND (a.charge_id = c.id) AND (a.voided_at IS NULL))), (0)::bigint)) AS unpaid
           FROM public.patient_charge c
          WHERE (c.voided_at IS NULL)
        ), credit AS (
         SELECT pay.organization_id,
            pay.patient_id,
            (((sum(pay.amount_cents))::numeric - COALESCE(sum(( SELECT sum(a.amount_cents) AS sum
                   FROM public.patient_payment_application a
                  WHERE ((a.organization_id = pay.organization_id) AND (a.payment_id = pay.id) AND (a.voided_at IS NULL)))), (0)::numeric)) - COALESCE(sum(( SELECT sum(r.amount_cents) AS sum
                   FROM public.patient_payment_refund r
                  WHERE ((r.organization_id = pay.organization_id) AND (r.payment_id = pay.id)))), (0)::numeric)) AS cents
           FROM public.patient_payment pay
          WHERE (pay.voided_at IS NULL)
          GROUP BY pay.organization_id, pay.patient_id
        ), owed AS (
         SELECT ch.organization_id,
            ch.patient_id,
            sum(ch.unpaid) FILTER (WHERE (ch.unpaid > 0)) AS unpaid,
            min(ch.created_at) FILTER (WHERE (ch.unpaid > 0)) AS since
           FROM charge ch
          GROUP BY ch.organization_id, ch.patient_id
        )
 SELECT o.patient_id AS paciente_id,
    pp.display_name AS paciente,
    round((o.unpaid / 100.0), 2) AS debe,
    round((GREATEST(COALESCE(cr.cents, (0)::numeric), (0)::numeric) / 100.0), 2) AS a_favor,
    round((GREATEST((o.unpaid - GREATEST(COALESCE(cr.cents, (0)::numeric), (0)::numeric)), (0)::numeric) / 100.0), 2) AS saldo,
    (o.since < (now() - '30 days'::interval)) AS vencida,
    ((o.since AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS desde,
    ((now())::date - (o.since)::date) AS dias
   FROM ((((owed o
     JOIN public.patient p ON (((p.organization_id = o.organization_id) AND (p.id = o.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN credit cr ON (((cr.organization_id = o.organization_id) AND (cr.patient_id = o.patient_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = o.organization_id)))
  WHERE (o.unpaid > GREATEST(COALESCE(cr.cents, (0)::numeric), (0)::numeric));--> statement-breakpoint
ALTER VIEW argos.deudas OWNER TO argos_dueno;--> statement-breakpoint

-- El embudo de Reportes (report-patients.ts, `firstContactSql` y `funnelSql`): el primer contacto de cada persona
-- (su primer mensaje entrante, el de quien escribió por ella y la registró en los 30 días anteriores, o su registro)
-- y hasta dónde llegó desde entonces. Quien aún no es paciente y escribe por un paciente no se cuenta otra vez.
--   (de la 0064 del 24-oct)
-- El embudo de Argos cuenta la consulta cobrada en latidIA (issue 229, decisión 15), como Reportes
-- (`funnelSql` con `budgetRequired` falso): allí lo indicado queda aceptado al indicarlo y no hay
-- presupuesto que aceptar, así que «pago» es vino y pagó algo. En odentIA no cambia: aceptó y pagó algo.
-- Las columnas son las mismas, en el mismo orden.
--   (de la 0100 del 24-oct)
CREATE VIEW argos.embudo AS
 WITH first_inbound AS (
         SELECT DISTINCT ON (c.organization_id, c.contact_id) c.organization_id,
            c.contact_id,
            fi.created_at AS at,
            cc.channel
           FROM ((public.conversation c
             JOIN LATERAL ( SELECT m.created_at
                   FROM public.message m
                  WHERE ((m.organization_id = c.organization_id) AND (m.conversation_id = c.id) AND (m.direction = 'in'::text))
                  ORDER BY m.created_at, m.id
                 LIMIT 1) fi ON (true))
             LEFT JOIN public.channel_connection cc ON (((cc.organization_id = c.organization_id) AND (cc.id = c.channel_connection_id))))
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM public.contact s
                  WHERE ((s.organization_id = c.organization_id) AND (s.id = c.contact_id) AND (s.screen IS NOT NULL)))))
          ORDER BY c.organization_id, c.contact_id, fi.created_at, c.id
        ), registered AS (
         SELECT p.organization_id,
            p.id AS patient_id,
            p.person_id,
            p.created_at,
            r_1.conversation_id,
            NULLIF(COALESCE(r_1.context_contact_id, rc.contact_id), p.person_id) AS writer_id,
                CASE
                    WHEN ((r_1.entry_point = ANY (ARRAY['public_link'::text, 'qr'::text])) OR ((r_1.entry_point = 'conversation'::text) AND (r_1.actor_user_id IS NULL))) THEN 'registro_en_linea'::text
                    ELSE 'recepcion'::text
                END AS registered_via
           FROM ((public.patient p
             LEFT JOIN public.patient_registration r_1 ON (((r_1.organization_id = p.organization_id) AND (r_1.patient_id = p.id))))
             LEFT JOIN public.conversation rc ON (((rc.organization_id = r_1.organization_id) AND (rc.id = r_1.conversation_id))))
        ), first_contact AS (
         SELECT g.organization_id,
            g.person_id,
            g.patient_id,
            k.at AS first_at,
            k.channel
           FROM (((registered g
             LEFT JOIN first_inbound own ON (((own.organization_id = g.organization_id) AND (own.contact_id = g.person_id))))
             LEFT JOIN LATERAL ( SELECT m.created_at AS at,
                    wcc.channel
                   FROM ((public.message m
                     JOIN public.conversation wc ON (((wc.organization_id = m.organization_id) AND (wc.id = m.conversation_id))))
                     LEFT JOIN public.channel_connection wcc ON (((wcc.organization_id = wc.organization_id) AND (wcc.id = wc.channel_connection_id))))
                  WHERE ((g.writer_id IS NOT NULL) AND (m.organization_id = g.organization_id) AND (m.conversation_id = g.conversation_id) AND (m.direction = 'in'::text) AND (m.created_at <= g.created_at) AND (m.created_at > (g.created_at - make_interval(days => 30))) AND (NOT (EXISTS ( SELECT 1
                           FROM public.contact s
                          WHERE ((s.organization_id = wc.organization_id) AND (s.id = wc.contact_id) AND (s.screen IS NOT NULL))))))
                  ORDER BY m.created_at, m.id
                 LIMIT 1) w ON (true))
             CROSS JOIN LATERAL ( SELECT x.at,
                    x.channel
                   FROM ( VALUES (own.at,own.channel,0), (w.at,w.channel,1), (g.created_at,g.registered_via,2)) x(at, channel, rank)
                  WHERE (x.at IS NOT NULL)
                  ORDER BY x.at, x.rank
                 LIMIT 1) k)
        UNION ALL
         SELECT i.organization_id,
            i.contact_id,
            NULL::uuid AS uuid,
            i.at,
            i.channel
           FROM first_inbound i
          WHERE ((NOT (EXISTS ( SELECT 1
                   FROM public.patient p
                  WHERE ((p.organization_id = i.organization_id) AND (p.person_id = i.contact_id))))) AND (NOT (EXISTS ( SELECT 1
                   FROM public.patient_contact v
                  WHERE ((v.organization_id = i.organization_id) AND (v.contact_id = i.contact_id) AND (v.relationship <> 'self'::text))))) AND (NOT (EXISTS ( SELECT 1
                   FROM registered g
                  WHERE ((g.organization_id = i.organization_id) AND (g.writer_id = i.contact_id))))))
        ), reached AS (
         SELECT k.organization_id,
            k.person_id,
            k.patient_id,
            k.first_at,
            k.channel,
            (EXISTS ( SELECT 1
                   FROM public.appointment a
                  WHERE ((a.organization_id = k.organization_id) AND (a.patient_id = k.patient_id) AND (a.created_at >= k.first_at) AND (a.status <> 'cancelada'::text)))) AS booked,
            ((EXISTS ( SELECT 1
                   FROM public.appointment a
                  WHERE ((a.organization_id = k.organization_id) AND (a.patient_id = k.patient_id) AND (a.created_at >= k.first_at) AND (a.status = 'atendida'::text)))) OR (EXISTS ( SELECT 1
                   FROM public.encounter e
                  WHERE ((e.organization_id = k.organization_id) AND (e.patient_id = k.patient_id) AND (e.status = 'finalizada'::text) AND (e.finalized_at >= k.first_at))))) AS came,
            (EXISTS ( SELECT 1
                   FROM public.treatment_budget b
                  WHERE ((b.organization_id = k.organization_id) AND (b.patient_id = k.patient_id) AND (b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text, 'presentado'::text, 'pospuesto'::text, 'rechazado'::text])) AND (b.presented_at >= k.first_at)))) AS budget,
            (EXISTS ( SELECT 1
                   FROM public.treatment_budget b
                  WHERE ((b.organization_id = k.organization_id) AND (b.patient_id = k.patient_id) AND (b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text])) AND (b.presented_at >= k.first_at)))) AS accepted,
            (EXISTS ( SELECT 1
                   FROM public.patient_payment y
                  WHERE ((y.organization_id = k.organization_id) AND (y.patient_id = k.patient_id) AND (y.voided_at IS NULL) AND (y.paid_at >= k.first_at)))) AS paid
           FROM first_contact k
        )
 SELECT r.first_at AS primer_contacto_en,
    ((r.first_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    r.channel AS canal,
    pp.display_name AS persona,
    r.person_id AS persona_id,
    r.patient_id AS paciente_id,
    (r.booked OR r.came OR r.budget) AS agendo,
    (r.came OR r.budget) AS vino,
    r.budget AS recibio_presupuesto,
    r.accepted AS acepto,
        CASE
            WHEN (op.product = 'medical'::text) THEN ((r.came OR r.budget) AND r.paid)
            ELSE (r.accepted AND r.paid)
        END AS pago
   FROM ((reached r
     JOIN public.contact pp ON (((pp.organization_id = r.organization_id) AND (pp.id = r.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = r.organization_id)));--> statement-breakpoint
ALTER VIEW argos.embudo OWNER TO argos_dueno;--> statement-breakpoint

-- El rol de quien atiende, en la vista del equipo de Argos, es el del producto (issue 229, entrega 9):
-- «odontología» en odentIA y «medicina» en latidIA. Las columnas son las mismas, en el mismo orden.
--   (de la 0102 del 24-oct)
CREATE VIEW argos.equipo AS
 SELECT u.name AS profesional,
    array_to_string(ARRAY( SELECT
                CASE TRIM(BOTH FROM r.r)
                    WHEN 'owner'::text THEN 'propietario'::text
                    WHEN 'admin'::text THEN 'administración'::text
                    WHEN 'clinician'::text THEN
                    CASE
                        WHEN (op.product = 'medical'::text) THEN 'medicina'::text
                        ELSE 'odontología'::text
                    END
                    WHEN 'reception'::text THEN 'recepción'::text
                    WHEN 'cashier'::text THEN 'caja'::text
                    ELSE 'otro'::text
                END AS "case"
           FROM unnest(string_to_array(m.role, ','::text)) r(r)), ', '::text) AS rol,
    ( SELECT string_agg(s.name, ', '::text ORDER BY s.name) AS string_agg
           FROM (public.professional_specialty ps
             JOIN public.org_specialty s ON (((s.organization_id = ps.organization_id) AND (s.id = ps.specialty_id))))
          WHERE ((ps.organization_id = m.organization_id) AND (ps.user_id = m.user_id))) AS especialidades,
    ((EXISTS ( SELECT 1
           FROM public.professional_schedule s
          WHERE ((s.organization_id = m.organization_id) AND (s.professional_user_id = m.user_id)))) OR (EXISTS ( SELECT 1
           FROM public.appointment a
          WHERE ((a.organization_id = m.organization_id) AND (a.professional_user_id = m.user_id))))) AS atiende
   FROM ((public.member m
     JOIN auth."user" u ON ((u.id = m.user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = m.organization_id)))
  WHERE (m.organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text));--> statement-breakpoint
ALTER VIEW argos.equipo OWNER TO argos_dueno;--> statement-breakpoint

-- Gastos registrados, como movimientos: el gasto en su fecha y su anulación en la suya.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.gastos AS
 SELECT x.momento,
    ((x.momento AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    x.categoria,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM public.commission_settlement s
              WHERE ((s.organization_id = x.organization_id) AND (s.expense_id = x.id)))) THEN 'pago_de_comisiones'::text
            WHEN (x.purchase_order_id IS NOT NULL) THEN 'pago_de_compra'::text
            WHEN x.sales_tax THEN 'pago_del_impuesto_de_lo_cobrado'::text
            ELSE 'gasto'::text
        END AS tipo,
    round(((x.cents)::numeric / 100.0), 2) AS monto,
    b.name AS sede
   FROM ((( SELECT e.organization_id,
            e.id,
            e.spent_at AS momento,
            e.category AS categoria,
            e.amount_cents AS cents,
            e.branch_id,
            e.purchase_order_id,
            e.sales_tax
           FROM public.expense e
        UNION ALL
         SELECT e.organization_id,
            e.id,
            e.voided_at,
            e.category,
            (- e.amount_cents),
            e.branch_id,
            e.purchase_order_id,
            e.sales_tax
           FROM public.expense e
          WHERE (e.voided_at IS NOT NULL)) x
     LEFT JOIN public.org_profile op ON ((op.organization_id = x.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = x.organization_id) AND (b.id = x.branch_id))));--> statement-breakpoint
ALTER VIEW argos.gastos OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.inventario AS
 SELECT pr.name AS producto,
    pr.unit AS unidad,
    b.name AS sede,
    (COALESCE(lot.hay, 0) - COALESCE(sh.falta, 0)) AS hay,
    COALESCE(m.min_quantity, 0) AS minimo,
        CASE
            WHEN (COALESCE(sh.falta, 0) > 0) THEN 'faltante'::text
            WHEN ((COALESCE(m.min_quantity, 0) > 0) AND (COALESCE(lot.hay, 0) <= 0)) THEN 'no_hay'::text
            WHEN (COALESCE(lot.hay, 0) < COALESCE(m.min_quantity, 0)) THEN 'hace_falta'::text
            ELSE 'ok'::text
        END AS estado,
    ((COALESCE(sh.falta, 0) > 0) OR (COALESCE(lot.hay, 0) < COALESCE(m.min_quantity, 0))) AS hay_que_reponer,
    COALESCE(lot.por_vencer, 0) AS cantidad_por_vencer,
    lot.vence_primero,
    COALESCE(lot.vencido, 0) AS cantidad_vencida,
    pr.used_in_care AS insumo,
    pr.for_sale AS se_vende
   FROM (((((public.product pr
     JOIN public.branch b ON (((b.organization_id = pr.organization_id) AND b.is_active AND (EXISTS ( SELECT 1
           FROM public.warehouse wh
          WHERE ((wh.organization_id = b.organization_id) AND (wh.branch_id = b.id)))))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = pr.organization_id)))
     LEFT JOIN LATERAL ( SELECT (sum(l.quantity_on_hand))::integer AS hay,
            (sum(l.quantity_on_hand) FILTER (WHERE ((l.expires_at >= ((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date) AND (l.expires_at <= (((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date + 30)))))::integer AS por_vencer,
            (sum(l.quantity_on_hand) FILTER (WHERE (l.expires_at < ((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date)))::integer AS vencido,
            min(l.expires_at) FILTER (WHERE ((l.quantity_on_hand > 0) AND (l.expires_at >= ((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date))) AS vence_primero
           FROM (public.product_lot l
             JOIN public.warehouse w ON (((w.organization_id = l.organization_id) AND (w.id = l.warehouse_id))))
          WHERE ((l.organization_id = pr.organization_id) AND (l.product_id = pr.id) AND (w.branch_id = b.id))) lot ON (true))
     LEFT JOIN LATERAL ( SELECT (sum(s.quantity))::integer AS falta
           FROM (public.stock_shortage s
             JOIN public.warehouse w ON (((w.organization_id = s.organization_id) AND (w.id = s.warehouse_id))))
          WHERE ((s.organization_id = pr.organization_id) AND (s.product_id = pr.id) AND (w.branch_id = b.id))) sh ON (true))
     LEFT JOIN public.product_minimum m ON (((m.organization_id = pr.organization_id) AND (m.product_id = pr.id) AND (m.branch_id = b.id))))
  WHERE pr.is_active;--> statement-breakpoint
ALTER VIEW argos.inventario OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.lineas_presupuesto AS
 SELECT b.id AS presupuesto_id,
    b.budget_number AS numero,
    pp.display_name AS paciente,
    b.patient_id AS paciente_id,
    b.presented_at AS presentado_en,
    ((b.presented_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS presentado_dia,
    b.status AS estado_presupuesto,
    COALESCE(s.name, i.title) AS tratamiento,
    i.decision,
    round((((i.price_cents *
        CASE
            WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
            ELSE 1
        END))::numeric / 100.0), 2) AS importe,
    i.promotion_name AS promocion,
    pi.status AS estado_tratamiento
   FROM ((((((public.treatment_budget b
     JOIN public.treatment_budget_item i ON (((i.organization_id = b.organization_id) AND (i.budget_id = b.id) AND (i.option_id = ( SELECT o.id
           FROM public.treatment_budget_option o
          WHERE ((o.organization_id = b.organization_id) AND (o.budget_id = b.id))
          ORDER BY (o.decision = 'elegida'::text) DESC, o.is_recommended DESC, o."position"
         LIMIT 1)))))
     JOIN public.patient p ON (((p.organization_id = b.organization_id) AND (p.id = b.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = b.organization_id)))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = i.organization_id) AND (s.id = i.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = i.organization_id) AND (pi.id = i.plan_item_id))))
  WHERE ((b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL));--> statement-breakpoint
ALTER VIEW argos.lineas_presupuesto OWNER TO argos_dueno;--> statement-breakpoint

-- 7. Inventario y compras (sin costos para quien no ve precios: estas vistas no los traen; las compras sí, y son de gestión).
--   (de la 0064 del 24-oct)
CREATE VIEW argos.lotes AS
 SELECT pr.name AS producto,
    pr.unit AS unidad,
    b.name AS sede,
    l.code AS lote,
    l.expires_at AS vence,
    l.quantity_on_hand AS cantidad,
        CASE
            WHEN (l.expires_at IS NULL) THEN 'sin_vencimiento'::text
            WHEN (l.expires_at < ((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date) THEN 'vencido'::text
            WHEN (l.expires_at <= (((now() AT TIME ZONE COALESCE(b.timezone, op.timezone, 'UTC'::text)))::date + 30)) THEN 'por_vencer'::text
            ELSE 'vigente'::text
        END AS estado
   FROM ((((public.product_lot l
     JOIN public.product pr ON (((pr.organization_id = l.organization_id) AND (pr.id = l.product_id))))
     JOIN public.warehouse w ON (((w.organization_id = l.organization_id) AND (w.id = l.warehouse_id))))
     JOIN public.branch b ON (((b.organization_id = w.organization_id) AND (b.id = w.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = l.organization_id)))
  WHERE (l.quantity_on_hand > 0);--> statement-breakpoint
ALTER VIEW argos.lotes OWNER TO argos_dueno;--> statement-breakpoint

-- Lo que entró y salió: uso en atenciones (consumo), venta, compra, ajuste, traslado, devolución.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.movimientos_inventario AS
 SELECT m.created_at AS fecha,
    ((m.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    m.kind AS tipo,
    pr.name AS producto,
    pr.unit AS unidad,
    m.quantity_delta AS cantidad,
    b.name AS sede,
    u.name AS profesional,
    pp.display_name AS paciente,
    pr.used_in_care AS insumo,
    pr.for_sale AS se_vende
   FROM ((((((((public.stock_movement m
     JOIN public.product pr ON (((pr.organization_id = m.organization_id) AND (pr.id = m.product_id))))
     JOIN public.warehouse w ON (((w.organization_id = m.organization_id) AND (w.id = m.warehouse_id))))
     JOIN public.branch b ON (((b.organization_id = w.organization_id) AND (b.id = w.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = m.organization_id)))
     LEFT JOIN public.encounter e ON (((e.organization_id = m.organization_id) AND (e.id = m.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.patient p ON (((p.organization_id = m.organization_id) AND (p.id = m.patient_id))))
     LEFT JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))));--> statement-breakpoint
ALTER VIEW argos.movimientos_inventario OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.oportunidades AS
 SELECT o.created_at AS creada_en,
    ((o.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    st.name AS etapa,
    st.moment AS momento,
    o.status AS estado,
    s.name AS servicio,
    round(((o.amount_cents)::numeric / 100.0), 2) AS valor,
    o.closed_at AS cerrada_en,
    o.close_reason AS motivo_cierre,
    pp.display_name AS persona,
    o.contact_id AS persona_id,
    ( SELECT p.id
           FROM public.patient p
          WHERE ((p.organization_id = o.organization_id) AND (p.person_id = o.contact_id))
         LIMIT 1) AS paciente_id,
    u.name AS responsable
   FROM (((((public.opportunity o
     JOIN public.contact pp ON (((pp.organization_id = o.organization_id) AND (pp.id = o.contact_id))))
     LEFT JOIN public.pipeline_stage st ON (((st.organization_id = o.organization_id) AND (st.id = o.stage_id))))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = o.organization_id) AND (s.id = o.service_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = o.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = o.assigned_user_id)))
  WHERE (pp.screen IS NULL);--> statement-breakpoint
ALTER VIEW argos.oportunidades OWNER TO argos_dueno;--> statement-breakpoint

-- 5. Pacientes y tratamientos.
--   (de la 0064 del 24-oct)
-- Argos (ADR 0075): lo que faltaba para contar como Reportes.
-- «Sin venir» y «no ha vuelto en N meses» comparan la hora de la última cita atendida (ultima_atencion_en), no solo su día;
-- el inventario dice qué es insumo (se usa en las atenciones) y qué se vende: un producto puede ser las dos cosas.
-- Las columnas van al final: una vista se reemplaza sin cambiar sus columnas de antes.
--   (de la 0068 del 24-oct)
CREATE VIEW argos.pacientes AS
 SELECT p.id AS paciente_id,
    pp.display_name AS nombre,
    (NOT pp.is_active) AS archivado,
    v.primera_atencion,
    v.ultima_atencion,
    COALESCE(v.atenciones, 0) AS atenciones,
    ( SELECT min(n.starts_at) AS min
           FROM public.appointment n
          WHERE ((n.organization_id = p.organization_id) AND (n.patient_id = p.id) AND (n.starts_at > now()) AND (n.status = ANY (ARRAY['programada'::text, 'confirmada'::text])))) AS proxima_cita,
        CASE p.referral_kind
            WHEN 'recomendacion'::text THEN 'Recomendación de alguien'::text
            WHEN 'redes_sociales'::text THEN 'Redes sociales'::text
            WHEN 'google_mapas'::text THEN 'Google o mapas'::text
            WHEN 'paso_por_aqui'::text THEN 'Pasaba por aquí'::text
            WHEN 'convenio'::text THEN 'Convenio o empresa'::text
            WHEN 'otro'::text THEN 'Otro'::text
            ELSE 'No lo dijo'::text
        END AS como_nos_conocio,
    (EXISTS ( SELECT 1
           FROM public.treatment_budget b
          WHERE ((b.organization_id = p.organization_id) AND (b.patient_id = p.id) AND ((b.status = ANY (ARRAY['presentado'::text, 'pospuesto'::text])) OR ((b.status = 'parcial'::text) AND (EXISTS ( SELECT 1
                   FROM public.treatment_budget_item i
                  WHERE ((i.organization_id = b.organization_id) AND (i.budget_id = b.id) AND (i.decision = 'pospuesto'::text))))))))) AS presupuesto_esperando,
    (EXISTS ( SELECT 1
           FROM public.clinical_follow_up f_1
          WHERE ((f_1.organization_id = p.organization_id) AND (f_1.patient_id = p.id) AND (f_1.status = ANY (ARRAY['pendiente'::text, 'programado'::text]))))) AS control_pendiente,
    p.created_at AS registrado_en,
    v.ultima_atencion_en,
    f.primera_atencion_en,
    f.primera_sede
   FROM ((((public.patient p
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = p.organization_id)))
     LEFT JOIN LATERAL ( SELECT min(((a.starts_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date) AS primera_atencion,
            max(((a.starts_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date) AS ultima_atencion,
            (count(*))::integer AS atenciones,
            max(a.starts_at) AS ultima_atencion_en
           FROM public.appointment a
          WHERE ((a.organization_id = p.organization_id) AND (a.patient_id = p.id) AND (a.status = 'atendida'::text))) v ON (true))
     LEFT JOIN LATERAL ( SELECT a.starts_at AS primera_atencion_en,
            b.name AS primera_sede
           FROM (public.appointment a
             JOIN public.branch b ON (((b.organization_id = a.organization_id) AND (b.id = a.branch_id))))
          WHERE ((a.organization_id = p.organization_id) AND (a.patient_id = p.id) AND (a.status = 'atendida'::text))
          ORDER BY a.starts_at, a.id
         LIMIT 1) f ON (true))
  WHERE (pp.screen IS NULL);--> statement-breakpoint
ALTER VIEW argos.pacientes OWNER TO argos_dueno;--> statement-breakpoint

-- Lo pagado aplicado a cada venta: qué se pagó, de qué y de quién lo atendió (solo pagos vigentes).
--   (de la 0064 del 24-oct)
CREATE VIEW argos.pagos_por_venta AS
 SELECT pay.paid_at AS pagado_en,
    ((pay.paid_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    round(((a.amount_cents)::numeric / 100.0), 2) AS importe,
    COALESCE(sep.name, spi.name, pr.name, c.description) AS concepto,
        CASE
            WHEN (c.product_id IS NULL) THEN 'tratamiento'::text
            ELSE 'producto'::text
        END AS tipo,
    COALESCE(c.product_quantity, (ep.quantity)::integer, 1) AS cantidad,
    u.name AS profesional,
    b.name AS sede,
    pp.display_name AS paciente,
    c.patient_id AS paciente_id,
    pay.method_name AS medio,
    c.id AS venta_id,
    os.name AS especialidad
   FROM ((((((((((((((((public.patient_payment_application a
     JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
     JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id) AND (c.voided_at IS NULL))))
     JOIN public.patient p ON (((p.organization_id = c.organization_id) AND (p.id = c.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = a.organization_id)))
     LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
     LEFT JOIN public.encounter e ON (((e.organization_id = c.organization_id) AND (e.id = ep.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.service_catalog sep ON (((sep.organization_id = c.organization_id) AND (sep.id = ep.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = c.organization_id) AND (pi.id = c.plan_item_id))))
     LEFT JOIN public.service_catalog spi ON (((spi.organization_id = c.organization_id) AND (spi.id = pi.service_id))))
     LEFT JOIN public.product pr ON (((pr.organization_id = c.organization_id) AND (pr.id = c.product_id))))
     LEFT JOIN public.branch b ON (((b.organization_id = c.organization_id) AND (b.id = c.branch_id))))
     LEFT JOIN public.treatment_budget_item bi ON (((bi.organization_id = c.organization_id) AND (bi.id = c.budget_item_id))))
     LEFT JOIN public.service_catalog sx ON (((sx.organization_id = c.organization_id) AND (sx.id = COALESCE(ep.service_id, bi.service_id, pi.service_id)))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = sx.organization_id) AND (os.id = sx.specialty_id))))
  WHERE (a.voided_at IS NULL);--> statement-breakpoint
ALTER VIEW argos.pagos_por_venta OWNER TO argos_dueno;--> statement-breakpoint

-- Los tratamientos indicados en los planes, con su decisión y su avance.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.planes AS
 SELECT pi.plan_id,
    pp.display_name AS paciente,
    pi.patient_id AS paciente_id,
    s.name AS tratamiento,
    os.name AS especialidad,
    pi.decision_status AS decision,
    pi.status AS estado,
    pi.created_at AS indicado_en,
    pi.decided_at AS decidido_en,
    pi.started_at AS iniciado_en,
    pi.completed_at AS terminado_en,
    round(((pi.price_cents)::numeric / 100.0), 2) AS precio,
    pi.phase AS fase,
    u.name AS indicado_por
   FROM (((((public.treatment_plan_item pi
     JOIN public.patient p ON (((p.organization_id = pi.organization_id) AND (p.id = pi.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = pi.organization_id) AND (s.id = pi.service_id))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = s.organization_id) AND (os.id = s.specialty_id))))
     LEFT JOIN auth."user" u ON ((u.id = pi.created_by)))
  WHERE (pi.status <> 'reemplazado'::text);--> statement-breakpoint
ALTER VIEW argos.planes OWNER TO argos_dueno;--> statement-breakpoint

-- 6. Presupuestos y promociones. Los importes son de la opción que vale: nunca se suman las opciones.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.presupuestos AS
 WITH line AS (
         SELECT i.organization_id,
            i.budget_id,
            i.decision,
            (i.price_cents *
                CASE
                    WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
                    ELSE 1
                END) AS cents
           FROM public.treatment_budget_item i
          WHERE ((i.price_cents IS NOT NULL) AND (i.option_id = ( SELECT o.id
                   FROM public.treatment_budget_option o
                  WHERE ((o.organization_id = i.organization_id) AND (o.budget_id = i.budget_id))
                  ORDER BY (o.decision = 'elegida'::text) DESC, o.is_recommended DESC, o."position"
                 LIMIT 1)))
        )
 SELECT b.id AS presupuesto_id,
    b.budget_number AS numero,
    pp.display_name AS paciente,
    b.patient_id AS paciente_id,
    b.presented_at AS presentado_en,
    ((b.presented_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS presentado_dia,
    b.status AS estado,
    b.decided_at AS decidido_en,
    u.name AS profesional,
    round(((COALESCE(sum(l.cents), (0)::bigint))::numeric / 100.0), 2) AS valor,
    round(((COALESCE(sum(l.cents) FILTER (WHERE (l.decision = 'aceptado'::text)), (0)::bigint))::numeric / 100.0), 2) AS aceptado,
    round(((COALESCE(sum(l.cents) FILTER (WHERE (l.decision = ANY (ARRAY['pendiente'::text, 'pospuesto'::text]))), (0)::bigint))::numeric / 100.0), 2) AS sin_decidir,
    ((b.status = ANY (ARRAY['presentado'::text, 'pospuesto'::text])) OR ((b.status = 'parcial'::text) AND (EXISTS ( SELECT 1
           FROM public.treatment_budget_item x
          WHERE ((x.organization_id = b.organization_id) AND (x.budget_id = b.id) AND (x.decision = 'pospuesto'::text)))))) AS espera_respuesta
   FROM (((((public.treatment_budget b
     JOIN public.patient p ON (((p.organization_id = b.organization_id) AND (p.id = b.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = b.organization_id)))
     LEFT JOIN line l ON (((l.organization_id = b.organization_id) AND (l.budget_id = b.id))))
     LEFT JOIN auth."user" u ON ((u.id = b.created_by)))
  WHERE ((b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL))
  GROUP BY b.id, b.budget_number, pp.display_name, b.patient_id, b.presented_at, op.timezone, b.status, b.decided_at, u.name, b.organization_id;--> statement-breakpoint
ALTER VIEW argos.presupuestos OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.promociones AS
 SELECT name AS nombre,
    starts_at AS inicio,
    ends_at AS fin,
    is_active AS activa,
    (is_active AND (starts_at <= now()) AND ((ends_at IS NULL) OR (ends_at > now()))) AS vigente_hoy
   FROM public.promotion pr;--> statement-breakpoint
ALTER VIEW argos.promociones OWNER TO argos_dueno;--> statement-breakpoint

-- Cada uso de una promoción (presupuesto entregado o cobro), con lo que esa persona pagó desde entonces.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.promociones_uso AS
 SELECT x.promocion,
    pp.display_name AS paciente,
    x.patient_id AS paciente_id,
    x.fecha,
    x.aceptado,
    round(((x.discount)::numeric / 100.0), 2) AS descuento,
    (NOT (EXISTS ( SELECT 1
           FROM public.appointment a
          WHERE ((a.organization_id = x.organization_id) AND (a.patient_id = x.patient_id) AND (a.status = 'atendida'::text) AND (a.starts_at < (x.fecha - '1 day'::interval)))))) AS paciente_nuevo,
    round((((COALESCE(( SELECT sum(pay.amount_cents) AS sum
           FROM public.patient_payment pay
          WHERE ((pay.organization_id = x.organization_id) AND (pay.patient_id = x.patient_id) AND (pay.voided_at IS NULL) AND (pay.paid_at >= x.fecha))), (0)::bigint) - COALESCE(( SELECT sum(r.amount_cents) AS sum
           FROM (public.patient_payment_refund r
             JOIN public.patient_payment pay ON (((pay.organization_id = r.organization_id) AND (pay.id = r.payment_id))))
          WHERE ((r.organization_id = x.organization_id) AND (r.patient_id = x.patient_id) AND (pay.voided_at IS NULL) AND (pay.paid_at >= x.fecha))), (0)::bigint)))::numeric / 100.0), 2) AS cobrado_desde_entonces
   FROM ((( SELECT b.organization_id,
            i.promotion_name AS promocion,
            b.patient_id,
            b.presented_at AS fecha,
            ((b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text])) AND (i.decision = 'aceptado'::text)) AS aceptado,
            (GREATEST((COALESCE(i.tariff_price_cents, i.price_cents) - i.price_cents), 0) *
                CASE
                    WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
                    ELSE 1
                END) AS discount
           FROM (public.treatment_budget b
             JOIN public.treatment_budget_item i ON (((i.organization_id = b.organization_id) AND (i.budget_id = b.id) AND (i.option_id = ( SELECT o.id
                   FROM public.treatment_budget_option o
                  WHERE ((o.organization_id = b.organization_id) AND (o.budget_id = b.id))
                  ORDER BY (o.decision = 'elegida'::text) DESC, o.is_recommended DESC, o."position"
                 LIMIT 1)))))
          WHERE ((i.promotion_id IS NOT NULL) AND (i.price_cents IS NOT NULL) AND (b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL))
        UNION ALL
         SELECT c.organization_id,
            c.promotion_name,
            c.patient_id,
            c.created_at,
            true,
            0
           FROM public.patient_charge c
          WHERE ((c.promotion_id IS NOT NULL) AND (c.voided_at IS NULL))) x
     JOIN public.patient p ON (((p.organization_id = x.organization_id) AND (p.id = x.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))));--> statement-breakpoint
ALTER VIEW argos.promociones_uso OWNER TO argos_dueno;--> statement-breakpoint
CREATE VIEW argos.tareas AS
 SELECT t.created_at AS creada_en,
    t.due_at AS vence_en,
    t.status AS estado,
    t.area,
    t.kind AS tipo,
        CASE
            WHEN (t.created_by = ANY (ARRAY['agent'::text, 'admin'::text])) THEN t.created_by
            ELSE 'equipo'::text
        END AS dejada_por,
    u.name AS responsable
   FROM (public.task t
     LEFT JOIN auth."user" u ON ((u.id = t.assignee_user_id)));--> statement-breakpoint
ALTER VIEW argos.tareas OWNER TO argos_dueno;--> statement-breakpoint

-- Los tickets de pago (odentIA no emite facturas). Un ticket junta lo cobrado en una visita: no es una venta.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.tickets AS
 SELECT t.ticket_number AS numero,
    t.created_at AS emitido_en,
    ((t.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    b.name AS sede,
    pp.display_name AS paciente,
    t.patient_id AS paciente_id,
    round(((t.total_cents)::numeric / 100.0), 2) AS total,
    round(((t.credit_applied_cents)::numeric / 100.0), 2) AS a_favor_usado,
    (t.voided_at IS NOT NULL) AS anulado
   FROM ((((public.payment_ticket t
     JOIN public.patient p ON (((p.organization_id = t.organization_id) AND (p.id = t.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = t.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = t.organization_id) AND (b.id = t.branch_id))));--> statement-breakpoint
ALTER VIEW argos.tickets OWNER TO argos_dueno;--> statement-breakpoint

-- Lo realizado: procedimientos de atenciones firmadas, sin anulados.
--   (de la 0064 del 24-oct)
CREATE VIEW argos.tratamientos_hechos AS
 SELECT e.started_at AS fecha,
    ((e.started_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    pp.display_name AS paciente,
    e.patient_id AS paciente_id,
    u.name AS profesional,
    b.name AS sede,
    s.name AS tratamiento,
    t.specialty AS tipo_tratamiento,
    os.name AS especialidad,
    ep.quantity AS cantidad,
    round(((ep.price_cents)::numeric / 100.0), 2) AS precio
   FROM (((((((((public.encounter_procedure ep
     JOIN public.encounter e ON (((e.organization_id = ep.organization_id) AND (e.id = ep.encounter_id) AND (e.status = 'finalizada'::text))))
     JOIN public.patient p ON (((p.organization_id = e.organization_id) AND (p.id = e.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = ep.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = e.organization_id) AND (b.id = e.branch_id))))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = ep.organization_id) AND (s.id = ep.service_id))))
     LEFT JOIN catalog.treatment_template t ON ((t.id = s.template_id)))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = s.organization_id) AND (os.id = s.specialty_id))))
  WHERE (ep.voided_at IS NULL);--> statement-breakpoint
ALTER VIEW argos.tratamientos_hechos OWNER TO argos_dueno;--> statement-breakpoint

-- 3. Dinero. Los importes en la moneda de la clínica (en unidades, no centavos); «dia» es el día de la clínica.

-- Lo cargado a cada paciente: tratamientos hechos y productos vendidos, sin anulados (lo devuelto ya descontado).
-- Una fila es una venta: «ticket promedio» es el promedio de «importe» de estas filas, no el de los tickets de pago.
--   (de la 0064 del 24-oct)
-- Argos (ADR 0075): la especialidad de lo vendido y de lo pagado, para «¿qué especialidad genera más ingresos?».
-- Es la del servicio del tratamiento (el de la atención, el del presupuesto o el del plan), como Reportes; null en productos
-- y en lo que no tiene servicio. Va al final: una vista se reemplaza sin cambiar sus columnas de antes.
--   (de la 0067 del 24-oct)
CREATE VIEW argos.ventas AS
 SELECT c.id AS venta_id,
    c.created_at AS cargado_en,
    ((c.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    c.patient_id AS paciente_id,
    pp.display_name AS paciente,
    COALESCE(sep.name, spi.name, pr.name, c.description) AS concepto,
        CASE
            WHEN (c.product_id IS NULL) THEN 'tratamiento'::text
            ELSE 'producto'::text
        END AS tipo,
    COALESCE(c.product_quantity, (ep.quantity)::integer, 1) AS cantidad,
    round(((c.amount_cents)::numeric / 100.0), 2) AS importe,
    round(((COALESCE(ap.cents, (0)::bigint))::numeric / 100.0), 2) AS pagado,
    round((((c.amount_cents - COALESCE(ap.cents, (0)::bigint)))::numeric / 100.0), 2) AS saldo,
    b.name AS sede,
    u.name AS profesional,
    c.promotion_name AS promocion,
    os.name AS especialidad
   FROM (((((((((((((((public.patient_charge c
     JOIN public.patient p ON (((p.organization_id = c.organization_id) AND (p.id = c.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = c.organization_id)))
     LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
     LEFT JOIN public.encounter e ON (((e.organization_id = c.organization_id) AND (e.id = ep.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.service_catalog sep ON (((sep.organization_id = c.organization_id) AND (sep.id = ep.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = c.organization_id) AND (pi.id = c.plan_item_id))))
     LEFT JOIN public.service_catalog spi ON (((spi.organization_id = c.organization_id) AND (spi.id = pi.service_id))))
     LEFT JOIN public.product pr ON (((pr.organization_id = c.organization_id) AND (pr.id = c.product_id))))
     LEFT JOIN public.branch b ON (((b.organization_id = c.organization_id) AND (b.id = c.branch_id))))
     LEFT JOIN public.treatment_budget_item bi ON (((bi.organization_id = c.organization_id) AND (bi.id = c.budget_item_id))))
     LEFT JOIN public.service_catalog sx ON (((sx.organization_id = c.organization_id) AND (sx.id = COALESCE(ep.service_id, bi.service_id, pi.service_id)))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = sx.organization_id) AND (os.id = sx.specialty_id))))
     LEFT JOIN LATERAL ( SELECT sum(a.amount_cents) AS cents
           FROM (public.patient_payment_application a
             JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
          WHERE ((a.organization_id = c.organization_id) AND (a.charge_id = c.id) AND (a.voided_at IS NULL))) ap ON (true))
  WHERE (c.voided_at IS NULL);--> statement-breakpoint
ALTER VIEW argos.ventas OWNER TO argos_dueno;--> statement-breakpoint
GRANT USAGE ON SCHEMA argos TO argos_gestion;--> statement-breakpoint
GRANT USAGE ON SCHEMA argos TO argos_recepcion;--> statement-breakpoint
GRANT USAGE ON SCHEMA argos TO argos_clinico;--> statement-breakpoint
GRANT USAGE ON SCHEMA argos TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.agenda_por_dia TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.agenda_por_dia TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.agenda_por_dia TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.agenda_por_hora TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.agenda_por_hora TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.agenda_por_hora TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.ausencias TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.ausencias TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.ausencias TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.citas TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.citas TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.citas TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.cobros TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.cobros TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.comisiones TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.compras TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.compras_detalle TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.controles TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.controles TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.controles TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.conversaciones TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.conversaciones TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.conversaciones TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.deudas TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.deudas TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.embudo TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.embudo TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.equipo TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.equipo TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.equipo TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.equipo TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.gastos TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.gastos TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.inventario TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.inventario TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.lineas_presupuesto TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.lineas_presupuesto TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.lineas_presupuesto TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.lineas_presupuesto TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.lotes TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.lotes TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.movimientos_inventario TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.movimientos_inventario TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.oportunidades TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.oportunidades TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.pacientes TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.pacientes TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.pacientes TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.pacientes TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.pagos_por_venta TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.pagos_por_venta TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.planes TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.planes TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.presupuestos TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.presupuestos TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.presupuestos TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.presupuestos TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.promociones TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.promociones TO argos_recepcion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.promociones TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.promociones TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.promociones_uso TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.tareas TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.tickets TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.tickets TO argos_caja;--> statement-breakpoint
GRANT SELECT ON TABLE argos.tratamientos_hechos TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.tratamientos_hechos TO argos_clinico;--> statement-breakpoint
GRANT SELECT ON TABLE argos.ventas TO argos_gestion;--> statement-breakpoint
GRANT SELECT ON TABLE argos.ventas TO argos_caja;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Colas de pgmq y despertador de pg_cron
-- ═════════════════════════════════════════════════════════════════════════
-- Las extensiones pgmq y pg_cron las crea el init de la imagen
-- (02-extensions.sql) con los mismos permisos; se repiten aquí para que la
-- base no dependa de ese orden. Las colas q_* que se crean después heredan
-- los permisos por defecto del esquema pgmq.
--   (de la 0001 del 16-oct)
GRANT USAGE ON SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE dentalagent IN SCHEMA pgmq GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalagent_app;--> statement-breakpoint
-- Colas del worker: mensajes que llegan y salen, turnos del agente y el
-- despertador de automatizaciones. `demo_tasks` la sigue usando el worker
-- (apps/worker/src/index.ts). pgmq.create no es idempotente: se tolera que la
-- cola ya exista.
--   (de la 0000, 0002 y 0026 del 16-oct)
DO $$ BEGIN PERFORM pgmq.create('demo_tasks'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('inbound_messages'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('outbound_messages'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('agent_runs'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN PERFORM pgmq.create('automation_ticks'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- Despertador durable del tick: un único job por minuto que encola un aviso
-- sin datos personales en 'automation_ticks'. El worker drena (junta los
-- avisos) y ejecuta un solo tick con la hora de la base. No se programa cada
-- envío en cron: los trabajos viven en automation_job.
--   (de la 0026 del 16-oct)
DO $$ BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'automation-tick';
  PERFORM cron.schedule('automation-tick', '* * * * *', $job$SELECT pgmq.send('automation_ticks', '{}'::jsonb)$job$);
END $$;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Datos de catálogo
-- ═════════════════════════════════════════════════════════════════════════
-- Las dos listas de la OMS y, preparadas sin cargar, las nacionales. Sus
-- códigos los carga `seed:diagnoses` con el archivo oficial (ADR 0041).
--   (de la 0102 del 16-oct)
INSERT INTO "catalog"."diagnosis_code_system" ("key", "title", "publisher", "country", "uri") VALUES
	('ICD-10', 'CIE-10 (OMS)', 'Organización Mundial de la Salud', NULL, 'http://hl7.org/fhir/sid/icd-10'),
	('ICD-11', 'CIE-11 (OMS)', 'Organización Mundial de la Salud', NULL, 'http://id.who.int/icd/release/11/mms'),
	('ICD-10-PE', 'CIE-10 MINSA', 'Ministerio de Salud del Perú', 'PE', 'urn:odentia:diagnosis:icd-10-pe'),
	('ICD-10-ES', 'CIE-10-ES', 'Ministerio de Sanidad de España', 'ES', 'urn:odentia:diagnosis:icd-10-es');--> statement-breakpoint

-- Mientras dure el programa Fundadores, se abren clínicas solo con invitación
-- (issue 165).
--   (de la 0032 del 24-oct)
INSERT INTO admin.saas_signup_policy (id, mode) VALUES (1, 'invitacion') ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- Las condiciones comerciales (ADR 0074), primera versión: los valores que
-- estaban en el código, vigentes desde siempre.
--   (de la 0051 del 24-oct)
INSERT INTO admin.saas_commercial_terms
  (effective_from, conversation_window_hours, recovery_window_days, review_auto_percent, review_answer_days,
   review_read_days, payment_days, grace_days, proof_extension_days, proof_extension_max, half_cycle_days,
   trial_days, warn_percent, alarm_percent, waitlist_answer_days, commission_months, discount_notice_days,
   guarantee_notice_days)
VALUES ('1970-01-01T00:00:00Z', 24, 7, 10, 2, 7, 7, 7, 3, 1, 15, 30, 75, 90, 2, 12, 15, 30);
