-- Argos (ADR 0075): lo que faltaba para contar como Reportes.
-- «Sin venir» y «no ha vuelto en N meses» comparan la hora de la última cita atendida (ultima_atencion_en), no solo su día;
-- el inventario dice qué es insumo (se usa en las atenciones) y qué se vende: un producto puede ser las dos cosas.
-- Las columnas van al final: una vista se reemplaza sin cambiar sus columnas de antes.
CREATE OR REPLACE VIEW argos.pacientes AS
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
  p.created_at AS registrado_en,
  v.ultima_atencion_en
FROM public.patient p
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = p.organization_id
LEFT JOIN LATERAL (SELECT min((a.starts_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date) AS primera_atencion,
    max((a.starts_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date) AS ultima_atencion, count(*)::int AS atenciones,
    max(a.starts_at) AS ultima_atencion_en
  FROM public.appointment a WHERE a.organization_id = p.organization_id AND a.patient_id = p.id AND a.status = 'atendida') v ON true
WHERE pp.screen IS NULL;--> statement-breakpoint
CREATE OR REPLACE VIEW argos.inventario AS
SELECT pr.name AS producto, pr.unit AS unidad, b.name AS sede,
  coalesce(lot.hay, 0) - coalesce(sh.falta, 0) AS hay, coalesce(m.min_quantity, 0) AS minimo,
  CASE WHEN coalesce(sh.falta, 0) > 0 THEN 'faltante'
    WHEN coalesce(m.min_quantity, 0) > 0 AND coalesce(lot.hay, 0) <= 0 THEN 'no_hay'
    WHEN coalesce(lot.hay, 0) < coalesce(m.min_quantity, 0) THEN 'hace_falta' ELSE 'ok' END AS estado,
  (coalesce(sh.falta, 0) > 0 OR coalesce(lot.hay, 0) < coalesce(m.min_quantity, 0)) AS hay_que_reponer,
  coalesce(lot.por_vencer, 0) AS cantidad_por_vencer, lot.vence_primero, coalesce(lot.vencido, 0) AS cantidad_vencida,
  pr.used_in_care AS insumo, pr.for_sale AS se_vende
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
CREATE OR REPLACE VIEW argos.movimientos_inventario AS
SELECT m.created_at AS fecha, (m.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, m.kind AS tipo, pr.name AS producto, pr.unit AS unidad,
  m.quantity_delta AS cantidad, b.name AS sede, u.name AS profesional, pp.display_name AS paciente,
  pr.used_in_care AS insumo, pr.for_sale AS se_vende
FROM public.stock_movement m
JOIN public.product pr ON pr.organization_id = m.organization_id AND pr.id = m.product_id
JOIN public.warehouse w ON w.organization_id = m.organization_id AND w.id = m.warehouse_id
JOIN public.branch b ON b.organization_id = w.organization_id AND b.id = w.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = m.organization_id
LEFT JOIN public.encounter e ON e.organization_id = m.organization_id AND e.id = m.encounter_id
LEFT JOIN auth."user" u ON u.id = e.dentist_user_id
LEFT JOIN public.patient p ON p.organization_id = m.organization_id AND p.id = m.patient_id
LEFT JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id;
