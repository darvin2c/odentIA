-- Probar igual que lo real (ADR 0094): una prueba crea de verdad, marcado.
-- La persona de prueba es la que solo existe por pruebas (como `testOnlyPersonSql`).
UPDATE "contact" c SET "is_test" = true
  WHERE EXISTS (SELECT 1 FROM "conversation" t WHERE t."organization_id" = c."organization_id" AND t."contact_id" = c."id" AND t."is_test")
    AND NOT EXISTS (SELECT 1 FROM "conversation" r WHERE r."organization_id" = c."organization_id" AND r."contact_id" = c."id" AND NOT r."is_test");--> statement-breakpoint
-- La marca nace con la persona y no cambia: una persona real nunca pasa a
-- prueba (se borraría con ella) ni una de prueba a real (contaría en números).
CREATE FUNCTION public.guard_contact_is_test() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'Una persona de prueba lo es desde que nace' USING ERRCODE = '23514', CONSTRAINT = 'contact_is_test_fixed';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER contact_is_test_fixed BEFORE UPDATE OF is_test ON public.contact FOR EACH ROW EXECUTE FUNCTION public.guard_contact_is_test();--> statement-breakpoint
-- La cita es de prueba si su paciente es una persona de prueba: lo pone la base,
-- nunca quien la crea, para que ninguna vía (Sofi, el enlace, la Agenda) se equivoque.
CREATE FUNCTION public.appointment_is_test() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.is_test := coalesce((
    SELECT pp.is_test FROM patient p
      JOIN contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
      WHERE p.organization_id = NEW.organization_id AND p.id = NEW.patient_id), false);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER appointment_is_test BEFORE INSERT OR UPDATE OF patient_id, is_test ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.appointment_is_test();--> statement-breakpoint
UPDATE "appointment" a SET "is_test" = true FROM "patient" p, "contact" pp
  WHERE p."organization_id" = a."organization_id" AND p."id" = a."patient_id"
    AND pp."organization_id" = p."organization_id" AND pp."id" = p."person_id" AND pp."is_test";--> statement-breakpoint
-- Una cita de prueba no ocupa el horario de pacientes reales, pero sí choca con
-- otra prueba: dos exclusiones por profesional y por consultorio, una para cada lado.
ALTER TABLE ONLY public.appointment DROP CONSTRAINT appointment_no_overlap_professional;--> statement-breakpoint
ALTER TABLE ONLY public.appointment DROP CONSTRAINT appointment_no_overlap_room;--> statement-breakpoint
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_no_overlap_professional EXCLUDE USING gist (organization_id WITH =, professional_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND NOT is_test);--> statement-breakpoint
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_no_overlap_room EXCLUDE USING gist (organization_id WITH =, room_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND NOT is_test);--> statement-breakpoint
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_test_no_overlap_professional EXCLUDE USING gist (organization_id WITH =, professional_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND is_test);--> statement-breakpoint
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_test_no_overlap_room EXCLUDE USING gist (organization_id WITH =, room_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND is_test);--> statement-breakpoint
-- Borrar una prueba («Borrar esta prueba», «Empezar de nuevo» o a los 7 días)
-- se lleva la conversación y, si su persona es de prueba, todo lo que se creó
-- para ella: su ficha, sus citas, sus oportunidades y sus tareas. Una persona
-- real que escribió en una prueba (antes de la marca) sigue como antes: solo
-- se suelta lo suyo de la conversación.
CREATE OR REPLACE FUNCTION public.delete_webchat_test(p_conversation uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_org text := NULLIF(current_setting('app.org_id', true), '');
  v_contact uuid;
  v_person_test boolean;
  v_tasks uuid[];
  v_patients uuid[];
  v_appointments uuid[];
BEGIN
  SELECT c."contact_id", p."is_test" INTO v_contact, v_person_test FROM "conversation" c
    JOIN "contact" p ON p."organization_id" = c."organization_id" AND p."id" = c."contact_id"
    WHERE c."id" = p_conversation AND c."organization_id" = v_org AND c."is_test";
  IF v_contact IS NULL THEN
    RETURN false;
  END IF;
  IF v_person_test THEN
    v_patients := ARRAY(SELECT "id" FROM "patient" WHERE "organization_id" = v_org AND "person_id" = v_contact);
    v_appointments := ARRAY(SELECT "id" FROM "appointment" WHERE "organization_id" = v_org AND "patient_id" = ANY(v_patients));
    DELETE FROM "appointment_booking_link" WHERE "organization_id" = v_org
      AND ("contact_id" = v_contact OR "patient_id" = ANY(v_patients) OR "appointment_id" = ANY(v_appointments));
    DELETE FROM "appointment_plan_item" WHERE "organization_id" = v_org AND "appointment_id" = ANY(v_appointments);
    DELETE FROM "clinical_follow_up" WHERE "organization_id" = v_org AND "patient_id" = ANY(v_patients);
    DELETE FROM "appointment" WHERE "organization_id" = v_org AND "id" = ANY(v_appointments);
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
  IF v_person_test AND NOT EXISTS (SELECT 1 FROM "conversation" WHERE "contact_id" = v_contact) THEN
    -- La persona de prueba no es nadie más: se va entera, con su ficha.
    DELETE FROM "task" WHERE "organization_id" = v_org AND ("contact_id" = v_contact OR "opportunity_id" IN (
      SELECT "id" FROM "opportunity" WHERE "organization_id" = v_org AND "contact_id" = v_contact));
    DELETE FROM "agent_person_fact" WHERE "contact_id" = v_contact;
    DELETE FROM "agent_proposal" WHERE "contact_id" = v_contact;
    DELETE FROM "agent_handoff" WHERE "contact_id" = v_contact;
    UPDATE "patient_registration" SET "link_id" = NULL WHERE "link_id" IN (
      SELECT "id" FROM "patient_registration_link" WHERE "contact_id" = v_contact);
    DELETE FROM "patient_registration_link" WHERE "contact_id" = v_contact;
    DELETE FROM "patient_registration" WHERE "organization_id" = v_org AND "patient_id" = ANY(v_patients);
    DELETE FROM "patient_responsibility" WHERE "organization_id" = v_org AND "patient_id" = ANY(v_patients);
    DELETE FROM "patient_record_opening" WHERE "organization_id" = v_org AND "patient_id" = ANY(v_patients);
    -- Si alguien abrió su ficha, quién la consultó no se borra (`clinical_access_log`):
    -- la persona queda, marcada de prueba y sin nada más.
    BEGIN
      DELETE FROM "patient_contact" WHERE "organization_id" = v_org AND ("patient_id" = ANY(v_patients) OR "contact_id" = v_contact);
      DELETE FROM "patient" WHERE "organization_id" = v_org AND "id" = ANY(v_patients);
      DELETE FROM "contact" WHERE "id" = v_contact;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  ELSIF NOT EXISTS (SELECT 1 FROM "conversation" WHERE "contact_id" = v_contact)
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
-- Argos no cuenta lo de una persona de prueba (ADR 0094): ni sus citas, ni su ficha,
-- ni sus oportunidades, ni sus tareas; una cita de prueba no ocupa la agenda.
CREATE OR REPLACE VIEW argos.agenda_base AS
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
          WHERE ((a.organization_id = f.organization_id) AND (a.branch_id = f.branch_id) AND (a.professional_user_id = f.dentist_user_id) AND (a.status <> 'cancelada'::text) AND (NOT a.is_test) AND (a.starts_at < upper(f.programado)) AND (a.ends_at > lower(f.programado)))), '{}'::tstzmultirange)) AS ocupado
   FROM free f;--> statement-breakpoint
CREATE OR REPLACE VIEW argos.citas AS
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
         LIMIT 1) e ON (true))
  WHERE (NOT a.is_test);--> statement-breakpoint
CREATE OR REPLACE VIEW argos.pacientes AS
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
  WHERE ((pp.screen IS NULL) AND (NOT pp.is_test));--> statement-breakpoint
CREATE OR REPLACE VIEW argos.oportunidades AS
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
  WHERE ((pp.screen IS NULL) AND (NOT pp.is_test));--> statement-breakpoint
CREATE OR REPLACE VIEW argos.tareas AS
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
     LEFT JOIN auth."user" u ON ((u.id = t.assignee_user_id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.contact tc
          WHERE ((tc.organization_id = t.organization_id) AND (tc.id = t.contact_id) AND tc.is_test))));--> statement-breakpoint
