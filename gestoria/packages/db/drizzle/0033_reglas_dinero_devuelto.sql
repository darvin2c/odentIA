-- Las reglas del dinero devuelto (entrega 8 de «gestorIA como odentIA», tablero 17). Como en las
-- migraciones de reglas anteriores, la tabla nace cerrada a `gestoria_app`: se concede solo lo que
-- la aplicación usa y cada tienda ve solo lo suyo. Quién puede devolver lo decide el servidor
-- (`pagos.confirmar` en `permisos.ts`), y que no se devuelva más de lo que sobra, también.
--
-- Lo devuelto solo se agrega, a nombre de quien pide y con la hora de la base: no se cambia ni se
-- borra. Sofi nunca devuelve dinero.
GRANT SELECT, INSERT ON TABLE order_refund TO gestoria_app;--> statement-breakpoint

ALTER TABLE order_refund ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY order_refund_read ON order_refund FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY order_refund_create ON order_refund FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND created_at = now());--> statement-breakpoint
CREATE POLICY order_refund_agent ON order_refund AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());
