-- Las reglas de los grupos de clientas (lienzo «Clientas bien perfiladas y Argos que hace el
-- marketing solo»). Como en las migraciones de reglas anteriores, cada tabla nace cerrada a
-- `gestoria_app`: se concede solo lo que la aplicación usa y cada tienda ve solo lo suyo. Quién
-- puede qué en la pantalla lo decide el servidor (`permisos.ts`).

-- Lo que Argos calcula de cada clienta lo escribe solo el dueño de la base, en la vuelta de cada
-- noche: la aplicación lo lee y nunca lo escribe (ni una persona, ni Sofi, ni Argos con sus reglas).
GRANT SELECT ON TABLE customer_profile TO gestoria_app;--> statement-breakpoint
ALTER TABLE customer_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_profile_read ON customer_profile FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint

-- Los grupos guardados: los crea una persona del equipo a su nombre y quitarlo solo lo marca (no
-- se borra ni se cambia lo que guarda). Los agentes no los tocan.
GRANT SELECT, INSERT ON TABLE customer_group TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (removed_at) ON TABLE customer_group TO gestoria_app;--> statement-breakpoint
ALTER TABLE customer_group ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_group_read ON customer_group FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY customer_group_create ON customer_group FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id()
    AND created_by = app_user_id()
    AND NOT app_is_agent()
    AND removed_at IS NULL
  );--> statement-breakpoint
CREATE POLICY customer_group_remove ON customer_group FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND removed_at IS NULL AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND removed_at IS NOT NULL);
