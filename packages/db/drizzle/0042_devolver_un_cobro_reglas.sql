-- Anular y devolver un cobro: reglas (ADR 0068).

-- 1. La devolución nace cerrada al rol de la app (ADR 0063): se lee y se crea,
-- nunca se cambia ni se borra.
GRANT SELECT,INSERT ON TABLE public.payment_return TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.payment_return ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.payment_return FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.payment_return USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
CREATE TRIGGER payment_return_immutable BEFORE UPDATE ON public.payment_return FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only();--> statement-breakpoint
CREATE TRIGGER payment_return_no_delete BEFORE DELETE ON public.payment_return FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint

-- 2. Todo vínculo queda dentro de la misma clínica.
ALTER TABLE ONLY public.payment_return ADD CONSTRAINT payment_return_ticket_fk FOREIGN KEY (organization_id, ticket_id) REFERENCES public.payment_ticket(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.payment_return ADD CONSTRAINT payment_return_branch_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_charge ADD CONSTRAINT patient_charge_original_fk FOREIGN KEY (organization_id, original_charge_id) REFERENCES public.patient_charge(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_application ADD CONSTRAINT patient_payment_application_replaces_fk FOREIGN KEY (organization_id, replaces_application_id) REFERENCES public.patient_payment_application(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_application ADD CONSTRAINT patient_payment_application_return_fk FOREIGN KEY (organization_id, return_id) REFERENCES public.payment_return(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.patient_payment_refund ADD CONSTRAINT patient_payment_refund_return_fk FOREIGN KEY (organization_id, return_id) REFERENCES public.payment_return(organization_id, id);--> statement-breakpoint

-- 3. El contador ahora numera también las devoluciones: lo único que cambia son
-- sus dos números.
DROP TRIGGER ticket_counter_immutable ON public.ticket_counter;--> statement-breakpoint
CREATE TRIGGER ticket_counter_immutable BEFORE UPDATE ON public.ticket_counter FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('next_number', 'next_return_number');
