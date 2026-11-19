-- Las reglas de la configuración de la tienda (paso B3 del lienzo B): medios de pago, formas de
-- entrega y el catálogo con su stock. Como en `0001_reglas.sql`, cada tabla nace cerrada a
-- `gestoria_app`: se concede solo lo que la aplicación usa y cada tienda ve solo lo suyo. Qué
-- rol puede cambiar qué lo decide el servidor (`permisos.ts`), en cada pedido.
--
-- El stock de una variante no lo escribe nadie: solo cambia con un movimiento del kardex. Al
-- agregarlo, `stock_movement_apply` (con el dueño de la base) pone al día el stock y anota el
-- saldo; un saldo negativo se rechaza. El kardex solo se agrega, a nombre de quien pide y con
-- la hora de la base. El disparador corre antes de insertar: nunca se agrega un movimiento con
-- `ON CONFLICT DO NOTHING`, que movería el stock aunque la fila se descarte (ADR 0206).

CREATE FUNCTION stock_movement_apply() RETURNS trigger
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
  -- Una variante quitada ya no recibe ni vende; solo vuelve lo de una venta anulada.
  IF gone IS NOT NULL AND NEW.kind <> 'anulacion' THEN
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
REVOKE ALL ON FUNCTION stock_movement_apply() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER stock_movement_apply BEFORE INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION stock_movement_apply();--> statement-breakpoint

-- Medios de pago y formas de entrega: los de la tienda en la que se está.
GRANT SELECT, INSERT, DELETE ON TABLE store_payment_method TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (name, type_code, collection, details, is_active, updated_at) ON TABLE store_payment_method TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE store_delivery_method TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (name, type, details, cost, price_cents, zones, eta, accepts_pay_on_delivery, max_discount_cents, free_from_cents, is_active, updated_at) ON TABLE store_delivery_method TO gestoria_app;--> statement-breakpoint
-- El catálogo.
GRANT SELECT, INSERT, DELETE ON TABLE product TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (name, category, description, list_price_cents, min_price_cents, options, updated_at) ON TABLE product TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE product_photo TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (position) ON TABLE product_photo TO gestoria_app;--> statement-breakpoint
-- Una variante nace con stock 0 (la regla de abajo) y su stock no se actualiza nunca a mano.
GRANT SELECT, INSERT ON TABLE product_variant TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (sku, price_cents, photo_id, removed_at, updated_at) ON TABLE product_variant TO gestoria_app;--> statement-breakpoint
-- El kardex solo se agrega.
GRANT SELECT, INSERT ON TABLE stock_movement TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE product_quantity_price TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE product_promotion TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (name, percent_off, starts_on, ends_on) ON TABLE product_promotion TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE product_link TO gestoria_app;--> statement-breakpoint

ALTER TABLE store_payment_method ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store_delivery_method ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_photo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_variant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_movement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_quantity_price ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_promotion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY store_payment_method_store ON store_payment_method FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_delivery_method_store ON store_delivery_method FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_store ON product FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_photo_store ON product_photo FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id() AND created_by = app_user_id());--> statement-breakpoint
CREATE POLICY product_quantity_price_store ON product_quantity_price FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_promotion_store ON product_promotion FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_link_store ON product_link FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY product_variant_read ON product_variant FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_variant_create ON product_variant FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND stock = 0);--> statement-breakpoint
CREATE POLICY product_variant_change ON product_variant FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY stock_movement_read ON stock_movement FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY stock_movement_create ON stock_movement FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND actor_user_id = app_user_id() AND created_at = now());
