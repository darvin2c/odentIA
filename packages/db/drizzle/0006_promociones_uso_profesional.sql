-- Argos (ADR 0075): el uso de una promoción dice qué profesional está detrás.
-- En un presupuesto, quien indicó el tratamiento (`treatment_plan_item.created_by`,
-- la misma regla de «lo propio» del odontólogo en los presupuestos); en un cobro,
-- quien lo atendió (`encounter.professional_user_id`, como Comisiones). Vacío en
-- la venta de un producto, que nadie atendió. La columna va al final: la vista
-- conserva las suyas y sus GRANT.
CREATE OR REPLACE VIEW argos.promociones_uso AS
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
          WHERE ((r.organization_id = x.organization_id) AND (r.patient_id = x.patient_id) AND (pay.voided_at IS NULL) AND (pay.paid_at >= x.fecha))), (0)::bigint)))::numeric / 100.0), 2) AS cobrado_desde_entonces,
    u.name AS profesional
   FROM (((( SELECT b.organization_id,
            i.promotion_name AS promocion,
            b.patient_id,
            b.presented_at AS fecha,
            ((b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text])) AND (i.decision = 'aceptado'::text)) AS aceptado,
            (GREATEST((COALESCE(i.tariff_price_cents, i.price_cents) - i.price_cents), 0) *
                CASE
                    WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
                    ELSE 1
                END) AS discount,
            pi.created_by AS professional_user_id
           FROM ((public.treatment_budget b
             JOIN public.treatment_budget_item i ON (((i.organization_id = b.organization_id) AND (i.budget_id = b.id) AND (i.option_id = ( SELECT o.id
                   FROM public.treatment_budget_option o
                  WHERE ((o.organization_id = b.organization_id) AND (o.budget_id = b.id))
                  ORDER BY (o.decision = 'elegida'::text) DESC, o.is_recommended DESC, o."position"
                 LIMIT 1)))))
             LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = i.organization_id) AND (pi.id = i.plan_item_id))))
          WHERE ((i.promotion_id IS NOT NULL) AND (i.price_cents IS NOT NULL) AND (b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL))
        UNION ALL
         SELECT c.organization_id,
            c.promotion_name,
            c.patient_id,
            c.created_at,
            true,
            0,
            e.professional_user_id
           FROM ((public.patient_charge c
             LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
             LEFT JOIN public.encounter e ON (((e.organization_id = ep.organization_id) AND (e.id = ep.encounter_id))))
          WHERE ((c.promotion_id IS NOT NULL) AND (c.voided_at IS NULL))) x
     JOIN public.patient p ON (((p.organization_id = x.organization_id) AND (p.id = x.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN auth."user" u ON ((u.id = x.professional_user_id)));
