ALTER TABLE "auth"."account_event" DROP CONSTRAINT "account_event_type_check";--> statement-breakpoint
ALTER TABLE "auth"."account_event" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "auth"."account_event" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_event_pending_user_idx" ON "auth"."account_event" USING btree ("app","user_id","created_at") WHERE delivered_at IS NULL;--> statement-breakpoint
ALTER TABLE "auth"."account_event" ADD CONSTRAINT "account_event_type_check" CHECK (type IN ('cuenta.cerrada','cuenta.bloqueada','cuenta.reabierta'));
-- Sin GRANT: `account_event` sigue siendo solo de la conexión propietaria y del trabajador (ADR 0201).
