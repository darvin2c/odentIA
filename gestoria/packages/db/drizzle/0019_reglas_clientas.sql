-- Las reglas de las clientas (entrega 4 de «gestorIA como odentIA», tablero 8; ADR 0223). Como en
-- las migraciones de reglas anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo
-- lo que la aplicación usa y cada tienda ve solo lo suyo. Qué rol puede hacer qué lo decide el
-- servidor (`permisos.ts`), en cada pedido.
--
-- Una ficha no se borra: su nombre, su teléfono y «Lo que sabemos» se corrigen, y queda dentro de
-- otra (o sale de ella) solo por lo que decidió una persona. Lo que decidió queda en la historia
-- de la ficha, que solo se agrega, a nombre de quien pide y con la hora de la base. Un pedido no
-- cambia de ficha: `sale_order.customer_id` se escribe al anotarlo y no tiene permiso de cambio.
GRANT SELECT, INSERT ON TABLE customer TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (name, phone, note, note_by, note_at, merged_into, updated_at) ON TABLE customer TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE customer_event TO gestoria_app;--> statement-breakpoint

ALTER TABLE customer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY customer_read ON customer FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
-- Nace sola (sin estar dentro de otra), a nombre de quien la abre.
CREATE POLICY customer_create ON customer FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND merged_into IS NULL);--> statement-breakpoint
-- Queda dentro de otra solo si esa otra está sola, y solo si nadie quedó dentro de ella: así una
-- clienta se lee de un solo paso y «Separar» deja todo como estaba.
CREATE POLICY customer_change ON customer FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id())
  WITH CHECK (
    store_id = app_store_id()
    AND (
      merged_into IS NULL
      OR (
        EXISTS (
          SELECT 1 FROM customer t
          WHERE t.store_id = customer.store_id AND t.id = customer.merged_into
            AND t.merged_into IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM customer c
          WHERE c.store_id = customer.store_id AND c.merged_into = customer.id
        )
      )
    )
  );--> statement-breakpoint

CREATE POLICY customer_event_read ON customer_event FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY customer_event_create ON customer_event FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND actor_user_id = app_user_id() AND created_at = now());--> statement-breakpoint

-- Sofi arma el pedido con la ficha de su clienta y la abre si es nueva, sin nada escrito por el
-- equipo; nunca decide quién es quién: no cambia una ficha ni anota lo que decide una persona.
CREATE POLICY customer_agent_create ON customer AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent() OR (note = '' AND note_by IS NULL));--> statement-breakpoint
CREATE POLICY customer_agent_change ON customer AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY customer_event_agent ON customer_event AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());
