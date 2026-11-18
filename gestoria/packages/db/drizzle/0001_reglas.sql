-- Las reglas de gestorIA (ADR 0203). La base es solo de gestorIA y tiene dos usuarios: su dueño
-- (migraciones, la copia de las cuentas y los avisos de la cuenta) y `gestoria_app`, con el que
-- se atiende a cada persona. `gestoria_app` lo crea quien prepara la base (`gestoria/infra`),
-- con su contraseña, antes de migrar. Toda tabla nace cerrada a ese rol: aquí se concede solo
-- lo que la aplicación usa, y cada tienda ve solo lo suyo (RLS).
--
-- Quién pide y en qué tienda llegan por `withPerson` (`app.user_id`, `app.user_email`,
-- `app.store_id`), fijados por el servidor desde el token de la cuenta y su equipo.
CREATE FUNCTION app_user_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;--> statement-breakpoint
CREATE FUNCTION app_user_email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(lower(current_setting('app.user_email', true)), '')
$$;--> statement-breakpoint
CREATE FUNCTION app_store_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.store_id', true), '')::uuid
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO gestoria_app;--> statement-breakpoint
-- La copia de las cuentas la escribe el dueño; la aplicación solo lee la de su equipo.
GRANT SELECT ON TABLE account_copy TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE store TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE store_member TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (role) ON TABLE store_member TO gestoria_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE store_invitation TO gestoria_app;--> statement-breakpoint
-- Una invitación no cambia lo que dice: solo se acepta o se anula, con quién.
GRANT UPDATE (accepted_at, accepted_by, revoked_at, revoked_by) ON TABLE store_invitation TO gestoria_app;--> statement-breakpoint
-- Lo anotado de una tienda solo se agrega.
GRANT SELECT, INSERT ON TABLE store_event TO gestoria_app;--> statement-breakpoint
-- `account_event_receipt`: sin GRANT; la escribe el dueño al recibir un aviso de la cuenta.

ALTER TABLE account_copy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store_member ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store_invitation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE store_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE account_event_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- El equipo: la persona ve sus propias tiendas (para elegir al entrar) y, dentro de una, a todo
-- su equipo. Solo se cambia el equipo de la tienda en la que se está.
CREATE POLICY store_member_read ON store_member FOR SELECT TO gestoria_app
  USING (store_id = app_store_id() OR user_id = app_user_id());--> statement-breakpoint
CREATE POLICY store_member_create ON store_member FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_member_change ON store_member FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_member_remove ON store_member FOR DELETE TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint

-- Las invitaciones: las de la tienda en la que se está, y las que son para el correo de quien pide.
CREATE POLICY store_invitation_read ON store_invitation FOR SELECT TO gestoria_app
  USING (store_id = app_store_id() OR email = app_user_email());--> statement-breakpoint
CREATE POLICY store_invitation_create ON store_invitation FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_invitation_close ON store_invitation FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());--> statement-breakpoint

-- La tienda: la de su equipo, o la que lo invitó (para ver su nombre antes de aceptar). Se crea
-- entrando antes a ella (`enterStore`), siempre a nombre de quien pide.
CREATE POLICY store_read ON store FOR SELECT TO gestoria_app
  USING (
    id = app_store_id()
    OR EXISTS (SELECT 1 FROM store_member m WHERE m.store_id = store.id AND m.user_id = app_user_id())
    OR EXISTS (
      SELECT 1 FROM store_invitation i
      WHERE i.store_id = store.id AND i.email = app_user_email()
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    )
  );--> statement-breakpoint
CREATE POLICY store_create ON store FOR INSERT TO gestoria_app
  WITH CHECK (id = app_store_id() AND created_by = app_user_id());--> statement-breakpoint

CREATE POLICY store_event_read ON store_event FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_event_create ON store_event FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id());--> statement-breakpoint

-- La copia de las cuentas: la propia, la de su equipo y la de quien lo invitó.
CREATE POLICY account_copy_read ON account_copy FOR SELECT TO gestoria_app
  USING (
    user_id = app_user_id()
    OR EXISTS (SELECT 1 FROM store_member m WHERE m.store_id = app_store_id() AND m.user_id = account_copy.user_id)
    OR EXISTS (
      SELECT 1 FROM store_invitation i
      WHERE i.email = app_user_email() AND i.invited_by = account_copy.user_id
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    )
  );
