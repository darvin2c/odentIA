-- La administración de hoy (11 nov): lo que TS no declara. Las dos tablas nuevas son de
-- odentIA y viven en `admin` (ADR 0064): nacen cerradas al rol de la aplicación (ADR 0063)
-- y no reciben ningún GRANT; solo la administración las usa con la conexión propietaria.

-- La bitácora de seguimiento solo se agrega. Lo único que cambia después es «solo
-- administración», de no a sí, y el autor a nulo, que lo pone la clave foránea al borrar a
-- esa persona. Es BEFORE UPDATE y no DELETE: borrar la solicitud o la clínica borra sus
-- entradas en cascada.
CREATE FUNCTION admin.saas_follow_up_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'admin_only' - 'author_user_id') = (to_jsonb(OLD) - 'admin_only' - 'author_user_id')
    AND (NEW.admin_only = OLD.admin_only OR (NOT OLD.admin_only AND NEW.admin_only))
    AND (NEW.author_user_id IS NOT DISTINCT FROM OLD.author_user_id OR NEW.author_user_id IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'El seguimiento solo se agrega: lo único que cambia es «solo administración», de no a sí'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_follow_up_append_only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER saas_follow_up_append_only BEFORE UPDATE ON admin.saas_follow_up FOR EACH ROW EXECUTE FUNCTION admin.saas_follow_up_append_only();--> statement-breakpoint

-- Un comprobante rechazado es final: corregirlo es registrar el pago en el cargo. Solo se
-- rechaza lo pendiente; lo confirmado es dinero que entró y se deshace con «reversado».
-- Lo demás es lo de siempre (0001_base_reglas.sql).
CREATE OR REPLACE FUNCTION public.saas_payment_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'rechazado' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Un comprobante rechazado no cambia: registra el pago en el cargo (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_payment_rejected_final';
  END IF;
  IF NEW.status = 'rechazado' AND OLD.status <> 'rechazado' AND OLD.status <> 'pendiente' THEN
    RAISE EXCEPTION 'Solo se rechaza un comprobante pendiente (%)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'saas_payment_reject_pending_only';
  END IF;
  IF OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.charge_id IS DISTINCT FROM NEW.charge_id
    OR OLD.receipt_object_key IS DISTINCT FROM NEW.receipt_object_key THEN
    RAISE EXCEPTION 'Pago SaaS inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- La nota de cada solicitud pasa a ser su primera entrada. Autor y fecha salen de la última
-- auditoría de la nota (`saas.waitlist_note`), si su autor sigue existiendo; sin auditoría,
-- autor nulo («Nota anterior, sin autor registrado») y la fecha de la solicitud. Sin fecha
-- para volver y visible para soporte, como hasta hoy. La columna `note` se borra en la
-- entrega siguiente: una pestaña o una instancia vieja puede seguir escribiéndola.
INSERT INTO saas_follow_up (request_id, author_user_id, body, follow_up_on, admin_only, created_at)
SELECT r.id,
  CASE WHEN EXISTS (SELECT 1 FROM "user" u WHERE u.id = a.actor_user_id) THEN a.actor_user_id END,
  r.note,
  NULL,
  false,
  coalesce(a.created_at, r.created_at)
FROM saas_waitlist_request r
LEFT JOIN LATERAL (
  SELECT x.actor_user_id, x.created_at
  FROM admin_audit x
  WHERE x.action = 'saas.waitlist_note' AND x.entity_id = r.id::text
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1
) a ON true
WHERE length(trim(coalesce(r.note, ''))) > 0;--> statement-breakpoint

-- Casos atascados: la clínica respondió después de nuestra última respuesta pública y el caso
-- seguía «Esperando a la clínica». Vuelven a «En atención», que es lo que nos espera.
UPDATE support_case c
SET status = 'en_atencion', updated_at = now()
WHERE c.status = 'esperando_clinica'
  AND EXISTS (
    SELECT 1 FROM support_message m
    WHERE m.case_id = c.id
      AND m.author_kind = 'cliente'
      AND NOT m.is_internal
      AND m.created_at > coalesce(c.last_public_message_at, '-infinity'::timestamptz)
  );
