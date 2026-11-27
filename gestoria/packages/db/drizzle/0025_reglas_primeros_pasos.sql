-- Las reglas de los primeros pasos (tablero 16). Como en las migraciones de reglas anteriores, la
-- tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa. Saltar un paso es
-- de quien tiene `configuracion` (lo decide el servidor), solo en la tienda en la que está, a su
-- nombre. Que quedó lista lo anota el sistema al verla completa (sin nombre). Nunca se borra: así
-- la lista no vuelve. Sofi y Argos no la tocan.
GRANT SELECT, INSERT ON TABLE store_setup TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (skipped, finished_at, updated_by, updated_at) ON TABLE store_setup TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_setup ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_setup_read ON store_setup FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_setup_create ON store_setup FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND (updated_by IS NULL OR updated_by = app_user_id())
    AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_setup_change ON store_setup FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND (updated_by IS NULL OR updated_by = app_user_id()));
