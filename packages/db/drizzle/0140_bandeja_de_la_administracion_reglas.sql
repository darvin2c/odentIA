-- La Bandeja de la administración (16 nov, ADR 0196): lo que TS no declara. La tabla
-- `saas_conversation_mark` y las columnas nuevas de `saas_outreach` y `kairos_chat_turn` las generó
-- 0139 desde el esquema; viven en `admin` y no reciben ningún GRANT al rol de la aplicación (ADR 0063
-- y 0064). No llevan RLS: no tienen `organization_id`.

-- Un envío no cambia lo que se envió ni a quién (0110 y 0128). Ahora también se anota cuándo dijo
-- Meta que llegó al teléfono (`delivered_at`) y que lo leyó (`read_at`): cada uno una sola vez, de
-- nulo a la fecha, y ya no cambia ni vuelve a nulo. No dependen del estado: un mensaje que ya salió
-- puede después llegar y leerse. Igual cuándo dijo que no llegó lo que ya había salido (`failed_at`,
-- un archivo por enlace que no pudo descargar) y por qué (`failed_why`): una vez, los dos en el mismo
-- cambio, y el estado sigue `enviado` (salió hacia el canal; no vuelve a «no salió»).
CREATE OR REPLACE FUNCTION admin.saas_outreach_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by' - 'external_id' - 'admin_only'
        - 'delivered_at' - 'read_at' - 'failed_at' - 'failed_why')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by' - 'external_id' - 'admin_only'
        - 'delivered_at' - 'read_at' - 'failed_at' - 'failed_why')
    OR (OLD.admin_only AND NOT NEW.admin_only)
    OR (NEW.client_id IS NULL AND OLD.client_id IS NOT NULL)
    OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
    OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
    OR (NEW.kairos_item_id IS DISTINCT FROM OLD.kairos_item_id AND NEW.kairos_item_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
    OR (NEW.external_id IS DISTINCT FROM OLD.external_id AND OLD.external_id IS NOT NULL)
    OR (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at AND OLD.delivered_at IS NOT NULL)
    OR (NEW.read_at IS DISTINCT FROM OLD.read_at AND OLD.read_at IS NOT NULL)
    OR (NEW.failed_at IS DISTINCT FROM OLD.failed_at AND OLD.failed_at IS NOT NULL)
    OR (NEW.failed_why IS DISTINCT FROM OLD.failed_why
      AND (OLD.failed_at IS NOT NULL OR NEW.failed_at IS NULL)) THEN
    RAISE EXCEPTION 'Un envío no cambia lo que se envió ni a quién (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_outreach_immutable';
  END IF;
  -- Que no llegó se anota solo de lo que ya salió (`enviado`).
  IF NEW.failed_at IS DISTINCT FROM OLD.failed_at AND NEW.status <> 'enviado' THEN
    RAISE EXCEPTION 'Que no llegó se anota solo de lo que salió (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_outreach_status_flow';
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
$$;
