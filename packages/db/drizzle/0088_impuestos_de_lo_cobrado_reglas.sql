-- Impuestos de lo cobrado (ADR 0083) en las vistas de Argos, para que «lo que deja» cuadre con Reportes.
-- argos.cobros suma al final «impuesto»: la parte del importe que es impuesto (el IGV de un pago, su
-- anulación y la parte de una devolución). argos.gastos marca el pago de ese impuesto con su propio tipo:
-- no resta de lo que deja, porque ya salió de lo cobrado. Las columnas de antes no cambian.
CREATE OR REPLACE VIEW argos.cobros AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.tipo, round(x.cents / 100.0, 2) AS importe,
  x.medio, b.name AS sede, pp.display_name AS paciente, x.patient_id AS paciente_id, round(x.tax_cents / 100.0, 2) AS impuesto
FROM (
  SELECT pay.organization_id, pay.paid_at AS momento, 'pago' AS tipo, pay.amount_cents AS cents, pay.method_name AS medio, pay.branch_id, pay.patient_id,
    pay.tax_cents
  FROM public.patient_payment pay
  UNION ALL
  SELECT pay.organization_id, pay.voided_at, 'anulacion', -pay.amount_cents, pay.method_name, pay.branch_id, pay.patient_id, -pay.tax_cents
  FROM public.patient_payment pay WHERE pay.voided_at IS NOT NULL
  UNION ALL
  SELECT r.organization_id, r.refunded_at, 'devolucion', -r.amount_cents, pay.method_name, pay.branch_id, r.patient_id, -r.tax_cents
  FROM public.patient_payment_refund r JOIN public.patient_payment pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
) x
JOIN public.patient p ON p.organization_id = x.organization_id AND p.id = x.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;--> statement-breakpoint

CREATE OR REPLACE VIEW argos.gastos AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.categoria,
  CASE WHEN EXISTS (SELECT 1 FROM public.commission_settlement s WHERE s.organization_id = x.organization_id AND s.expense_id = x.id) THEN 'pago_de_comisiones'
    WHEN x.purchase_order_id IS NOT NULL THEN 'pago_de_compra'
    WHEN x.sales_tax THEN 'pago_del_impuesto_de_lo_cobrado' ELSE 'gasto' END AS tipo,
  round(x.cents / 100.0, 2) AS monto, b.name AS sede
FROM (
  SELECT e.organization_id, e.id, e.spent_at AS momento, e.category AS categoria, e.amount_cents AS cents, e.branch_id, e.purchase_order_id, e.sales_tax
  FROM public.expense e
  UNION ALL
  SELECT e.organization_id, e.id, e.voided_at, e.category, -e.amount_cents, e.branch_id, e.purchase_order_id, e.sales_tax
  FROM public.expense e WHERE e.voided_at IS NOT NULL
) x
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;
