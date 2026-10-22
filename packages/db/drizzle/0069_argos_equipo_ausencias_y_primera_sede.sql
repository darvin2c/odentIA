-- Argos (ADR 0075): lo que decía que «no se registra» y sí se registra, y la sede de la primera visita.
-- Pacientes nuevos de una sede = los de su primera cita atendida en esa sede (primera_sede), como Reportes.
-- La unidad dental de cada cita; las ausencias del equipo (sin el motivo, que es texto libre); el equipo con su rol, sus especialidades
-- y si atiende (tiene horario o citas): la propietaria también puede atender.
-- El inventario, solo de las sedes con almacén.
-- Las columnas nuevas van al final: una vista se reemplaza sin cambiar sus columnas de antes.
GRANT SELECT ON TABLE public.schedule_chair, public.professional_specialty TO argos_dueno;--> statement-breakpoint
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
  v.ultima_atencion_en,
  f.primera_atencion_en, f.primera_sede
FROM public.patient p
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = p.organization_id
LEFT JOIN LATERAL (SELECT min((a.starts_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date) AS primera_atencion,
    max((a.starts_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date) AS ultima_atencion, count(*)::int AS atenciones,
    max(a.starts_at) AS ultima_atencion_en
  FROM public.appointment a WHERE a.organization_id = p.organization_id AND a.patient_id = p.id AND a.status = 'atendida') v ON true
LEFT JOIN LATERAL (SELECT a.starts_at AS primera_atencion_en, b.name AS primera_sede FROM public.appointment a
  JOIN public.branch b ON b.organization_id = a.organization_id AND b.id = a.branch_id
  WHERE a.organization_id = p.organization_id AND a.patient_id = p.id AND a.status = 'atendida'
  ORDER BY a.starts_at, a.id LIMIT 1) f ON true
WHERE pp.screen IS NULL;--> statement-breakpoint
CREATE OR REPLACE VIEW argos.citas AS
SELECT a.id AS cita_id, a.starts_at AS inicio, (a.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date AS dia,
  (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow FROM a.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::int + 1] AS dia_semana,
  extract(hour FROM a.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::int AS hora,
  b.name AS sede, u.name AS profesional, a.patient_id AS paciente_id, pp.display_name AS paciente, a.service_name AS servicio,
  CASE a.status WHEN 'no_asistio' THEN 'no_vino' ELSE a.status END AS estado, (a.ends_at < now()) AS ya_paso, a.duration_min AS duracion_min,
  a.arrived_at AS llego_en, e.started_at AS atencion_inicio,
  CASE WHEN a.arrived_at IS NOT NULL AND e.started_at >= a.arrived_at THEN round(extract(epoch FROM e.started_at - a.arrived_at) / 60) END AS espera_min,
  a.source AS origen,
  ch.name AS unidad_dental
FROM public.appointment a
JOIN public.patient p ON p.organization_id = a.organization_id AND p.id = a.patient_id
JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
JOIN public.branch b ON b.organization_id = a.organization_id AND b.id = a.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = a.organization_id
LEFT JOIN auth."user" u ON u.id = a.dentist_user_id
LEFT JOIN public.schedule_chair ch ON ch.organization_id = a.organization_id AND ch.id = a.chair_id
LEFT JOIN LATERAL (SELECT x.started_at FROM public.encounter x WHERE x.organization_id = a.organization_id AND x.appointment_id = a.id AND x.status <> 'anulada'
  ORDER BY x.started_at LIMIT 1) e ON true;--> statement-breakpoint
CREATE VIEW argos.ausencias AS
SELECT u.name AS profesional, b.name AS sede, k.starts_at AS desde, k.ends_at AS hasta,
  (k.starts_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date AS primer_dia,
  ((k.ends_at - interval '1 second') AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date AS ultimo_dia
FROM public.schedule_block k
JOIN public.branch b ON b.organization_id = k.organization_id AND b.id = k.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = k.organization_id
LEFT JOIN auth."user" u ON u.id = k.dentist_user_id
WHERE k.kind = 'ausencia';--> statement-breakpoint
CREATE VIEW argos.equipo AS
SELECT u.name AS profesional,
  array_to_string(ARRAY(SELECT CASE trim(r) WHEN 'owner' THEN 'propietario' WHEN 'admin' THEN 'administración' WHEN 'dentist' THEN 'odontología'
    WHEN 'reception' THEN 'recepción' WHEN 'cashier' THEN 'caja' ELSE 'otro' END FROM unnest(string_to_array(m.role, ',')) r), ', ') AS rol,
  (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM public.professional_specialty ps
    JOIN public.org_specialty s ON s.organization_id = ps.organization_id AND s.id = ps.specialty_id
    WHERE ps.organization_id = m.organization_id AND ps.user_id = m.user_id) AS especialidades,
  (EXISTS (SELECT 1 FROM public.professional_schedule s WHERE s.organization_id = m.organization_id AND s.dentist_user_id = m.user_id)
    OR EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = m.organization_id AND a.dentist_user_id = m.user_id)) AS atiende
FROM public.member m
JOIN auth."user" u ON u.id = m.user_id
WHERE m.organization_id = NULLIF(current_setting('app.org_id', true), '');--> statement-breakpoint
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
  -- Solo las sedes con almacén: una sede sin almacén no tiene inventario que reponer.
  AND EXISTS (SELECT 1 FROM public.warehouse wh WHERE wh.organization_id = b.organization_id AND wh.branch_id = b.id)
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
ALTER VIEW argos.ausencias OWNER TO argos_dueno;--> statement-breakpoint
ALTER VIEW argos.equipo OWNER TO argos_dueno;--> statement-breakpoint
-- Las ausencias, a quien ve la agenda; el equipo, a todos.
GRANT SELECT ON argos.ausencias TO argos_gestion, argos_recepcion, argos_clinico;--> statement-breakpoint
GRANT SELECT ON argos.equipo TO argos_gestion, argos_recepcion, argos_clinico, argos_caja;
