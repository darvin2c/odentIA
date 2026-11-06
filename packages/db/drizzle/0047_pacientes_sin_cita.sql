-- Pacientes nuevos (M34 del QA del 2026-11-04): la primera vez que vino una persona es su
-- primera cita atendida o su primera atención firmada sin cita, como en Reportes
-- (`firstVisitSql`) y en «Vinieron» del embudo. Las citas de prueba no cuentan. La vista
-- conserva sus columnas, su dueño y sus GRANT.
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
     LEFT JOIN LATERAL ( SELECT min(((x.t AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date) AS primera_atencion,
            max(((x.t AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date) AS ultima_atencion,
            (count(*))::integer AS atenciones,
            max(x.t) AS ultima_atencion_en
           FROM ( SELECT a.starts_at AS t
                   FROM public.appointment a
                  WHERE ((a.organization_id = p.organization_id) AND (a.patient_id = p.id) AND (a.status = 'atendida'::text) AND (NOT a.is_test))
                UNION ALL
                 SELECT e.started_at AS t
                   FROM public.encounter e
                  WHERE ((e.organization_id = p.organization_id) AND (e.patient_id = p.id) AND (e.status = 'finalizada'::text) AND (e.voided_at IS NULL) AND (e.appointment_id IS NULL))) x) v ON (true))
     LEFT JOIN LATERAL ( SELECT x.t AS primera_atencion_en,
            b.name AS primera_sede
           FROM (( SELECT a.id, a.starts_at AS t, a.branch_id
                   FROM public.appointment a
                  WHERE ((a.organization_id = p.organization_id) AND (a.patient_id = p.id) AND (a.status = 'atendida'::text) AND (NOT a.is_test))
                UNION ALL
                 SELECT e.id, e.started_at AS t, e.branch_id
                   FROM public.encounter e
                  WHERE ((e.organization_id = p.organization_id) AND (e.patient_id = p.id) AND (e.status = 'finalizada'::text) AND (e.voided_at IS NULL) AND (e.appointment_id IS NULL))) x
             LEFT JOIN public.branch b ON (((b.organization_id = p.organization_id) AND (b.id = x.branch_id))))
          ORDER BY x.t, x.id
         LIMIT 1) f ON (true))
  WHERE ((pp.screen IS NULL) AND (NOT pp.is_test));
