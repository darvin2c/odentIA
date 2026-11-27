-- Las reglas de corregir un pedido sin anularlo (ADR 0224). Como en las migraciones de reglas
-- anteriores, se concede solo lo que la aplicación usa; qué rol puede hacer qué lo decide el
-- servidor (`permisos.ts`).
--
-- 1. «Cambiar»: el mismo pedido, con su número y sus pagos, cambia sus productos, su entrega y su
--    total. Las líneas no se editan: se reemplazan enteras, y cada una vuelve a pasar sus reglas
--    de precio (`sale_order_line_price_check`); el total sigue siendo su suma
--    (`sale_order_amounts_check`). El medio de pago, el cliente y el canal no se cambian aquí.
-- 2. «Pasar a…» y «No se entregó»: el día de entrega.
-- 3. «Deshacer» la confirmación de una captura: vuelve a esperar a una persona. Un pago solo da
--    los pasos de su revisión (`order_payment_step`): de por confirmar a confirmado o no coincide,
--    y de una captura confirmada a por confirmar. Nada más, ni con el dueño de la base.
-- 4. El agente no reemplaza líneas: sigue anotando las de su pedido al crearlo (`0007_reglas_sofi.sql`).
GRANT UPDATE (address, delivery_method_id, delivery_name, delivery_type, delivery_zone, delivery_list_cents, delivery_cents, delivery_free_by_policy, items_auto_cents, subtotal_cents, discount_cents, gift_cents, total_cents, margin_cents, margin_used_cents, price_expires_at, deliver_on) ON TABLE sale_order TO gestoria_app;--> statement-breakpoint
GRANT DELETE ON TABLE sale_order_line TO gestoria_app;--> statement-breakpoint
CREATE POLICY sale_order_line_agent_remove ON sale_order_line AS RESTRICTIVE FOR DELETE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint

-- Deshacer una confirmación: solo la de una captura, a nombre de nadie (vuelve a esperar).
CREATE POLICY order_payment_undo ON order_payment FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND status = 'confirmado' AND kind = 'comprobante')
  WITH CHECK (store_id = app_store_id() AND status = 'por_confirmar' AND reviewed_by IS NULL);--> statement-breakpoint

CREATE FUNCTION order_payment_step() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'por_confirmar' AND NEW.status IN ('confirmado', 'no_coincide') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmado' AND OLD.kind = 'comprobante' AND NEW.status = 'por_confirmar'
    AND NEW.reviewed_by IS NULL AND NEW.reviewed_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'un pago solo da los pasos de su revisión' USING ERRCODE = '23514',
    CONSTRAINT = 'order_payment_step_check';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION order_payment_step() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_payment_step BEFORE UPDATE ON order_payment
  FOR EACH ROW EXECUTE FUNCTION order_payment_step();
