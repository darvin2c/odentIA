-- Fase 4, paso 4: WhatsApp y los mensajes que se pueden apagar.
-- 1) Una plantilla que ya estaba en la cuenta y que odentIA no sabe enviar
--    (con encabezado o con datos por nombre) se muestra, pero no se ofrece.
--    Nulo: se puede enviar.
ALTER TABLE "channel_template" ADD COLUMN "unsupported" text;--> statement-breakpoint
ALTER TABLE "channel_template" ADD CONSTRAINT "channel_template_unsupported_check" CHECK ("channel_template"."unsupported" is null or "channel_template"."unsupported" in ('encabezado','datos_por_nombre'));--> statement-breakpoint
-- 2) La revisión diaria de cada conexión: cuándo se leyeron por última vez sus
--    plantillas (estados y categorías), por si se perdió un aviso del proveedor.
ALTER TABLE "channel_connection" ADD COLUMN "templates_synced_at" timestamp with time zone;--> statement-breakpoint
-- 3) El enlace de baja del correo (RFC 2369, cabecera `List-Unsubscribe`):
--    lo pone el mensaje automático y el adaptador de correo lo envía como cabecera.
ALTER TABLE "message" ADD COLUMN "list_unsubscribe" text;--> statement-breakpoint
-- 4) Tipos de mensaje (ADR 0040): «avisos» es la fila de lo que pasó con su
--    cita y sus papeles; solo se apaga con «No quiero ningún mensaje de la
--    clínica». Los demás tipos siguen siendo los de siempre.
ALTER TABLE "automation_consent" ADD CONSTRAINT "automation_consent_purpose_check" CHECK ("automation_consent"."purpose" in ('recordatorio','seguimiento','novedades','avisos'));
