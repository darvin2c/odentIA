-- Las reglas del acuerdo con la administración (paso B7 del lienzo B). Como en las migraciones de
-- reglas anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la
-- aplicación usa y cada tienda ve solo lo suyo.
--
-- La bandeja de salida: la aplicación solo agrega avisos de la tienda en la que está, en la misma
-- transacción que lo que los causó; enviarlos y anotar cómo salió lo hace el dueño de la base (el
-- trabajo de envío). Lo que usó Sofi solo lo anota el agente, y el agente solo anota eso.
GRANT SELECT, INSERT ON TABLE contract_outbox TO gestoria_app;--> statement-breakpoint
-- Lo último que dijo la administración: lo escribe el dueño de la base; la tienda lo lee.
GRANT SELECT ON TABLE contract_state TO gestoria_app;--> statement-breakpoint

ALTER TABLE contract_outbox ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contract_state ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY contract_outbox_read ON contract_outbox FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY contract_outbox_create ON contract_outbox FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND sent_at IS NULL AND attempts = 0
    AND (type = 'uso.contado') = app_is_agent()
  );--> statement-breakpoint

CREATE POLICY contract_state_read ON contract_state FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());
