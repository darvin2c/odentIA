-- El ARM de la administración (12 nov, ADR 0184): lo que TS no declara y el traslado de lo que
-- ya había. Las tablas nuevas (`saas_client`, `saas_client_contact`, `saas_task`,
-- `saas_opportunity`, `saas_proposal`, `saas_outreach`, `kairos_item`, `saas_client_file`,
-- `saas_inbound_email`, `kairos_ai_usage` y `kairos_weekly`) son de odentIA y viven en `admin`
-- (ADR 0064): nacen cerradas al rol de la aplicación (ADR 0063) y no reciben
-- ningún GRANT; solo la administración las usa con la conexión propietaria.
--
-- El check de sujeto de `saas_follow_up` (con cliente, o una solicitud o una clínica) ya lo
-- cambió 0106, que generó drizzle-kit desde el esquema.
--
-- El traslado va en este orden: clientes de las organizaciones, clientes de las solicitudes,
-- personas, bitácora, fechas vigentes y oportunidades. En una base nueva no hace nada. Mientras
-- tanto la bitácora acepta que se le llenen el cliente y la fecha en que pasó cada entrada, que
-- 0106 dejó en la hora del despliegue; al final vuelve a solo agregar.
ALTER TABLE saas_follow_up DISABLE TRIGGER saas_follow_up_append_only;--> statement-breakpoint

-- 1. Cada organización que no es una demo para presentar (ni marcada demo en su suscripción ni
-- en `saas_demo`) es un cliente con cuenta: su nombre, su producto (sin perfil todavía no eligió:
-- nace dental, como lee `listOrganizations`) y su país. Llegó por la web si tiene solicitud.
INSERT INTO saas_client (name, product, country_code, origin, organization_id, created_at, updated_at)
SELECT left(coalesce(nullif(trim(o.name), ''), o.slug), 160),
  coalesce(p.product, 'dental'),
  coalesce(p.country_code, 'PE'),
  CASE WHEN EXISTS (SELECT 1 FROM saas_waitlist_request r WHERE r.organization_id = o.id) THEN 'web' ELSE 'otro' END,
  o.id,
  coalesce(o.created_at, now()),
  coalesce(o.created_at, now())
FROM organization o
LEFT JOIN org_profile p ON p.organization_id = o.id
WHERE NOT EXISTS (SELECT 1 FROM saas_subscription s WHERE s.organization_id = o.id AND s.is_demo)
  AND NOT EXISTS (SELECT 1 FROM saas_demo d WHERE d.organization_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM saas_client c WHERE c.organization_id = o.id);--> statement-breakpoint

-- 2. Cada solicitud es un cliente. La que entró comparte el de su organización, que se queda con
-- lo que la clínica contó en la web (ciudad, profesionales, herramienta) y con la fecha de su
-- primer contacto, la de la solicitud.
UPDATE saas_client c SET
  city = coalesce(c.city, left(trim(r.city), 120)),
  professionals = coalesce(c.professionals, r.professionals),
  current_tool = coalesce(c.current_tool, r.current_tool),
  origin = 'web',
  created_at = least(c.created_at, r.created_at)
FROM saas_waitlist_request r
WHERE r.organization_id = c.organization_id AND r.client_id IS NULL;--> statement-breakpoint

UPDATE saas_waitlist_request r SET client_id = c.id
FROM saas_client c
WHERE c.organization_id = r.organization_id AND r.client_id IS NULL;--> statement-breakpoint

WITH nuevos AS (
  SELECT r.id AS request_id, gen_random_uuid() AS client_id, r.clinic_name, r.product, r.country_code,
    r.city, r.professionals, r.current_tool, r.created_at, r.updated_at
  FROM saas_waitlist_request r
  WHERE r.client_id IS NULL
), creados AS (
  INSERT INTO saas_client (id, name, product, country_code, city, professionals, current_tool, origin, created_at, updated_at)
  SELECT n.client_id, left(trim(n.clinic_name), 160), n.product, n.country_code, left(trim(n.city), 120),
    n.professionals, n.current_tool, 'web', n.created_at, n.updated_at
  FROM nuevos n
  RETURNING id
)
UPDATE saas_waitlist_request r SET client_id = n.client_id
FROM nuevos n
WHERE r.id = n.request_id;--> statement-breakpoint

-- 3. La persona de cada solicitud es el contacto principal de su cliente, con sus papeles por
-- confirmar (la web no pregunta quién decide). Su teléfono solo si es E.164 válido sin espacios
-- ni guiones; nunca se completa un prefijo de país. El correo, en minúsculas. No se liga a ningún
-- usuario: eso es por correo exacto y con el sí de una persona.
INSERT INTO saas_client_contact (client_id, name, phone, email, roles, roles_confirmed, is_primary, created_at, updated_at)
SELECT r.client_id,
  left(trim(r.first_name) || ' ' || trim(r.last_name), 160),
  CASE WHEN regexp_replace(r.phone, '[\s().-]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$'
    THEN regexp_replace(r.phone, '[\s().-]', '', 'g') END,
  nullif(lower(trim(r.email)), ''),
  '{}'::text[],
  false,
  NOT EXISTS (SELECT 1 FROM saas_client_contact x WHERE x.client_id = r.client_id AND x.is_primary),
  r.created_at,
  r.created_at
FROM saas_waitlist_request r
WHERE r.client_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM saas_client_contact x WHERE x.client_id = r.client_id AND x.email = lower(trim(r.email))
  );--> statement-breakpoint

-- 4. Cada entrada de la bitácora es de su cliente: el de su solicitud o el de su clínica. La de
-- una demo queda sin cliente (las demos no son clientes). Pasó cuando se anotó.
UPDATE saas_follow_up f SET
  client_id = coalesce(
    (SELECT r.client_id FROM saas_waitlist_request r WHERE r.id = f.request_id),
    (SELECT c.id FROM saas_client c WHERE c.organization_id = f.organization_id)),
  happened_at = f.created_at
WHERE f.client_id IS NULL;--> statement-breakpoint

-- 5. La fecha vigente de cada solicitud no descartada pasa a ser una tarea «Volver a contactar»
-- para quien la puso. Vigente es la de la última entrada, como la lee hoy la lista de espera
-- (`isLastEntry` de saas-founders): si la última no tiene fecha, no hay que volver. También la
-- que ya pasó: hoy sale en Inicio como vencida y seguirá saliendo en Hoy como tarea vencida
-- (abierta con su día ya pasado), en vez de desaparecer con el traslado.
INSERT INTO saas_task (client_id, kind, title, due_on, assignee_user_id, created_by, created_at, updated_at)
SELECT r.client_id, 'llamar', 'Volver a contactar', f.follow_up_on, f.author_user_id, f.author_user_id,
  f.created_at, f.created_at
FROM saas_waitlist_request r
JOIN LATERAL (
  SELECT x.follow_up_on, x.author_user_id, x.created_at
  FROM saas_follow_up x
  WHERE x.request_id = r.id
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1
) f ON true
WHERE r.status <> 'descartada'
  AND r.client_id IS NOT NULL
  AND f.follow_up_on IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM saas_task t
    WHERE t.client_id = r.client_id AND t.kind = 'llamar' AND t.due_on = f.follow_up_on AND t.title = 'Volver a contactar'
  );--> statement-breakpoint

-- 6. La venta de cada cliente: con cuenta, entró (cuando entró su solicitud, o cuando nació la
-- clínica); sin cuenta y descartada, perdida por «otro» con el motivo que se escribió (hasta 500
-- caracteres), cuando y quien la descartó; sin cuenta y viva, abierta.
INSERT INTO saas_opportunity (client_id, decision, reason, reason_detail, decided_by, decided_at, created_at, updated_at)
SELECT DISTINCT ON (c.id) c.id,
  CASE WHEN c.organization_id IS NOT NULL THEN 'entro' WHEN r.status = 'descartada' THEN 'perdido' END,
  CASE WHEN c.organization_id IS NULL AND r.status = 'descartada' THEN 'otro' END,
  CASE WHEN c.organization_id IS NULL AND r.status = 'descartada' THEN left(trim(r.discard_reason), 500) END,
  CASE WHEN c.organization_id IS NULL AND r.status = 'descartada' THEN r.decided_by END,
  CASE WHEN c.organization_id IS NOT NULL THEN coalesce(r.entered_at, c.created_at)
    WHEN r.status = 'descartada' THEN coalesce(r.decided_at, r.updated_at) END,
  c.created_at,
  c.created_at
FROM saas_client c
LEFT JOIN saas_waitlist_request r ON r.client_id = c.id
WHERE NOT EXISTS (SELECT 1 FROM saas_opportunity o WHERE o.client_id = c.id)
ORDER BY c.id, r.created_at DESC;--> statement-breakpoint

-- 7. Las reglas.

-- La bitácora sigue solo agregando. Además de «solo administración» (de no a sí) y el autor a
-- nulo, ahora el contacto, la demo y la propuesta pasan a nulo cuando se borran (su clave
-- foránea), y el cliente se llena o pasa a otro al fusionar dos clientes; nunca vuelve a nulo.
CREATE OR REPLACE FUNCTION admin.saas_follow_up_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'admin_only' - 'author_user_id' - 'client_id' - 'contact_id' - 'demo_id' - 'proposal_id')
      = (to_jsonb(OLD) - 'admin_only' - 'author_user_id' - 'client_id' - 'contact_id' - 'demo_id' - 'proposal_id')
    AND (NEW.admin_only = OLD.admin_only OR (NOT OLD.admin_only AND NEW.admin_only))
    AND (NEW.author_user_id IS NOT DISTINCT FROM OLD.author_user_id OR NEW.author_user_id IS NULL)
    AND (NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id OR NEW.contact_id IS NULL)
    AND (NEW.demo_id IS NOT DISTINCT FROM OLD.demo_id OR NEW.demo_id IS NULL)
    AND (NEW.proposal_id IS NOT DISTINCT FROM OLD.proposal_id OR NEW.proposal_id IS NULL)
    AND (NEW.client_id IS NOT DISTINCT FROM OLD.client_id OR NEW.client_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'El seguimiento solo se agrega: lo único que cambia es «solo administración», de no a sí'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_follow_up_append_only';
END;
$$;--> statement-breakpoint
ALTER TABLE saas_follow_up ENABLE TRIGGER saas_follow_up_append_only;--> statement-breakpoint

-- Una propuesta enviada no cambia sus condiciones (otra oferta es otra versión) y de enviada solo
-- pasa a aceptada o no aceptada; decidida, ya no cambia. Pueden cambiar el cliente y la versión
-- (al fusionar dos clientes) y la oportunidad a nula (su clave foránea).
CREATE FUNCTION admin.saas_proposal_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('enviada', 'aceptada', 'no_aceptada') AND (
    NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.list_price_cents IS DISTINCT FROM OLD.list_price_cents
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.discount_bps IS DISTINCT FROM OLD.discount_bps
    OR NEW.discount_months IS DISTINCT FROM OLD.discount_months
    OR NEW.trial_days IS DISTINCT FROM OLD.trial_days
    OR NEW.trial_credit_cents IS DISTINCT FROM OLD.trial_credit_cents
    OR NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Una propuesta enviada no cambia sus condiciones: haz una versión nueva (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_proposal_terms_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (
    OLD.status IN ('aceptada', 'no_aceptada')
    OR (OLD.status = 'enviada' AND NEW.status NOT IN ('aceptada', 'no_aceptada'))) THEN
    RAISE EXCEPTION 'Una propuesta enviada solo pasa a aceptada o no aceptada, y decidida ya no cambia (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_proposal_status_flow';
  END IF;
  IF OLD.status IN ('aceptada', 'no_aceptada') AND (
    NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
    OR NEW.accepted_note IS DISTINCT FROM OLD.accepted_note) THEN
    RAISE EXCEPTION 'Una propuesta decidida ya no cambia (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_proposal_status_flow';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER saas_proposal_guard BEFORE UPDATE ON admin.saas_proposal FOR EACH ROW EXECUTE FUNCTION admin.saas_proposal_guard();--> statement-breakpoint

-- Un envío no cambia lo que se envió ni a quién. Su estado solo avanza de pendiente a enviado,
-- incierto o no salió, y de incierto a enviado o no salió (lo resuelve una persona: lo incierto
-- nunca se reintenta); enviado y no salió son finales. Quién y cuándo se anotan al avanzar.
-- Pueden cambiar el cliente (al fusionar dos) y el contacto, la propuesta, el ítem de Kairós y
-- quien lo creó a nulo (su clave foránea).
CREATE FUNCTION admin.saas_outreach_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'sent_at' - 'resolved_by' - 'resolved_at' - 'updated_at' - 'client_id'
        - 'contact_id' - 'proposal_id' - 'kairos_item_id' - 'created_by')
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
$$;--> statement-breakpoint
CREATE TRIGGER saas_outreach_guard BEFORE UPDATE ON admin.saas_outreach FOR EACH ROW EXECUTE FUNCTION admin.saas_outreach_guard();
