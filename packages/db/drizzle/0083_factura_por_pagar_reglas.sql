-- Factura por pagar (ADR 0174): lo que TS no declara. Nace cerrada al rol de la aplicación
-- (ADR 0063) y aislada por clínica; no se borra y, una vez anotada, solo cambia al anularla.
ALTER TABLE public.expense_payable ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.expense_payable FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.expense_payable USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER expense_payable_immutable BEFORE UPDATE ON public.expense_payable FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('voided_at', 'voided_by', 'void_reason', 'updated_at');--> statement-breakpoint
CREATE TRIGGER expense_payable_no_delete BEFORE DELETE ON public.expense_payable FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.expense_payable TO dentalagent_app;
