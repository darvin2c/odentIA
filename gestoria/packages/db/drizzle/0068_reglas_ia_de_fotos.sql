-- Las reglas de la IA de fotos. Como en las migraciones de reglas anteriores, cada tabla nace
-- cerrada a `gestoria_app`: se concede solo lo que la aplicación usa y cada tienda ve solo lo suyo.
-- Qué rol puede pedir y usar propuestas lo decide el servidor (`permisos.ts`): `configuracion`;
-- verlas, `catalogo.ver`.
--
-- 1. Mirar se anota a nombre de quien lo pide, con la hora de la base, y empieza «mirando». Solo
--    se le pone el resultado: el estado, el modelo, lo que usó y costó, el motivo si falló y la hora.
-- 2. Una propuesta nace «propuesta», a nombre de quien pidió mirar. Después solo se decide una vez:
--    pasa a usada, cambiada o descartada, a nombre de quien decide y con la hora de la base. Lo único
--    que cambia mientras espera es su producto, al crear el producto desde la carga (y las fotos de
--    un color, que pasan al producto con otro id). Nadie la borra: se va con su producto, su carga
--    o su tienda.
-- 3. El agente (Sofi, Argos) no las ve ni las toca: la IA de fotos no es un agente que escribe, y las
--    propuestas las escribe el servidor a pedido de una persona.
GRANT SELECT, INSERT ON TABLE ai_look TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (state, model, input_tokens, cached_tokens, output_tokens, cost_micros, failure, notice, finished_at) ON TABLE ai_look TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE ai_proposal TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (state, applied_value, decided_by, decided_at, product_id, value) ON TABLE ai_proposal TO gestoria_app;--> statement-breakpoint

ALTER TABLE ai_look ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_proposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY ai_look_read ON ai_look FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY ai_look_create ON ai_look FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND requested_by = app_user_id() AND requested_at = now()
    AND state = 'mirando' AND finished_at IS NULL AND cost_micros IS NULL
  );--> statement-breakpoint
CREATE POLICY ai_look_change ON ai_look FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND state = 'mirando')
  WITH CHECK (store_id = app_store_id() AND state <> 'mirando');--> statement-breakpoint

CREATE POLICY ai_proposal_read ON ai_proposal FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY ai_proposal_create ON ai_proposal FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND created_at = now()
    AND state = 'propuesta' AND decided_by IS NULL AND applied_value IS NULL
  );--> statement-breakpoint
-- Solo una propuesta que espera cambia: o se decide (a nombre de quien decide) o pasa al producto.
CREATE POLICY ai_proposal_change ON ai_proposal FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND state = 'propuesta')
  WITH CHECK (
    store_id = app_store_id()
    AND (state = 'propuesta' OR (decided_by = app_user_id() AND decided_at = now()))
  );--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_look', 'ai_proposal'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO gestoria_app USING (NOT app_is_agent()) WITH CHECK (NOT app_is_agent())',
      t || '_agent', t);
  END LOOP;
END
$$;
