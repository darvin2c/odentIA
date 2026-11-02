-- Lecturas en dos monedas: Reportes y Argos cuentan con el valor congelado de cada
-- cobro y de cada gasto; lo que se debe o falta cobrar, al cambio de hoy.

-- Cuánto es un importe en unidades de su moneda. Cada moneda con sus decimales, los
-- de ICU (`currencyFractionDigits`; una prueba compara las dos listas): antes todo se
-- dividía entre 100 y 45.000 pesos chilenos se veían como 450. No redondea: una parte
-- de un importe congelado sigue exacta para que `sum()` dé el total, y una clínica de
-- una moneda sigue viendo sus dos decimales de siempre.
CREATE FUNCTION public.money_major(cents numeric, moneda text) RETURNS numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT trim_scale(cents / CASE
    WHEN moneda IN ('AFN', 'ALL', 'BIF', 'CLP', 'COP', 'DJF', 'GNF', 'HUF', 'IDR', 'IQD', 'IRR', 'ISK', 'JPY', 'KMF', 'KPW', 'KRW', 'LAK', 'LBP', 'MGA', 'MMK', 'PKR', 'PYG', 'RWF', 'SLL', 'SOS', 'SYP', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF', 'YER') THEN 1::numeric
    WHEN moneda IN ('BHD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') THEN 1000::numeric
    ELSE 100::numeric
  END)
$$;--> statement-breakpoint

-- `money_value` con lo que la clínica sabe: el factor de hoy solo vale para su otra
-- moneda (una moneda vieja que no es esa no tiene valor) y la moneda del negocio no
-- necesita cuenta. Sin `search_path` fijo para que la base la pueda poner dentro de la
-- consulta: una clínica de una moneda no paga una llamada por cada fila.
CREATE FUNCTION public.org_money_value(parte numeric, importe numeric, valor numeric, moneda text, moneda_negocio text, segunda text, factor numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN valor IS NULL AND moneda = moneda_negocio THEN parte
    ELSE public.money_value(parte, importe, valor, moneda, moneda_negocio, CASE WHEN moneda = segunda THEN factor END)
  END
$$;--> statement-breakpoint

-- La comisión de una parte de un pago: floor(a × B × tasa ÷ (A × 10000)), multiplicando
-- antes de dividir, igual que `commissionOfValue` de @odentia/clinical (una prueba
-- compara las dos). Sin valor, la misma regla de `money_value`: la moneda del negocio
-- vale lo que dice, su otra moneda sale del factor y otra cualquiera no entra.
CREATE FUNCTION public.money_commission(parte numeric, importe numeric, valor numeric, moneda text, moneda_negocio text, segunda text, factor numeric, tasa numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN valor IS NOT NULL THEN CASE WHEN importe = 0 THEN 0 ELSE floor((parte * valor * tasa) / (importe * 10000)) END
    WHEN moneda = moneda_negocio THEN floor((parte * tasa) / 10000)
    WHEN moneda = segunda AND factor IS NOT NULL THEN floor((parte * factor * tasa) / 10000)
  END
$$;--> statement-breakpoint

-- Quien usa una vista debe poder llamar a sus funciones: también cada llave de Argos.
REVOKE ALL ON FUNCTION public.money_major(numeric, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.org_money_value(numeric, numeric, numeric, text, text, text, numeric) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.money_commission(numeric, numeric, numeric, text, text, text, numeric, numeric) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.money_major(numeric, text) TO dentalagent_app, argos_dueno, argos_gestion, argos_recepcion, argos_clinico, argos_caja;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.org_money_value(numeric, numeric, numeric, text, text, text, numeric) TO dentalagent_app, argos_dueno, argos_gestion, argos_recepcion, argos_clinico, argos_caja;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.money_commission(numeric, numeric, numeric, text, text, text, numeric, numeric) TO dentalagent_app, argos_dueno, argos_gestion, argos_recepcion, argos_clinico, argos_caja;--> statement-breakpoint

-- Lo usado a favor con el proveedor también paga una compra (`purchase-balance.ts`).
GRANT SELECT ON TABLE public.supplier_credit_use TO argos_dueno;--> statement-breakpoint

-- Las vistas de Argos: todo el dinero en moneda del negocio, para que `sum()` no pueda
-- mezclar. Lo que ya pasó, con el valor de su día; lo que se debe o falta cobrar, al
-- cambio de hoy. El importe en la otra moneda va al final, nulo en moneda del negocio
-- («_otra_moneda»), con `otra_moneda`. Las columnas nuevas van al final: la vista
-- conserva las suyas y sus GRANT. Lo viejo en otra moneda sin factor no tiene valor y
-- no entra en las sumas, igual que en Reportes.

CREATE OR REPLACE VIEW argos.cobros AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.tipo,
  public.money_major(public.org_money_value(x.cents, x.amount, x.business, x.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
  x.medio, b.name AS sede, pp.display_name AS paciente, x.patient_id AS paciente_id,
  public.money_major(public.org_money_value(x.tax_cents, x.amount, x.business, x.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS impuesto,
  CASE WHEN x.entered_currency <> op.currency THEN public.money_major(x.entered, x.entered_currency) END AS importe_otra_moneda,
  CASE WHEN x.entered_currency <> op.currency THEN x.entered_currency END AS otra_moneda
FROM (
  SELECT pay.organization_id, pay.paid_at AS momento, 'pago' AS tipo, pay.amount_cents AS cents, pay.method_name AS medio, pay.branch_id, pay.patient_id,
    pay.tax_cents, pay.amount_cents AS amount, pay.business_cents AS business, pay.currency::text AS currency, COALESCE(pay.tender_cents, pay.amount_cents)::numeric AS entered, COALESCE(pay.tender_currency, pay.currency)::text AS entered_currency
  FROM public.patient_payment pay
  UNION ALL
  SELECT pay.organization_id, pay.voided_at, 'anulacion', -pay.amount_cents, pay.method_name, pay.branch_id, pay.patient_id, -pay.tax_cents,
    pay.amount_cents AS amount, pay.business_cents AS business, pay.currency::text AS currency, -COALESCE(pay.tender_cents, pay.amount_cents)::numeric, COALESCE(pay.tender_currency, pay.currency)::text
  FROM public.patient_payment pay WHERE pay.voided_at IS NOT NULL
  UNION ALL
  SELECT r.organization_id, r.refunded_at, 'devolucion', -r.amount_cents, pay.method_name, pay.branch_id, r.patient_id, -r.tax_cents,
    pay.amount_cents AS amount, pay.business_cents AS business, pay.currency::text AS currency, -(COALESCE(pay.tender_cents, pay.amount_cents)::numeric * r.amount_cents / NULLIF(pay.amount_cents, 0)), COALESCE(pay.tender_currency, pay.currency)::text
  FROM public.patient_payment_refund r JOIN public.patient_payment pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
) x
JOIN public.patient p ON p.organization_id = x.organization_id AND p.id = x.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;--> statement-breakpoint

-- Comisiones: lo cobrado de lo que atendió con su valor y su porcentaje; lo pagado, como se pagó.
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
     LEFT JOIN public.branch b ON (((b.organization_id = l.organization_id) AND (b.id = l.branch_id))))
  WHERE (EXISTS ( SELECT 1
           FROM public.member m
          WHERE ((m.organization_id = l.organization_id) AND (m.user_id = l.user_id))));--> statement-breakpoint

-- Compras: lo pagado con su valor, también lo usado a favor; lo que falta, al cambio de hoy.
CREATE OR REPLACE VIEW argos.compras AS
 SELECT po.order_number AS numero,
    s.name AS proveedor,
    b.name AS sede,
    po.status AS estado,
    po.created_at AS creada_en,
    ((po.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    public.money_major(public.org_money_value(pl.ordered, NULL, NULL, po.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS total,
    public.money_major(public.org_money_value(pl.received, NULL, NULL, po.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS recibido,
    public.money_major(COALESCE(paid.value, 0) + COALESCE(public.org_money_value(favor.cents, NULL, NULL, po.currency, op.currency, op.second_currency, op.exchange_factor), 0), op.currency) AS pagado,
    public.money_major(public.org_money_value(CASE WHEN po.status = 'cancelada' THEN 0 ELSE GREATEST(pl.received - paid.cents - favor.cents, 0) END, NULL, NULL, po.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS por_pagar,
    CASE WHEN po.currency <> op.currency THEN public.money_major(pl.ordered, po.currency) END AS total_otra_moneda,
    CASE WHEN po.currency <> op.currency THEN po.currency END AS otra_moneda
   FROM ((((public.purchase_order po
     JOIN public.supplier s ON (((s.organization_id = po.organization_id) AND (s.id = po.supplier_id))))
     JOIN public.warehouse w ON (((w.organization_id = po.organization_id) AND (w.id = po.warehouse_id))))
     JOIN public.branch b ON (((b.organization_id = w.organization_id) AND (b.id = w.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = po.organization_id)))
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(l.quantity * l.unit_cost_cents), (0)::bigint) AS ordered,
            COALESCE(sum(l.received_quantity * l.unit_cost_cents), (0)::bigint) AS received
           FROM public.purchase_order_line l
          WHERE ((l.organization_id = po.organization_id) AND (l.order_id = po.id))) pl ON (true)
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(e.amount_cents), (0)::bigint) AS cents,
            sum(public.org_money_value(e.amount_cents, e.amount_cents, e.business_cents, e.currency, op.currency, op.second_currency, op.exchange_factor)) AS value
           FROM public.expense e
          WHERE ((e.organization_id = po.organization_id) AND (e.purchase_order_id = po.id) AND (e.voided_at IS NULL))) paid ON (true)
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(c.amount_cents), (0)::bigint) AS cents
           FROM public.supplier_credit_use c
          WHERE ((c.organization_id = po.organization_id) AND (c.order_id = po.id) AND (c.voided_at IS NULL))) favor ON (true);--> statement-breakpoint

CREATE OR REPLACE VIEW argos.compras_detalle AS
 SELECT po.order_number AS numero,
    s.name AS proveedor,
    b.name AS sede,
    po.status AS estado,
    po.created_at AS creada_en,
    ((po.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    pr.name AS producto,
    pr.unit AS unidad,
    l.quantity AS cantidad,
    l.received_quantity AS recibida,
    public.money_major(public.org_money_value(l.unit_cost_cents, NULL, NULL, po.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS precio,
    public.money_major(public.org_money_value(l.quantity * l.unit_cost_cents, NULL, NULL, po.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS total,
    CASE WHEN po.currency <> op.currency THEN public.money_major(l.quantity * l.unit_cost_cents, po.currency) END AS total_otra_moneda,
    CASE WHEN po.currency <> op.currency THEN po.currency END AS otra_moneda
   FROM ((((((public.purchase_order_line l
     JOIN public.purchase_order po ON (((po.organization_id = l.organization_id) AND (po.id = l.order_id))))
     JOIN public.product pr ON (((pr.organization_id = l.organization_id) AND (pr.id = l.product_id))))
     JOIN public.supplier s ON (((s.organization_id = po.organization_id) AND (s.id = po.supplier_id))))
     JOIN public.warehouse w ON (((w.organization_id = po.organization_id) AND (w.id = po.warehouse_id))))
     JOIN public.branch b ON (((b.organization_id = w.organization_id) AND (b.id = w.branch_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = po.organization_id)));--> statement-breakpoint

-- Lo que debe cada paciente, por moneda: una fila por paciente y moneda. Lo que tiene a
-- favor no se cruza entre monedas. Todo al cambio de hoy; contar personas es contar
-- pacientes distintos.
CREATE OR REPLACE VIEW argos.deudas AS
 WITH charge AS (
         SELECT c.organization_id,
            c.patient_id,
            c.currency::text AS currency,
            c.created_at,
            (c.amount_cents - COALESCE(( SELECT sum(a.amount_cents) AS sum
                   FROM (public.patient_payment_application a
                     JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
                  WHERE ((a.organization_id = c.organization_id) AND (a.charge_id = c.id) AND (a.voided_at IS NULL))), (0)::bigint)) AS unpaid
           FROM public.patient_charge c
          WHERE (c.voided_at IS NULL)
        ), credit AS (
         SELECT pay.organization_id,
            pay.patient_id,
            pay.currency::text AS currency,
            (((sum(pay.amount_cents))::numeric - COALESCE(sum(( SELECT sum(a.amount_cents) AS sum
                   FROM public.patient_payment_application a
                  WHERE ((a.organization_id = pay.organization_id) AND (a.payment_id = pay.id) AND (a.voided_at IS NULL)))), (0)::numeric)) - COALESCE(sum(( SELECT sum(r.amount_cents) AS sum
                   FROM public.patient_payment_refund r
                  WHERE ((r.organization_id = pay.organization_id) AND (r.payment_id = pay.id)))), (0)::numeric)) AS cents
           FROM public.patient_payment pay
          WHERE (pay.voided_at IS NULL)
          GROUP BY pay.organization_id, pay.patient_id, (pay.currency::text)
        ), owed AS (
         SELECT ch.organization_id,
            ch.patient_id,
            ch.currency,
            sum(ch.unpaid) FILTER (WHERE (ch.unpaid > 0)) AS unpaid,
            min(ch.created_at) FILTER (WHERE (ch.unpaid > 0)) AS since
           FROM charge ch
          GROUP BY ch.organization_id, ch.patient_id, ch.currency
        ), due AS (
         SELECT o_1.organization_id,
            o_1.patient_id,
            o_1.currency,
            o_1.unpaid,
            o_1.since,
            GREATEST(COALESCE(cr.cents, (0)::numeric), (0)::numeric) AS favor
           FROM (owed o_1
             LEFT JOIN credit cr ON (((cr.organization_id = o_1.organization_id) AND (cr.patient_id = o_1.patient_id) AND (cr.currency = o_1.currency))))
        )
 SELECT o.patient_id AS paciente_id,
    pp.display_name AS paciente,
    public.money_major(public.org_money_value(o.unpaid, NULL, NULL, o.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS debe,
    public.money_major(public.org_money_value(o.favor, NULL, NULL, o.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS a_favor,
    public.money_major(public.org_money_value(o.unpaid - o.favor, NULL, NULL, o.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS saldo,
    (o.since < (now() - '30 days'::interval)) AS vencida,
    ((o.since AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS desde,
    ((now())::date - (o.since)::date) AS dias,
    CASE WHEN o.currency <> op.currency THEN public.money_major(o.unpaid - o.favor, o.currency) END AS saldo_otra_moneda,
    CASE WHEN o.currency <> op.currency THEN o.currency END AS otra_moneda
   FROM (((due o
     JOIN public.patient p ON (((p.organization_id = o.organization_id) AND (p.id = o.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = o.organization_id)))
  WHERE (o.unpaid > o.favor);--> statement-breakpoint

-- Gastos, con el valor de su día; lo que salió en otra moneda va al final.
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
        UNION ALL
         SELECT e.organization_id,
            e.id,
            e.voided_at,
            e.category,
            -1,
            e.branch_id,
            e.purchase_order_id,
            e.sales_tax,
            e.amount_cents AS amount, e.business_cents AS business, e.currency::text AS currency, COALESCE(e.tender_cents, e.amount_cents) AS out_cents, COALESCE(e.tender_currency, e.currency)::text AS out_currency
           FROM public.expense e
          WHERE (e.voided_at IS NOT NULL)) x
     LEFT JOIN public.org_profile op ON ((op.organization_id = x.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = x.organization_id) AND (b.id = x.branch_id))));--> statement-breakpoint

-- Lo presupuestado no se cobró: al cambio de hoy, línea por línea.
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
    CASE WHEN i.currency::text <> op.currency THEN i.currency::text END AS otra_moneda
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
  WHERE ((b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL));--> statement-breakpoint

CREATE OR REPLACE VIEW argos.oportunidades AS
 SELECT o.created_at AS creada_en,
    ((o.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    st.name AS etapa,
    st.moment AS momento,
    o.status AS estado,
    s.name AS servicio,
    public.money_major(public.org_money_value(o.amount_cents, NULL, NULL, o.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS valor,
    o.closed_at AS cerrada_en,
    o.close_reason AS motivo_cierre,
    pp.display_name AS persona,
    o.contact_id AS persona_id,
    ( SELECT p.id
           FROM public.patient p
          WHERE ((p.organization_id = o.organization_id) AND (p.person_id = o.contact_id))
         LIMIT 1) AS paciente_id,
    u.name AS responsable,
    CASE WHEN o.currency <> op.currency THEN public.money_major(o.amount_cents, o.currency) END AS valor_otra_moneda,
    CASE WHEN o.currency::text <> op.currency THEN o.currency::text END AS otra_moneda
   FROM (((((public.opportunity o
     JOIN public.contact pp ON (((pp.organization_id = o.organization_id) AND (pp.id = o.contact_id))))
     LEFT JOIN public.pipeline_stage st ON (((st.organization_id = o.organization_id) AND (st.id = o.stage_id))))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = o.organization_id) AND (s.id = o.service_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = o.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = o.assigned_user_id)))
  WHERE ((pp.screen IS NULL) AND (NOT pp.is_test));--> statement-breakpoint

-- Lo pagado de cada venta, con el valor de su pago; lo que entró en otra moneda va al final.
CREATE OR REPLACE VIEW argos.pagos_por_venta AS
 SELECT pay.paid_at AS pagado_en,
    ((pay.paid_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    public.money_major(public.org_money_value(a.amount_cents, pay.amount_cents, pay.business_cents, pay.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
    COALESCE(sep.name, spi.name, pr.name, c.description) AS concepto,
        CASE
            WHEN (c.product_id IS NULL) THEN 'tratamiento'::text
            ELSE 'producto'::text
        END AS tipo,
    COALESCE(c.product_quantity, (ep.quantity)::integer, 1) AS cantidad,
    u.name AS profesional,
    b.name AS sede,
    pp.display_name AS paciente,
    c.patient_id AS paciente_id,
    pay.method_name AS medio,
    c.id AS venta_id,
    os.name AS especialidad,
    CASE WHEN COALESCE(pay.tender_currency, pay.currency)::text <> op.currency THEN public.money_major(COALESCE(pay.tender_cents, pay.amount_cents)::numeric * a.amount_cents / NULLIF(pay.amount_cents, 0), COALESCE(pay.tender_currency, pay.currency)::text) END AS importe_otra_moneda,
    CASE WHEN COALESCE(pay.tender_currency, pay.currency)::text <> op.currency THEN COALESCE(pay.tender_currency, pay.currency)::text END AS otra_moneda
   FROM ((((((((((((((((public.patient_payment_application a
     JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
     JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id) AND (c.voided_at IS NULL))))
     JOIN public.patient p ON (((p.organization_id = c.organization_id) AND (p.id = c.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = a.organization_id)))
     LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
     LEFT JOIN public.encounter e ON (((e.organization_id = c.organization_id) AND (e.id = ep.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.service_catalog sep ON (((sep.organization_id = c.organization_id) AND (sep.id = ep.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = c.organization_id) AND (pi.id = c.plan_item_id))))
     LEFT JOIN public.service_catalog spi ON (((spi.organization_id = c.organization_id) AND (spi.id = pi.service_id))))
     LEFT JOIN public.product pr ON (((pr.organization_id = c.organization_id) AND (pr.id = c.product_id))))
     LEFT JOIN public.branch b ON (((b.organization_id = c.organization_id) AND (b.id = c.branch_id))))
     LEFT JOIN public.treatment_budget_item bi ON (((bi.organization_id = c.organization_id) AND (bi.id = c.budget_item_id))))
     LEFT JOIN public.service_catalog sx ON (((sx.organization_id = c.organization_id) AND (sx.id = COALESCE(ep.service_id, bi.service_id, pi.service_id)))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = sx.organization_id) AND (os.id = sx.specialty_id))))
  WHERE (a.voided_at IS NULL);--> statement-breakpoint

-- El precio de un tratamiento indicado, al cambio de hoy.
CREATE OR REPLACE VIEW argos.planes AS
 SELECT pi.plan_id,
    pp.display_name AS paciente,
    pi.patient_id AS paciente_id,
    s.name AS tratamiento,
    os.name AS especialidad,
    pi.decision_status AS decision,
    pi.status AS estado,
    pi.created_at AS indicado_en,
    pi.decided_at AS decidido_en,
    pi.started_at AS iniciado_en,
    pi.completed_at AS terminado_en,
    public.money_major(public.org_money_value(pi.price_cents, NULL, NULL, pi.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS precio,
    pi.phase AS fase,
    u.name AS indicado_por,
    CASE WHEN pi.currency <> op.currency THEN public.money_major(pi.price_cents, pi.currency) END AS precio_otra_moneda,
    CASE WHEN pi.currency::text <> op.currency THEN pi.currency::text END AS otra_moneda
   FROM ((((((public.treatment_plan_item pi
     JOIN public.patient p ON (((p.organization_id = pi.organization_id) AND (p.id = pi.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = pi.organization_id) AND (s.id = pi.service_id))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = s.organization_id) AND (os.id = s.specialty_id))))
     LEFT JOIN auth."user" u ON ((u.id = pi.created_by)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = pi.organization_id)))
  WHERE (pi.status <> 'reemplazado'::text);--> statement-breakpoint

-- Un presupuesto por fila: lo que vale cada línea en su moneda, sumado al cambio de hoy.
CREATE OR REPLACE VIEW argos.presupuestos AS
 WITH line AS (
         SELECT i.organization_id,
            i.budget_id,
            i.decision,
            i.currency::text AS currency,
            (i.price_cents * CASE
            WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
            ELSE 1
        END) AS cents
           FROM public.treatment_budget_item i
          WHERE ((i.price_cents IS NOT NULL) AND (i.option_id = ( SELECT o.id
           FROM public.treatment_budget_option o
          WHERE ((o.organization_id = i.organization_id) AND (o.budget_id = i.budget_id))
          ORDER BY (o.decision = 'elegida'::text) DESC, o.is_recommended DESC, o."position"
         LIMIT 1)))
        )
 SELECT b.id AS presupuesto_id,
    b.budget_number AS numero,
    pp.display_name AS paciente,
    b.patient_id AS paciente_id,
    b.presented_at AS presentado_en,
    ((b.presented_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS presentado_dia,
    b.status AS estado,
    b.decided_at AS decidido_en,
    u.name AS profesional,
    public.money_major(COALESCE(sum(public.org_money_value(l.cents, NULL, NULL, l.currency, op.currency, op.second_currency, op.exchange_factor)), (0)::numeric), op.currency) AS valor,
    public.money_major(COALESCE(sum(public.org_money_value(l.cents, NULL, NULL, l.currency, op.currency, op.second_currency, op.exchange_factor)) FILTER (WHERE (l.decision = 'aceptado'::text)), (0)::numeric), op.currency) AS aceptado,
    public.money_major(COALESCE(sum(public.org_money_value(l.cents, NULL, NULL, l.currency, op.currency, op.second_currency, op.exchange_factor)) FILTER (WHERE (l.decision = ANY (ARRAY['pendiente'::text, 'pospuesto'::text]))), (0)::numeric), op.currency) AS sin_decidir,
    ((b.status = ANY (ARRAY['presentado'::text, 'pospuesto'::text])) OR ((b.status = 'parcial'::text) AND (EXISTS ( SELECT 1
           FROM public.treatment_budget_item x
          WHERE ((x.organization_id = b.organization_id) AND (x.budget_id = b.id) AND (x.decision = 'pospuesto'::text)))))) AS espera_respuesta,
    public.money_major(sum(l.cents) FILTER (WHERE (l.currency <> op.currency)), min(l.currency) FILTER (WHERE (l.currency <> op.currency))) AS valor_otra_moneda,
    min(l.currency) FILTER (WHERE (l.currency <> op.currency)) AS otra_moneda
   FROM (((((public.treatment_budget b
     JOIN public.patient p ON (((p.organization_id = b.organization_id) AND (p.id = b.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = b.organization_id)))
     LEFT JOIN line l ON (((l.organization_id = b.organization_id) AND (l.budget_id = b.id))))
     LEFT JOIN auth."user" u ON ((u.id = b.created_by)))
  WHERE ((b.status <> 'borrador'::text) AND (b.presented_at IS NOT NULL))
  GROUP BY b.id, b.budget_number, pp.display_name, b.patient_id, b.presented_at, op.timezone, b.status, b.decided_at, u.name, b.organization_id, op.currency, op.second_currency, op.exchange_factor;--> statement-breakpoint

-- Lo que esa persona pagó desde entonces, con el valor de cada pago; el descuento, al cambio de hoy.
CREATE OR REPLACE VIEW argos.promociones_uso AS
 SELECT x.promocion,
    pp.display_name AS paciente,
    x.patient_id AS paciente_id,
    x.fecha,
    x.aceptado,
    public.money_major(public.org_money_value(x.discount, NULL, NULL, x.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS descuento,
    (NOT (EXISTS ( SELECT 1
           FROM public.appointment a
          WHERE ((a.organization_id = x.organization_id) AND (a.patient_id = x.patient_id) AND (a.status = 'atendida'::text) AND (a.starts_at < (x.fecha - '1 day'::interval)))))) AS paciente_nuevo,
    public.money_major(COALESCE(( SELECT sum(public.org_money_value(pay.amount_cents, pay.amount_cents, pay.business_cents, pay.currency, op.currency, op.second_currency, op.exchange_factor)) AS sum FROM public.patient_payment pay WHERE ((pay.organization_id = x.organization_id) AND (pay.patient_id = x.patient_id) AND (pay.voided_at IS NULL) AND (pay.paid_at >= x.fecha))), (0)::numeric) - COALESCE(( SELECT sum(public.org_money_value(r.amount_cents, pay.amount_cents, pay.business_cents, pay.currency, op.currency, op.second_currency, op.exchange_factor)) AS sum FROM (public.patient_payment_refund r JOIN public.patient_payment pay ON (((pay.organization_id = r.organization_id) AND (pay.id = r.payment_id)))) WHERE ((r.organization_id = x.organization_id) AND (r.patient_id = x.patient_id) AND (pay.voided_at IS NULL) AND (pay.paid_at >= x.fecha))), (0)::numeric), op.currency) AS cobrado_desde_entonces,
    u.name AS profesional
   FROM ((((( SELECT b.organization_id,
            i.promotion_name AS promocion,
            b.patient_id,
            b.presented_at AS fecha,
            ((b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text])) AND (i.decision = 'aceptado'::text)) AS aceptado,
            (GREATEST((COALESCE(i.tariff_price_cents, i.price_cents) - i.price_cents), 0) * CASE
            WHEN (i.billing_mode = 'session'::text) THEN GREATEST(COALESCE((i.sessions_planned)::integer, 1), 1)
            ELSE 1
        END) AS discount,
            pi.created_by AS professional_user_id,
            i.currency::text AS currency
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
            e.professional_user_id,
            c.currency::text
           FROM ((public.patient_charge c
             LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
             LEFT JOIN public.encounter e ON (((e.organization_id = ep.organization_id) AND (e.id = ep.encounter_id))))
          WHERE ((c.promotion_id IS NOT NULL) AND (c.voided_at IS NULL))) x
     JOIN public.patient p ON (((p.organization_id = x.organization_id) AND (p.id = x.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN auth."user" u ON ((u.id = x.professional_user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = x.organization_id)));--> statement-breakpoint

-- Un ticket vale lo que valen sus pagos; sin pagos (todo con saldo a favor), al cambio de hoy.
CREATE OR REPLACE VIEW argos.tickets AS
 SELECT t.ticket_number AS numero,
    t.created_at AS emitido_en,
    ((t.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    b.name AS sede,
    pp.display_name AS paciente,
    t.patient_id AS paciente_id,
    public.money_major(CASE WHEN t.currency = op.currency THEN (t.total_cents)::numeric ELSE public.org_money_value(t.total_cents, ( SELECT sum(pay.amount_cents) FROM public.patient_payment pay WHERE ((pay.organization_id = t.organization_id) AND (pay.ticket_id = t.id))), ( SELECT sum(pay.business_cents) FROM public.patient_payment pay WHERE ((pay.organization_id = t.organization_id) AND (pay.ticket_id = t.id))), t.currency, op.currency, op.second_currency, op.exchange_factor) END, op.currency) AS total,
    public.money_major(CASE WHEN t.currency = op.currency THEN (t.credit_applied_cents)::numeric ELSE public.org_money_value(t.credit_applied_cents, ( SELECT sum(pay.amount_cents) FROM public.patient_payment pay WHERE ((pay.organization_id = t.organization_id) AND (pay.ticket_id = t.id))), ( SELECT sum(pay.business_cents) FROM public.patient_payment pay WHERE ((pay.organization_id = t.organization_id) AND (pay.ticket_id = t.id))), t.currency, op.currency, op.second_currency, op.exchange_factor) END, op.currency) AS a_favor_usado,
    (t.voided_at IS NOT NULL) AS anulado,
    CASE WHEN t.currency <> op.currency THEN public.money_major(t.total_cents, t.currency) END AS total_otra_moneda,
    CASE WHEN t.currency::text <> op.currency THEN t.currency::text END AS otra_moneda
   FROM ((((public.payment_ticket t
     JOIN public.patient p ON (((p.organization_id = t.organization_id) AND (p.id = t.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = t.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = t.organization_id) AND (b.id = t.branch_id))));--> statement-breakpoint

-- El precio de lo realizado, al cambio de hoy: lo que se cobró de eso está en cobros.
CREATE OR REPLACE VIEW argos.tratamientos_hechos AS
 SELECT e.started_at AS fecha,
    ((e.started_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    pp.display_name AS paciente,
    e.patient_id AS paciente_id,
    u.name AS profesional,
    b.name AS sede,
    s.name AS tratamiento,
    t.specialty AS tipo_tratamiento,
    os.name AS especialidad,
    ep.quantity AS cantidad,
    public.money_major(public.org_money_value(ep.price_cents, NULL, NULL, ep.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS precio,
    CASE WHEN ep.currency <> op.currency THEN public.money_major(ep.price_cents, ep.currency) END AS precio_otra_moneda,
    CASE WHEN ep.currency::text <> op.currency THEN ep.currency::text END AS otra_moneda
   FROM (((((((((public.encounter_procedure ep
     JOIN public.encounter e ON (((e.organization_id = ep.organization_id) AND (e.id = ep.encounter_id) AND (e.status = 'finalizada'::text))))
     JOIN public.patient p ON (((p.organization_id = e.organization_id) AND (p.id = e.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = ep.organization_id)))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = e.organization_id) AND (b.id = e.branch_id))))
     LEFT JOIN public.service_catalog s ON (((s.organization_id = ep.organization_id) AND (s.id = ep.service_id))))
     LEFT JOIN catalog.treatment_template t ON ((t.id = s.template_id)))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = s.organization_id) AND (os.id = s.specialty_id))))
  WHERE (ep.voided_at IS NULL);--> statement-breakpoint

-- Una venta: lo pagado con el valor de cada pago, lo que falta al cambio de hoy, y su
-- importe es la suma de las dos cosas (lo pagado más el saldo sigue dando el importe).
CREATE OR REPLACE VIEW argos.ventas AS
 SELECT c.id AS venta_id,
    c.created_at AS cargado_en,
    ((c.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    c.patient_id AS paciente_id,
    pp.display_name AS paciente,
    COALESCE(sep.name, spi.name, pr.name, c.description) AS concepto,
        CASE
            WHEN (c.product_id IS NULL) THEN 'tratamiento'::text
            ELSE 'producto'::text
        END AS tipo,
    COALESCE(c.product_quantity, (ep.quantity)::integer, 1) AS cantidad,
    public.money_major(COALESCE(ap.value, (0)::numeric) + public.org_money_value(c.amount_cents - COALESCE(ap.cents, (0)::bigint), NULL, NULL, c.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
    public.money_major(COALESCE(ap.value, (0)::numeric), op.currency) AS pagado,
    public.money_major(public.org_money_value(c.amount_cents - COALESCE(ap.cents, (0)::bigint), NULL, NULL, c.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS saldo,
    b.name AS sede,
    u.name AS profesional,
    c.promotion_name AS promocion,
    os.name AS especialidad,
    CASE WHEN c.currency <> op.currency THEN public.money_major(c.amount_cents, c.currency) END AS importe_otra_moneda,
    CASE WHEN c.currency::text <> op.currency THEN c.currency::text END AS otra_moneda
   FROM (((((((((((((((public.patient_charge c
     JOIN public.patient p ON (((p.organization_id = c.organization_id) AND (p.id = c.patient_id))))
     JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = c.organization_id)))
     LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
     LEFT JOIN public.encounter e ON (((e.organization_id = c.organization_id) AND (e.id = ep.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.service_catalog sep ON (((sep.organization_id = c.organization_id) AND (sep.id = ep.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = c.organization_id) AND (pi.id = c.plan_item_id))))
     LEFT JOIN public.service_catalog spi ON (((spi.organization_id = c.organization_id) AND (spi.id = pi.service_id))))
     LEFT JOIN public.product pr ON (((pr.organization_id = c.organization_id) AND (pr.id = c.product_id))))
     LEFT JOIN public.branch b ON (((b.organization_id = c.organization_id) AND (b.id = c.branch_id))))
     LEFT JOIN public.treatment_budget_item bi ON (((bi.organization_id = c.organization_id) AND (bi.id = c.budget_item_id))))
     LEFT JOIN public.service_catalog sx ON (((sx.organization_id = c.organization_id) AND (sx.id = COALESCE(ep.service_id, bi.service_id, pi.service_id)))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = sx.organization_id) AND (os.id = sx.specialty_id))))
     LEFT JOIN LATERAL ( SELECT sum(a.amount_cents) AS cents,
            sum(public.org_money_value(a.amount_cents, pay.amount_cents, pay.business_cents, pay.currency, op.currency, op.second_currency, op.exchange_factor)) AS value
           FROM (public.patient_payment_application a
             JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
          WHERE ((a.organization_id = c.organization_id) AND (a.charge_id = c.id) AND (a.voided_at IS NULL))) ap ON (true))
  WHERE (c.voided_at IS NULL);
