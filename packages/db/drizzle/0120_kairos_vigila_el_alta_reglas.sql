-- Kairós vigila el alta (14 nov): lo que TS no declara. La tabla `saas_client_milestone` y las
-- columnas nuevas de `saas_client_file` y `saas_task` las generó 0119 desde el esquema; viven en
-- `admin` y no reciben ningún GRANT al rol de la aplicación (ADR 0063 y 0064). No llevan RLS: no
-- tienen `organization_id`.

-- La primera vez de un paso del alta no se mueve: no cambia de cliente ni de paso, y una vez
-- alcanzado su `reached_at` (y de dónde salió) queda fijo. Solo vuelve a nulo cuando se pierde
-- (`lost_at`, el primer pago revertido o los datos borrados sin cargar); perdido, si se vuelve a
-- alcanzar toma la fecha nueva y limpia lo perdido (lo exige `saas_client_milestone_lost_check`).
-- «No aplica» lo pone y lo quita una persona: no lo vigila esta guarda. Borrar la fila no se
-- vigila: la cascada del cliente (al fusionar, el absorbido) la necesita, y quitar «No aplica» de
-- un paso alcanzado lo cuida el servicio.
CREATE FUNCTION admin.saas_client_milestone_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.client_id <> OLD.client_id OR NEW.step <> OLD.step OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Un paso del alta no cambia de cliente ni de paso'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_client_milestone_guard';
  END IF;
  IF OLD.reached_at IS NOT NULL THEN
    IF NEW.reached_at IS NULL THEN
      IF NEW.lost_at IS NULL THEN
        RAISE EXCEPTION 'Un paso alcanzado solo vuelve a faltar cuando se pierde'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_client_milestone_guard';
      END IF;
    ELSIF NEW.reached_at <> OLD.reached_at OR NEW.source IS DISTINCT FROM OLD.source THEN
      RAISE EXCEPTION 'La primera vez de un paso del alta no se mueve'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_client_milestone_guard';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER saas_client_milestone_guard BEFORE UPDATE ON admin.saas_client_milestone FOR EACH ROW EXECUTE FUNCTION admin.saas_client_milestone_guard();--> statement-breakpoint

-- La carga de datos (`archivo_clinica`) no deja de serlo: no cambia de tipo, ni cuándo llegó, ni
-- cuándo se marcó (una subida por el código anterior, sin marca, puede recibirla una vez), y su
-- día de borrado no se quita ni se aleja (sí se adelanta). El cliente sí cambia: al fusionar dos
-- clientes, sus archivos pasan al que queda.
CREATE FUNCTION admin.saas_client_file_carga_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.kind = 'archivo_clinica' AND (
    NEW.kind <> OLD.kind
    OR NEW.received_at <> OLD.received_at
    OR (OLD.carga_at IS NOT NULL AND NEW.carga_at IS DISTINCT FROM OLD.carga_at)
    OR NEW.delete_after IS NULL
    OR NEW.delete_after > OLD.delete_after
  ) THEN
    RAISE EXCEPTION 'La carga de datos no se desmarca ni alarga su plazo de borrado'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_client_file_carga_guard';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER saas_client_file_carga_guard BEFORE UPDATE ON admin.saas_client_file FOR EACH ROW EXECUTE FUNCTION admin.saas_client_file_carga_guard();--> statement-breakpoint

-- El relleno de la primera vez de cada paso, desde lo que ya pasó, con los mismos hechos que lee
-- la ficha (`admin-onboarding.ts`): solo de los clientes con cuenta, sin archivar y que no son una
-- demo (ni en `saas_demo` ni marcada en su suscripción), como la pasada de Kairós. La hora de la
-- clínica sin zona (`member`, `session`, `invitation`) es UTC, como la lee drizzle.
--   entro          la primera propietaria de la clínica (`member.role = 'owner'`, literal).
--   contrato       la primera aceptación del contrato de encargo, de cualquier versión.
--   carta          la primera carta guardada, aunque ya se haya borrado.
--   archivos       lo primero que llegó como la carga (`archivo_clinica`, por `received_at`, que
--                  llenó 0119). Un correo a soporte@ no cuenta aquí: si la clínica ya tuvo una
--                  carga, lo pone la pasada como `respaldo`.
--   configuracion  la primera configuración cargada (`org.setup_import`).
--   pacientes      la primera persona o tanda de la carga de pacientes (`clinic_import_row`,
--                  `org.data_import`).
--   informe        el primer informe enviado (`org.progress_report_sent`, a la hora de su `sentAt`
--                  si la trae: la del correo aparte que se registró después).
--   equipo         solo si hoy está hecho (alguien más dentro y ninguna invitación pendiente): la
--                  llegada del último. Lo que ya se perdió no se recupera.
--   whatsapp       la primera vez que Meta verificó la dirección de un WhatsApp de la clínica o el
--                  primer mensaje que llegó por uno.
--   primer_uso     la primera sesión de alguien de la clínica desde que es parte de ella.
--   primer_pago    el primer pago confirmado, si queda alguno confirmado o devuelto; con solo
--                  pagos revertidos no hay hito.
-- Las acciones de los informes son las de `PROGRESS_REPORT_ACTIONS` (lo exige una prueba de los
-- servicios).
INSERT INTO admin.saas_client_milestone (client_id, step, reached_at, source)
SELECT c.id, v.step, v.reached_at, 'hecho'
FROM admin.saas_client c
CROSS JOIN LATERAL (VALUES
  ('entro', (SELECT min(m.created_at AT TIME ZONE 'UTC') FROM member m
    WHERE m.organization_id = c.organization_id AND m.role = 'owner')),
  ('contrato', (SELECT min(pa.accepted_at) FROM processing_agreement_acceptance pa
    WHERE pa.organization_id = c.organization_id)),
  ('carta', (SELECT min(f.created_at) FROM admin.saas_client_file f
    WHERE f.client_id = c.id AND f.kind = 'carta')),
  ('archivos', (SELECT min(f.received_at) FROM admin.saas_client_file f
    WHERE f.client_id = c.id AND f.kind = 'archivo_clinica')),
  ('configuracion', (SELECT min(a.created_at) FROM admin.admin_audit a
    WHERE a.organization_id = c.organization_id AND a.action = 'org.setup_import')),
  ('pacientes', least(
    (SELECT min(r.created_at) FROM admin.clinic_import_row r WHERE r.organization_id = c.organization_id),
    (SELECT min(a.created_at) FROM admin.admin_audit a
      WHERE a.organization_id = c.organization_id AND a.action = 'org.data_import'))),
  ('informe', (SELECT min(CASE WHEN a.metadata->>'sentAt' ~ '^\d{4}-\d{2}-\d{2}'
      THEN (a.metadata->>'sentAt')::timestamptz ELSE a.created_at END)
    FROM admin.admin_audit a
    WHERE a.organization_id = c.organization_id AND a.action = 'org.progress_report_sent')),
  ('equipo', CASE WHEN NOT EXISTS (SELECT 1 FROM invitation i
      WHERE i.organization_id = c.organization_id AND i.role <> 'owner' AND i.status = 'pending')
    THEN (SELECT max(m.created_at AT TIME ZONE 'UTC') FROM member m
      WHERE m.organization_id = c.organization_id AND m.role <> 'owner') END),
  ('whatsapp', least(
    (SELECT min(cc.webhook_verified_at) FROM channel_connection cc
      WHERE cc.organization_id = c.organization_id AND cc.channel = 'whatsapp'),
    (SELECT min(ms.created_at) FROM message ms
      JOIN conversation cv ON cv.id = ms.conversation_id
      JOIN channel_connection cc ON cc.id = cv.channel_connection_id
      WHERE ms.organization_id = c.organization_id AND ms.direction = 'in' AND cc.channel = 'whatsapp'))),
  ('primer_uso', (SELECT min(greatest(s.created_at, m.created_at) AT TIME ZONE 'UTC')
    FROM auth.session s JOIN member m ON m.user_id = s.user_id
    WHERE m.organization_id = c.organization_id AND s.updated_at >= m.created_at)),
  ('primer_pago', CASE WHEN EXISTS (SELECT 1 FROM saas_payment p
      WHERE p.organization_id = c.organization_id AND p.status IN ('confirmado', 'devuelto'))
    THEN (SELECT min(p.confirmed_at) FROM saas_payment p
      WHERE p.organization_id = c.organization_id AND p.status IN ('confirmado', 'devuelto', 'reversado')) END)
) AS v(step, reached_at)
WHERE c.organization_id IS NOT NULL
  AND c.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM saas_demo d WHERE d.organization_id = c.organization_id)
  AND NOT EXISTS (SELECT 1 FROM saas_subscription s WHERE s.organization_id = c.organization_id AND s.is_demo)
  AND v.reached_at IS NOT NULL
ON CONFLICT DO NOTHING;
