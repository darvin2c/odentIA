-- Las reglas de Sofi y Argos (paso B5 del lienzo B). Como en las migraciones de reglas
-- anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa
-- y cada tienda ve solo lo suyo.
--
-- Sofi y Argos entran con el rol de la aplicación y un remitente propio (`agente:sofi`,
-- `agente:argos`, fijado por el servidor en `app.user_id`; ninguna cuenta empieza así). Pasan por
-- las mismas reglas de cada tienda y, además, la base les niega lo que nunca hacen, aunque el
-- código se equivoque o el modelo lo intente: confirmar o revisar un pago, anotar un pago que no
-- sea una captura por confirmar, tocar un pedido que ya no está por pagar, mover el stock o
-- cambiar la configuración, el catálogo o el equipo. Son reglas restrictivas: se suman a las que
-- ya hay, no las reemplazan.
CREATE FUNCTION app_is_agent() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.user_id', true), '') LIKE 'agente:%'
$$;--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE store_agent TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (enabled, display_name, knowledge, follow_payment, follow_thanks, follow_restock, follow_return, updated_by, updated_at) ON TABLE store_agent TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE conversation TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (customer_name, handler, waiting_reason, last_customer_at, updated_at) ON TABLE conversation TO gestoria_app;--> statement-breakpoint
-- Un mensaje no se cambia ni se borra: solo se agrega.
GRANT SELECT, INSERT ON TABLE conversation_message TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE stock_request TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (notified_at) ON TABLE stock_request TO gestoria_app;--> statement-breakpoint

ALTER TABLE store_agent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversation_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Lo que el dueño deja escrito: lo cambia una persona (con `configuracion`, en el servidor).
CREATE POLICY store_agent_read ON store_agent FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_agent_create ON store_agent FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id() AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_agent_change ON store_agent FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id());--> statement-breakpoint

-- Las conversaciones: hoy una persona solo abre las de prueba; las de cada canal las traerá su
-- adaptador (B2). Sofi y Argos no abren conversaciones.
CREATE POLICY conversation_read ON conversation FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY conversation_create ON conversation FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND channel = 'prueba'
    AND NOT app_is_agent()
  );--> statement-breakpoint
CREATE POLICY conversation_change ON conversation FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

-- Un mensaje va a nombre de quien lo escribe, con la hora de la base. Lo de Sofi lo escribe
-- solo el agente, y el agente solo escribe como Sofi: nadie firma por el otro.
CREATE POLICY conversation_message_read ON conversation_message FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY conversation_message_create ON conversation_message FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND actor_user_id = app_user_id() AND created_at = now()
    AND (author = 'sofi') = app_is_agent()
  );--> statement-breakpoint

CREATE POLICY stock_request_store ON stock_request FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

-- Lo que el agente nunca hace (tablero 8, «Nunca lo hace»).
-- Un pago: solo anota una captura, que queda por confirmar; nunca lo revisa.
CREATE POLICY order_payment_agent_create ON order_payment AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent() OR (kind = 'comprobante' AND status = 'por_confirmar' AND reviewed_by IS NULL));--> statement-breakpoint
CREATE POLICY order_payment_agent_review ON order_payment AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
-- Un pedido: solo toca uno por pagar, y solo para dejarlo por confirmar (anotó una captura),
-- guardar su link o anularlo para anotarlo de nuevo. Nunca lo da por pagado ni lo entrega.
CREATE POLICY sale_order_agent_change ON sale_order AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent() OR state = 'por_pagar')
  WITH CHECK (NOT app_is_agent() OR state IN ('por_pagar', 'por_confirmar', 'anulado'));--> statement-breakpoint
CREATE POLICY sale_order_agent_create ON sale_order AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent() OR state IN ('por_pagar', 'por_salir'));--> statement-breakpoint
-- El stock solo lo mueve una persona (al confirmar un pago, al salir o con una entrada).
CREATE POLICY stock_movement_agent ON stock_movement AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());--> statement-breakpoint

-- La tienda, su equipo, su configuración y su catálogo: el agente solo los lee.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'store', 'store_member', 'store_invitation', 'store_event',
    'store_payment_method', 'store_delivery_method', 'store_payment_link',
    'product', 'product_photo', 'product_variant', 'product_quantity_price',
    'product_promotion', 'product_link'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT TO gestoria_app WITH CHECK (NOT app_is_agent())',
      t || '_agent_create', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE TO gestoria_app USING (NOT app_is_agent())',
      t || '_agent_change', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE TO gestoria_app USING (NOT app_is_agent())',
      t || '_agent_remove', t);
  END LOOP;
END
$$;
