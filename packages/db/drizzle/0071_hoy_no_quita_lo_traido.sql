-- «Hoy no» (la atención de una sola página, ADR 0165): quien lleva el borrador saca de
-- la atención un tratamiento que trajo con «Hacerla hoy» y aún no registró. Solo la
-- operación `leaveTreatmentFromEncounter` borra la fila, con la RLS de la clínica.
GRANT DELETE ON TABLE public.encounter_plan_item TO dentalagent_app;
