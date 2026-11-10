-- Los controles largos de un tratamiento terminado antes de que el cierre los creara (entrega 9):
-- una endodoncia terminada antes del 9 nov no tiene su control radiográfico al año (QA de la ficha
-- del 10 nov, B11). Se crean solo los que faltan, con la configuración de hoy de su servicio (la
-- suya o, sin ella, la de la biblioteca) y la fecha desde que se terminó. Idempotente: no se crea
-- si ese tratamiento ya tiene un control de esos días, en cualquier estado (también el que alguien
-- quitó al firmar). Solo controles de 180 días o más que todavía no vencen (dentro de 2 días o
-- después): ni vencidos que llenen Inicio ni recordatorios que salgan solos. No toca la pieza que
-- después se extrajo o se volvió a tratar.
INSERT INTO public.clinical_follow_up
  (organization_id, patient_id, kind, title, due_at, plan_item_id, finish_after_days)
SELECT due.organization_id, due.patient_id, 'tratamiento', due.title, due.due_at, due.plan_item_id, due.after_days
FROM (
  SELECT item.organization_id, item.patient_id, item.id AS plan_item_id,
    (control.value->>'afterDays')::int AS after_days,
    (control.value->>'title')
      || CASE WHEN item.site_system = 'ISO-3950' AND item.site_code ~ '^[1-8][1-8]$'
        THEN ' · pieza ' || item.site_code ELSE '' END AS title,
    ((((item.completed_at AT TIME ZONE coalesce(nullif(profile.timezone, ''), 'America/Lima'))::date
      + (control.value->>'afterDays')::int)::timestamp + interval '9 hours')
      AT TIME ZONE coalesce(nullif(profile.timezone, ''), 'America/Lima')) AS due_at
  FROM public.treatment_plan_item item
  JOIN public.service_catalog s ON s.organization_id = item.organization_id AND s.id = item.service_id
  LEFT JOIN catalog.treatment_template t ON t.id = s.template_id
  LEFT JOIN public.org_profile profile ON profile.organization_id = item.organization_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.finish_controls, t.finish_controls, '[]'::jsonb)) AS control(value)
  WHERE item.status = 'realizado' AND item.completed_at IS NOT NULL
    AND jsonb_typeof(control.value) = 'object'
    AND (control.value->>'afterDays') ~ '^[0-9]+$'
    AND (control.value->>'afterDays')::int >= 180
    AND coalesce(control.value->>'title', '') <> ''
    AND NOT EXISTS (SELECT 1 FROM public.clinical_follow_up f
      WHERE f.organization_id = item.organization_id AND f.plan_item_id = item.id
        AND f.finish_after_days = (control.value->>'afterDays')::int)
    AND NOT EXISTS (SELECT 1 FROM public.clinical_follow_up_item link
      JOIN public.clinical_follow_up f ON f.id = link.follow_up_id
      WHERE link.organization_id = item.organization_id AND link.plan_item_id = item.id
        AND f.finish_after_days = (control.value->>'afterDays')::int)
    AND NOT EXISTS (SELECT 1 FROM public.treatment_plan_item later
      JOIN public.service_catalog ls ON ls.organization_id = later.organization_id AND ls.id = later.service_id
      JOIN catalog.treatment_template lt ON lt.id = ls.template_id
      WHERE later.organization_id = item.organization_id AND later.patient_id = item.patient_id
        AND later.id <> item.id AND later.site_system = item.site_system AND later.site_code = item.site_code
        AND later.status = 'realizado' AND later.completed_at > item.completed_at
        AND (lt.key LIKE 'exodoncia%' OR lt.key LIKE 'retratamiento%' OR lt.key LIKE 'apicectomia%'))
) due
WHERE due.due_at > now() + interval '2 days';--> statement-breakpoint
INSERT INTO public.clinical_follow_up_item (organization_id, patient_id, follow_up_id, plan_item_id)
  SELECT organization_id, patient_id, id, plan_item_id FROM public.clinical_follow_up
  WHERE kind = 'tratamiento' AND finish_after_days IS NOT NULL AND plan_item_id IS NOT NULL
  ON CONFLICT DO NOTHING;
