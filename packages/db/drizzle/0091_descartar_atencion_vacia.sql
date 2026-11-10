-- «Descartar» una atención en borrador sin nada registrado (10 nov): se borra y queda solo su
-- evento de auditoría. La app solo puede borrar borradores sin procedimientos (estos se
-- propagan); lo demás que la nombra con contenido clínico tiene FK sin propagar y frena el borrado.
GRANT DELETE ON TABLE public.encounter TO dentalagent_app;--> statement-breakpoint
CREATE POLICY encounter_delete_empty_draft ON public.encounter AS RESTRICTIVE FOR DELETE USING (
  status = 'borrador'
  AND NOT EXISTS (SELECT 1 FROM public.encounter_procedure p WHERE p.encounter_id = encounter.id)
);
