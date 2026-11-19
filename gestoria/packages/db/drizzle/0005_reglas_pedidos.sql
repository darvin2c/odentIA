-- Las reglas de los pedidos (paso B4 del lienzo B). Como en `0003_reglas_catalogo.sql`, cada
-- tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa y cada tienda ve
-- solo lo suyo. Qué rol puede hacer qué lo decide el servidor (`permisos.ts`), en cada pedido.
--
-- Lo que se acordó en un pedido (líneas, precios, envío, medio de pago) no se cambia: solo su
-- estado, el número de envío, el link vigente y el motivo de anularlo. Un pago anotado solo se
-- revisa (confirmado o no coincide), con quién. La historia del pedido solo se agrega, a nombre
-- de quien pide y con la hora de la base. Lo que llega del proveedor del link lo escribe el
-- dueño de la base, sin persona.

GRANT SELECT, INSERT ON TABLE sale_order TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (state, tracking, link_url, link_ref, link_expires_at, cancel_reason, updated_at) ON TABLE sale_order TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE sale_order_line TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE order_payment TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (status, note, reviewed_by, reviewed_at) ON TABLE order_payment TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE order_event TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE store_payment_link TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (provider, access_token_enc, webhook_secret_enc, hint, connected_by, connected_at) ON TABLE store_payment_link TO gestoria_app;--> statement-breakpoint

ALTER TABLE sale_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE order_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE order_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store_payment_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY sale_order_read ON sale_order FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY sale_order_create ON sale_order FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id());--> statement-breakpoint
CREATE POLICY sale_order_change ON sale_order FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY sale_order_line_store ON sale_order_line FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY order_payment_read ON order_payment FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY order_payment_create ON order_payment FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND created_at = now());--> statement-breakpoint
CREATE POLICY order_payment_review ON order_payment FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id())
  WITH CHECK (store_id = app_store_id() AND reviewed_by = app_user_id());--> statement-breakpoint

CREATE POLICY order_event_read ON order_event FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY order_event_create ON order_event FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND actor_user_id = app_user_id() AND created_at = now());--> statement-breakpoint

CREATE POLICY store_payment_link_store ON store_payment_link FOR ALL TO gestoria_app
  USING (store_id = app_store_id())
  WITH CHECK (store_id = app_store_id() AND connected_by = app_user_id());
