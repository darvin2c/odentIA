-- Sitios del chat web (decisión 8 del pulido de la Bandeja): de cada clínica.
GRANT SELECT,INSERT,UPDATE ON TABLE public.webchat_site TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.webchat_site ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.webchat_site FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.webchat_site USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));
--> statement-breakpoint

-- «Borrar esta prueba» y el borrado a los 7 días (fase 6 del pulido): una
-- conversación de prueba del chat web se borra con todo lo que dejó. Solo una
-- prueba (`is_test`) de la clínica en contexto (`app.org_id`): el rol de la app
-- no borra temas, corridas ni tareas por su cuenta. Lo aprendido en una
-- corrección queda, sin la conversación. Lo que una prueba no debería dejar
-- (una cita, un registro) tampoco se borra: se suelta de la conversación. La
-- persona de prueba se borra solo si no es nadie más: sin otras
-- conversaciones, sin ficha y sin más identidad que la de la prueba; si quedó
-- unida a algo real (un pago, un consentimiento), se queda.
CREATE OR REPLACE FUNCTION public.delete_webchat_test(p_conversation uuid) RETURNS boolean
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
REVOKE ALL ON FUNCTION public.delete_webchat_test(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.delete_webchat_test(uuid) TO dentalagent_app;
