-- Las reglas de Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6; ADR 0232). Como en
-- las migraciones de reglas anteriores, cada tabla nueva nace cerrada a `gestoria_app`: se concede
-- solo lo que la aplicación usa y cada tienda ve solo lo suyo. Quién cambia los cobros lo decide el
-- servidor (`configuracion` en `permisos.ts`). Sofi y Argos solo leen: nunca tocan los cobros.
--
-- Los datos de cada forma de cobro: su forma, el celular, el titular, el banco, la cuenta y el CCI.
GRANT UPDATE (kind, phone, holder, bank_code, account_number, cci) ON TABLE store_payment_method TO gestoria_app;--> statement-breakpoint

-- El QR de Yape o Plin: uno por medio, a nombre de quien lo sube. Se cambia o se quita.
GRANT SELECT, INSERT, DELETE ON TABLE store_payment_qr TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (content_type, content, updated_by, updated_at) ON TABLE store_payment_qr TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_payment_qr ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_payment_qr_read ON store_payment_qr FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_payment_qr_create ON store_payment_qr FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id() AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_payment_qr_change ON store_payment_qr FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND updated_by = app_user_id());--> statement-breakpoint
CREATE POLICY store_payment_qr_remove ON store_payment_qr FOR DELETE TO gestoria_app
  USING (store_id = app_store_id() AND NOT app_is_agent());--> statement-breakpoint

-- La pasarela: al conectarla entrando a la cuenta se guardan además el token para renovarla, cuándo
-- vence, su modo y la cuenta (a medias). Renovarla y marcar que la tienda quitó el permiso lo hace
-- el sistema (el dueño de la base), no una persona.
GRANT UPDATE (refresh_token_enc, expires_at, mode, provider_user_id, account_label, revoked_at) ON TABLE store_payment_link TO gestoria_app;--> statement-breakpoint

-- El intento de conectar: lo ve y lo usa solo quien lo empezó, en su tienda, una vez.
GRANT SELECT, INSERT ON TABLE store_payment_link_attempt TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (used_at) ON TABLE store_payment_link_attempt TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_payment_link_attempt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_payment_link_attempt_read ON store_payment_link_attempt FOR SELECT TO gestoria_app
  USING (store_id = app_store_id() AND created_by = app_user_id());--> statement-breakpoint
CREATE POLICY store_payment_link_attempt_create ON store_payment_link_attempt FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND used_at IS NULL AND NOT app_is_agent());--> statement-breakpoint
CREATE POLICY store_payment_link_attempt_use ON store_payment_link_attempt FOR UPDATE TO gestoria_app
  USING (store_id = app_store_id() AND created_by = app_user_id() AND used_at IS NULL AND NOT app_is_agent())
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id());--> statement-breakpoint

-- El link de prueba de S/ 1: lo crea una persona de la tienda; que se pagó lo anota el sistema
-- cuando el proveedor avisa y se le pregunta (el dueño de la base), nunca la aplicación.
GRANT SELECT, INSERT ON TABLE store_payment_link_trial TO gestoria_app;--> statement-breakpoint
ALTER TABLE store_payment_link_trial ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY store_payment_link_trial_read ON store_payment_link_trial FOR SELECT TO gestoria_app
  USING (store_id = app_store_id());--> statement-breakpoint
CREATE POLICY store_payment_link_trial_create ON store_payment_link_trial FOR INSERT TO gestoria_app
  WITH CHECK (store_id = app_store_id() AND created_by = app_user_id() AND paid_at IS NULL
    AND paid_cents IS NULL AND payment_ref IS NULL AND NOT app_is_agent());
