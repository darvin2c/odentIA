-- Las reglas de «Tu marca» y los datos de la tienda (tablero 10). Como en las migraciones de reglas
-- anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa.
-- Lo cambia quien tiene `configuracion` (lo decide el servidor), solo en la tienda en la que está.
--
-- La tienda: además de su hora, su nombre, su país, el nombre que ve el cliente y el color. La
-- moneda no se toca (decisión 9). Sofi y Argos nunca cambian la tienda.
GRANT UPDATE (name, country, public_name, brand_color) ON TABLE store TO gestoria_app;--> statement-breakpoint
CREATE POLICY store_no_agent_change ON store AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint

-- El logo y la portada: una de cada una por tienda, a nombre de quien la sube. Se cambian o se
-- quitan; el agente no las toca.
GRANT SELECT, INSERT, DELETE ON TABLE store_image TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (content_type, content, updated_by, updated_at) ON TABLE store_image TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_image ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_image_read ON store_image FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_image_create ON store_image FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id() AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_image_change ON store_image FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id());--> statement-breakpoint
CREATE POLICY store_image_remove ON store_image FOR DELETE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent());--> statement-breakpoint

-- El nombre del link: se agrega uno nuevo o se vuelve a uno propio de antes, y nunca se borra (el
-- de antes lleva al nuevo y nadie más lo toma). Solo cambia cuál está vigente.
GRANT SELECT, INSERT ON TABLE store_link TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (current) ON TABLE store_link TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_link_read ON store_link FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_link_create ON store_link FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_link_change ON store_link FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id());
