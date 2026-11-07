-- Comisiones de quien dejó la clínica (QA de comisiones, D-3): lo que ganó mientras atendía sigue
-- siendo suyo y del mes en que pasó. Argos deja de filtrar por miembro, como Reportes: sacar a
-- alguien del equipo ya no reescribe «Comisiones» ni «Lo que deja» de los meses en que trabajó.
-- La vista conserva sus columnas, su dueño y sus GRANT.
CREATE OR REPLACE VIEW argos.comisiones AS
 WITH live_app AS (
         SELECT a.id,
            a.organization_id,
            (a.amount_cents)::bigint AS cents,
            a.created_at AS at,
            e.professional_user_id AS user_id,
            p.branch_id,
            p.amount_cents AS payment_cents,
            p.business_cents,
            p.currency::text AS currency
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
                    WHEN f.live THEN (f.base)::numeric
                    ELSE (0)::numeric
                END AS base,
                CASE
                    WHEN f.live THEN (f.commission)::numeric
                    ELSE (0)::numeric
                END AS commission,
            (f.commission)::numeric AS paid,
            (0)::numeric AS fresh,
            f.branch_id
           FROM frozen f
        UNION ALL
         SELECT la.organization_id,
            la.user_id,
            la.at,
            public.org_money_value(la.cents, la.payment_cents, la.business_cents, la.currency, op_1.currency, op_1.second_currency, op_1.exchange_factor),
            public.money_commission(la.cents, la.payment_cents, la.business_cents, la.currency, op_1.currency, op_1.second_currency, op_1.exchange_factor, COALESCE(r.rate_bps, 0)),
            (0)::numeric,
            public.money_commission(la.cents, la.payment_cents, la.business_cents, la.currency, op_1.currency, op_1.second_currency, op_1.exchange_factor, COALESCE(r.rate_bps, 0)),
            la.branch_id
           FROM ((live_app la
             LEFT JOIN public.commission_rule r ON (((r.organization_id = la.organization_id) AND (r.professional_user_id = la.user_id))))
             LEFT JOIN public.org_profile op_1 ON ((op_1.organization_id = la.organization_id)))
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM frozen f
                  WHERE ((f.organization_id = la.organization_id) AND (f.application_id = la.id)))))
        )
 SELECT l.at AS momento,
    ((l.at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    u.name AS profesional,
    b.name AS sede,
    public.money_major(l.base, op.currency) AS base,
    public.money_major(l.commission, op.currency) AS comision,
    public.money_major(l.paid, op.currency) AS pagado,
    public.money_major(l.fresh, op.currency) AS sin_pagar
   FROM (((line l
     JOIN auth."user" u ON ((u.id = l.user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = l.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = l.organization_id) AND (b.id = l.branch_id))));--> statement-breakpoint
