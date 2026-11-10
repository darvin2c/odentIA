-- El consentimiento se elige por la familia del tratamiento, no por cómo empieza su clave (QA del
-- 10 nov, A1 y M2; `SUGGESTED_CONSENT_TEMPLATES`). En las clínicas de hoy:
-- 1. La terapia pulpar de un temporal (pulpectomía, pulpotomía) y la corona de acero de un
--    temporal piden el consentimiento de odontopediatría: con el prefijo no pedían ninguno.
-- 2. La corona sobre la propia pieza deja de pedir el de prótesis (piezas ausentes, implantes):
--    ese vínculo lo puso la regla del prefijo, no la clínica. El suyo, «corona», lo crea y lo une
--    el worker al arrancar (`ensureSuggestedConsentsEverywhere`), como toda plantilla sugerida nueva.
INSERT INTO public.consent_template_service (organization_id, template_key, service_id)
  SELECT DISTINCT s.organization_id, 'odontopediatria', s.id
  FROM public.service_catalog s
  JOIN catalog.treatment_template t ON t.id = s.template_id
  LEFT JOIN catalog.dental_template_rule r ON r.template_id = t.id
  WHERE (r.family = 'pulpectomia-deciduo' OR r.leaves_condition = 'pulpotomy'
      OR t.key LIKE 'pulpectomia-%' OR t.key LIKE 'pulpotomia%'
      OR t.key IN ('corona-de-acero-prefabricada-deciduo', 'corona-de-acero-con-frente-estetico-deciduo'))
    AND EXISTS (SELECT 1 FROM public.consent_template ct
      WHERE ct.organization_id = s.organization_id AND ct.key = 'odontopediatria')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM public.consent_template_service link
  USING public.service_catalog s, catalog.treatment_template t
  WHERE link.template_key = 'protesis'
    AND s.organization_id = link.organization_id AND s.id = link.service_id
    AND t.id = s.template_id
    AND (t.key LIKE 'corona-de-acero-%' OR t.key LIKE '3-4-de-corona-%' OR t.key LIKE 'poste-prefabricado-y-nucleo%'
      OR t.key IN ('corona-de-acrilico-con-metal-base', 'corona-de-metal-base', 'corona-de-porcelana', 'corona-de-titanio',
        'corona-metal-ceramica-metal-base', 'corona-de-acrilico-indirecta', 'poste-y-munon', 'reconstruccion-de-munon')
      OR EXISTS (SELECT 1 FROM catalog.dental_template_rule r
        WHERE r.template_id = t.id AND r.leaves_condition IN ('crown', 'post_and_core')));
