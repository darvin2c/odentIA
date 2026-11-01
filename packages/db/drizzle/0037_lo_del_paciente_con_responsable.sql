-- Lo de un paciente se borra también cuando lo lleva quien habla por él (una madre,
-- un apoderado): su enlace de reserva, sus tareas con su pase, sus oportunidades con
-- su tarea, sus notas y sus mensajes automáticos, y las propuestas del agente. Lo que
-- esa persona tiene por su cuenta, sus conversaciones incluidas, es suyo y queda.
CREATE OR REPLACE FUNCTION public.erase_person_data(p_patient uuid, p_actor text) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'catalog', 'auth', 'admin', 'dental', 'pg_temp'
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
  v_opps := ARRAY(SELECT "id" FROM "opportunity"
    WHERE ("contact_id" = v_contact OR "patient_id" = p_patient) AND "organization_id" = v_org);
  v_keys := ARRAY(
    SELECT a ->> 'objectKey' FROM "message" m, jsonb_array_elements(coalesce(m."attachments", '[]'::jsonb)) a
    WHERE m."conversation_id" = ANY(v_convs) AND jsonb_typeof(a) = 'object' AND a ? 'objectKey');
  -- Sus conversaciones y lo que el agente dejó en ellas.
  UPDATE "appointment" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  UPDATE "patient_registration" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  UPDATE "portal_link" SET "delivery_conversation_id" = NULL, "delivery_message_id" = NULL
    WHERE "delivery_conversation_id" = ANY(v_convs);
  -- Todas las tareas que se van, en una sola lista: lo que depende de ellas se va con ellas.
  v_tasks := ARRAY(SELECT "task_id" FROM "agent_handoff"
    WHERE ("conversation_id" = ANY(v_convs) OR "contact_id" = v_contact) AND "task_id" IS NOT NULL)
    || ARRAY(SELECT "id" FROM "task" WHERE "organization_id" = v_org AND ("contact_id" = v_contact
      OR "conversation_id" = ANY(v_convs) OR "patient_id" = p_patient OR "opportunity_id" = ANY(v_opps)));
  -- Un pase solo se cierra con su tarea: sin ella quedaría abierto para siempre, también en la conversación de otra persona.
  DELETE FROM "agent_handoff" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact OR "task_id" = ANY(v_tasks);
  DELETE FROM "agent_proposal" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact OR "patient_id" = p_patient;
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
  DELETE FROM "appointment_booking_link" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact OR "patient_id" = p_patient;
  UPDATE "patient_registration" SET "link_id" = NULL WHERE "link_id" IN (
    SELECT "id" FROM "patient_registration_link" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact);
  DELETE FROM "patient_registration_link" WHERE "conversation_id" = ANY(v_convs) OR "contact_id" = v_contact;
  DELETE FROM "task" WHERE "id" = ANY(v_tasks);
  DELETE FROM "crm_note" WHERE "contact_id" = v_contact OR "opportunity_id" IN (
    SELECT "id" FROM "opportunity" WHERE "id" = ANY(v_opps) AND "patient_id" = p_patient);
  UPDATE "crm_note" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  UPDATE "crm_note" SET "opportunity_id" = NULL WHERE "opportunity_id" = ANY(v_opps);
  DELETE FROM "opportunity" WHERE "id" = ANY(v_opps);
  UPDATE "opportunity" SET "conversation_id" = NULL WHERE "conversation_id" = ANY(v_convs);
  DELETE FROM "conversation" WHERE "id" = ANY(v_convs);
  DELETE FROM "contact_identity" WHERE "contact_id" = v_contact;
  -- Mensajes automáticos y su portal: sin conversación ni canal ya no sirven.
  DELETE FROM "automation_job" WHERE "organization_id" = v_org AND ("contact_id" = v_contact OR "patient_id" = p_patient
    OR "opportunity_id" = ANY(v_opps) OR "task_id" = ANY(v_tasks));
  DELETE FROM "automation_link_token" WHERE "organization_id" = v_org AND "contact_id" = v_contact;
  DELETE FROM "portal_session" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  DELETE FROM "portal_verification" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  DELETE FROM "portal_link" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  DELETE FROM "portal_grant" WHERE "patient_id" = p_patient OR "contact_id" = v_contact;
  -- Correo, redes y etiquetas. Nombre, documento y teléfono quedan, solo dentro
  -- de la historia bloqueada.
  UPDATE "contact" SET
    "email" = NULL, "preferred_channel" = NULL, "tags" = '{}',
    "last_interaction_at" = NULL, "screen" = NULL, "screened_at" = NULL, "screened_by_user_id" = NULL,
    "screen_reason" = NULL, "screen_note" = NULL, "not_spam_at" = NULL, "not_spam_by_user_id" = NULL,
    "is_active" = false, "record_locked_at" = now(), "record_locked_by" = p_actor, "updated_at" = now()
  WHERE "id" = v_contact AND "organization_id" = v_org;
  RETURN coalesce(v_keys, '{}');
END;
$$;
