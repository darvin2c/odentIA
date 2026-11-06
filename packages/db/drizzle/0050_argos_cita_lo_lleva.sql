-- «Aceptó y no tiene cita» en Argos (ADR 0145, revisión del PR #472): la misma regla de Inicio,
-- Pacientes › «Por agendar», Reportes y la línea «Presupuesto aceptado sin cita». Cada línea dice si
-- una cita por venir (programada o confirmada) lleva su tratamiento (`carriedByUpcomingSql` de
-- `to-schedule.ts`), aunque la persona tenga otra cita. La columna va al final: la vista conserva
-- sus columnas, su dueño y sus GRANT. argos_dueno lee qué tratamientos lleva cada cita, con la
-- misma aislación por clínica (RLS) que el resto.
GRANT SELECT ON TABLE public.appointment_plan_item TO argos_dueno;--> statement-breakpoint
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
          WHERE ((api.organization_id = i.organization_id) AND (api.plan_item_id = i.plan_item_id) AND (a.status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND (a.starts_at > now())))) AS cita_lo_lleva
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
