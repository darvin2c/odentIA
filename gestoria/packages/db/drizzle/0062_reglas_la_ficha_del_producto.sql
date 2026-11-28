-- Las reglas de la ficha del producto (lienzo «La ficha del producto»). Como en las migraciones de
-- reglas anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación
-- usa y cada tienda ve solo lo suyo. Qué rol puede cambiar qué lo decide el servidor
-- (`permisos.ts`): la ficha, los colores y la plantilla son `configuracion`; responder lo que Sofi
-- no supo es `ventas.atender`, y guardarlo en la ficha, `configuracion`.
--
-- 1. La ficha: los datos nuevos del producto, el color de cada foto y el código de barras de cada
--    variante. Cambiar el nombre de un color o de una talla desde la cuadrícula cambia los valores
--    de sus variantes sin rehacerlas: su stock y su kardex siguen siendo los mismos.
-- 2. Lo que Sofi no supo: Sofi solo anota la pregunta, sin respuesta, con su conversación. No la
--    responde ni la guarda en la ficha (es una regla restrictiva, como en `0007_reglas_sofi.sql`).
-- 3. El historial de la ficha solo se agrega, a nombre de quien pide y con la hora de la base.
-- 4. Los colores, la plantilla y el historial: el agente solo los lee.
GRANT UPDATE (color_option, rubro, rubro_data, code, status, status_days, status_per_day, status_date, package_weight_g, package_length_mm, package_width_mm, package_height_mm, keywords, web_visible, web_slug) ON TABLE product TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (color_id) ON TABLE product_photo TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (option_values, barcode) ON TABLE product_variant TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE product_color TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (value, hex, hex2, photo_id, updated_at) ON TABLE product_color TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE store_template_field TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (position, needed, hidden, label, type, options, columns, unit, updated_by, updated_at) ON TABLE store_template_field TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE product_question TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (answer, answered_by, answered_at, save_requested, saved_by, saved_at) ON TABLE product_question TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE product_event TO gestoria_app;--> statement-breakpoint

ALTER TABLE product_color ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store_template_field ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_question ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY product_color_store ON product_color FOR ALL TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY store_template_field_read ON store_template_field FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_template_field_create ON store_template_field FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id());--> statement-breakpoint
CREATE POLICY store_template_field_change ON store_template_field FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id());--> statement-breakpoint
CREATE POLICY store_template_field_remove ON store_template_field FOR DELETE TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint

-- Una pregunta va a nombre de quien la anota, con la hora de la base.
CREATE POLICY product_question_read ON product_question FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_question_create ON product_question FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND asked_by = app_user_id() AND asked_at = now());--> statement-breakpoint
CREATE POLICY product_question_change ON product_question FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

CREATE POLICY product_event_read ON product_event FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY product_event_create ON product_event FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND actor_user_id = app_user_id() AND created_at = now());--> statement-breakpoint

-- Lo que el agente nunca hace: responder por la tienda ni guardar en la ficha. Solo deja la
-- pregunta de una conversación, sin respuesta.
CREATE POLICY product_question_agent_create ON product_question AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (
    NOT app_is_agent() OR (
      conversation_id IS NOT NULL AND answer IS NULL AND saved_at IS NULL AND NOT save_requested
    )
  );--> statement-breakpoint
CREATE POLICY product_question_agent_change ON product_question AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY product_event_agent ON product_event AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_color', 'store_template_field'] LOOP
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
