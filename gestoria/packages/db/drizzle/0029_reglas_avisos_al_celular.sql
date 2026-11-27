-- Las reglas de los avisos al celular (tablero 15). Como en las migraciones de reglas anteriores,
-- cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa. Lo que hace
-- el sistema por su cuenta (anotar hasta dónde miró, el «Listo», olvidar un celular que ya no
-- existe, pasar un celular a quien lo activa en el mismo navegador) lo hace el dueño de la base.
-- Sofi y Argos no tocan nada de esto.
--
-- Un celular: cada persona ve, activa, renueva sus claves y apaga solo los suyos. Nunca anota el
-- «Listo» por su cuenta.
GRANT SELECT, INSERT, DELETE ON TABLE push_device TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (p256dh, auth) ON TABLE push_device TO gestoria_app;--> statement-breakpoint
ALTER TABLE push_device ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY push_device_read ON push_device FOR SELECT TO gestoria_app
  USING (user_id = app_user_id() AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY push_device_create ON push_device FOR INSERT TO gestoria_app
  WITH CHECK (user_id = app_user_id() AND NOT app_is_agent() AND welcomed_at IS NULL);--> statement-breakpoint
CREATE POLICY push_device_change ON push_device FOR UPDATE TO gestoria_app
  USING (user_id = app_user_id() AND NOT app_is_agent())
  WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY push_device_remove ON push_device FOR DELETE TO gestoria_app
  USING (user_id = app_user_id() AND NOT app_is_agent());--> statement-breakpoint

-- Lo que elige: cada persona, lo suyo y solo en la tienda en la que está. Qué puede elegir lo
-- decide el servidor con su rol (`permisos.ts`). Hasta dónde miró el sistema no lo escribe la
-- aplicación.
GRANT SELECT, INSERT ON TABLE push_choice TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (kinds, updated_at) ON TABLE push_choice TO gestoria_app;--> statement-breakpoint
ALTER TABLE push_choice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY push_choice_read ON push_choice FOR SELECT TO gestoria_app
  USING (store_id = app_store_id() AND user_id = app_user_id() AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY push_choice_create ON push_choice FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND user_id = app_user_id() AND NOT app_is_agent()
    AND last_event_seq IS NULL AND chats_seen IS NULL);--> statement-breakpoint
CREATE POLICY push_choice_change ON push_choice FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND user_id = app_user_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND user_id = app_user_id());
