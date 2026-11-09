-- «Hoy no» (la atención de una sola página, ADR 0165): quien lleva el borrador saca de
-- la atención un tratamiento que trajo con «Hacerla hoy» y aún no registró. Solo la
-- operación `leaveTreatmentFromEncounter` borra la fila, con la RLS de la clínica.
GRANT DELETE ON TABLE public.encounter_plan_item TO dentalagent_app;--> statement-breakpoint
-- Y solo de una atención en borrador: lo de una atención firmada o anulada no se toca.
CREATE POLICY encounter_plan_item_delete_draft ON public.encounter_plan_item AS RESTRICTIVE FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.encounter e WHERE e.organization_id = encounter_plan_item.organization_id
    AND e.id = encounter_plan_item.encounter_id AND e.status = 'borrador'));
