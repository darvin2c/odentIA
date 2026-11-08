-- Argos lee lo mismo que Reportes y Finanzas (ADR 0160 y 0157):
-- 1. `argos.gastos`: un gasto anulado no ocurrió y no está, en ningún mes (antes: su anulación negativa en el mes de anularlo).
-- 2. `argos.comisiones`: `pagado` es el dinero que salió. Lo que un pago descontó de cobros anulados
--    después de pagados resta, en el mes de los cobros de ese pago, como en Reportes. Lo devuelto o
--    saldado a mano (`kind` 'devuelto' o 'saldado') no baja lo que salió en pagos.

CREATE OR REPLACE VIEW argos.gastos AS
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
    public.money_major(public.org_money_value(x.sign * x.amount, x.amount, x.business, x.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS monto,
    b.name AS sede,
    CASE WHEN x.out_currency <> op.currency THEN public.money_major(x.sign * x.out_cents, x.out_currency) END AS monto_otra_moneda,
    CASE WHEN x.out_currency <> op.currency THEN x.out_currency END AS otra_moneda
   FROM ((( SELECT e.organization_id,
            e.id,
            e.spent_at AS momento,
            e.category AS categoria,
            1 AS sign,
            e.branch_id,
            e.purchase_order_id,
            e.sales_tax,
            e.amount_cents AS amount, e.business_cents AS business, e.currency::text AS currency, COALESCE(e.tender_cents, e.amount_cents) AS out_cents, COALESCE(e.tender_currency, e.currency)::text AS out_currency
           FROM public.expense e
          WHERE (e.voided_at IS NULL)) x
     LEFT JOIN public.org_profile op ON ((op.organization_id = x.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = x.organization_id) AND (b.id = x.branch_id))));--> statement-breakpoint

CREATE OR REPLACE VIEW argos.comisiones AS
 WITH frozen AS (
         SELECT l_1.organization_id,
            -- Lo pagado en otra moneda, con el cambio de su pago (una línea es de un solo cobro).
                CASE
                    WHEN (s.currency = op.currency) THEN (l_1.base_cents)::numeric
                    ELSE public.org_money_value((l_1.base_cents)::numeric, (p.amount_cents)::numeric, (p.business_cents)::numeric, (p.currency)::text, op.currency, op.second_currency, op.exchange_factor)
                END AS base,
                CASE
                    WHEN (s.currency = op.currency) THEN (l_1.commission_cents)::numeric
                    ELSE public.org_money_value((l_1.commission_cents)::numeric, (p.amount_cents)::numeric, (p.business_cents)::numeric, (p.currency)::text, op.currency, op.second_currency, op.exchange_factor)
                END AS commission,
            l_1.occurred_at AS at,
            s.professional_user_id AS user_id,
            ((a.voided_at IS NULL) AND (p.voided_at IS NULL) AND (c.voided_at IS NULL)) AS live,
            p.branch_id
           FROM (((((public.commission_settlement_line l_1
             JOIN public.commission_settlement s ON (((s.organization_id = l_1.organization_id) AND (s.id = l_1.settlement_id) AND (s.voided_at IS NULL))))
             JOIN public.patient_payment_application a ON (((a.organization_id = l_1.organization_id) AND (a.id = l_1.application_id))))
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id))))
             LEFT JOIN public.org_profile op ON ((op.organization_id = l_1.organization_id)))
          WHERE ((l_1.kind = 'cobro'::text) AND (l_1.voided_at IS NULL))
        ), discounted AS (
         -- Lo que un pago descontó no salió: cuenta en el mes de los cobros de ese pago, como en Reportes.
         SELECT l_1.organization_id,
                CASE
                    WHEN (s.currency = op.currency) THEN (l_1.commission_cents)::numeric
                    ELSE public.org_money_value((l_1.commission_cents)::numeric, (p.amount_cents)::numeric, (p.business_cents)::numeric, (p.currency)::text, op.currency, op.second_currency, op.exchange_factor)
                END AS discount,
            ( SELECT min(c2.occurred_at) AS min
                   FROM public.commission_settlement_line c2
                  WHERE ((c2.organization_id = s.organization_id) AND (c2.settlement_id = s.id) AND (c2.kind = 'cobro'::text) AND (c2.voided_at IS NULL))) AS at,
            s.professional_user_id AS user_id,
            p.branch_id
           FROM ((((public.commission_settlement_line l_1
             JOIN public.commission_settlement s ON (((s.organization_id = l_1.organization_id) AND (s.id = l_1.settlement_id) AND (s.voided_at IS NULL))))
             JOIN public.patient_payment_application a ON (((a.organization_id = l_1.organization_id) AND (a.id = l_1.application_id))))
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             LEFT JOIN public.org_profile op ON ((op.organization_id = l_1.organization_id)))
          WHERE ((l_1.kind = 'ajuste'::text) AND (l_1.voided_at IS NULL) AND (s.kind = 'pago'::text))
        ), line AS (
         SELECT f.organization_id,
            f.user_id,
            f.at,
                CASE
                    WHEN f.live THEN f.base
                    ELSE (0)::numeric
                END AS base,
                CASE
                    WHEN f.live THEN f.commission
                    ELSE (0)::numeric
                END AS commission,
            f.commission AS paid,
            (0)::numeric AS fresh,
            f.branch_id
           FROM frozen f
        UNION ALL
         SELECT d.organization_id,
            d.user_id,
            d.at,
            (0)::numeric,
            (0)::numeric,
            (- d.discount),
            (0)::numeric,
            d.branch_id
           FROM discounted d
          WHERE (d.at IS NOT NULL)
        UNION ALL
         SELECT cl.organization_id,
            cl.professional_user_id,
            cl.at,
            cl.value,
            cl.commission,
            (0)::numeric,
            cl.commission,
            cl.branch_id
           FROM public.commission_live cl
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
     LEFT JOIN public.branch b ON (((b.organization_id = l.organization_id) AND (b.id = l.branch_id))));
