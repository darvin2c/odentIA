-- Argos consulta las vistas del negocio con la llave de quien pregunta (ADR 0075).
-- Las vistas son de argos_dueno: sin BYPASSRLS, ve solo la clínica de app.org_id.
-- Las llaves argos_* no leen tablas, solo las vistas de su rol. Nada de texto libre
-- (mensajes, notas, motivos escritos) ni de historia clínica.

-- 1. Roles. El dueño de las vistas y una llave por rol de la aplicación.
DO $$
DECLARE key text;
BEGIN
  FOREACH key IN ARRAY ARRAY['argos_dueno', 'argos_gestion', 'argos_recepcion', 'argos_clinico', 'argos_caja'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = key) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', key);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- La aplicación se pone la llave con SET LOCAL ROLE, sin heredar lo que ve.
GRANT argos_gestion, argos_recepcion, argos_clinico, argos_caja TO dentalagent_app WITH INHERIT FALSE, SET TRUE;--> statement-breakpoint
-- Una consulta no puede cambiar de clínica: set_config deja de ser de todos.
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO dentalagent_app;--> statement-breakpoint

-- 2. Lo que lee el dueño de las vistas (con la RLS de la clínica).
GRANT USAGE ON SCHEMA public, auth, catalog TO argos_dueno;--> statement-breakpoint
GRANT SELECT ON TABLE public.patient_charge, public.patient_payment, public.patient_payment_application, public.patient_payment_refund,
  public.payment_ticket, public.patient, public.contact, public.encounter, public.encounter_procedure, public.service_catalog,
  public.treatment_plan_item, public.product, public.branch, public.org_profile, public.org_specialty, public.appointment,
  public.clinical_follow_up, public.treatment_budget, public.treatment_budget_option, public.treatment_budget_item, public.promotion,
  public.product_lot, public.product_minimum, public.stock_shortage, public.stock_movement, public.warehouse, public.purchase_order,
  public.purchase_order_line, public.supplier, public.expense, public.commission_settlement, public.commission_settlement_line,
  public.commission_rule, public.member, public.professional_schedule, public.schedule_block, public.conversation,
  public.channel_connection, public.opportunity, public.pipeline_stage, public.task TO argos_dueno;--> statement-breakpoint
GRANT SELECT (id, name) ON TABLE auth."user" TO argos_dueno;--> statement-breakpoint
GRANT SELECT (id, specialty) ON TABLE catalog.treatment_template TO argos_dueno;--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS argos;--> statement-breakpoint
REVOKE ALL ON SCHEMA argos FROM PUBLIC;--> statement-breakpoint

-- 3. Dinero. Los importes en la moneda de la clínica (en unidades, no centavos); «dia» es el día de la clínica.

-- Lo cargado a cada paciente: tratamientos hechos y productos vendidos, sin anulados (lo devuelto ya descontado).
-- Una fila es una venta: «ticket promedio» es el promedio de «importe» de estas filas, no el de los tickets de pago.
CREATE VIEW argos.ventas AS
SELECT c.id AS venta_id, c.created_at AS cargado_en, (c.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia,
  c.patient_id AS paciente_id, pp.display_name AS paciente,
  coalesce(sep.name, spi.name, pr.name) AS concepto,
  CASE WHEN c.product_id IS NULL THEN 'tratamiento' ELSE 'producto' END AS tipo,
  coalesce(c.product_quantity, ep.quantity, 1) AS cantidad,
  round(c.amount_cents / 100.0, 2) AS importe,
  round(coalesce(ap.cents, 0) / 100.0, 2) AS pagado,
  round((c.amount_cents - coalesce(ap.cents, 0)) / 100.0, 2) AS saldo,
  b.name AS sede, u.name AS profesional, c.promotion_name AS promocion
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
LEFT JOIN LATERAL (SELECT sum(a.amount_cents) AS cents FROM public.patient_payment_application a
  JOIN public.patient_payment pay ON pay.organization_id = a.organization_id AND pay.id = a.payment_id AND pay.voided_at IS NULL
  WHERE a.organization_id = c.organization_id AND a.charge_id = c.id AND a.voided_at IS NULL) ap ON true
WHERE c.voided_at IS NULL;--> statement-breakpoint

-- Cada movimiento de lo cobrado: sumar «importe» en un periodo da lo cobrado (pagos menos anulaciones y devoluciones del periodo).
CREATE VIEW argos.cobros AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.tipo, round(x.cents / 100.0, 2) AS importe,
  x.medio, b.name AS sede, pp.display_name AS paciente, x.patient_id AS paciente_id
FROM (
  SELECT pay.organization_id, pay.paid_at AS momento, 'pago' AS tipo, pay.amount_cents AS cents, pay.method_name AS medio, pay.branch_id, pay.patient_id
  FROM public.patient_payment pay
  UNION ALL
  SELECT pay.organization_id, pay.voided_at, 'anulacion', -pay.amount_cents, pay.method_name, pay.branch_id, pay.patient_id
  FROM public.patient_payment pay WHERE pay.voided_at IS NOT NULL
  UNION ALL
  SELECT r.organization_id, r.refunded_at, 'devolucion', -r.amount_cents, pay.method_name, pay.branch_id, r.patient_id
  FROM public.patient_payment_refund r JOIN public.patient_payment pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
) x
JOIN public.patient p ON p.organization_id = x.organization_id AND p.id = x.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;--> statement-breakpoint

-- Lo pagado aplicado a cada venta: qué se pagó, de qué y de quién lo atendió (solo pagos vigentes).
CREATE VIEW argos.pagos_por_venta AS
SELECT pay.paid_at AS pagado_en, (pay.paid_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, round(a.amount_cents / 100.0, 2) AS importe,
  coalesce(sep.name, spi.name, pr.name) AS concepto, CASE WHEN c.product_id IS NULL THEN 'tratamiento' ELSE 'producto' END AS tipo,
  coalesce(c.product_quantity, ep.quantity, 1) AS cantidad, u.name AS profesional, b.name AS sede, pp.display_name AS paciente, c.patient_id AS paciente_id, pay.method_name AS medio
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
WHERE a.voided_at IS NULL;--> statement-breakpoint

-- Los tickets de pago (odentIA no emite facturas). Un ticket junta lo cobrado en una visita: no es una venta.
CREATE VIEW argos.tickets AS
SELECT t.ticket_number AS numero, t.created_at AS emitido_en, (t.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia,
  b.name AS sede, pp.display_name AS paciente, t.patient_id AS paciente_id, round(t.total_cents / 100.0, 2) AS total, round(t.credit_applied_cents / 100.0, 2) AS a_favor_usado,
  (t.voided_at IS NOT NULL) AS anulado
FROM public.payment_ticket t
JOIN public.patient p ON p.organization_id = t.organization_id AND p.id = t.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = t.organization_id
LEFT JOIN public.branch b ON b.organization_id = t.organization_id AND b.id = t.branch_id;--> statement-breakpoint

-- Lo que debe cada paciente, a hoy: lo cargado sin pagar menos lo que tiene a favor. Su deuda está
-- vencida si su concepto más antiguo sin pagar tiene más de 30 días (la regla de «Te deben hace más de 30 días»).
CREATE VIEW argos.deudas AS
WITH charge AS (
  SELECT c.organization_id, c.patient_id, c.created_at, c.amount_cents - coalesce((SELECT sum(a.amount_cents) FROM public.patient_payment_application a
      JOIN public.patient_payment pay ON pay.organization_id = a.organization_id AND pay.id = a.payment_id AND pay.voided_at IS NULL
      WHERE a.organization_id = c.organization_id AND a.charge_id = c.id AND a.voided_at IS NULL), 0) AS unpaid
  FROM public.patient_charge c WHERE c.voided_at IS NULL
), credit AS (
  SELECT pay.organization_id, pay.patient_id,
    sum(pay.amount_cents) - coalesce(sum((SELECT sum(a.amount_cents) FROM public.patient_payment_application a
      WHERE a.organization_id = pay.organization_id AND a.payment_id = pay.id AND a.voided_at IS NULL)), 0)
      - coalesce(sum((SELECT sum(r.amount_cents) FROM public.patient_payment_refund r WHERE r.organization_id = pay.organization_id AND r.payment_id = pay.id)), 0) AS cents
  FROM public.patient_payment pay WHERE pay.voided_at IS NULL GROUP BY 1, 2
), owed AS (
  SELECT ch.organization_id, ch.patient_id, sum(ch.unpaid) FILTER (WHERE ch.unpaid > 0) AS unpaid,
    min(ch.created_at) FILTER (WHERE ch.unpaid > 0) AS since
  FROM charge ch GROUP BY 1, 2
)
SELECT o.patient_id AS paciente_id, pp.display_name AS paciente,
  round(o.unpaid / 100.0, 2) AS debe, round(greatest(coalesce(cr.cents, 0), 0) / 100.0, 2) AS a_favor,
  round(greatest(o.unpaid - greatest(coalesce(cr.cents, 0), 0), 0) / 100.0, 2) AS saldo,
  (o.since < now() - interval '30 days') AS vencida,
  (o.since AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS desde, (now()::date - o.since::date) AS dias
FROM owed o
JOIN public.patient p ON p.organization_id = o.organization_id AND p.id = o.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN credit cr ON cr.organization_id = o.organization_id AND cr.patient_id = o.patient_id
LEFT JOIN public.org_profile op ON op.organization_id = o.organization_id
WHERE o.unpaid > greatest(coalesce(cr.cents, 0), 0);--> statement-breakpoint

-- Gastos registrados, como movimientos: el gasto en su fecha y su anulación en la suya.
CREATE VIEW argos.gastos AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.categoria,
  CASE WHEN EXISTS (SELECT 1 FROM public.commission_settlement s WHERE s.organization_id = x.organization_id AND s.expense_id = x.id) THEN 'pago_de_comisiones'
    WHEN x.purchase_order_id IS NOT NULL THEN 'pago_de_compra' ELSE 'gasto' END AS tipo,
  round(x.cents / 100.0, 2) AS monto, b.name AS sede
FROM (
  SELECT e.organization_id, e.id, e.spent_at AS momento, e.category AS categoria, e.amount_cents AS cents, e.branch_id, e.purchase_order_id FROM public.expense e
  UNION ALL
  SELECT e.organization_id, e.id, e.voided_at, e.category, -e.amount_cents, e.branch_id, e.purchase_order_id FROM public.expense e WHERE e.voided_at IS NOT NULL
) x
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;--> statement-breakpoint

-- Comisiones, como Finanzas › Comisiones: cada cobro de lo que atendió un profesional con su porcentaje; lo pagado, como se pagó.
CREATE VIEW argos.comisiones AS
WITH live_app AS (
  SELECT a.id, a.organization_id, a.amount_cents::bigint AS cents, a.created_at AS at, e.dentist_user_id AS user_id, p.branch_id
  FROM public.patient_payment_application a
  JOIN public.patient_payment p ON p.organization_id = a.organization_id AND p.id = a.payment_id
  JOIN public.patient_charge c ON c.organization_id = a.organization_id AND c.id = a.charge_id
  JOIN public.encounter_procedure ep ON ep.organization_id = a.organization_id AND ep.id = c.encounter_procedure_id
  JOIN public.encounter e ON e.organization_id = a.organization_id AND e.id = ep.encounter_id
  WHERE a.voided_at IS NULL AND p.voided_at IS NULL AND c.voided_at IS NULL AND ep.voided_at IS NULL AND e.status = 'finalizada' AND e.voided_at IS NULL
), frozen AS (
  SELECT l.application_id, l.organization_id, l.base_cents::bigint AS base, l.commission_cents::bigint AS commission, l.occurred_at AS at,
    s.professional_user_id AS user_id, (a.voided_at IS NULL AND p.voided_at IS NULL AND c.voided_at IS NULL) AS live, p.branch_id
  FROM public.commission_settlement_line l
  JOIN public.commission_settlement s ON s.organization_id = l.organization_id AND s.id = l.settlement_id AND s.voided_at IS NULL
  JOIN public.patient_payment_application a ON a.organization_id = l.organization_id AND a.id = l.application_id
  JOIN public.patient_payment p ON p.organization_id = a.organization_id AND p.id = a.payment_id
  JOIN public.patient_charge c ON c.organization_id = a.organization_id AND c.id = a.charge_id
  WHERE l.kind = 'cobro' AND l.voided_at IS NULL
), line AS (
  SELECT f.organization_id, f.user_id, f.at, CASE WHEN f.live THEN f.base ELSE 0 END AS base, CASE WHEN f.live THEN f.commission ELSE 0 END AS commission,
    f.commission AS paid, 0::bigint AS fresh, f.branch_id
  FROM frozen f
  UNION ALL
  SELECT la.organization_id, la.user_id, la.at, la.cents, (la.cents * coalesce(r.rate_bps, 0)) / 10000, 0, (la.cents * coalesce(r.rate_bps, 0)) / 10000, la.branch_id
  FROM live_app la LEFT JOIN public.commission_rule r ON r.organization_id = la.organization_id AND r.professional_user_id = la.user_id
  WHERE NOT EXISTS (SELECT 1 FROM frozen f WHERE f.organization_id = la.organization_id AND f.application_id = la.id)
)
SELECT l.at AS momento, (l.at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, u.name AS profesional, b.name AS sede,
  round(l.base / 100.0, 2) AS base, round(l.commission / 100.0, 2) AS comision, round(l.paid / 100.0, 2) AS pagado, round(l.fresh / 100.0, 2) AS sin_pagar
FROM line l
JOIN auth."user" u ON u.id = l.user_id
LEFT JOIN public.org_profile op ON op.organization_id = l.organization_id
LEFT JOIN public.branch b ON b.organization_id = l.organization_id AND b.id = l.branch_id
-- Solo quien sigue en la clínica; EXISTS y no JOIN: una persona puede tener más de una fila de miembro.
WHERE EXISTS (SELECT 1 FROM public.member m WHERE m.organization_id = l.organization_id AND m.user_id = l.user_id);--> statement-breakpoint

-- 4. Agenda.

CREATE VIEW argos.citas AS
SELECT a.id AS cita_id, a.starts_at AS inicio, (a.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date AS dia,
  (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow FROM a.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::int + 1] AS dia_semana,
  extract(hour FROM a.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::int AS hora,
  b.name AS sede, u.name AS profesional, a.patient_id AS paciente_id, pp.display_name AS paciente, a.service_name AS servicio,
  CASE a.status WHEN 'no_asistio' THEN 'no_vino' ELSE a.status END AS estado, (a.ends_at < now()) AS ya_paso, a.duration_min AS duracion_min,
  a.arrived_at AS llego_en, e.started_at AS atencion_inicio,
  CASE WHEN a.arrived_at IS NOT NULL AND e.started_at >= a.arrived_at THEN round(extract(epoch FROM e.started_at - a.arrived_at) / 60) END AS espera_min,
  a.source AS origen
FROM public.appointment a
JOIN public.patient p ON p.organization_id = a.organization_id AND p.id = a.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
JOIN public.branch b ON b.organization_id = a.organization_id AND b.id = a.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = a.organization_id
LEFT JOIN auth."user" u ON u.id = a.dentist_user_id
LEFT JOIN LATERAL (SELECT x.started_at FROM public.encounter x WHERE x.organization_id = a.organization_id AND x.appointment_id = a.id AND x.status <> 'anulada'
  ORDER BY x.started_at LIMIT 1) e ON true;--> statement-breakpoint

-- La base de las horas libres (sin llave: la leen las dos vistas de abajo). Como Reportes › Agenda:
-- el horario que valía cada día (o el de hoy antes del primero guardado), menos los bloqueos, y lo
-- que de eso ocuparon citas no canceladas. De 400 días atrás a 60 días adelante.
CREATE VIEW argos.agenda_base AS
WITH pair AS (
  SELECT s.organization_id, s.branch_id, s.dentist_user_id, min(s.valid_from) AS first_day
  FROM public.professional_schedule s GROUP BY 1, 2, 3
), day AS (
  SELECT pr.*, coalesce(b.timezone, op.timezone, 'UTC') AS tz, d::date AS dia
  FROM pair pr
  JOIN public.branch b ON b.organization_id = pr.organization_id AND b.id = pr.branch_id
  LEFT JOIN public.org_profile op ON op.organization_id = pr.organization_id
  CROSS JOIN LATERAL generate_series((now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date - 400,
    (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date + 60, interval '1 day') d
), sched AS (
  SELECT d.*, (d.dia < d.first_day) AS supuesto,
    (SELECT range_agg(tstzrange((d.dia + make_interval(mins => s.start_min)) AT TIME ZONE d.tz, (d.dia + make_interval(mins => s.end_min)) AT TIME ZONE d.tz))
      FROM public.professional_schedule s
      WHERE s.organization_id = d.organization_id AND s.branch_id = d.branch_id AND s.dentist_user_id = d.dentist_user_id
        AND s.weekday = extract(dow FROM d.dia)::int
        AND CASE WHEN d.dia < d.first_day THEN s.is_active ELSE s.valid_from <= d.dia AND (s.valid_until IS NULL OR s.valid_until > d.dia) END) AS programado
  FROM day d
), free AS (
  SELECT s.*, s.programado - coalesce((SELECT range_agg(tstzrange(k.starts_at, k.ends_at)) FROM public.schedule_block k
      WHERE k.organization_id = s.organization_id AND k.branch_id = s.branch_id
        AND (k.dentist_user_id = s.dentist_user_id OR (k.dentist_user_id IS NULL AND k.chair_id IS NULL))
        AND k.starts_at < upper(s.programado) AND k.ends_at > lower(s.programado)), '{}'::tstzmultirange) AS libre
  FROM sched s WHERE s.programado IS NOT NULL
)
SELECT f.organization_id, f.branch_id, f.dentist_user_id, f.tz, f.dia, f.supuesto, f.programado, f.libre,
  f.libre * coalesce((SELECT range_agg(tstzrange(a.starts_at, a.ends_at)) FROM public.appointment a
      WHERE a.organization_id = f.organization_id AND a.branch_id = f.branch_id AND a.dentist_user_id = f.dentist_user_id AND a.status <> 'cancelada'
        AND a.starts_at < upper(f.programado) AND a.ends_at > lower(f.programado)), '{}'::tstzmultirange) AS ocupado
FROM free f;--> statement-breakpoint

CREATE VIEW argos.agenda_por_dia AS
SELECT g.dia, (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow FROM g.dia)::int + 1] AS dia_semana,
  b.name AS sede, u.name AS profesional,
  round(coalesce((SELECT sum(extract(epoch FROM upper(r) - lower(r))) FROM unnest(g.programado) r), 0) / 60) AS minutos_horario,
  round(coalesce((SELECT sum(extract(epoch FROM upper(r) - lower(r))) FROM unnest(g.libre) r), 0) / 60) AS minutos_disponibles,
  round(coalesce((SELECT sum(extract(epoch FROM upper(r) - lower(r))) FROM unnest(g.ocupado) r), 0) / 60) AS minutos_ocupados,
  g.supuesto AS horario_supuesto
FROM argos.agenda_base g
JOIN public.branch b ON b.organization_id = g.organization_id AND b.id = g.branch_id
LEFT JOIN auth."user" u ON u.id = g.dentist_user_id;--> statement-breakpoint

CREATE VIEW argos.agenda_por_hora AS
SELECT x.dia, x.dia_semana, x.hora, x.sede, x.profesional, x.minutos_disponibles, x.minutos_ocupados
FROM (
  SELECT g.dia, (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow FROM g.dia)::int + 1] AS dia_semana, h AS hora,
    b.name AS sede, u.name AS profesional,
    round(coalesce((SELECT sum(extract(epoch FROM upper(r) - lower(r))) FROM unnest(g.libre * tstzmultirange(tstzrange((g.dia + make_interval(hours => h)) AT TIME ZONE g.tz, (g.dia + make_interval(hours => h + 1)) AT TIME ZONE g.tz))) r), 0) / 60) AS minutos_disponibles,
    round(coalesce((SELECT sum(extract(epoch FROM upper(r) - lower(r))) FROM unnest(g.ocupado * tstzmultirange(tstzrange((g.dia + make_interval(hours => h)) AT TIME ZONE g.tz, (g.dia + make_interval(hours => h + 1)) AT TIME ZONE g.tz))) r), 0) / 60) AS minutos_ocupados
  FROM argos.agenda_base g
  JOIN public.branch b ON b.organization_id = g.organization_id AND b.id = g.branch_id
  LEFT JOIN auth."user" u ON u.id = g.dentist_user_id
  CROSS JOIN generate_series(0, 23) h
) x WHERE x.minutos_disponibles > 0;--> statement-breakpoint

-- 5. Pacientes y tratamientos.

CREATE VIEW argos.pacientes AS
SELECT p.id AS paciente_id, pp.display_name AS nombre, NOT pp.is_active AS archivado,
  v.primera_atencion, v.ultima_atencion, coalesce(v.atenciones, 0) AS atenciones,
  (SELECT min(n.starts_at) FROM public.appointment n WHERE n.organization_id = p.organization_id AND n.patient_id = p.id
    AND n.starts_at > now() AND n.status IN ('programada','confirmada')) AS proxima_cita,
  CASE p.referral_kind WHEN 'recomendacion' THEN 'Recomendación de alguien' WHEN 'redes_sociales' THEN 'Redes sociales'
    WHEN 'google_mapas' THEN 'Google o mapas' WHEN 'paso_por_aqui' THEN 'Pasaba por aquí' WHEN 'convenio' THEN 'Convenio o empresa'
    WHEN 'otro' THEN 'Otro' ELSE 'No lo dijo' END AS como_nos_conocio,
  EXISTS (SELECT 1 FROM public.treatment_budget b WHERE b.organization_id = p.organization_id AND b.patient_id = p.id
    AND (b.status IN ('presentado','pospuesto') OR (b.status = 'parcial' AND EXISTS (SELECT 1 FROM public.treatment_budget_item i
      WHERE i.organization_id = b.organization_id AND i.budget_id = b.id AND i.decision = 'pospuesto')))) AS presupuesto_esperando,
  EXISTS (SELECT 1 FROM public.clinical_follow_up f WHERE f.organization_id = p.organization_id AND f.patient_id = p.id AND f.status IN ('pendiente','programado')) AS control_pendiente,
  p.created_at AS registrado_en
FROM public.patient p
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = p.organization_id
LEFT JOIN LATERAL (SELECT min((a.starts_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date) AS primera_atencion,
    max((a.starts_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date) AS ultima_atencion, count(*)::int AS atenciones
  FROM public.appointment a WHERE a.organization_id = p.organization_id AND a.patient_id = p.id AND a.status = 'atendida') v ON true
WHERE pp.screen IS NULL;--> statement-breakpoint

-- Lo realizado: procedimientos de atenciones firmadas, sin anulados.
CREATE VIEW argos.tratamientos_hechos AS
SELECT e.started_at AS fecha, (e.started_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, pp.display_name AS paciente, e.patient_id AS paciente_id, u.name AS profesional,
  b.name AS sede, s.name AS tratamiento, t.specialty AS tipo_tratamiento, os.name AS especialidad, ep.quantity AS cantidad,
  round(ep.price_cents / 100.0, 2) AS precio
FROM public.encounter_procedure ep
JOIN public.encounter e ON e.organization_id = ep.organization_id AND e.id = ep.encounter_id AND e.status = 'finalizada'
JOIN public.patient p ON p.organization_id = e.organization_id AND p.id = e.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = ep.organization_id
LEFT JOIN auth."user" u ON u.id = e.dentist_user_id
LEFT JOIN public.branch b ON b.organization_id = e.organization_id AND b.id = e.branch_id
LEFT JOIN public.service_catalog s ON s.organization_id = ep.organization_id AND s.id = ep.service_id
LEFT JOIN catalog.treatment_template t ON t.id = s.template_id
LEFT JOIN public.org_specialty os ON os.organization_id = s.organization_id AND os.id = s.specialty_id
WHERE ep.voided_at IS NULL;--> statement-breakpoint

-- Los tratamientos indicados en los planes, con su decisión y su avance.
CREATE VIEW argos.planes AS
SELECT pi.plan_id, pp.display_name AS paciente, pi.patient_id AS paciente_id, s.name AS tratamiento, os.name AS especialidad, pi.decision_status AS decision, pi.status AS estado,
  pi.created_at AS indicado_en, pi.decided_at AS decidido_en, pi.started_at AS iniciado_en, pi.completed_at AS terminado_en,
  round(pi.price_cents / 100.0, 2) AS precio, pi.phase AS fase, u.name AS indicado_por
FROM public.treatment_plan_item pi
JOIN public.patient p ON p.organization_id = pi.organization_id AND p.id = pi.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.service_catalog s ON s.organization_id = pi.organization_id AND s.id = pi.service_id
LEFT JOIN public.org_specialty os ON os.organization_id = s.organization_id AND os.id = s.specialty_id
LEFT JOIN auth."user" u ON u.id = pi.created_by
WHERE pi.status <> 'reemplazado';--> statement-breakpoint

-- Controles: cuándo vencen y si ya tienen cita (sin el texto de las indicaciones).
CREATE VIEW argos.controles AS
SELECT pp.display_name AS paciente, f.patient_id AS paciente_id, f.kind AS tipo, f.due_at AS vence_en, (f.due_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS vence_dia,
  f.status AS estado, (f.appointment_id IS NOT NULL) AS tiene_cita, f.completed_at AS hecho_en
FROM public.clinical_follow_up f
JOIN public.patient p ON p.organization_id = f.organization_id AND p.id = f.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = f.organization_id;--> statement-breakpoint

-- 6. Presupuestos y promociones. Los importes son de la opción que vale: nunca se suman las opciones.

CREATE VIEW argos.presupuestos AS
WITH line AS (
  SELECT i.organization_id, i.budget_id, i.decision,
    i.price_cents * (CASE WHEN i.billing_mode = 'session' THEN greatest(coalesce(i.sessions_planned, 1), 1) ELSE 1 END) AS cents
  FROM public.treatment_budget_item i
  WHERE i.price_cents IS NOT NULL AND i.option_id = (SELECT o.id FROM public.treatment_budget_option o
    WHERE o.organization_id = i.organization_id AND o.budget_id = i.budget_id
    ORDER BY (o.decision = 'elegida') DESC, o.is_recommended DESC, o.position LIMIT 1)
)
SELECT b.id AS presupuesto_id, b.budget_number AS numero, pp.display_name AS paciente, b.patient_id AS paciente_id, b.presented_at AS presentado_en,
  (b.presented_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS presentado_dia, b.status AS estado, b.decided_at AS decidido_en, u.name AS profesional,
  round(coalesce(sum(l.cents), 0) / 100.0, 2) AS valor,
  round(coalesce(sum(l.cents) FILTER (WHERE l.decision = 'aceptado'), 0) / 100.0, 2) AS aceptado,
  round(coalesce(sum(l.cents) FILTER (WHERE l.decision IN ('pendiente','pospuesto')), 0) / 100.0, 2) AS sin_decidir,
  (b.status IN ('presentado','pospuesto') OR (b.status = 'parcial' AND EXISTS (SELECT 1 FROM public.treatment_budget_item x
    WHERE x.organization_id = b.organization_id AND x.budget_id = b.id AND x.decision = 'pospuesto'))) AS espera_respuesta
FROM public.treatment_budget b
JOIN public.patient p ON p.organization_id = b.organization_id AND p.id = b.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = b.organization_id
LEFT JOIN line l ON l.organization_id = b.organization_id AND l.budget_id = b.id
LEFT JOIN auth."user" u ON u.id = b.created_by
WHERE b.status <> 'borrador' AND b.presented_at IS NOT NULL
GROUP BY b.id, b.budget_number, pp.display_name, b.patient_id, b.presented_at, op.timezone, b.status, b.decided_at, u.name, b.organization_id;--> statement-breakpoint

CREATE VIEW argos.lineas_presupuesto AS
SELECT b.id AS presupuesto_id, b.budget_number AS numero, pp.display_name AS paciente, b.patient_id AS paciente_id, b.presented_at AS presentado_en,
  (b.presented_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS presentado_dia, b.status AS estado_presupuesto,
  coalesce(s.name, i.title) AS tratamiento, i.decision,
  round(i.price_cents * (CASE WHEN i.billing_mode = 'session' THEN greatest(coalesce(i.sessions_planned, 1), 1) ELSE 1 END) / 100.0, 2) AS importe,
  i.promotion_name AS promocion, pi.status AS estado_tratamiento
FROM public.treatment_budget b
JOIN public.treatment_budget_item i ON i.organization_id = b.organization_id AND i.budget_id = b.id
  AND i.option_id = (SELECT o.id FROM public.treatment_budget_option o WHERE o.organization_id = b.organization_id AND o.budget_id = b.id
    ORDER BY (o.decision = 'elegida') DESC, o.is_recommended DESC, o.position LIMIT 1)
JOIN public.patient p ON p.organization_id = b.organization_id AND p.id = b.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = b.organization_id
LEFT JOIN public.service_catalog s ON s.organization_id = i.organization_id AND s.id = i.service_id
LEFT JOIN public.treatment_plan_item pi ON pi.organization_id = i.organization_id AND pi.id = i.plan_item_id
WHERE b.status <> 'borrador' AND b.presented_at IS NOT NULL;--> statement-breakpoint

CREATE VIEW argos.promociones AS
SELECT pr.name AS nombre, pr.starts_at AS inicio, pr.ends_at AS fin, pr.is_active AS activa,
  (pr.is_active AND pr.starts_at <= now() AND (pr.ends_at IS NULL OR pr.ends_at > now())) AS vigente_hoy
FROM public.promotion pr;--> statement-breakpoint

-- Cada uso de una promoción (presupuesto entregado o cobro), con lo que esa persona pagó desde entonces.
CREATE VIEW argos.promociones_uso AS
SELECT x.promocion, pp.display_name AS paciente, x.patient_id AS paciente_id, x.fecha, x.aceptado, round(x.discount / 100.0, 2) AS descuento,
  NOT EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = x.organization_id AND a.patient_id = x.patient_id
    AND a.status = 'atendida' AND a.starts_at < x.fecha - interval '1 day') AS paciente_nuevo,
  round((coalesce((SELECT sum(pay.amount_cents) FROM public.patient_payment pay WHERE pay.organization_id = x.organization_id AND pay.patient_id = x.patient_id
      AND pay.voided_at IS NULL AND pay.paid_at >= x.fecha), 0)
    - coalesce((SELECT sum(r.amount_cents) FROM public.patient_payment_refund r JOIN public.patient_payment pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
      WHERE r.organization_id = x.organization_id AND r.patient_id = x.patient_id AND pay.voided_at IS NULL AND pay.paid_at >= x.fecha), 0)) / 100.0, 2) AS cobrado_desde_entonces
FROM (
  SELECT b.organization_id, i.promotion_name AS promocion, b.patient_id, b.presented_at AS fecha,
    (b.status IN ('aceptado','parcial') AND i.decision = 'aceptado') AS aceptado,
    greatest(coalesce(i.tariff_price_cents, i.price_cents) - i.price_cents, 0)
      * (CASE WHEN i.billing_mode = 'session' THEN greatest(coalesce(i.sessions_planned, 1), 1) ELSE 1 END) AS discount
  FROM public.treatment_budget b
  JOIN public.treatment_budget_item i ON i.organization_id = b.organization_id AND i.budget_id = b.id
    AND i.option_id = (SELECT o.id FROM public.treatment_budget_option o WHERE o.organization_id = b.organization_id AND o.budget_id = b.id
      ORDER BY (o.decision = 'elegida') DESC, o.is_recommended DESC, o.position LIMIT 1)
  WHERE i.promotion_id IS NOT NULL AND i.price_cents IS NOT NULL AND b.status <> 'borrador' AND b.presented_at IS NOT NULL
  UNION ALL
  SELECT c.organization_id, c.promotion_name, c.patient_id, c.created_at, true, 0 FROM public.patient_charge c
  WHERE c.promotion_id IS NOT NULL AND c.voided_at IS NULL
) x
JOIN public.patient p ON p.organization_id = x.organization_id AND p.id = x.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id;--> statement-breakpoint

-- 7. Inventario y compras (sin costos para quien no ve precios: estas vistas no los traen; las compras sí, y son de gestión).

CREATE VIEW argos.lotes AS
SELECT pr.name AS producto, pr.unit AS unidad, b.name AS sede, l.code AS lote, l.expires_at AS vence, l.quantity_on_hand AS cantidad,
  CASE WHEN l.expires_at IS NULL THEN 'sin_vencimiento'
    WHEN l.expires_at < (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date THEN 'vencido'
    WHEN l.expires_at <= (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date + 30 THEN 'por_vencer' ELSE 'vigente' END AS estado
FROM public.product_lot l
JOIN public.product pr ON pr.organization_id = l.organization_id AND pr.id = l.product_id
JOIN public.warehouse w ON w.organization_id = l.organization_id AND w.id = l.warehouse_id
JOIN public.branch b ON b.organization_id = w.organization_id AND b.id = w.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = l.organization_id
WHERE l.quantity_on_hand > 0;--> statement-breakpoint

CREATE VIEW argos.inventario AS
SELECT pr.name AS producto, pr.unit AS unidad, b.name AS sede,
  coalesce(lot.hay, 0) - coalesce(sh.falta, 0) AS hay, coalesce(m.min_quantity, 0) AS minimo,
  CASE WHEN coalesce(sh.falta, 0) > 0 THEN 'faltante'
    WHEN coalesce(m.min_quantity, 0) > 0 AND coalesce(lot.hay, 0) <= 0 THEN 'no_hay'
    WHEN coalesce(lot.hay, 0) < coalesce(m.min_quantity, 0) THEN 'hace_falta' ELSE 'ok' END AS estado,
  (coalesce(sh.falta, 0) > 0 OR coalesce(lot.hay, 0) < coalesce(m.min_quantity, 0)) AS hay_que_reponer,
  coalesce(lot.por_vencer, 0) AS cantidad_por_vencer, lot.vence_primero, coalesce(lot.vencido, 0) AS cantidad_vencida
FROM public.product pr
JOIN public.branch b ON b.organization_id = pr.organization_id AND b.is_active
LEFT JOIN public.org_profile op ON op.organization_id = pr.organization_id
LEFT JOIN LATERAL (SELECT sum(l.quantity_on_hand)::int AS hay,
    sum(l.quantity_on_hand) FILTER (WHERE l.expires_at >= (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date
      AND l.expires_at <= (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date + 30)::int AS por_vencer,
    sum(l.quantity_on_hand) FILTER (WHERE l.expires_at < (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date)::int AS vencido,
    min(l.expires_at) FILTER (WHERE l.quantity_on_hand > 0 AND l.expires_at >= (now() AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date) AS vence_primero
  FROM public.product_lot l JOIN public.warehouse w ON w.organization_id = l.organization_id AND w.id = l.warehouse_id
  WHERE l.organization_id = pr.organization_id AND l.product_id = pr.id AND w.branch_id = b.id) lot ON true
LEFT JOIN LATERAL (SELECT sum(s.quantity)::int AS falta FROM public.stock_shortage s JOIN public.warehouse w ON w.organization_id = s.organization_id AND w.id = s.warehouse_id
  WHERE s.organization_id = pr.organization_id AND s.product_id = pr.id AND w.branch_id = b.id) sh ON true
LEFT JOIN public.product_minimum m ON m.organization_id = pr.organization_id AND m.product_id = pr.id AND m.branch_id = b.id
WHERE pr.is_active;--> statement-breakpoint

-- Lo que entró y salió: uso en atenciones (consumo), venta, compra, ajuste, traslado, devolución.
CREATE VIEW argos.movimientos_inventario AS
SELECT m.created_at AS fecha, (m.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, m.kind AS tipo, pr.name AS producto, pr.unit AS unidad,
  m.quantity_delta AS cantidad, b.name AS sede, u.name AS profesional, pp.display_name AS paciente
FROM public.stock_movement m
JOIN public.product pr ON pr.organization_id = m.organization_id AND pr.id = m.product_id
JOIN public.warehouse w ON w.organization_id = m.organization_id AND w.id = m.warehouse_id
JOIN public.branch b ON b.organization_id = w.organization_id AND b.id = w.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = m.organization_id
LEFT JOIN public.encounter e ON e.organization_id = m.organization_id AND e.id = m.encounter_id
LEFT JOIN auth."user" u ON u.id = e.dentist_user_id
LEFT JOIN public.patient p ON p.organization_id = m.organization_id AND p.id = m.patient_id
LEFT JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id;--> statement-breakpoint

CREATE VIEW argos.compras AS
SELECT po.order_number AS numero, s.name AS proveedor, b.name AS sede, po.status AS estado, po.created_at AS creada_en,
  (po.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia,
  round(coalesce((SELECT sum(l.quantity * l.unit_cost_cents) FROM public.purchase_order_line l WHERE l.organization_id = po.organization_id AND l.order_id = po.id), 0) / 100.0, 2) AS total,
  round(coalesce((SELECT sum(l.received_quantity * l.unit_cost_cents) FROM public.purchase_order_line l WHERE l.organization_id = po.organization_id AND l.order_id = po.id), 0) / 100.0, 2) AS recibido,
  round(coalesce((SELECT sum(e.amount_cents) FROM public.expense e WHERE e.organization_id = po.organization_id AND e.purchase_order_id = po.id AND e.voided_at IS NULL), 0) / 100.0, 2) AS pagado
FROM public.purchase_order po
JOIN public.supplier s ON s.organization_id = po.organization_id AND s.id = po.supplier_id
JOIN public.warehouse w ON w.organization_id = po.organization_id AND w.id = po.warehouse_id
JOIN public.branch b ON b.organization_id = w.organization_id AND b.id = w.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = po.organization_id;--> statement-breakpoint

-- 8. Relación con las personas: conversaciones, oportunidades y tareas (sin mensajes ni notas).

CREATE VIEW argos.conversaciones AS
SELECT c.created_at AS inicio, (c.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, cc.channel AS canal, c.status AS estado,
  c.close_reason AS motivo_cierre, c.closed_at AS cerrada_en, c.last_message_at AS ultimo_mensaje_en, pp.display_name AS persona, c.contact_id AS persona_id,
  (SELECT p.id FROM public.patient p WHERE p.organization_id = c.organization_id AND p.person_id = c.contact_id LIMIT 1) AS paciente_id,
  EXISTS (SELECT 1 FROM public.patient p WHERE p.organization_id = c.organization_id AND p.person_id = c.contact_id) AS es_paciente,
  c.agent_status AS agente, u.name AS asignada_a
FROM public.conversation c
JOIN public.contact pp ON pp.organization_id = c.organization_id AND pp.id = c.contact_id
LEFT JOIN public.channel_connection cc ON cc.organization_id = c.organization_id AND cc.id = c.channel_connection_id
LEFT JOIN public.org_profile op ON op.organization_id = c.organization_id
LEFT JOIN auth."user" u ON u.id = c.assigned_user_id
WHERE pp.screen IS NULL;--> statement-breakpoint

CREATE VIEW argos.oportunidades AS
SELECT o.created_at AS creada_en, (o.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, st.name AS etapa, st.moment AS momento,
  o.status AS estado, s.name AS servicio, round(o.amount_cents / 100.0, 2) AS valor, o.closed_at AS cerrada_en, o.close_reason AS motivo_cierre,
  pp.display_name AS persona, o.contact_id AS persona_id,
  (SELECT p.id FROM public.patient p WHERE p.organization_id = o.organization_id AND p.person_id = o.contact_id LIMIT 1) AS paciente_id, u.name AS responsable
FROM public.opportunity o
JOIN public.contact pp ON pp.organization_id = o.organization_id AND pp.id = o.contact_id
LEFT JOIN public.pipeline_stage st ON st.organization_id = o.organization_id AND st.id = o.stage_id
LEFT JOIN public.service_catalog s ON s.organization_id = o.organization_id AND s.id = o.service_id
LEFT JOIN public.org_profile op ON op.organization_id = o.organization_id
LEFT JOIN auth."user" u ON u.id = o.assigned_user_id
WHERE pp.screen IS NULL;--> statement-breakpoint

CREATE VIEW argos.tareas AS
SELECT t.created_at AS creada_en, t.due_at AS vence_en, t.status AS estado, t.area, t.kind AS tipo,
  CASE WHEN t.created_by IN ('agent','admin') THEN t.created_by ELSE 'equipo' END AS dejada_por, u.name AS responsable
FROM public.task t
LEFT JOIN auth."user" u ON u.id = t.assignee_user_id;--> statement-breakpoint

-- 9. Dueño y llaves. Las vistas son de argos_dueno; cada llave lee solo lo de su rol.
DO $$
DECLARE v text;
BEGIN
  FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'argos' AND c.relkind = 'v' LOOP
    EXECUTE format('ALTER VIEW argos.%I OWNER TO argos_dueno', v);
  END LOOP;
END $$;--> statement-breakpoint
ALTER SCHEMA argos OWNER TO argos_dueno;--> statement-breakpoint
GRANT USAGE ON SCHEMA argos TO argos_gestion, argos_recepcion, argos_clinico, argos_caja;--> statement-breakpoint
-- Quien dirige la clínica (propietario y administración): todo.
GRANT SELECT ON argos.ventas, argos.cobros, argos.pagos_por_venta, argos.tickets, argos.deudas, argos.gastos, argos.comisiones,
  argos.citas, argos.agenda_por_dia, argos.agenda_por_hora, argos.pacientes, argos.tratamientos_hechos, argos.planes, argos.controles,
  argos.presupuestos, argos.lineas_presupuesto, argos.promociones, argos.promociones_uso, argos.lotes, argos.inventario,
  argos.movimientos_inventario, argos.compras, argos.conversaciones, argos.oportunidades, argos.tareas TO argos_gestion;--> statement-breakpoint
-- Recepción: agenda, personas, conversaciones, ventas del CRM, presupuestos como los recibe la persona e inventario sin precios.
GRANT SELECT ON argos.citas, argos.agenda_por_dia, argos.agenda_por_hora, argos.pacientes, argos.controles, argos.presupuestos,
  argos.lineas_presupuesto, argos.promociones, argos.lotes, argos.inventario, argos.movimientos_inventario, argos.conversaciones,
  argos.oportunidades TO argos_recepcion;--> statement-breakpoint
-- Odontología: agenda, pacientes, lo realizado, planes, controles y presupuestos. Sin caja.
GRANT SELECT ON argos.citas, argos.agenda_por_dia, argos.agenda_por_hora, argos.pacientes, argos.tratamientos_hechos, argos.planes,
  argos.controles, argos.presupuestos, argos.lineas_presupuesto, argos.promociones, argos.conversaciones TO argos_clinico;--> statement-breakpoint
-- Caja: cobros, ventas, tickets, deudas y gastos de caja, con pacientes y presupuestos como documento económico.
GRANT SELECT ON argos.ventas, argos.cobros, argos.pagos_por_venta, argos.tickets, argos.deudas, argos.gastos, argos.pacientes,
  argos.presupuestos, argos.lineas_presupuesto, argos.promociones TO argos_caja;
