-- El correo de la administración (13 nov): lo que TS no declara. Las columnas nuevas de
-- `saas_inbound_email`, `saas_outreach` y `admin_staff` las generó 0109 desde el esquema; todas
-- viven en `admin` y siguen sin ningún GRANT al rol de la aplicación (ADR 0063 y 0064).

-- La dirección de cada persona del equipo en los dominios de las marcas (`<mail_local>@odentia32.com`,
-- @latidia72.com, @vistia20.com). Si su correo ya es de uno de esos dominios, su parte local; si no,
-- «nombre.apellido» de su nombre, sin tildes ni signos y en minúsculas (el primer nombre y el primer
-- apellido: con cuatro palabras o más, la penúltima; con dos o tres, la segunda). Sin nombre, la parte
-- local de su correo, limpia. Si choca con la de otra persona o con un nombre reservado (la lista de
-- `STAFF_MAIL_RESERVED`, la misma del check), se le suma un número. Nula si no hay de dónde sacarla.
CREATE FUNCTION admin.admin_staff_mail_local_for(p_user_id text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_reserved constant text[] := ARRAY['soporte', 'hola', 'contacto', 'fundadores', 'privacidad',
    'reclamaciones', 'redes', 'reply', 'no-reply', 'noreply', 'postmaster', 'abuse', 'admin',
    'administracion', 'ventas', 'info', 'webmaster', 'hostmaster', 'mailer-daemon', 'security', 'seguridad'];
  v_email text;
  v_name text;
  v_local text;
  v_words text[];
  v_count integer;
  v_base text;
  v_candidate text;
  v_n integer := 1;
BEGIN
  SELECT lower(trim(u.email)), u.name INTO v_email, v_name FROM auth."user" u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_local := split_part(split_part(coalesce(v_email, ''), '@', 1), '+', 1);
  IF split_part(coalesce(v_email, ''), '@', 2) IN ('odentia32.com', 'latidia72.com', 'vistia20.com')
    AND v_local ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' AND length(v_local) BETWEEN 2 AND 64
    AND NOT v_local = ANY (v_reserved) THEN
    v_base := v_local;
  END IF;
  IF v_base IS NULL THEN
    v_words := ARRAY(
      SELECT w FROM regexp_split_to_table(
        trim(regexp_replace(replace(public.search_fold(coalesce(v_name, '')), '''', ''), '[^a-z0-9]+', ' ', 'g')),
        ' ') AS w
      WHERE w <> '' AND w NOT IN ('de', 'del', 'la', 'las', 'los', 'y', 'e'));
    v_count := coalesce(array_length(v_words, 1), 0);
    IF v_count >= 4 THEN
      v_base := v_words[1] || '.' || v_words[v_count - 1];
    ELSIF v_count >= 2 THEN
      v_base := v_words[1] || '.' || v_words[2];
    ELSIF v_count = 1 THEN
      v_base := v_words[1];
    END IF;
  END IF;
  IF v_base IS NULL THEN
    v_base := trim(both '._-' from regexp_replace(regexp_replace(v_local, '[^a-z0-9._-]+', '', 'g'), '[._-]{2,}', '.', 'g'));
  END IF;
  v_base := trim(both '._-' from left(coalesce(v_base, ''), 60));
  IF v_base = '' THEN
    RETURN NULL;
  END IF;
  v_candidate := v_base;
  WHILE length(v_candidate) < 2 OR v_candidate = ANY (v_reserved)
    OR EXISTS (SELECT 1 FROM admin.admin_staff s WHERE s.mail_local = v_candidate AND s.user_id <> p_user_id) LOOP
    v_n := v_n + 1;
    v_candidate := v_base || v_n::text;
  END LOOP;
  RETURN v_candidate;
END;
$$;--> statement-breakpoint

-- Se pone sola al crear la fila (aceptar una invitación, el primer admin, la semilla), por cualquier
-- vía. La llave consultiva ordena dos altas a la vez para que no elijan la misma.
CREATE FUNCTION admin.admin_staff_mail_local() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.mail_local IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('admin_staff_mail_local'));
    NEW.mail_local := admin.admin_staff_mail_local_for(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_staff_mail_local BEFORE INSERT ON admin.admin_staff FOR EACH ROW EXECUTE FUNCTION admin.admin_staff_mail_local();--> statement-breakpoint

-- Después del primer correo que salió con ella, la dirección queda fija: una clínica ya la tiene y
-- le respondería a una dirección que no es de nadie. Cuándo salió el primero se anota una vez.
CREATE FUNCTION admin.admin_staff_mail_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.mail_first_sent_at IS NOT NULL AND (
    NEW.mail_local IS DISTINCT FROM OLD.mail_local
    OR NEW.mail_first_sent_at IS DISTINCT FROM OLD.mail_first_sent_at) THEN
    RAISE EXCEPTION 'Ya salieron correos con la dirección de %: queda fija', OLD.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'admin_staff_mail_fixed';
  END IF;
  IF NEW.mail_first_sent_at IS NOT NULL AND NEW.mail_local IS NULL THEN
    RAISE EXCEPTION 'Sin dirección no se anota el primer correo (%)', OLD.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'admin_staff_mail_fixed';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_staff_mail_guard BEFORE UPDATE ON admin.admin_staff FOR EACH ROW EXECUTE FUNCTION admin.admin_staff_mail_guard();--> statement-breakpoint

-- Las personas de hoy, en el orden en que entraron: la primera se queda con la dirección que choca.
DO $$
DECLARE
  r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('admin_staff_mail_local'));
  FOR r IN SELECT user_id FROM admin.admin_staff WHERE mail_local IS NULL ORDER BY created_at, user_id LOOP
    UPDATE admin.admin_staff SET mail_local = admin.admin_staff_mail_local_for(r.user_id) WHERE user_id = r.user_id;
  END LOOP;
END;
$$;--> statement-breakpoint

-- Un envío no cambia lo que se envió ni a quién, ahora con su remitente, su Message-ID, el correo que
-- responde y su hilo (columnas que no se excluyen: no cambian). El cliente cambia al fusionar dos o al
-- ligar el correo que respondía uno que salió sin cliente, pero nunca vuelve a nulo.
CREATE OR REPLACE FUNCTION admin.saas_outreach_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by')
    OR (NEW.client_id IS NULL AND OLD.client_id IS NOT NULL)
    OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
    OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
    OR (NEW.kairos_item_id IS DISTINCT FROM OLD.kairos_item_id AND NEW.kairos_item_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
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
$$;
