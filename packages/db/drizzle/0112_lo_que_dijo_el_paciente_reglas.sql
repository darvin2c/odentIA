-- Lo que dijo el paciente (13 nov): lo que TS no declara. Las columnas `submitted_via` y
-- `finalized_by` de `clinical_form_response` y la tabla `patient_health_declaration` las generó
-- 0111 desde el esquema.

-- Lo que la persona declaró de su salud después del alta, tal como llegó: de la clínica, con su
-- RLS, y la aplicación solo lo agrega y lo lee (ADR 0063).
ALTER TABLE public.patient_health_declaration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_health_declaration FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_health_declaration USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.patient_health_declaration FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_health_declaration TO dentalagent_app;--> statement-breakpoint

-- Quién finalizó lo ya finalizado y por dónde llegó lo ya enviado salen de la auditoría, que es
-- donde estaban. La respuesta finalizada no admite cambios: el disparador se aparta solo para
-- este relleno. Lo que la auditoría no dice queda nulo, y la pantalla no lo afirma.
ALTER TABLE public.clinical_form_response DISABLE TRIGGER clinical_form_response_immutable;--> statement-breakpoint
UPDATE public.clinical_form_response r
SET finalized_by = a.actor_user_id
FROM (
  SELECT DISTINCT ON (e.organization_id, e.entity_id) e.organization_id, e.entity_id, e.actor_user_id
  FROM public.audit_event e
  JOIN auth."user" u ON u.id = e.actor_user_id
  WHERE e.entity = 'clinical_form_response' AND e.action = 'form_response.finalize'
  ORDER BY e.organization_id, e.entity_id, e.created_at DESC
) a
WHERE r.status = 'finalizado' AND r.finalized_by IS NULL
  AND a.organization_id = r.organization_id AND a.entity_id = r.id::text;--> statement-breakpoint
UPDATE public.clinical_form_response r
SET submitted_via = a.via
FROM (
  SELECT DISTINCT ON (e.organization_id, e.entity_id) e.organization_id, e.entity_id, e.metadata->>'via' AS via
  FROM public.audit_event e
  WHERE e.entity = 'clinical_form_response' AND e.action = 'form_response.portal_submitted'
    AND e.metadata->>'via' IN ('portal', 'enlace')
  ORDER BY e.organization_id, e.entity_id, e.created_at DESC
) a
WHERE r.source = 'portal' AND r.submitted_at IS NOT NULL AND r.submitted_via IS NULL
  AND a.organization_id = r.organization_id AND a.entity_id = r.id::text;--> statement-breakpoint
ALTER TABLE public.clinical_form_response ENABLE TRIGGER clinical_form_response_immutable;--> statement-breakpoint

-- Lo que el paciente envió queda como llegó (NTS 139-MINSA/2018/DGAIN, 5.3.3: nada se elimina y
-- la corrección es un registro nuevo). Desde el envío no cambian sus respuestas, la plantilla con
-- que respondió, de quién es, quién lo envió ni cuándo: el equipo lo corrige aparte, con una adenda
-- (`clinical_form_addendum`), y solo cambia lo que hace al revisarlo (estado, quién y cuándo, la
-- atención en que se revisó) o al descartarlo. La base no distingue al paciente del equipo: el
-- borrador que el paciente aún no envió lo cuida el servicio. Finalizado y descartado siguen
-- siendo definitivos.
CREATE OR REPLACE FUNCTION public.clinical_forms_response_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('finalizado','descartado') THEN
    RAISE EXCEPTION 'Formulario % inmutable (usar adenda) (%)', OLD.status, OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND (
    NEW.answers IS DISTINCT FROM OLD.answers
    OR NEW.template_id IS DISTINCT FROM OLD.template_id
    OR NEW.template_version IS DISTINCT FROM OLD.template_version
    OR NEW.template_title IS DISTINCT FROM OLD.template_title
    OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.respondent_contact_id IS DISTINCT FROM OLD.respondent_contact_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.submitted_via IS DISTINCT FROM OLD.submitted_via) THEN
    RAISE EXCEPTION 'Lo que envió el paciente no se cambia: se corrige aparte (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
