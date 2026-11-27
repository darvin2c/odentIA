-- Las reglas de Despachos y Caja (entrega 3 del lienzo «gestorIA como odentIA»; ADR 0228). Como en
-- las migraciones de reglas anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo
-- que la aplicación usa y cada tienda ve solo lo suyo. Qué rol puede hacer qué lo decide el servidor
-- (`permisos.ts`): las entregas, todo el equipo; Caja, el Dueño y el Administrador.
--
-- 1. Las franjas de la tienda las cambia quien cambia la configuración; Sofi nunca toca la tienda
--    (`store_no_agent_change`, de `0023_reglas_tu_marca.sql`).
-- 2. Un pedido cambia su franja, su repartidor y su agencia (el número de envío ya se concedía).
--    Sofi no asigna repartidor, franja ni agencia: ni al anotar el pedido ni al cambiarlo.
-- 3. Un repartidor es de la tienda y no se borra: lo que llevó y lo que cobró siguen con su nombre.
--    Se corrige su nombre o se deja de usar; su cuenta no se cambia aquí (la enlazará gestorIA
--    Reparto, en su propia migración). Una persona del equipo es repartidor solo de su tienda.
-- 4. Lo cobrado en la puerta queda a nombre de quien llevaba el pedido, nunca de otro.
-- 5. «Recibí» solo se agrega, a nombre de quien recibe y con la hora de la base, y cada pago en
--    efectivo entra en uno solo (la clave de `cash_handover_payment`), del mismo repartidor.
GRANT UPDATE (delivery_slots) ON TABLE store TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (slot_start, slot_end, courier_id, agency) ON TABLE sale_order TO gestoria_app;--> statement-breakpoint
CREATE POLICY sale_order_agent_dispatch ON sale_order AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent() OR (courier_id IS NULL AND agency IS NULL));--> statement-breakpoint
-- Sofi sí cambia sus pedidos por pagar (anularlos, cambiarlos), pero una regla no ve lo de antes:
-- el cambio de franja, repartidor o agencia lo frena este disparador.
CREATE FUNCTION sale_order_agent_dispatch() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF app_is_agent() AND (
    NEW.courier_id IS DISTINCT FROM OLD.courier_id OR NEW.agency IS DISTINCT FROM OLD.agency
    OR NEW.slot_start IS DISTINCT FROM OLD.slot_start OR NEW.slot_end IS DISTINCT FROM OLD.slot_end
  ) THEN
    RAISE EXCEPTION 'el agente no asigna repartidor, franja ni agencia' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION sale_order_agent_dispatch() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER sale_order_agent_dispatch BEFORE UPDATE ON sale_order
  FOR EACH ROW EXECUTE FUNCTION sale_order_agent_dispatch();--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE store_courier TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (name, is_active) ON TABLE store_courier TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_courier ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_courier_read ON store_courier FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_courier_create ON store_courier FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND NOT app_is_agent()
    AND (
      user_id IS NULL
      OR EXISTS (
        SELECT 1 FROM store_member m
        WHERE m.store_id = store_courier.store_id AND m.user_id = store_courier.user_id
      )
    )
  );--> statement-breakpoint
CREATE POLICY store_courier_change ON store_courier FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id());--> statement-breakpoint

-- Lo cobrado en la puerta, a nombre de quien llevaba el pedido; Sofi nunca cobra en la puerta.
CREATE POLICY order_payment_courier ON order_payment AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (
    courier_id IS NULL
    OR (
      NOT app_is_agent() AND kind = 'al_recibir'
      AND EXISTS (
        SELECT 1 FROM sale_order o
        WHERE o.id = order_payment.order_id AND o.courier_id = order_payment.courier_id
      )
    )
  );--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE cash_handover TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE cash_handover_payment TO gestoria_app;--> statement-breakpoint
ALTER TABLE cash_handover ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cash_handover_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cash_handover_read ON cash_handover FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY cash_handover_create ON cash_handover FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND received_by = app_user_id() AND received_at = now()
    AND NOT app_is_agent()
  );--> statement-breakpoint
CREATE POLICY cash_handover_payment_read ON cash_handover_payment FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
-- Solo un pago en efectivo cobrado en la puerta y confirmado, del mismo repartidor que el «Recibí»
-- (o los dos sin repartidor), en un «Recibí» de quien lo anota.
CREATE POLICY cash_handover_payment_create ON cash_handover_payment FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND NOT app_is_agent()
    AND EXISTS (
      SELECT 1 FROM cash_handover h JOIN order_payment p ON p.id = cash_handover_payment.payment_id
      WHERE h.id = cash_handover_payment.handover_id AND h.store_id = cash_handover_payment.store_id
        AND h.received_by = app_user_id()
        AND p.store_id = cash_handover_payment.store_id AND p.kind = 'al_recibir'
        AND p.method_type = '10' AND p.status = 'confirmado'
        AND p.courier_id IS NOT DISTINCT FROM h.courier_id
    )
  );
