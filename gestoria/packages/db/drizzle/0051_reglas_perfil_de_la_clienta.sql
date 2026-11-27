-- Las reglas del perfil de la clienta (lienzo «Clientas bien perfiladas y Argos que hace el
-- marketing solo», decisiones 1 a 3 y las reglas firmes). Como en las migraciones de reglas
-- anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa y
-- cada tienda ve solo lo suyo. Quién puede qué en la pantalla lo decide el servidor (`permisos.ts`).
--
-- Nada de esto se cambia ni se borra: el historial de un dato y del permiso son sus filas, a nombre
-- de quien las escribió y con la hora de la base.
GRANT SELECT, INSERT ON TABLE customer_fact TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE customer_consent TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE argos_reading TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (seq, read_at) ON TABLE argos_reading TO gestoria_app;--> statement-breakpoint

ALTER TABLE customer_fact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_consent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE argos_reading ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Lo que se sabe de ella: lo anota Argos (de un chat, un pedido o cómo responde) o lo corrige una
-- persona del equipo («Lo puso la tienda»). Nadie más: Sofi no anota datos.
CREATE POLICY customer_fact_read ON customer_fact FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY customer_fact_create ON customer_fact FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id()
    AND actor_user_id = app_user_id()
    AND created_at = now()
    AND (
      (app_user_id() = 'agente:argos' AND source <> 'tienda')
      OR (NOT app_is_agent() AND source = 'tienda')
    )
  );--> statement-breakpoint
-- Lo que corrigió la tienda, Argos no lo vuelve a pisar: aunque el código se equivoque.
CREATE POLICY customer_fact_store_wins ON customer_fact AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (
    NOT app_is_agent()
    OR NOT EXISTS (
      SELECT 1 FROM customer_fact f
      WHERE f.store_id = customer_fact.store_id AND f.customer_id = customer_fact.customer_id
        AND f.key = customer_fact.key AND f.source = 'tienda'
    )
  );--> statement-breakpoint

-- El permiso y la baja: los anota Sofi, y cada uno sale de un mensaje de la clienta en esa misma
-- conversación, con lo que dijo tal cual. Una persona no los anota: nadie dice por ella que sí.
CREATE POLICY customer_consent_read ON customer_consent FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY customer_consent_create ON customer_consent FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id()
    AND actor_user_id = app_user_id()
    AND app_user_id() = 'agente:sofi'
    AND created_at = now()
    AND EXISTS (
      SELECT 1 FROM conversation_message m
      JOIN conversation c ON c.id = m.conversation_id
      WHERE m.id = customer_consent.message_id
        AND m.store_id = customer_consent.store_id
        AND m.conversation_id = customer_consent.conversation_id
        AND m.author = 'cliente'
        AND c.channel = customer_consent.channel
        AND position(customer_consent.quote IN m.text) > 0
    )
  );--> statement-breakpoint

-- Hasta dónde leyó Argos cada conversación: solo Argos.
CREATE POLICY argos_reading_read ON argos_reading FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY argos_reading_create ON argos_reading FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND app_user_id() = 'agente:argos');--> statement-breakpoint
CREATE POLICY argos_reading_change ON argos_reading FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND app_user_id() = 'agente:argos')
  WITH CHECK (store_id = app_store_id() AND app_user_id() = 'agente:argos');
