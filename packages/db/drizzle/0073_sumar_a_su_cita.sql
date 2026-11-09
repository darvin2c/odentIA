-- «Sumar a su cita» y su «Deshacer» (QA de la ficha del 9 nov): lo que lleva una cita que ya
-- existe se cambia con `setAppointmentPlanItems`, la única operación que borra una fila, con la
-- RLS de la clínica.
GRANT DELETE ON TABLE public.appointment_plan_item TO dentalagent_app;--> statement-breakpoint
-- Y solo de una cita en pie y por venir: lo que llevó una cita que ya pasó, se atendió o se
-- canceló es constancia y no se toca.
CREATE POLICY appointment_plan_item_delete_upcoming ON public.appointment_plan_item AS RESTRICTIVE FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = appointment_plan_item.organization_id
    AND a.id = appointment_plan_item.appointment_id AND a.status IN ('programada', 'confirmada') AND a.starts_at > now()));
