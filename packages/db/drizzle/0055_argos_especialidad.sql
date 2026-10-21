-- Argos (ADR 0075): la especialidad de lo vendido y de lo pagado, para «¿qué especialidad genera más ingresos?».
-- Es la del servicio del tratamiento (el de la atención, el del presupuesto o el del plan), como Reportes; null en productos
-- y en lo que no tiene servicio. Va al final: una vista se reemplaza sin cambiar sus columnas de antes.
CREATE OR REPLACE VIEW argos.ventas AS
SELECT c.id AS venta_id, c.created_at AS cargado_en, (c.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia,
  c.patient_id AS paciente_id, pp.display_name AS paciente,
  coalesce(sep.name, spi.name, pr.name, c.description) AS concepto,
  CASE WHEN c.product_id IS NULL THEN 'tratamiento' ELSE 'producto' END AS tipo,
  coalesce(c.product_quantity, ep.quantity, 1) AS cantidad,
  round(c.amount_cents / 100.0, 2) AS importe,
  round(coalesce(ap.cents, 0) / 100.0, 2) AS pagado,
  round((c.amount_cents - coalesce(ap.cents, 0)) / 100.0, 2) AS saldo,
  b.name AS sede, u.name AS profesional, c.promotion_name AS promocion,
  os.name AS especialidad
FROM public.patient_charge c
JOIN public.patient p ON p.organization_id = c.organization_id AND p.id = c.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = c.organization_id
LEFT JOIN public.encounter_procedure ep ON ep.organization_id = c.organization_id AND ep.id = c.encounter_procedure_id
LEFT JOIN public.encounter e ON e.organization_id = c.organization_id AND e.id = ep.encounter_id
LEFT JOIN auth."user" u ON u.id = e.dentist_user_id
LEFT JOIN public.service_catalog sep ON sep.organization_id = c.organization_id AND sep.id = ep.service_id
LEFT JOIN public.treatment_plan_item pi ON pi.organization_id = c.organization_id AND pi.id = c.plan_item_id
LEFT JOIN public.service_catalog spi ON spi.organization_id = c.organization_id AND spi.id = pi.service_id
LEFT JOIN public.product pr ON pr.organization_id = c.organization_id AND pr.id = c.product_id
LEFT JOIN public.branch b ON b.organization_id = c.organization_id AND b.id = c.branch_id
LEFT JOIN public.treatment_budget_item bi ON bi.organization_id = c.organization_id AND bi.id = c.budget_item_id
LEFT JOIN public.service_catalog sx ON sx.organization_id = c.organization_id AND sx.id = coalesce(ep.service_id, bi.service_id, pi.service_id)
LEFT JOIN public.org_specialty os ON os.organization_id = sx.organization_id AND os.id = sx.specialty_id
LEFT JOIN LATERAL (SELECT sum(a.amount_cents) AS cents FROM public.patient_payment_application a
  JOIN public.patient_payment pay ON pay.organization_id = a.organization_id AND pay.id = a.payment_id AND pay.voided_at IS NULL
  WHERE a.organization_id = c.organization_id AND a.charge_id = c.id AND a.voided_at IS NULL) ap ON true
WHERE c.voided_at IS NULL;--> statement-breakpoint
CREATE OR REPLACE VIEW argos.pagos_por_venta AS
SELECT pay.paid_at AS pagado_en, (pay.paid_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, round(a.amount_cents / 100.0, 2) AS importe,
  coalesce(sep.name, spi.name, pr.name, c.description) AS concepto, CASE WHEN c.product_id IS NULL THEN 'tratamiento' ELSE 'producto' END AS tipo,
  coalesce(c.product_quantity, ep.quantity, 1) AS cantidad, u.name AS profesional, b.name AS sede, pp.display_name AS paciente, c.patient_id AS paciente_id, pay.method_name AS medio,
  c.id AS venta_id, os.name AS especialidad
FROM public.patient_payment_application a
JOIN public.patient_payment pay ON pay.organization_id = a.organization_id AND pay.id = a.payment_id AND pay.voided_at IS NULL
JOIN public.patient_charge c ON c.organization_id = a.organization_id AND c.id = a.charge_id AND c.voided_at IS NULL
JOIN public.patient p ON p.organization_id = c.organization_id AND p.id = c.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = a.organization_id
LEFT JOIN public.encounter_procedure ep ON ep.organization_id = c.organization_id AND ep.id = c.encounter_procedure_id
LEFT JOIN public.encounter e ON e.organization_id = c.organization_id AND e.id = ep.encounter_id
LEFT JOIN auth."user" u ON u.id = e.dentist_user_id
LEFT JOIN public.service_catalog sep ON sep.organization_id = c.organization_id AND sep.id = ep.service_id
LEFT JOIN public.treatment_plan_item pi ON pi.organization_id = c.organization_id AND pi.id = c.plan_item_id
LEFT JOIN public.service_catalog spi ON spi.organization_id = c.organization_id AND spi.id = pi.service_id
LEFT JOIN public.product pr ON pr.organization_id = c.organization_id AND pr.id = c.product_id
LEFT JOIN public.branch b ON b.organization_id = c.organization_id AND b.id = c.branch_id
LEFT JOIN public.treatment_budget_item bi ON bi.organization_id = c.organization_id AND bi.id = c.budget_item_id
LEFT JOIN public.service_catalog sx ON sx.organization_id = c.organization_id AND sx.id = coalesce(ep.service_id, bi.service_id, pi.service_id)
LEFT JOIN public.org_specialty os ON os.organization_id = sx.organization_id AND os.id = sx.specialty_id
WHERE a.voided_at IS NULL;
