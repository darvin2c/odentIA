-- «Va después» en Argos (entrega 8): la misma regla de `to-schedule.ts` (`awaitsBookedSql`). Lo
-- aceptado sin empezar que va después de otro tratamiento de la misma pieza, de una fase anterior
-- del plan y que ya tiene su cita por venir (la corona tras la endodoncia con la sesión 2 reservada),
-- no cuenta como «aceptó y no tiene cita». `cita_lo_lleva` no cambia de sentido: la columna nueva
-- va al final y la vista conserva su dueño y sus GRANT. Las fases son las de odentIA en su orden
-- (`TREATMENT_PHASES`); latidIA tiene una sola («general»), fuera de la lista: nunca espera.
CREATE OR REPLACE VIEW argos.lineas_presupuesto AS
 SELECT b.id AS presupuesto_id,
    b.budget_number AS numero,
    pp.display_name AS paciente,
    b.patient_id AS paciente_id,
    b.presented_at AS presentado_en,
    ((b.presented_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS presentado_dia,
    b.status AS estado_presupuesto,
    COALESCE(s.name, i.title) AS tratamiento,
    i.decision,
    public.money_major(public.org_money_value(i.price_cents * CASE
            WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
            ELSE 1
        END, NULL, NULL, i.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
    i.promotion_name AS promocion,
    pi.status AS estado_tratamiento,
    CASE WHEN i.currency <> op.currency THEN public.money_major(i.price_cents * CASE
            WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
            ELSE 1
        END, i.currency) END AS importe_otra_moneda,
    CASE WHEN i.currency::text <> op.currency THEN i.currency::text END AS otra_moneda,
    (EXISTS ( SELECT 1
           FROM (public.appointment_plan_item api
             JOIN public.appointment a ON (((a.organization_id = api.organization_id) AND (a.id = api.appointment_id))))
          WHERE ((api.organization_id = i.organization_id) AND (api.plan_item_id = i.plan_item_id) AND (a.status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND (a.starts_at > now())))) AS cita_lo_lleva,
    (pi.status = ANY (ARRAY['pendiente'::text, 'programado'::text]) AND pi.site_code IS NOT NULL AND (EXISTS ( SELECT 1
           FROM public.treatment_plan_item bi
          WHERE ((bi.organization_id = pi.organization_id) AND (bi.patient_id = pi.patient_id) AND (bi.id <> pi.id) AND (bi.decision_status = 'aceptado'::text)
            AND (bi.status = ANY (ARRAY['pendiente'::text, 'programado'::text, 'en_curso'::text, 'suspendido'::text]))
            AND (bi.site_system IS NOT DISTINCT FROM pi.site_system) AND (bi.site_code = pi.site_code)
            AND (array_position(ARRAY['urgencia'::text, 'basica'::text, 'quirurgica'::text, 'rehabilitadora'::text, 'mantenimiento'::text], bi.phase) < array_position(ARRAY['urgencia'::text, 'basica'::text, 'quirurgica'::text, 'rehabilitadora'::text, 'mantenimiento'::text], pi.phase))
            AND (EXISTS ( SELECT 1
                   FROM (public.appointment_plan_item bapi
                     JOIN public.appointment ba ON (((ba.organization_id = bapi.organization_id) AND (ba.id = bapi.appointment_id))))
                  WHERE ((bapi.organization_id = bi.organization_id) AND (bapi.plan_item_id = bi.id) AND (ba.status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND (ba.starts_at > now())))))))) IS TRUE AS espera_a_otro_con_cita
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
  WHERE ((b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL));
