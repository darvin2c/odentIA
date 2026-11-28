-- Las reglas de lo que la tienda elige para Sofi, «Lo que sabe» y «Lo que aprendió» (tablero 8 de
-- «gestorIA · Configuración, de nuevo»; ADR 0234). Como en las migraciones de reglas anteriores,
-- cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa y cada tienda
-- ve solo lo suyo. Quién cambia la configuración lo decide el servidor (`configuracion` en
-- `permisos.ts`).
--
-- Sofi solo lee lo que la tienda eligió y lo que sabe; nunca lo escribe. De «Lo que aprendió» solo
-- anota una pregunta abierta, a su nombre: no la responde ni la cierra.
GRANT UPDATE (tone, address, emojis, offer_shipping, offer_discount, offer_gift, offer_second, handoff_upset, handoff_over_cents, team_hours, after_hours_sells) ON TABLE store_agent TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE store_agent_answer TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (question, answer, updated_by, updated_at) ON TABLE store_agent_answer TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE agent_gap TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (outcome, answer_id, closed_by, closed_at) ON TABLE agent_gap TO gestoria_app;--> statement-breakpoint

ALTER TABLE store_agent_answer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_gap ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- «Lo que sabe»: lo escribe una persona de la tienda, a su nombre.
CREATE POLICY store_agent_answer_read ON store_agent_answer FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_agent_answer_create ON store_agent_answer FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND created_by = app_user_id() AND updated_by = app_user_id()
  );--> statement-breakpoint
CREATE POLICY store_agent_answer_change ON store_agent_answer FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id())
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id());--> statement-breakpoint
CREATE POLICY store_agent_answer_remove ON store_agent_answer FOR DELETE TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
-- El agente nunca la escribe (como el resto de la configuración, `0007_reglas_sofi.sql`).
CREATE POLICY store_agent_answer_agent_create ON store_agent_answer AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_agent_answer_agent_change ON store_agent_answer AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_agent_answer_agent_remove ON store_agent_answer AS RESTRICTIVE FOR DELETE TO gestoria_app
  USING (NOT app_is_agent());--> statement-breakpoint

-- «Lo que aprendió»: solo Sofi anota una pregunta, abierta, a su nombre y con la hora de la base.
-- La cierra (respondida o quitada) una persona, a su nombre; nadie la borra.
CREATE POLICY agent_gap_read ON agent_gap FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY agent_gap_create ON agent_gap FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND app_user_id() = 'agente:sofi' AND created_by = app_user_id()
    AND created_at = now() AND outcome IS NULL AND answer_id IS NULL
  );--> statement-breakpoint
CREATE POLICY agent_gap_close ON agent_gap FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND outcome IS NULL)
  WITH CHECK (
    store_id = app_store_id() AND closed_by = app_user_id() AND outcome IS NOT NULL
    -- La respuesta, si la hay, es de la misma tienda (la llave foránea no pasa por las reglas).
    AND (answer_id IS NULL OR EXISTS (
      SELECT 1 FROM store_agent_answer a WHERE a.id = answer_id AND a.store_id = app_store_id()
    ))
  );--> statement-breakpoint
CREATE POLICY agent_gap_agent_close ON agent_gap AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (NOT app_is_agent());
