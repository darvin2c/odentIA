-- Gasto con medio de pago (ADR 0167): lo que TS no declara. La plantilla de lo que se repite
-- también cambia «con qué suele pagarse» (`payment_method_id`); lo demás sigue como en la 0055.
DROP TRIGGER expense_recurring_immutable ON public.expense_recurring;--> statement-breakpoint
CREATE TRIGGER expense_recurring_immutable BEFORE UPDATE ON public.expense_recurring FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only('concept', 'amount_cents', 'day', 'member_user_id', 'last_month', 'from_cash', 'payment_method_id', 'updated_at');
