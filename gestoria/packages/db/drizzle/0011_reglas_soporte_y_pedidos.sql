-- Las reglas de lo que pide la administración (ADR 0214). Como en las migraciones de reglas
-- anteriores, cada tabla nace cerrada a `gestoria_app`: se concede solo lo que la aplicación usa.
--
-- Los pedidos recibidos: solo el dueño de la base, al recibirlos (sin GRANT).
ALTER TABLE contract_request_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- La entrada de soporte la crea el dueño de la base al recibir el pedido. La aplicación la lee
-- (la tienda en la que se está, o la persona de soporte la suya, para ver en qué tienda puede
-- entrar) y solo anota la respuesta del Dueño o el Administrador, que se quitó y cuándo entró.
GRANT SELECT ON TABLE store_support_access TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (state, answered_at, answered_by, expires_at, used_at, ended_at, ended_by) ON TABLE store_support_access TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_support_access ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_support_access_read ON store_support_access FOR SELECT TO gestoria_app
  USING (store_id = app_store_id() OR staff_user_id = app_user_id());--> statement-breakpoint
CREATE POLICY store_support_access_change ON store_support_access FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND NOT app_is_agent());--> statement-breakpoint

-- La tienda: también la que soporte puede mirar ahora (aceptada y sin vencer), para elegirla al
-- entrar. Lo demás de la tienda lo ve solo dentro de ella (`app_store_id`), como el equipo.
DROP POLICY store_read ON store;--> statement-breakpoint
CREATE POLICY store_read ON store FOR SELECT TO gestoria_app
  USING (
    id = app_store_id()
    OR EXISTS (SELECT 1 FROM store_member m WHERE m.store_id = store.id AND m.user_id = app_user_id())
    OR EXISTS (
      SELECT 1 FROM store_invitation i
      WHERE i.store_id = store.id AND i.email = app_user_email()
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    )
    OR EXISTS (
      SELECT 1 FROM store_support_access s
      WHERE s.store_id = store.id AND s.staff_user_id = app_user_id()
        AND s.state = 'aceptado' AND s.expires_at > now()
    )
  );
