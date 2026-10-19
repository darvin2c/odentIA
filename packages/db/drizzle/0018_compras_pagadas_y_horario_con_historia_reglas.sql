-- Reglas de la 0017 (Reportes v2, fase 3; ADR 0060 y 0061).

-- professional_schedule: el horario guarda desde cuándo vale. Lo que ya existía
-- vale desde el día en que se guardó (día de su sede); un día antes de eso no
-- hay registro y Reportes usa el horario de hoy, y lo dice.
UPDATE public.professional_schedule s SET valid_from = (s.created_at AT TIME ZONE coalesce(b.timezone, op.timezone, 'UTC'))::date
FROM public.branch b LEFT JOIN public.org_profile op ON op.organization_id = b.organization_id
WHERE b.organization_id = s.organization_id AND b.id = s.branch_id;--> statement-breakpoint
-- Una fila apagada de antes no tiene cuándo terminó: termina al día siguiente de empezar.
UPDATE public.professional_schedule SET valid_until = valid_from + 1 WHERE NOT is_active AND valid_until IS NULL;--> statement-breakpoint
-- La vigente es la activa y no tiene fin; la cerrada terminó después de empezar.
ALTER TABLE public.professional_schedule ADD CONSTRAINT professional_schedule_validity_check
  CHECK ((valid_until IS NULL) = is_active AND (valid_until IS NULL OR valid_until > valid_from));--> statement-breakpoint

-- purchase_order: número sin saltos por clínica, en el orden en que se crearon.
UPDATE public.purchase_order o SET order_number = n.number
FROM (
  SELECT id, row_number() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS number FROM public.purchase_order
) n WHERE n.id = o.id;--> statement-breakpoint
INSERT INTO public.org_counter (organization_id, key, value)
  SELECT organization_id, 'purchase_order', max(order_number) FROM public.purchase_order GROUP BY organization_id
ON CONFLICT (organization_id, key) DO UPDATE SET value = greatest(public.org_counter.value, excluded.value);--> statement-breakpoint
ALTER TABLE public.purchase_order ALTER COLUMN order_number SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.purchase_order ADD CONSTRAINT purchase_order_number_check CHECK (order_number > 0);--> statement-breakpoint

-- expense: el gasto que paga una compra va a la sede de su almacén y en su
-- moneda; `purchase_order_id` ya es inmutable (`expense_immutable` revisa todas
-- las columnas salvo la anulación).

-- supplier_credit_use: cada clínica ve lo suyo; se anula, no se borra ni se reescribe.
ALTER TABLE public.supplier_credit_use ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.supplier_credit_use FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.supplier_credit_use USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.supplier_credit_use FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.supplier_credit_use TO dentalagent_app;--> statement-breakpoint
CREATE TRIGGER supplier_credit_use_immutable BEFORE UPDATE ON public.supplier_credit_use FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason');--> statement-breakpoint
CREATE TRIGGER supplier_credit_use_no_delete BEFORE DELETE ON public.supplier_credit_use FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- expense_gap_dismissal: cada clínica ve lo suyo; uno por tipo, mes y sede
-- (sin sede cuenta como una más); la aplicación lo anota y no lo reescribe.
ALTER TABLE ONLY public.expense_gap_dismissal ADD CONSTRAINT expense_gap_dismissal_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
CREATE UNIQUE INDEX expense_gap_dismissal_uidx ON public.expense_gap_dismissal USING btree (organization_id, category, month, branch_id) NULLS NOT DISTINCT;--> statement-breakpoint
ALTER TABLE public.expense_gap_dismissal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense_gap_dismissal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense_gap_dismissal USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.expense_gap_dismissal FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.expense_gap_dismissal TO dentalagent_app;
