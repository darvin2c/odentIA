-- Su enlace y el portal en un paso (fase 3, paso 6A; ADR 0037, que precisa el
-- 0014). No hay datos reales: lo que sale se borra sin plan de conservación.
--
-- 1. Su enlace: el enlace de reserva pasa a ser la página personal de cada
--    persona, con lo que tiene pendiente (su cita, sus datos, su presupuesto,
--    su consentimiento y su cuestionario). Es uno por persona y paciente, y no
--    siempre nace de una conversación: también lo envía recepción o lo lleva
--    el aviso de la cita. Se guarda quién lo envió y cuándo envió sus datos:
--    «Tus datos» se envían una sola vez.
ALTER TABLE "appointment_booking_link" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD COLUMN "data_submitted_at" timestamp with time zone;--> statement-breakpoint
-- Si ofrece reservar una cita nueva (el agente lo envía para eso); el que envía
-- recepción o el aviso de la cita muestra lo pendiente, no un calendario.
ALTER TABLE "appointment_booking_link" ADD COLUMN "booking" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- La plantilla de WhatsApp con el botón de «Su enlace» lleva su token como dato
-- del botón: el worker lo envía tal cual, igual que los datos del cuerpo.
ALTER TABLE "message" ADD COLUMN "template_link" text;--> statement-breakpoint
CREATE INDEX "appointment_booking_link_contact_idx" ON "appointment_booking_link" USING btree ("organization_id","contact_id","patient_id");--> statement-breakpoint
-- 2. Consentimiento por enlace (decisión 3): se envía a firmar antes de llegar,
--    la persona lo firma en su enlace y el profesional confirma en la cita.
--    Mientras el profesional no confirma sigue pendiente, con la firma de la
--    persona ya puesta.
ALTER TABLE "consent_document" ADD COLUMN "link_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "person_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_link_signed_check" CHECK ("signature_method" IS DISTINCT FROM 'enlace' OR "person_signed_at" IS NOT NULL);--> statement-breakpoint
-- 3. Dos pendientes que deja el sistema para una persona del equipo, cada uno
--    con su fila en «Te espera»: el documento que la persona escribió en su
--    enlace ya es de otra ficha («Posible ficha repetida»; nunca se unen
--    solas) y quien pide volver a entrar al portal («Enviar nuevo enlace»).
ALTER TABLE "task" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_kind_check" CHECK ("kind" IS NULL OR "kind" IN ('ficha_repetida', 'volver_al_portal'));
--> statement-breakpoint
-- 4. El portal en un paso (decisión 9). Valores fijos en lugar de «Opciones
--    avanzadas»: el enlace vale 3 días, la sesión dura 48 horas (30 días si el
--    teléfono no puede guardar la llave) y el acceso no vence hasta «Quitar
--    acceso». La llave guardada y el código de 6 dígitos valen siempre. Salen
--    las solicitudes (la web pública, la detección por palabras y su bloque de
--    Tareas): pedir el portal es un pedido más que el agente deja en «Te
--    espera» y atiende una persona del equipo.
ALTER TABLE "portal_verification" DROP COLUMN IF EXISTS "request_id";--> statement-breakpoint
DROP TABLE IF EXISTS "portal_request";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP CONSTRAINT IF EXISTS "portal_policy_ttl_check";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "requests_enabled";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "public_requests_enabled";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "channel_requests_enabled";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "auto_approve_verified";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "allowed_channel_ids";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "link_ttl_minutes";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "session_ttl_hours";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "grant_ttl_days";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "passkeys_enabled";--> statement-breakpoint
ALTER TABLE "portal_policy" DROP COLUMN IF EXISTS "assisted_recovery_enabled";--> statement-breakpoint
-- El acceso ya no vence solo. Lo que ya había vencido no revive: queda
-- revocado, con sus sesiones, sus llaves y sus enlaces pendientes, como
-- «Quitar acceso». Solo lo vigente pasa a no vencer.
UPDATE "portal_session" SET "revoked_at" = now(), "updated_at" = now()
WHERE "revoked_at" IS NULL AND "grant_id" IN (
  SELECT "id" FROM "portal_grant" WHERE "status" = 'activo' AND "expires_at" IS NOT NULL AND "expires_at" <= now()
);--> statement-breakpoint
UPDATE "portal_passkey" SET "revoked_at" = now()
WHERE "revoked_at" IS NULL AND "grant_id" IN (
  SELECT "id" FROM "portal_grant" WHERE "status" = 'activo' AND "expires_at" IS NOT NULL AND "expires_at" <= now()
);--> statement-breakpoint
UPDATE "portal_link" AS l SET "status" = 'revocado', "revoked_at" = now(), "updated_at" = now()
FROM "portal_grant" AS g
WHERE l."status" = 'pendiente' AND g."status" = 'activo' AND g."expires_at" IS NOT NULL AND g."expires_at" <= now()
  AND l."organization_id" = g."organization_id" AND l."patient_id" = g."patient_id" AND l."contact_id" = g."contact_id";--> statement-breakpoint
UPDATE "portal_grant" SET "status" = 'revocado', "revoked_at" = now(), "revoke_reason" = 'Había vencido antes de que el acceso dejara de vencer', "updated_at" = now()
WHERE "status" = 'activo' AND "expires_at" IS NOT NULL AND "expires_at" <= now();--> statement-breakpoint
UPDATE "portal_grant" SET "expires_at" = NULL WHERE "status" = 'activo' AND "expires_at" IS NOT NULL;
