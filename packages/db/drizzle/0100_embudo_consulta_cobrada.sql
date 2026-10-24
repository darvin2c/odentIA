-- El embudo de Argos cuenta la consulta cobrada en latidIA (issue 229, decisión 15), como Reportes
-- (`funnelSql` con `budgetRequired` falso): allí lo indicado queda aceptado al indicarlo y no hay
-- presupuesto que aceptar, así que «pago» es vino y pagó algo. En odentIA no cambia: aceptó y pagó algo.
-- Las columnas son las mismas, en el mismo orden.
CREATE OR REPLACE VIEW argos.embudo AS
WITH first_inbound AS (
  SELECT DISTINCT ON (c.organization_id, c.contact_id) c.organization_id, c.contact_id, fi.created_at AS at, cc.channel
  FROM public.conversation c
  JOIN LATERAL (
    SELECT m.created_at FROM public.message m
    WHERE m.organization_id = c.organization_id AND m.conversation_id = c.id AND m.direction = 'in'
    ORDER BY m.created_at, m.id LIMIT 1
  ) fi ON true
  LEFT JOIN public.channel_connection cc ON cc.organization_id = c.organization_id AND cc.id = c.channel_connection_id
  WHERE NOT EXISTS (SELECT 1 FROM public.contact s WHERE s.organization_id = c.organization_id AND s.id = c.contact_id AND s.screen IS NOT NULL)
  ORDER BY c.organization_id, c.contact_id, fi.created_at, c.id
), registered AS (
  SELECT p.organization_id, p.id AS patient_id, p.person_id, p.created_at, r.conversation_id,
    nullif(coalesce(r.context_contact_id, rc.contact_id), p.person_id) AS writer_id,
    CASE WHEN r.entry_point IN ('public_link', 'qr') OR (r.entry_point = 'conversation' AND r.actor_user_id IS NULL)
      THEN 'registro_en_linea' ELSE 'recepcion' END AS registered_via
  FROM public.patient p
  LEFT JOIN public.patient_registration r ON r.organization_id = p.organization_id AND r.patient_id = p.id
  LEFT JOIN public.conversation rc ON rc.organization_id = r.organization_id AND rc.id = r.conversation_id
), first_contact AS (
  SELECT g.organization_id, g.person_id, g.patient_id, k.at AS first_at, k.channel
  FROM registered g
  LEFT JOIN first_inbound own ON own.organization_id = g.organization_id AND own.contact_id = g.person_id
  LEFT JOIN LATERAL (
    SELECT m.created_at AS at, wcc.channel FROM public.message m
    JOIN public.conversation wc ON wc.organization_id = m.organization_id AND wc.id = m.conversation_id
    LEFT JOIN public.channel_connection wcc ON wcc.organization_id = wc.organization_id AND wcc.id = wc.channel_connection_id
    WHERE g.writer_id IS NOT NULL AND m.organization_id = g.organization_id AND m.conversation_id = g.conversation_id
      AND m.direction = 'in' AND m.created_at <= g.created_at AND m.created_at > g.created_at - make_interval(days => 30)
      AND NOT EXISTS (SELECT 1 FROM public.contact s WHERE s.organization_id = wc.organization_id AND s.id = wc.contact_id AND s.screen IS NOT NULL)
    ORDER BY m.created_at, m.id LIMIT 1
  ) w ON true
  CROSS JOIN LATERAL (
    SELECT x.at, x.channel FROM (VALUES (own.at, own.channel, 0), (w.at, w.channel, 1), (g.created_at, g.registered_via, 2)) AS x(at, channel, rank)
    WHERE x.at IS NOT NULL ORDER BY x.at, x.rank LIMIT 1
  ) k
  UNION ALL
  SELECT i.organization_id, i.contact_id, NULL::uuid, i.at, i.channel
  FROM first_inbound i
  WHERE NOT EXISTS (SELECT 1 FROM public.patient p WHERE p.organization_id = i.organization_id AND p.person_id = i.contact_id)
    AND NOT EXISTS (SELECT 1 FROM public.patient_contact v WHERE v.organization_id = i.organization_id AND v.contact_id = i.contact_id AND v.relationship <> 'self')
    AND NOT EXISTS (SELECT 1 FROM registered g WHERE g.organization_id = i.organization_id AND g.writer_id = i.contact_id)
), reached AS (
  SELECT k.*,
    EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = k.organization_id AND a.patient_id = k.patient_id
      AND a.created_at >= k.first_at AND a.status <> 'cancelada') AS booked,
    EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = k.organization_id AND a.patient_id = k.patient_id
      AND a.created_at >= k.first_at AND a.status = 'atendida')
      OR EXISTS (SELECT 1 FROM public.encounter e WHERE e.organization_id = k.organization_id AND e.patient_id = k.patient_id
        AND e.status = 'finalizada' AND e.finalized_at >= k.first_at) AS came,
    EXISTS (SELECT 1 FROM public.treatment_budget b WHERE b.organization_id = k.organization_id AND b.patient_id = k.patient_id
      AND b.status IN ('aceptado', 'parcial', 'presentado', 'pospuesto', 'rechazado') AND b.presented_at >= k.first_at) AS budget,
    EXISTS (SELECT 1 FROM public.treatment_budget b WHERE b.organization_id = k.organization_id AND b.patient_id = k.patient_id
      AND b.status IN ('aceptado', 'parcial') AND b.presented_at >= k.first_at) AS accepted,
    EXISTS (SELECT 1 FROM public.patient_payment y WHERE y.organization_id = k.organization_id AND y.patient_id = k.patient_id
      AND y.voided_at IS NULL AND y.paid_at >= k.first_at) AS paid
  FROM first_contact k
)
SELECT r.first_at AS primer_contacto_en, (r.first_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, r.channel AS canal,
  pp.display_name AS persona, r.person_id AS persona_id, r.patient_id AS paciente_id,
  r.booked OR r.came OR r.budget AS agendo, r.came OR r.budget AS vino, r.budget AS recibio_presupuesto, r.accepted AS acepto,
  CASE WHEN op.product = 'medical' THEN (r.came OR r.budget) AND r.paid ELSE r.accepted AND r.paid END AS pago
FROM reached r
JOIN public.contact pp ON pp.organization_id = r.organization_id AND pp.id = r.person_id
LEFT JOIN public.org_profile op ON op.organization_id = r.organization_id;
