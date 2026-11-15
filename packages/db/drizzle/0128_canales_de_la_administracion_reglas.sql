-- El WhatsApp de la administración (14 nov): lo que TS no declara. Las tablas `saas_chat` y
-- `saas_inbound_message` y las columnas nuevas de `saas_outreach`, `saas_follow_up` y
-- `saas_client_file` las generó 0127 desde el esquema; viven en `admin` y no reciben ningún GRANT
-- al rol de la aplicación (ADR 0063 y 0064). No llevan RLS: no tienen `organization_id`.

-- La bitácora sigue solo agregando, con las mismas excepciones de 0108 (solo administración de
-- no a sí, el autor, el contacto, la demo y la propuesta a nulo, el cliente a otro). La
-- conversación de la que salió una entrada (`chat_id`) no cambia a otra: con ella la entrada pasa
-- a otro cliente cuando la conversación se mueve. Solo vuelve a nulo si se borra la conversación
-- (su clave foránea).
CREATE OR REPLACE FUNCTION admin.saas_follow_up_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'admin_only' - 'author_user_id' - 'client_id' - 'contact_id' - 'demo_id' - 'proposal_id' - 'chat_id')
      = (to_jsonb(OLD) - 'admin_only' - 'author_user_id' - 'client_id' - 'contact_id' - 'demo_id' - 'proposal_id' - 'chat_id')
    AND (NEW.admin_only = OLD.admin_only OR (NOT OLD.admin_only AND NEW.admin_only))
    AND (NEW.author_user_id IS NOT DISTINCT FROM OLD.author_user_id OR NEW.author_user_id IS NULL)
    AND (NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id OR NEW.contact_id IS NULL)
    AND (NEW.demo_id IS NOT DISTINCT FROM OLD.demo_id OR NEW.demo_id IS NULL)
    AND (NEW.proposal_id IS NOT DISTINCT FROM OLD.proposal_id OR NEW.proposal_id IS NULL)
    AND (NEW.chat_id IS NOT DISTINCT FROM OLD.chat_id OR NEW.chat_id IS NULL)
    AND (NEW.client_id IS NOT DISTINCT FROM OLD.client_id OR NEW.client_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'El seguimiento solo se agrega: lo único que cambia es «solo administración», de no a sí'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_follow_up_append_only';
END;
$$;--> statement-breakpoint

-- Un envío no cambia lo que se envió ni a quién (0110), ahora tampoco su conversación ni su plantilla
-- (columnas que no se excluyen). Si es solo de Administración se decide al reservarlo y solo sube,
-- de no a sí (la conversación pasa a un cliente sin app); nunca baja. El id que devuelve Meta
-- (`external_id`) se anota una vez, al salir: de nulo a un valor, y ya no cambia.
CREATE OR REPLACE FUNCTION admin.saas_outreach_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by' - 'external_id' - 'admin_only')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by' - 'external_id' - 'admin_only')
    OR (OLD.admin_only AND NOT NEW.admin_only)
    OR (NEW.client_id IS NULL AND OLD.client_id IS NOT NULL)
    OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
    OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
    OR (NEW.kairos_item_id IS DISTINCT FROM OLD.kairos_item_id AND NEW.kairos_item_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
    OR (NEW.external_id IS DISTINCT FROM OLD.external_id AND OLD.external_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Un envío no cambia lo que se envió ni a quién (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_outreach_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pendiente' AND NEW.status IN ('enviado', 'incierto', 'no_salio'))
        OR (OLD.status = 'incierto' AND NEW.status IN ('enviado', 'no_salio'))) THEN
      RAISE EXCEPTION 'Un envío solo pasa de pendiente a enviado, incierto o no salió, y de incierto a enviado o no salió (%)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_outreach_status_flow';
    END IF;
  ELSIF NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'Cuándo salió y quién lo resolvió se anotan solo al cambiar de estado (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_outreach_status_flow';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Un mensaje que entró es solo de Administración desde que llega si su conversación no es de una
-- clínica con su app; eso no baja nunca (Soporte no ve después lo que era de la venta). Lo demás
-- del mensaje lo cambian los servicios (sus archivos al pasar a documentos, el texto al borrarse
-- la carga).
CREATE OR REPLACE FUNCTION admin.saas_inbound_message_admin_only_up() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.admin_only AND NOT NEW.admin_only THEN
    RAISE EXCEPTION 'Lo que es solo de Administración no deja de serlo (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_inbound_message_admin_only_up';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER saas_inbound_message_admin_only_up BEFORE UPDATE ON admin.saas_inbound_message
  FOR EACH ROW EXECUTE FUNCTION admin.saas_inbound_message_admin_only_up();
