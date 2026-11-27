-- Las reglas de los cambios y devoluciones (entrega 8 de «gestorIA como odentIA», tablero 17). Como
-- en las migraciones de reglas anteriores, se concede solo lo que la aplicación usa y cada tienda ve
-- solo lo suyo; qué rol puede hacer qué lo decide el servidor (`permisos.ts`).
--
-- 1. El pedido entregado no se toca: el cambio es otro pedido. De qué pedido sale y lo que se
--    descuenta por lo que vuelve se escriben al crearlo y no tienen permiso de cambio.
-- 2. Lo que vuelve se anota solo junto con su cambio (en la misma transacción) y no se edita; solo
--    se marca, una vez, cuándo llegó a la tienda.
-- 3. Lo que vuelve entra al stock aunque la variante ya no se venda: la prenda vuelve igual.
-- 4. Sofi no arma cambios ni anota lo que vuelve: los pasa a una persona (tablero 24).
GRANT SELECT, INSERT ON TABLE sale_order_return TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (returned_at) ON TABLE sale_order_return TO gestoria_app;--> statement-breakpoint

ALTER TABLE sale_order_return ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY sale_order_return_read ON sale_order_return FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY sale_order_return_create ON sale_order_return FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND returned_at IS NULL
    AND EXISTS (
      SELECT 1 FROM sale_order o
      WHERE o.id = order_id AND o.exchange_of_id IS NOT NULL AND o.created_at = now()
    )
  );--> statement-breakpoint
CREATE POLICY sale_order_return_back ON sale_order_return FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND returned_at IS NULL)
  WITH CHECK (store_id = app_store_id() AND returned_at IS NOT NULL);--> statement-breakpoint

CREATE POLICY sale_order_return_agent_create ON sale_order_return AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY sale_order_return_agent_change ON sale_order_return AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY sale_order_agent_exchange ON sale_order AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent() OR exchange_of_id IS NULL);--> statement-breakpoint

CREATE OR REPLACE FUNCTION stock_movement_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  next_stock integer;
  gone timestamptz;
BEGIN
  SELECT removed_at INTO gone FROM product_variant
    WHERE id = NEW.variant_id AND store_id = NEW.store_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la variante no es de esta tienda' USING ERRCODE = '23503';
  END IF;
  -- Una variante quitada ya no recibe ni vende; solo vuelve lo de una venta anulada o devuelta.
  IF gone IS NOT NULL AND NEW.kind NOT IN ('anulacion', 'devolucion') THEN
    RAISE EXCEPTION 'la variante ya no se vende' USING ERRCODE = '23514',
      CONSTRAINT = 'stock_movement_removed_check';
  END IF;
  UPDATE product_variant SET stock = stock + NEW.quantity, updated_at = now()
    WHERE id = NEW.variant_id AND store_id = NEW.store_id
    RETURNING stock INTO next_stock;
  NEW.balance := next_stock;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION stock_movement_apply() FROM PUBLIC;
