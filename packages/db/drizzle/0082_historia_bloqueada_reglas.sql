-- Historia bloqueada (ADR 0080, fase 2). Las aperturas con motivo son de cada
-- clínica: la aplicación las anota y las lee; nunca las cambia ni las borra.
GRANT SELECT,INSERT ON TABLE public.patient_record_opening TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.patient_record_opening ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_record_opening FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_record_opening USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
-- Borrar lo no clínico de una persona a su pedido y bloquear su historia. La
-- aplicación no tiene DELETE en las tablas del agente, del CRM ni del portal,
-- así que el borrado es esta función, como `delete_webchat_test` (0057), en el
-- orden que piden las claves foráneas. Lo clínico, los cobros y los
-- comprobantes no se tocan: la ley pide guardarlos. Devuelve las claves de los
-- adjuntos de sus mensajes para borrarlos del almacenamiento después de
-- confirmar.
CREATE OR REPLACE FUNCTION public.erase_person_data(p_patient uuid, p_actor text) RETURNS text[]
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
REVOKE ALL ON FUNCTION public.erase_person_data(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.erase_person_data(uuid, text) TO dentalagent_app;
