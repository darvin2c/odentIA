-- La pulpectomía de un temporal tiene su propio consentimiento («pulpectomia», con sus riesgos y
-- alternativas: QA del 10 nov, M3). La 0089 unió esos servicios al de odontopediatría, que no la
-- describe: ese vínculo, el que puso la migración (sin autor), se quita. El nuevo lo crea y lo une
-- el worker al arrancar (`ensureSuggestedConsentsEverywhere`), como toda plantilla sugerida nueva.
-- Un vínculo que puso una persona de la clínica no se toca.
DELETE FROM public.consent_template_service link
  USING public.service_catalog s, catalog.treatment_template t
  WHERE link.template_key = 'odontopediatria'
    AND link.created_by IS NULL
    AND s.organization_id = link.organization_id AND s.id = link.service_id
    AND t.id = s.template_id
    AND (t.key LIKE 'pulpectomia-%'
      OR EXISTS (SELECT 1 FROM catalog.dental_template_rule r
        WHERE r.template_id = t.id AND r.family = 'pulpectomia-deciduo'));
