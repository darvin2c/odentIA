CREATE TABLE "contract_request_receipt" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"store_id" uuid,
	"status" text NOT NULL,
	"message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_support_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"staff_user_id" text NOT NULL,
	"staff_name" text NOT NULL,
	"minutes" smallint NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'pedido' NOT NULL,
	"request_expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"answered_by" text,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_support_access_state_check" CHECK (state IN ('pedido','aceptado','rechazado','quitado')),
	CONSTRAINT "store_support_access_minutes_check" CHECK ("store_support_access"."minutes" between 5 and 60),
	CONSTRAINT "store_support_access_texts_check" CHECK (char_length(btrim("store_support_access"."reason")) between 3 and 500 and char_length(btrim("store_support_access"."staff_name")) between 1 and 200),
	CONSTRAINT "store_support_access_answer_check" CHECK (("store_support_access"."state" = 'pedido') = ("store_support_access"."answered_at" is null) and ("store_support_access"."answered_at" is null) = ("store_support_access"."answered_by" is null) and ("store_support_access"."expires_at" is not null) = ("store_support_access"."state" in ('aceptado','quitado') and "store_support_access"."answered_at" is not null) and ("store_support_access"."state" = 'quitado') = ("store_support_access"."ended_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "contract_outbox" DROP CONSTRAINT "contract_outbox_type_check";--> statement-breakpoint
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
DROP INDEX "contract_outbox_pending_idx";--> statement-breakpoint
ALTER TABLE "contract_outbox" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_support_access" ADD CONSTRAINT "store_support_access_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_support_access_store_idx" ON "store_support_access" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "store_support_access_staff_idx" ON "store_support_access" USING btree ("staff_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "contract_outbox_sent_idx" ON "contract_outbox" USING btree ("sent_at") WHERE sent_at is not null;--> statement-breakpoint
CREATE INDEX "contract_outbox_pending_idx" ON "contract_outbox" USING btree ("next_attempt_at","created_at") WHERE sent_at is null and rejected_at is null;--> statement-breakpoint
ALTER TABLE "contract_outbox" ADD CONSTRAINT "contract_outbox_rejected_check" CHECK ("contract_outbox"."rejected_at" is null or ("contract_outbox"."sent_at" is null and "contract_outbox"."type" = 'pago.comprobante'));--> statement-breakpoint
ALTER TABLE "contract_outbox" ADD CONSTRAINT "contract_outbox_type_check" CHECK (type IN ('cuenta.abierta','uso.contado','soporte.pedido','pago.comprobante'));--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi','soporte.pedido','soporte.aceptado','soporte.rechazado','soporte.quitado','soporte.entro'));