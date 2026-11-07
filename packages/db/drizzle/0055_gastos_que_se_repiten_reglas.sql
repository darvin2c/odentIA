-- Gastos que se repiten (QA de comisiones, entrega 8): lo que TS no declara. Las dos tablas nacen
-- cerradas al rol de la aplicación (ADR 0063) y sin GRANT a Argos: ninguna vista las lee todavía.
-- La plantilla solo cambia en lo que se edita (importe, concepto, día, persona, fin y si sale de la
-- caja) y nada se borra; «este mes no» solo se agrega y se anula. El pago es un gasto: su enlace
-- (`recurring_id`, `recurring_month`) se escribe al insertar y `expense_immutable` ya lo congela.

-- ═════════════════════════════════════════════════════════════════════════
-- public.expense_recurring
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.expense_recurring ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense_recurring FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense_recurring USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
-- La sede es de la misma clínica.
ALTER TABLE ONLY public.expense_recurring
    ADD CONSTRAINT expense_recurring_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
CREATE TRIGGER expense_recurring_immutable BEFORE UPDATE ON public.expense_recurring FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('concept', 'amount_cents', 'day', 'member_user_id', 'last_month', 'from_cash', 'updated_at');--> statement-breakpoint
CREATE TRIGGER expense_recurring_no_delete BEFORE DELETE ON public.expense_recurring FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.expense_recurring FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.expense_recurring TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.expense_recurring_skip
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.expense_recurring_skip ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense_recurring_skip FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense_recurring_skip USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
-- Solo se anula («Deshacer»): lo demás no cambia.
CREATE TRIGGER expense_recurring_skip_immutable BEFORE UPDATE ON public.expense_recurring_skip FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by');--> statement-breakpoint
CREATE TRIGGER expense_recurring_skip_no_delete BEFORE DELETE ON public.expense_recurring_skip FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.expense_recurring_skip FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.expense_recurring_skip TO dentalagent_app;
