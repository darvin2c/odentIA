-- Las reglas de las fotos, los videos y «Cargar muchos» (ADR 0236). Como en las migraciones de
-- reglas anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación
-- usa y cada tienda ve solo lo suyo. Qué rol puede cambiar qué lo decide el servidor
-- (`permisos.ts`): cambiar es `configuracion`; ver, `catalogo.ver`.
--
-- 1. La foto: dónde está, su peso, su tamaño y la propuesta de quitar el fondo. La regla de antes
--    pedía que quien la cambia fuera quien la subió (`created_by` en el WITH CHECK de FOR ALL):
--    nadie más podía moverla. Ahora se sube a nombre de quien la sube y la cambia cualquiera de
--    la tienda con permiso. La aplicación ya no escribe el contenido en la base (`content`).
-- 2. El video y la carga: a nombre de quien los sube o abre, con la hora de la base. Una carga
--    creada o descartada ya no cambia.
-- 3. El agente (Sofi, Argos) solo lee las fotos y los videos, y no ve las cargas.
-- 4. Lo que hay que borrar del almacenamiento lo anota la base al borrar la fila que lo usaba
--    (`media_trash`), también cuando se borra en cascada. La aplicación no lo ve.
GRANT UPDATE (cutout) ON TABLE product_photo TO gestoria_app;--> statement-breakpoint
DROP POLICY product_photo_store ON product_photo;--> statement-breakpoint
CREATE POLICY product_photo_read ON product_photo FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_photo_create ON product_photo FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND created_at = now()
    AND content IS NULL AND object_key IS NOT NULL
  );--> statement-breakpoint
CREATE POLICY product_photo_change ON product_photo FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_photo_remove ON product_photo FOR DELETE TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON TABLE product_video TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (color_id, label) ON TABLE product_video TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE bulk_load TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (state, finished_by, finished_at, created_products) ON TABLE bulk_load TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE bulk_load_item TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (position, state, name, category, description, list_price_cents, options, variants, doubt, updated_at) ON TABLE bulk_load_item TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE bulk_load_photo TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (item_id, position) ON TABLE bulk_load_photo TO gestoria_app;--> statement-breakpoint

ALTER TABLE product_video ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bulk_load ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bulk_load_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bulk_load_photo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE media_trash ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY product_video_read ON product_video FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_video_create ON product_video FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND created_at = now());--> statement-breakpoint
CREATE POLICY product_video_change ON product_video FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_video_remove ON product_video FOR DELETE TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY bulk_load_read ON bulk_load FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY bulk_load_create ON bulk_load FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND created_at = now()
    AND state = 'abierta'
  );--> statement-breakpoint
CREATE POLICY bulk_load_change ON bulk_load FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND state = 'abierta')
  WITH CHECK (store_id = app_store_id() AND finished_by = app_user_id() AND finished_at = now());--> statement-breakpoint

-- Los productos y las fotos de una carga se tocan solo mientras está abierta.
CREATE POLICY bulk_load_item_read ON bulk_load_item FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY bulk_load_item_create ON bulk_load_item FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id()
    AND EXISTS (SELECT 1 FROM bulk_load l WHERE l.id = load_id AND l.state = 'abierta')
  );--> statement-breakpoint
CREATE POLICY bulk_load_item_change ON bulk_load_item FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id())
  WITH CHECK (
    store_id = app_store_id()
    AND EXISTS (SELECT 1 FROM bulk_load l WHERE l.id = load_id AND l.state = 'abierta')
  );--> statement-breakpoint
CREATE POLICY bulk_load_item_remove ON bulk_load_item FOR DELETE TO gestoria_app
  USING (
    store_id = app_store_id()
    AND EXISTS (SELECT 1 FROM bulk_load l WHERE l.id = load_id AND l.state = 'abierta')
  );--> statement-breakpoint

CREATE POLICY bulk_load_photo_read ON bulk_load_photo FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY bulk_load_photo_create ON bulk_load_photo FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND created_at = now()
    AND EXISTS (SELECT 1 FROM bulk_load l WHERE l.id = load_id AND l.state = 'abierta')
  );--> statement-breakpoint
CREATE POLICY bulk_load_photo_change ON bulk_load_photo FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id())
  WITH CHECK (
    store_id = app_store_id()
    AND EXISTS (SELECT 1 FROM bulk_load l WHERE l.id = load_id AND l.state = 'abierta')
  );--> statement-breakpoint
-- Al crear o descartar, las fotos de la carga se quitan en la misma transacción que la cierra.
CREATE POLICY bulk_load_photo_remove ON bulk_load_photo FOR DELETE TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint

-- Lo que el agente nunca hace: subir, cambiar o quitar un video, ni ver o tocar una carga. Las
-- fotos ya tienen su regla restrictiva (`0007_reglas_sofi.sql`).
CREATE POLICY product_video_agent_create ON product_video AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY product_video_agent_change ON product_video AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY product_video_agent_remove ON product_video AS RESTRICTIVE FOR DELETE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bulk_load', 'bulk_load_item', 'bulk_load_photo'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO gestoria_app USING (NOT app_is_agent()) WITH CHECK (NOT app_is_agent())',
      t || '_agent', t);
  END LOOP;
END
$$;--> statement-breakpoint

-- Lo que queda por borrar del almacenamiento. La función corre como el dueño (la aplicación no ve
-- `media_trash`) y anota la carpeta solo si ninguna otra fila la usa: la foto que pasó de la carga
-- al producto lleva la misma.
CREATE FUNCTION note_media_trash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  folder text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Dejar la original: se borra la propuesta de quitar el fondo.
    IF OLD.cutout IS NOT NULL AND NEW.cutout IS NULL AND OLD.object_key IS NOT NULL THEN
      INSERT INTO media_trash (object_key) VALUES (OLD.object_key || '/sin-fondo')
        ON CONFLICT (object_key) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;
  folder := OLD.object_key;
  IF folder IS NULL THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM product_photo WHERE object_key = folder)
    OR EXISTS (SELECT 1 FROM product_video WHERE object_key = folder)
    OR EXISTS (SELECT 1 FROM bulk_load_photo WHERE object_key = folder) THEN
    RETURN OLD;
  END IF;
  INSERT INTO media_trash (object_key) VALUES (folder) ON CONFLICT (object_key) DO NOTHING;
  RETURN OLD;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION note_media_trash() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_photo_trash AFTER DELETE ON product_photo
  FOR EACH ROW EXECUTE FUNCTION note_media_trash();--> statement-breakpoint
CREATE TRIGGER product_photo_cutout_trash AFTER UPDATE OF cutout ON product_photo
  FOR EACH ROW EXECUTE FUNCTION note_media_trash();--> statement-breakpoint
CREATE TRIGGER product_video_trash AFTER DELETE ON product_video
  FOR EACH ROW EXECUTE FUNCTION note_media_trash();--> statement-breakpoint
CREATE TRIGGER bulk_load_photo_trash AFTER DELETE ON bulk_load_photo
  FOR EACH ROW EXECUTE FUNCTION note_media_trash();--> statement-breakpoint
CREATE INDEX product_photo_object_key_idx ON product_photo (object_key) WHERE object_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX bulk_load_photo_object_key_idx ON bulk_load_photo (object_key);
