-- Controles configurables (entrega 10, decisión B5) y uno por fecha (B4): lo que TS no declara.
-- Los tratamientos de cada control nacen cerrados al rol de la aplicación (ADR 0063), aislados
-- por clínica, y se agregan o se quitan: nada se reescribe.
ALTER TABLE public.clinical_follow_up_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.clinical_follow_up_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.clinical_follow_up_item USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.clinical_follow_up_item TO dentalagent_app;--> statement-breakpoint
-- Los controles del año que dejó la endodoncia antes de esta entrega (regla fija del código, con
-- la pieza en el título): quedan marcados como de su tratamiento, a los 365 días, con su vínculo.
UPDATE public.clinical_follow_up SET finish_after_days = 365
  WHERE kind = 'tratamiento' AND plan_item_id IS NOT NULL AND finish_after_days IS NULL
    AND title LIKE 'Control radiográfico de la endodoncia%';--> statement-breakpoint
INSERT INTO public.clinical_follow_up_item (organization_id, patient_id, follow_up_id, plan_item_id)
  SELECT organization_id, patient_id, id, plan_item_id FROM public.clinical_follow_up
  WHERE finish_after_days IS NOT NULL AND plan_item_id IS NOT NULL
  ON CONFLICT DO NOTHING;
