-- Las reglas de lo que Sofi no supo en el celular. Hasta dónde miró el sistema no lo escribe la
-- aplicación: quien activa sus avisos crea su fila sin `questions_seen`, como sin `chats_seen`. El
-- sistema (el dueño de la base) lo anota antes de enviar.
DROP POLICY push_choice_create ON push_choice;--> statement-breakpoint
CREATE POLICY push_choice_create ON push_choice FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND user_id = app_user_id() AND NOT app_is_agent()
    AND last_event_seq IS NULL AND chats_seen IS NULL AND questions_seen IS NULL);
