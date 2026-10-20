-- Biblioteca de servicios por país (ADR 0067, issue 40).
-- Sale el estado «Heredada»: ningún flujo crea un servicio heredado y no hay
-- datos reales. Lo que quede de una base de desarrollo pasa a servicio propio.
-- Un servicio de la biblioteca anterior (plantillas `cpms:`, que la siembra
-- nueva retira junto con sus códigos) pasa a propio con el código que tenía:
-- sigue codificado y la clínica no lo pierde.
UPDATE public.service_catalog s SET source = 'custom', template_id = NULL, procedure_system = c.system_key, procedure_code = c.code, procedure_version = c.version FROM catalog.treatment_template t JOIN catalog.treatment_template_code c ON c.template_id = t.id WHERE s.template_id = t.id AND t.key LIKE 'cpms:%';--> statement-breakpoint
UPDATE public.service_catalog SET source = 'custom', template_id = NULL WHERE source = 'legacy';--> statement-breakpoint
UPDATE public.service_catalog SET source = 'custom' WHERE source = 'template' AND template_id IS NULL;--> statement-breakpoint
UPDATE public.service_catalog SET source = 'template' WHERE source = 'custom' AND template_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE public.service_catalog DROP CONSTRAINT service_catalog_source_check;--> statement-breakpoint
ALTER TABLE public.service_catalog ADD CONSTRAINT service_catalog_source_check CHECK (source IN ('template', 'custom') AND (source = 'template') = (template_id IS NOT NULL));--> statement-breakpoint
-- Lo que deja un tratamiento de la biblioteca en la pieza tiene la misma forma
-- que el de un servicio: un hallazgo y, si corresponde, su variante.
ALTER TABLE catalog.treatment_template ADD CONSTRAINT treatment_template_leaves_finding_check CHECK (leaves_finding IS NULL OR (jsonb_typeof(leaves_finding) = 'object' AND jsonb_typeof(leaves_finding -> 'condition') = 'string'));--> statement-breakpoint
-- La clínica nace con las especialidades de su país (ADR 0067). En una que ya
-- existía, las claves de la biblioteca que corresponden una a una con una del
-- país pasan a esa clave, con su nombre del país si conservaba el de la
-- biblioteca: así no quedan «Periodoncia» y «Periodoncia e Implantología» a la
-- vez. Las demás (Diagnóstico, Prevención, Estética…) quedan como especialidades
-- creadas por la clínica, que puede archivar.
UPDATE public.org_specialty s SET key = m.new_key, name = CASE WHEN s.name = m.old_name THEN m.new_name ELSE s.name END
FROM public.org_profile p, (VALUES
  ('PE', 'general', 'Servicios odontológicos generales', 'odontologia_general', 'Odontología general'),
  ('PE', 'cirugia', 'Cirugía', 'cirugia_bucal_maxilofacial', 'Cirugía Bucal y Maxilofacial'),
  ('PE', 'ortodoncia', 'Ortodoncia', 'ortodoncia_ortopedia_maxilar', 'Ortodoncia y Ortopedia Maxilar'),
  ('PE', 'periodoncia', 'Periodoncia', 'periodoncia_implantologia', 'Periodoncia e Implantología'),
  ('PE', 'protesis', 'Prótesis', 'rehabilitacion_oral', 'Rehabilitación Oral'),
  ('PE', 'restauradora', 'Restauradora', 'restauradora_estetica', 'Odontología Restauradora y Estética'),
  ('PE', 'implantologia', 'Implantología', 'implantologia_oral_integral', 'Implantología Oral Integral'),
  ('CL', 'general', 'Servicios odontológicos generales', 'odontologia_general', 'Odontología general'),
  ('CL', 'cirugia', 'Cirugía', 'cirugia_traumatologia_bucomaxilofacial', 'Cirugía y traumatología buco maxilofacial'),
  ('CL', 'ortodoncia', 'Ortodoncia', 'ortodoncia_ortopedia_dentomaxilofacial', 'Ortodoncia y ortopedia dento maxilofacial'),
  ('CL', 'protesis', 'Prótesis', 'rehabilitacion_oral', 'Rehabilitación oral'),
  ('CL', 'implantologia', 'Implantología', 'implantologia_bucomaxilofacial', 'Implantología buco maxilofacial'),
  ('CL', 'disfuncion', 'Disfunción', 'trastornos_temporomandibulares', 'Trastornos temporomandibulares y dolor orofacial'),
  ('CO', 'general', 'Servicios odontológicos generales', 'odontologia_general', 'Odontología general'),
  ('CO', 'cirugia', 'Cirugía', 'cirugia_oral', 'Cirugía oral'),
  ('CO', 'protesis', 'Prótesis', 'rehabilitacion_oral', 'Rehabilitación oral'),
  ('*', 'general', 'Servicios odontológicos generales', 'odontologia_general', 'Odontología general'),
  ('*', 'cirugia', 'Cirugía', 'cirugia_oral', 'Cirugía oral y maxilofacial'),
  ('*', 'protesis', 'Prótesis', 'rehabilitacion_oral', 'Rehabilitación oral')
) AS m(country, old_key, old_name, new_key, new_name)
WHERE p.organization_id = s.organization_id
  AND (p.country_code = m.country OR (m.country = '*' AND p.country_code IS DISTINCT FROM 'PE' AND p.country_code IS DISTINCT FROM 'CL' AND p.country_code IS DISTINCT FROM 'CO'))
  AND s.key = m.old_key
  AND NOT EXISTS (SELECT 1 FROM public.org_specialty o WHERE o.organization_id = s.organization_id AND o.key = m.new_key);
