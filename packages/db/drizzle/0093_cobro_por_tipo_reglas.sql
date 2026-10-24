-- Cobro por tipo (ADR 0085). La conversación de Sofi cambia de tipo mientras
-- dura su ventana (de «Informa» a «Gestiona» si después mueve o reserva una
-- cita): la aplicación puede reescribir su tipo y su precio, nunca los de una
-- acción ya cobrada. El GB del día lo mide el reloj SaaS con owner; la clínica
-- lo lee.
GRANT UPDATE(tier,base_price_micros,price_micros,discount_bps,detail) ON TABLE public.saas_action TO dentalagent_app;
--> statement-breakpoint
CREATE FUNCTION public.saas_action_charged_is_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.charge_id IS NOT NULL AND (
    NEW.tier IS DISTINCT FROM OLD.tier
    OR NEW.base_price_micros IS DISTINCT FROM OLD.base_price_micros
    OR NEW.price_micros IS DISTINCT FROM OLD.price_micros
    OR NEW.discount_bps IS DISTINCT FROM OLD.discount_bps
    OR NEW.units IS DISTINCT FROM OLD.units
    OR NEW.kind IS DISTINCT FROM OLD.kind
  ) THEN
    RAISE EXCEPTION 'Una acción ya cobrada no cambia de tipo ni de precio' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER saas_action_charged_is_frozen BEFORE UPDATE ON public.saas_action FOR EACH ROW EXECUTE FUNCTION public.saas_action_charged_is_frozen();--> statement-breakpoint
REVOKE ALL ON TABLE public.storage_usage_day FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.storage_usage_day TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.storage_usage_day ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.storage_usage_day FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.storage_usage_day USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));
