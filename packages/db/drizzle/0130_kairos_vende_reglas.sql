-- Kairós vende y agenda (14 nov): lo que TS no declara. Las tablas `admin_staff_hours`,
-- `admin_staff_absence`, `kairos_setting` y `kairos_proposal` y las columnas nuevas de
-- `admin_staff`, `saas_task`, `saas_chat` y `saas_outreach` las generó 0129 desde el esquema; viven
-- en `admin` y no reciben ningún GRANT al rol de la aplicación (ADR 0063 y 0064). No llevan RLS:
-- no tienen `organization_id`.

-- La fila única de lo general de Kairós, con «responde solo en los chats» apagado hasta medirlo.
INSERT INTO admin.kairos_setting (id, sells_enabled) VALUES (true, false) ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- Las presentaciones abiertas con hora que ya estaban agendadas duran 45 minutos, como las nuevas:
-- con eso se ven sus choques y no se ofrece esa hora a otra clínica.
UPDATE admin.saas_task SET ends_at = due_at + interval '45 minutes'
  WHERE kind = 'presentacion' AND status = 'abierta' AND due_at IS NOT NULL AND ends_at IS NULL;
